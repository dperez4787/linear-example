import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import NewRecordForm from './NewRecordForm.jsx'

// The form delegates the actual create to `onCreate`; App wires that to
// api.createRecord + state append. These tests drive the form in isolation with
// a stubbed onCreate so they assert exactly what the form is responsible for:
// collecting the four fields, calling onCreate with coerced values, clearing on
// success, and mapping a field-scoped rejection onto the offending input.
describe('NewRecordForm', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function fill({ name, status, amount, notes }) {
    if (name !== undefined) {
      fireEvent.change(screen.getByLabelText('New name'), { target: { value: name } })
    }
    if (status !== undefined) {
      fireEvent.change(screen.getByLabelText('New status'), { target: { value: status } })
    }
    if (amount !== undefined) {
      fireEvent.change(screen.getByLabelText('New amount'), { target: { value: amount } })
    }
    if (notes !== undefined) {
      fireEvent.change(screen.getByLabelText('New notes'), { target: { value: notes } })
    }
  }

  it('submits name, status, amount (coerced to a number) and notes', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<NewRecordForm onCreate={onCreate} />)

    fill({ name: 'Gamma', status: 'pending', amount: '42', notes: 'fresh' })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: 'Gamma',
        status: 'pending',
        amount: 42,
        notes: 'fresh',
      }),
    )
  })

  it('clears the inputs after a successful create', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<NewRecordForm onCreate={onCreate} />)

    fill({ name: 'Gamma', amount: '42', notes: 'fresh' })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(screen.getByLabelText('New name')).toHaveValue(''))
    expect(screen.getByLabelText('New amount')).toHaveValue(null)
    expect(screen.getByLabelText('New notes')).toHaveValue('')
  })

  it('surfaces a 400 against the offending field and marks it invalid', async () => {
    const err = new Error('amount must be a finite number greater than or equal to 0')
    err.field = 'amount'
    const onCreate = vi.fn().mockRejectedValue(err)
    render(<NewRecordForm onCreate={onCreate} />)

    fill({ name: 'Gamma', amount: '-1', notes: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    // The message lands on the amount field: aria-invalid set, and the alert is
    // wired to the input via aria-describedby.
    const amountInput = await screen.findByLabelText('New amount')
    await waitFor(() => expect(amountInput).toHaveAttribute('aria-invalid', 'true'))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(
      'amount must be a finite number greater than or equal to 0',
    )
    expect(amountInput).toHaveAttribute('aria-describedby', alert.id)
    // A different field is not marked invalid.
    expect(screen.getByLabelText('New name')).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps the draft so the user can fix and resubmit after a rejection', async () => {
    const err = new Error('name is required')
    err.field = 'name'
    const onCreate = vi.fn().mockRejectedValue(err)
    render(<NewRecordForm onCreate={onCreate} />)

    fill({ name: 'x', amount: '5', notes: 'keep me' })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText('name is required')
    // On failure the inputs are NOT cleared — the user can correct them.
    expect(screen.getByLabelText('New amount')).toHaveValue(5)
    expect(screen.getByLabelText('New notes')).toHaveValue('keep me')
  })

  it('shows an error without a field as a form-level alert', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('Network down'))
    render(<NewRecordForm onCreate={onCreate} />)

    fill({ name: 'Gamma', amount: '1' })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText('Network down')).toBeInTheDocument()
    // Not attached to any input.
    expect(screen.getByLabelText('New amount')).not.toHaveAttribute('aria-invalid', 'true')
  })
})
