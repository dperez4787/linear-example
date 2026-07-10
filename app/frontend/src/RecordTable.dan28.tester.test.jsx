// DAN-28 tester verification. Independent of the developer's own
// RecordTable.dan28.test.jsx: different fixtures, and it drives every acceptance
// criterion by rendering the component and asserting the observed DOM, not the
// implementation. Sorting/filtering is client-side over the `records` prop, so
// these render RecordTable directly with fixed data.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import RecordTable from './RecordTable.jsx'

// Intentionally unsorted, mixed-case, with amounts and dates whose numeric and
// chronological order disagrees with their string order — so a numeric sort that
// accidentally stringified, or a date sort that compared lexicographically, would
// be caught. "zebra"/"Zulu" vs "apple" also separate case-insensitive from
// case-sensitive ordering (a naive sort puts uppercase before lowercase).
const RECORDS = [
  { id: '1', name: 'zebra', status: 'Pending', amount: 9, notes: '', updatedAt: '2026-05-01T00:00:00.000Z' },
  { id: '2', name: 'apple', status: 'active', amount: 100, notes: '', updatedAt: '2026-01-15T00:00:00.000Z' },
  { id: '3', name: 'Mango', status: 'archived', amount: 2, notes: '', updatedAt: '2026-11-30T00:00:00.000Z' },
]

function rowNames() {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent)
}

describe('DAN-28 tester · sorting', () => {
  it('renders rows in listRecords() order before any header click', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    expect(rowNames()).toEqual(['zebra', 'apple', 'Mango'])
  })

  it('name: click sorts case-insensitive ascending; second click reverses', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    // apple < Mango < zebra, case-insensitively (uppercase M not before lowercase).
    expect(rowNames()).toEqual(['apple', 'Mango', 'zebra'])
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(rowNames()).toEqual(['zebra', 'Mango', 'apple'])
  })

  it('amount: sorts numerically, not lexically', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    // 2 < 9 < 100 numerically (lexically "100" would sort before "2").
    expect(rowNames()).toEqual(['Mango', 'zebra', 'apple'])
    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    expect(rowNames()).toEqual(['apple', 'zebra', 'Mango'])
  })

  it('status: sorts case-insensitively as a string', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Status' }))
    // active(apple) < archived(Mango) < Pending(zebra), case-insensitive.
    expect(rowNames()).toEqual(['apple', 'Mango', 'zebra'])
    fireEvent.click(screen.getByRole('button', { name: 'Status' }))
    expect(rowNames()).toEqual(['zebra', 'Mango', 'apple'])
  })

  it('updatedAt: sorts chronologically, not lexically', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }))
    // Jan(apple) < May(zebra) < Nov(Mango).
    expect(rowNames()).toEqual(['apple', 'zebra', 'Mango'])
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }))
    expect(rowNames()).toEqual(['Mango', 'zebra', 'apple'])
  })

  it('switching to a different column always starts ascending', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    fireEvent.click(screen.getByRole('button', { name: 'Name' })) // name descending
    fireEvent.click(screen.getByRole('button', { name: 'Amount' })) // switch column
    expect(rowNames()).toEqual(['Mango', 'zebra', 'apple']) // ascending, not carried-over desc
  })
})

describe('DAN-28 tester · sort indicator / aria-sort', () => {
  it('marks only the active header with aria-sort and a matching visible arrow', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    for (const label of ['Name', 'Status', 'Amount', 'Updated']) {
      expect(screen.getByRole('columnheader', { name: label })).not.toHaveAttribute('aria-sort')
    }

    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    const amount = screen.getByRole('columnheader', { name: 'Amount' })
    expect(amount).toHaveAttribute('aria-sort', 'ascending')
    expect(amount).toHaveTextContent('▲')
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort')

    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    expect(amount).toHaveAttribute('aria-sort', 'descending')
    expect(amount).toHaveTextContent('▼')

    // Moving on clears aria-sort from the previous column.
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(screen.getByRole('columnheader', { name: 'Amount' })).not.toHaveAttribute('aria-sort')
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending')
  })
})

describe('DAN-28 tester · filtering', () => {
  it('name filter is a case-insensitive substring; clearing restores all', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    const input = screen.getByLabelText('Filter by name')

    fireEvent.change(input, { target: { value: 'AP' } }) // -> apple
    expect(rowNames()).toEqual(['apple'])
    fireEvent.change(input, { target: { value: 'a' } }) // substring in all three
    expect(rowNames()).toEqual(['zebra', 'apple', 'Mango'])
    fireEvent.change(input, { target: { value: '' } })
    expect(rowNames()).toEqual(['zebra', 'apple', 'Mango'])
  })

  it('status filter shows only the exact status; "all" shows everything', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    const select = screen.getByLabelText('Filter by status')

    fireEvent.change(select, { target: { value: 'archived' } })
    expect(rowNames()).toEqual(['Mango'])
    fireEvent.change(select, { target: { value: 'all' } })
    expect(rowNames()).toEqual(['zebra', 'apple', 'Mango'])
  })

  it('offers active/pending/archived plus an "all" default', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    const select = screen.getByLabelText('Filter by status')
    const options = within(select).getAllByRole('option').map((o) => o.value)
    expect(options).toEqual(['all', 'active', 'pending', 'archived'])
    expect(select).toHaveValue('all')
  })

  it('AND-combines name + status, and sorting orders the filtered subset', () => {
    const many = [
      { id: '1', name: 'Alpha', status: 'active', amount: 30, notes: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', name: 'Algo', status: 'pending', amount: 5, notes: '', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: '3', name: 'Alto', status: 'active', amount: 10, notes: '', updatedAt: '2026-01-03T00:00:00.000Z' },
      { id: '4', name: 'Zed', status: 'active', amount: 1, notes: '', updatedAt: '2026-01-04T00:00:00.000Z' },
    ]
    render(<RecordTable records={many} onSave={() => {}} onDelete={() => {}} />)
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'al' } })
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'active' } })
    expect(rowNames()).toEqual(['Alpha', 'Alto']) // "al" AND active; excludes Algo(pending), Zed(no "al")

    fireEvent.click(screen.getByRole('button', { name: 'Amount' }))
    expect(rowNames()).toEqual(['Alto', 'Alpha']) // 10 < 30 within the subset
  })
})

describe('DAN-28 tester · table states', () => {
  it('zero records shows a distinct empty state and no clear-filters control', () => {
    render(<RecordTable records={[]} onSave={() => {}} onDelete={() => {}} />)
    expect(screen.getByText('No records yet.')).toBeInTheDocument()
    expect(screen.queryByText(/No matching records/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })

  it('no-match shows its own state with a Clear filters control that restores rows', () => {
    render(<RecordTable records={RECORDS} onSave={() => {}} onDelete={() => {}} />)
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'nope' } })
    expect(screen.getByText(/No matching records/)).toBeInTheDocument()
    expect(screen.queryByText('No records yet.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(rowNames()).toEqual(['zebra', 'apple', 'Mango'])
    expect(screen.getByLabelText('Filter by name')).toHaveValue('')
    expect(screen.getByLabelText('Filter by status')).toHaveValue('all')
  })
})
