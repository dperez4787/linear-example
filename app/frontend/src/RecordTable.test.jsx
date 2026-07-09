import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import RecordTable from './RecordTable.jsx'

describe('RecordTable', () => {
  it('renders one row per record', () => {
    const records = [
      { id: 'a', name: 'Alpha', status: 'active', amount: 1, notes: '' },
      { id: 'b', name: 'Beta', status: 'pending', amount: 2, notes: '' },
    ]
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
})
