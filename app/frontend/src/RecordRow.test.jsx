import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import RecordRow from './RecordRow.jsx'

function renderRow(props) {
  return render(
    <table>
      <tbody>
        <RecordRow {...props} />
      </tbody>
    </table>,
  )
}

describe('RecordRow display mode', () => {
  it('renders name, status, amount, and notes', () => {
    renderRow({
      record: {
        id: 'r1',
        name: 'Alpha',
        status: 'active',
        amount: 42,
        notes: 'first note',
      },
    })

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('first note')).toBeInTheDocument()
  })

  it('renders an empty notes cell without printing undefined', () => {
    const { container } = renderRow({
      record: {
        id: 'r2',
        name: 'Beta',
        status: 'pending',
        amount: 0,
        // notes omitted — it is optional
      },
    })

    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(container.textContent).not.toContain('undefined')
  })

  it('an Edit affordance requests edit mode for this row', () => {
    const onEdit = vi.fn()
    renderRow({
      record: { id: 'r1', name: 'Alpha', status: 'active', amount: 1, notes: '' },
      onEdit,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('a Delete affordance calls onDelete with the record id', () => {
    const onDelete = vi.fn()
    renderRow({
      record: { id: 'r1', name: 'Alpha', status: 'active', amount: 1, notes: '' },
      onDelete,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith('r1')
  })
})

describe('RecordRow edit mode', () => {
  const record = {
    id: 'r1',
    name: 'Alpha',
    status: 'active',
    amount: 42,
    notes: 'first note',
  }

  it('renders inputs seeded with the current values', () => {
    renderRow({ record, isEditing: true })

    expect(screen.getByLabelText('Name')).toHaveValue('Alpha')
    expect(screen.getByLabelText('Status')).toHaveValue('active')
    expect(screen.getByLabelText('Amount')).toHaveValue(42)
    expect(screen.getByLabelText('Notes')).toHaveValue('first note')
  })

  it('Save calls onSave with the id and the edited patch (amount coerced to a number)', () => {
    const onSave = vi.fn()
    renderRow({ record, isEditing: true, onSave })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'pending' } })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '99' } })
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSave).toHaveBeenCalledWith('r1', {
      name: 'Renamed',
      status: 'pending',
      amount: 99,
      notes: 'edited',
    })
  })

  it('Cancel calls onCancel and does not save', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    renderRow({ record, isEditing: true, onSave, onCancel })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })
})
