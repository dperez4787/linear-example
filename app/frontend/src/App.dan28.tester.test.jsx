// DAN-28 tester verification, App level. Covers the criteria that only surface
// when the table is wired to App's data ownership: the loading state while the
// initial listRecords() promise is unresolved, and the "a newly created row
// appears subject to the current filters and sort" regression — sorting/filtering
// state lives in RecordTable while the record array lives in App, so a created
// row must flow through the active view state with no coordination code.
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import * as api from './api.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderApp() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

function rowNames() {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent)
}

afterEach(() => vi.restoreAllMocks())

describe('DAN-28 tester · loading state', () => {
  it('renders a loading state and neither empty state while the fetch is in flight', async () => {
    const d = deferred()
    vi.spyOn(api, 'listRecords').mockReturnValue(d.promise)

    renderApp()

    expect(screen.getByText('Loading records…')).toBeInTheDocument()
    expect(screen.queryByText('No records yet.')).not.toBeInTheDocument()
    expect(screen.queryByText(/No matching records/)).not.toBeInTheDocument()

    // Resolving to zero records flips to the empty state, proving loading was transient.
    d.resolve([])
    expect(await screen.findByText('No records yet.')).toBeInTheDocument()
    expect(screen.queryByText('Loading records…')).not.toBeInTheDocument()
  })
})

describe('DAN-28 tester · created row honors active filter and sort', () => {
  it('a created row that matches the active name filter appears; one that does not stays hidden', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue([
      { id: 'a1', name: 'Apple', status: 'active', amount: 10, notes: '', updatedAt: '2026-01-01T00:00:00.000Z' },
    ])
    // First creation matches the filter, second does not.
    vi.spyOn(api, 'createRecord')
      .mockResolvedValueOnce({ id: 'n1', name: 'Apricot', status: 'active', amount: 3, notes: '', updatedAt: '2026-02-01T00:00:00.000Z' })
      .mockResolvedValueOnce({ id: 'n2', name: 'Cherry', status: 'active', amount: 4, notes: '', updatedAt: '2026-03-01T00:00:00.000Z' })

    renderApp()
    await screen.findByText('Apple')

    // Filter to names containing "ap" — matches Apple.
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'ap' } })
    expect(rowNames()).toEqual(['Apple'])

    // Create Apricot (contains "ap") -> appears under the active filter.
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Apricot' } })
    fireEvent.change(screen.getByLabelText('New amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Apricot')).toBeInTheDocument()
    expect(rowNames().sort()).toEqual(['Apple', 'Apricot'])

    // Create Cherry (no "ap") -> filtered out, not shown while filter is active.
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Cherry' } })
    fireEvent.change(screen.getByLabelText('New amount'), { target: { value: '4' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    // Create resolved (createRecord called twice), yet Cherry stays hidden under
    // the active filter.
    await waitFor(() => expect(api.createRecord).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Cherry')).not.toBeInTheDocument()

    // Clearing the filter reveals the hidden created row.
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: '' } })
    expect(await screen.findByText('Cherry')).toBeInTheDocument()
  })

  it('a created row lands in its sorted position, not merely appended', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue([
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'z1', name: 'Zeta', status: 'active', amount: 20, notes: '', updatedAt: '2026-01-02T00:00:00.000Z' },
    ])
    vi.spyOn(api, 'createRecord').mockResolvedValue({
      id: 'm1', name: 'Mango', status: 'active', amount: 15, notes: '', updatedAt: '2026-01-03T00:00:00.000Z',
    })

    renderApp()
    await screen.findByText('Alpha')

    // Sort ascending by name.
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(rowNames()).toEqual(['Alpha', 'Zeta'])

    // Create Mango — it must sort between Alpha and Zeta, not append after them.
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Mango' } })
    fireEvent.change(screen.getByLabelText('New amount'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText('Mango')).toBeInTheDocument()
    expect(rowNames()).toEqual(['Alpha', 'Mango', 'Zeta'])
  })
})
