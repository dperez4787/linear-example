import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import RecordRow from './RecordRow.jsx'

function renderRow(record) {
  return render(
    <table>
      <tbody>
        <RecordRow record={record} />
      </tbody>
    </table>,
  )
}

describe('RecordRow', () => {
  it('renders name, status, amount, and notes', () => {
    renderRow({
      id: 'r1',
      name: 'Alpha',
      status: 'active',
      amount: 42,
      notes: 'first note',
    })

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('first note')).toBeInTheDocument()
  })

  it('renders an empty notes cell without printing undefined', () => {
    const { container } = renderRow({
      id: 'r2',
      name: 'Beta',
      status: 'pending',
      amount: 0,
      // notes omitted — it is optional
    })

    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(container.textContent).not.toContain('undefined')
  })
})
