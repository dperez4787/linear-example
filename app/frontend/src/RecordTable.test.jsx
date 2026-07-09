import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import RecordTable from './RecordTable.jsx'

const records = [
  { id: 'a', name: 'Alpha', status: 'active', amount: 1, notes: '' },
  { id: 'b', name: 'Beta', status: 'pending', amount: 2, notes: '' },
]

describe('RecordTable', () => {
  it('renders one row per record', () => {
    render(<RecordTable records={records} />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    // One header row + two data rows.
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })

  it('renders a visible empty state (and does not crash) on zero records', () => {
    render(<RecordTable records={[]} />)

    expect(screen.getByText('No records yet.')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('owns which row is editing: clicking Edit puts only that row into edit mode', () => {
    render(<RecordTable records={records} />)

    // Two Edit buttons in display mode, no inputs yet.
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2)
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()

    // Edit the first row.
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])

    // Exactly one row is now editing (one set of inputs), seeded with its values.
    expect(screen.getByLabelText('Name')).toHaveValue('Alpha')
    // The other row stays in display mode.
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1)
  })

  it('leaves edit mode immediately on Save and hands the patch to onSave', () => {
    const onSave = vi.fn()
    render(<RecordTable records={records} onSave={onSave} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The row returns to display mode at once — it does not wait on the request
    // (App applies the change optimistically and rolls back on failure).
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2)
    expect(onSave).toHaveBeenCalledWith('a', {
      name: 'Alpha',
      status: 'active',
      amount: 1,
      notes: '',
    })
  })

  it('Cancel leaves edit mode without calling onSave', () => {
    const onSave = vi.fn()
    render(<RecordTable records={records} onSave={onSave} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('delegates delete to onDelete with the row id', () => {
    const onDelete = vi.fn()
    render(<RecordTable records={records} onDelete={onDelete} />)

    const betaRow = screen.getByText('Beta').closest('tr')
    fireEvent.click(within(betaRow).getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith('b')
  })
})
