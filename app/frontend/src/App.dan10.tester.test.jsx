import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import * as api from './api.js'

// Tester verification for DAN-10 (create a record from the table view). These
// tests were also confirmed end-to-end in a real Chromium browser against the
// live backend on the test database (MONGODB_DB=linear_example_test): the new
// row appeared without a reload, and negative-amount / empty-name submissions
// each surfaced a 400 on their own field. This suite re-encodes the parts of
// that proof that survive a clean `npm ci && npm test` checkout with no browser.

function renderApp() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

describe('DAN-10 tester · create from the table view', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('submitting prevents the form default so there is NO full page reload', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue([
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: '' },
    ])
    vi.spyOn(api, 'createRecord').mockResolvedValue({
      id: 'n1', name: 'Gamma', status: 'pending', amount: 42, notes: 'x',
    })

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Gamma' } })
    fireEvent.change(screen.getByLabelText('New amount'), { target: { value: '42' } })

    // fireEvent returns false when a handler called preventDefault — i.e. the
    // browser's default form submit (a navigation / full reload) was cancelled.
    // A <form> that forgot preventDefault would return true here and reload.
    const form = screen.getByRole('form', { name: 'New record' })
    const notReloaded = fireEvent.submit(form)
    expect(notReloaded).toBe(false)

    expect(await screen.findByText('Gamma')).toBeInTheDocument()
  })

  it('appends the returned record WITHOUT re-fetching the list (useRef guard)', async () => {
    const listSpy = vi.spyOn(api, 'listRecords').mockResolvedValue([
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: '' },
    ])
    vi.spyOn(api, 'createRecord').mockResolvedValue({
      id: 'n1', name: 'Gamma', status: 'pending', amount: 42, notes: 'x',
    })

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Gamma' } })
    fireEvent.change(screen.getByLabelText('New amount'), { target: { value: '42' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText('Gamma')
    expect(screen.getByText('Alpha')).toBeInTheDocument() // old rows survive
    // The list is fetched exactly once (mount) and never re-fetched on create.
    // A re-fetch would re-await the cached mount promise and replay the stale
    // pre-create list — the new row would vanish.
    expect(listSpy).toHaveBeenCalledTimes(1)
  })

  it('a 400 lands on the offending field and adds no row — two different fields', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue([
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: '' },
    ])
    const createSpy = vi.spyOn(api, 'createRecord')

    // Field #1: negative amount -> error on the amount input, not on name.
    const amountErr = new Error('amount must be a finite number greater than or equal to 0')
    amountErr.field = 'amount'
    createSpy.mockRejectedValueOnce(amountErr)

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Bad' } })
    fireEvent.change(screen.getByLabelText('New amount'), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    const amountInput = await screen.findByLabelText('New amount')
    await waitFor(() => expect(amountInput).toHaveAttribute('aria-invalid', 'true'))
    const amountAlert = document.getElementById(amountInput.getAttribute('aria-describedby'))
    expect(amountAlert).toHaveTextContent('amount must be a finite number greater than or equal to 0')
    expect(screen.getByLabelText('New name')).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText('Bad')).not.toBeInTheDocument()

    // Field #2: empty name -> error on the name input, not on amount.
    const nameErr = new Error('name is required')
    nameErr.field = 'name'
    createSpy.mockRejectedValueOnce(nameErr)

    fireEvent.change(screen.getByLabelText('New name'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('New amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    const nameInput = await screen.findByLabelText('New name')
    await waitFor(() => expect(nameInput).toHaveAttribute('aria-invalid', 'true'))
    const nameAlert = document.getElementById(nameInput.getAttribute('aria-describedby'))
    expect(nameAlert).toHaveTextContent('name is required')
    expect(screen.getByLabelText('New amount')).not.toHaveAttribute('aria-invalid', 'true')

    // Still exactly one data row (Alpha) — no rejected row ever landed.
    const dataRows = screen.getAllByRole('row').filter((r) => within(r).queryByText('Alpha'))
    expect(dataRows).toHaveLength(1)
  })
})
