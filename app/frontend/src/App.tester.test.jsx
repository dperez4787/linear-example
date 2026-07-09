// DAN-9 tester verification. Independent of the developer's own *.test.jsx.
// Locks the invariants the ticket's acceptance criteria hinge on:
//  - RecordTable owns *which single* row is editing (not App, not RecordRow).
//  - Edit/delete are optimistic: the change renders BEFORE the request resolves
//    (proved with a controlled deferred, not just an end state), and on failure
//    the prior state is restored AND an error is surfaced to the user.
import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import RecordTable from './RecordTable.jsx'
import * as api from './api.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ROWS = [
  { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'note a' },
  { id: 'b2', name: 'Beta', status: 'pending', amount: 5, notes: '' },
]

function renderApp() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('DAN-9 · RecordTable owns which row is editing', () => {
  it('editing one row leaves every other row in display mode', () => {
    render(<RecordTable records={ROWS} onSave={() => {}} onDelete={() => {}} />)

    const alphaRow = screen.getByText('Alpha').closest('tr')
    fireEvent.click(within(alphaRow).getByRole('button', { name: 'Edit' }))

    // Exactly one row entered edit mode: a single set of inputs exists.
    expect(screen.getAllByLabelText('Name')).toHaveLength(1)
    // The other row is still plain display text with its own Edit button.
    const betaRow = screen.getByText('Beta').closest('tr')
    expect(within(betaRow).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(betaRow).queryByLabelText('Name')).not.toBeInTheDocument()
  })
})

describe('DAN-9 · edit is optimistic with rollback', () => {
  it('renders the new value BEFORE the PATCH resolves', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue(ROWS)
    const d = deferred()
    vi.spyOn(api, 'updateRecord').mockReturnValue(d.promise)

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.click(within(screen.getByText('Alpha').closest('tr')).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Pending PATCH: the optimistic value is already on screen.
    expect(d.promise).toBeDefined()
    expect(screen.getByText('Renamed')).toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

    d.resolve({ id: 'a1', name: 'Renamed', status: 'active', amount: 10, notes: 'srv' })
    expect(await screen.findByText('srv')).toBeInTheDocument()
  })

  it('restores the prior value and surfaces the server error on PATCH failure', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue(ROWS)
    vi.spyOn(api, 'updateRecord').mockRejectedValue(new Error('amount must be a finite number greater than or equal to 0'))

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.click(within(screen.getByText('Alpha').closest('tr')).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.queryByText('Renamed')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('amount must be a finite number')
  })
})

describe('DAN-9 · delete is optimistic with rollback', () => {
  it('removes the row BEFORE the DELETE resolves', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue(ROWS)
    const d = deferred()
    vi.spyOn(api, 'deleteRecord').mockReturnValue(d.promise)

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.click(within(screen.getByText('Alpha').closest('tr')).getByRole('button', { name: 'Delete' }))

    // Gone while the DELETE is still pending; the sibling row remains.
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()

    d.resolve(undefined)
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument())
  })

  it('restores the row and surfaces the server error on DELETE failure', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue(ROWS)
    vi.spyOn(api, 'deleteRecord').mockRejectedValue(new Error('record not found'))

    renderApp()
    await screen.findByText('Alpha')

    fireEvent.click(within(screen.getByText('Alpha').closest('tr')).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('record not found')
  })
})
