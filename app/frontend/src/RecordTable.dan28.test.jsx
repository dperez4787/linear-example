import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import RecordTable from './RecordTable.jsx'

// Deliberately out of any sorted order, and with mixed-case names/statuses, so
// "sorts case-insensitively" and "renders in fetched order before any click" are
// distinguishable from each other and from an accidental alphabetization.
const records = [
  { id: 'b', name: 'banana', status: 'pending', amount: 30, notes: '', updatedAt: '2026-03-02T00:00:00.000Z' },
  { id: 'a', name: 'Apple', status: 'active', amount: 20, notes: '', updatedAt: '2026-01-05T00:00:00.000Z' },
  { id: 'c', name: 'Cherry', status: 'archived', amount: 10, notes: '', updatedAt: '2026-02-10T00:00:00.000Z' },
]

// The name shown in each data row, top to bottom (drops the header row).
function rowNames() {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent)
}

describe('RecordTable sorting', () => {
  it('renders rows in the order listRecords() returned before any header is clicked', () => {
    render(<RecordTable records={records} />)
    expect(rowNames()).toEqual(['banana', 'Apple', 'Cherry'])
  })

  it('sorts by name case-insensitively ascending, then reverses on a second click', () => {
    render(<RecordTable records={records} />)

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(rowNames()).toEqual(['Apple', 'banana', 'Cherry'])

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(rowNames()).toEqual(['Cherry', 'banana', 'Apple'])
  })

  it('sorts by amount numerically', () => {
    render(<RecordTable records={records} />)

    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    // 10 (Cherry) < 20 (Apple) < 30 (banana) — numeric, not string.
    expect(rowNames()).toEqual(['Cherry', 'Apple', 'banana'])

    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    expect(rowNames()).toEqual(['banana', 'Apple', 'Cherry'])
  })

  it('sorts by status case-insensitively as a string', () => {
    render(<RecordTable records={records} />)

    fireEvent.click(screen.getByRole('button', { name: 'Status' }))
    // active (Apple) < archived (Cherry) < pending (banana).
    expect(rowNames()).toEqual(['Apple', 'Cherry', 'banana'])

    fireEvent.click(screen.getByRole('button', { name: 'Status' }))
    expect(rowNames()).toEqual(['banana', 'Cherry', 'Apple'])
  })

  it('sorts by updatedAt chronologically', () => {
    render(<RecordTable records={records} />)

    fireEvent.click(screen.getByRole('button', { name: 'Updated' }))
    // Jan (Apple) < Feb (Cherry) < Mar (banana).
    expect(rowNames()).toEqual(['Apple', 'Cherry', 'banana'])

    fireEvent.click(screen.getByRole('button', { name: 'Updated' }))
    expect(rowNames()).toEqual(['banana', 'Cherry', 'Apple'])
  })

  it('sorts a different column ascending when its header is clicked', () => {
    render(<RecordTable records={records} />)

    fireEvent.click(screen.getByRole('button', { name: 'Name' })) // desc-capable state
    fireEvent.click(screen.getByRole('button', { name: 'Name' })) // now descending
    // Switching columns always starts ascending, regardless of the prior column.
    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    expect(rowNames()).toEqual(['Cherry', 'Apple', 'banana'])
  })

  it('exposes the active sort via aria-sort on that header only, with a visible indicator', () => {
    render(<RecordTable records={records} />)

    // No header carries aria-sort before any click.
    for (const label of ['Name', 'Status', 'Amount', 'Updated']) {
      expect(screen.getByRole('columnheader', { name: label })).not.toHaveAttribute('aria-sort')
    }

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    const nameHeader = screen.getByRole('columnheader', { name: 'Name' })
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')
    expect(nameHeader).toHaveTextContent('▲')
    // Only the active column carries aria-sort.
    expect(screen.getByRole('columnheader', { name: 'Amount' })).not.toHaveAttribute('aria-sort')

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveTextContent('▼')

    // Moving to another column clears aria-sort from the old one.
    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort')
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toHaveAttribute('aria-sort', 'ascending')
  })
})

describe('RecordTable filtering', () => {
  it('filters by name as a case-insensitive substring, and clearing restores all rows', () => {
    render(<RecordTable records={records} />)
    const input = screen.getByLabelText('Filter by name')

    fireEvent.change(input, { target: { value: 'an' } }) // matches "banana" only
    expect(rowNames()).toEqual(['banana'])

    fireEvent.change(input, { target: { value: 'APP' } }) // case-insensitive → "Apple"
    expect(rowNames()).toEqual(['Apple'])

    fireEvent.change(input, { target: { value: '' } })
    expect(rowNames()).toEqual(['banana', 'Apple', 'Cherry'])
  })

  it('filters by exact status, and "all" shows every row', () => {
    render(<RecordTable records={records} />)
    const select = screen.getByLabelText('Filter by status')

    fireEvent.change(select, { target: { value: 'active' } })
    expect(rowNames()).toEqual(['Apple'])

    fireEvent.change(select, { target: { value: 'all' } })
    expect(rowNames()).toEqual(['banana', 'Apple', 'Cherry'])
  })

  it('combines name and status filters with AND, and sorts the filtered subset', () => {
    const many = [
      { id: '1', name: 'Alpha', status: 'active', amount: 3, notes: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', name: 'Algo', status: 'pending', amount: 2, notes: '', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: '3', name: 'Alto', status: 'active', amount: 5, notes: '', updatedAt: '2026-01-03T00:00:00.000Z' },
      { id: '4', name: 'Beta', status: 'active', amount: 1, notes: '', updatedAt: '2026-01-04T00:00:00.000Z' },
    ]
    render(<RecordTable records={many} />)

    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'al' } })
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'active' } })
    // "al" substring AND status active → Alpha, Alto (not Algo=pending, not Beta).
    expect(rowNames()).toEqual(['Alpha', 'Alto'])

    // Sorting orders that filtered subset.
    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    expect(rowNames()).toEqual(['Alpha', 'Alto']) // 3 < 5
    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    expect(rowNames()).toEqual(['Alto', 'Alpha'])
  })
})

describe('RecordTable states', () => {
  it('renders the zero-records empty state, distinct from no-match', () => {
    render(<RecordTable records={[]} />)
    expect(screen.getByText('No records yet.')).toBeInTheDocument()
    expect(screen.queryByText(/No matching records/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })

  it('renders a no-match state with a Clear filters control that restores the rows', () => {
    render(<RecordTable records={records} />)

    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'zzz' } })
    expect(screen.getByText(/No matching records/)).toBeInTheDocument()
    // Distinct from the zero-records state.
    expect(screen.queryByText('No records yet.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(rowNames()).toEqual(['banana', 'Apple', 'Cherry'])
    expect(screen.getByLabelText('Filter by name')).toHaveValue('')
  })

  it('Clear filters resets the status select too but leaves the sort intact', () => {
    render(<RecordTable records={records} />)

    fireEvent.click(screen.getByRole('button', { name: 'Name' })) // sort ascending
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'active' } })
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'zzz' } })
    expect(screen.getByText(/No matching records/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    // Filters reset; sort by name (ascending) still applies.
    expect(screen.getByLabelText('Filter by status')).toHaveValue('all')
    expect(rowNames()).toEqual(['Apple', 'banana', 'Cherry'])
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending')
  })
})
