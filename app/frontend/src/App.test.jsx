import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import * as api from './api.js'

// A promise whose settlement we control, to observe the UI between an optimistic
// apply and the request resolving.
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Mount App the way main.jsx mounts it — inside <StrictMode> — so these tests
// exercise the real double-invoked-effect path in dev, not a StrictMode-free
// render the app never uses.
function renderApp() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches records once on mount and renders a row per record', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'note a' },
      { id: 'b2', name: 'Beta', status: 'archived', amount: 5, notes: '' },
    ]
    const spy = vi.spyOn(api, 'listRecords').mockResolvedValue(records)

    renderApp()

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    // Fetched exactly once even though StrictMode double-invokes the effect.
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('renders a visible empty state when there are no records', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue([])

    renderApp()

    expect(await screen.findByText('No records yet.')).toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    vi.spyOn(api, 'listRecords').mockRejectedValue(new Error('boom'))

    renderApp()

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom')
    })
  })
})

describe('App edit (optimistic-with-rollback)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the edited value immediately, before the PATCH resolves, then reconciles with the server record', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'note a' },
    ]
    vi.spyOn(api, 'listRecords').mockResolvedValue(records)
    const d = deferred()
    const updateSpy = vi.spyOn(api, 'updateRecord').mockReturnValue(d.promise)

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Optimistic: the new value is in the table (display mode) while the request
    // is still pending — the PATCH has not resolved yet.
    expect(screen.getByText('Renamed')).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(updateSpy).toHaveBeenCalledWith('a1', {
      name: 'Renamed',
      status: 'active',
      amount: 10,
      notes: 'note a',
    })

    // Resolve with the server's canonical record; the UI reconciles to it.
    d.resolve({ id: 'a1', name: 'Renamed', status: 'active', amount: 10, notes: 'from server' })
    expect(await screen.findByText('from server')).toBeInTheDocument()
  })

  it('restores the prior value and surfaces an error when the PATCH fails', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'note a' },
    ]
    vi.spyOn(api, 'listRecords').mockResolvedValue(records)
    vi.spyOn(api, 'updateRecord').mockRejectedValue(new Error('amount must be a finite number greater than or equal to 0'))

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Rollback: prior value restored, edited value gone, error surfaced.
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })
    expect(screen.queryByText('Renamed')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'amount must be a finite number greater than or equal to 0',
    )
  })
})

describe('App delete (optimistic-with-rollback)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes the row immediately on delete', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 1, notes: '' },
      { id: 'b2', name: 'Beta', status: 'pending', amount: 2, notes: '' },
    ]
    vi.spyOn(api, 'listRecords').mockResolvedValue(records)
    const delSpy = vi.spyOn(api, 'deleteRecord').mockResolvedValue(undefined)

    renderApp()
    await screen.findByText('Alpha')

    const alphaRow = screen.getByText('Alpha').closest('tr')
    fireEvent.click(within(alphaRow).getByRole('button', { name: 'Delete' }))

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(delSpy).toHaveBeenCalledWith('a1')
  })

  it('restores the row and surfaces an error when the DELETE fails', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 1, notes: '' },
    ]
    vi.spyOn(api, 'listRecords').mockResolvedValue(records)
    vi.spyOn(api, 'deleteRecord').mockRejectedValue(new Error('record not found'))

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    // Optimistically gone, then restored with an error.
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('record not found')
  })
})
