import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import CostBreakdown, { formatUsd, grandTotalUsd } from './CostBreakdown.jsx'

// DAN-103: the cost-breakdown section — the grand total as arithmetic first
// (grandTotalUsd is the one place it is computed), then the rendered rows.
// Presentation-only component, so no api mock: WatchBuild owns the reads and
// this suite hands values straight in as props. Accessible-text assertions,
// never styles, same idiom as every suite since DAN-53.

const planning = { calls: 7, tokensIn: 5120, tokensOut: 2048, costUsd: 0.1234 }

const rows = [
  {
    ticketIdentifier: 'DAN-90',
    leg: 'develop',
    model: 'claude-opus-5',
    costUsd: 0.21,
    recordedAt: '2026-08-27T10:00:00.000Z',
  },
  {
    ticketIdentifier: 'DAN-90',
    leg: 'test',
    model: 'gpt-5.6-terra',
    costUsd: 0.09,
    recordedAt: '2026-08-27T10:05:00.000Z',
  },
  {
    ticketIdentifier: 'DAN-91',
    leg: 'develop',
    model: 'claude-opus-5',
    costUsd: 0.1,
    recordedAt: '2026-08-27T11:00:00.000Z',
  },
]

describe('DAN-103 grand total arithmetic', () => {
  it('is planning cost plus the sum of every build row', () => {
    expect(grandTotalUsd(planning, rows)).toBeCloseTo(0.5234, 10)
  })

  it('treats a null planning ledger as zero, not as no total', () => {
    expect(grandTotalUsd(null, rows)).toBeCloseTo(0.4, 10)
  })

  it('is the planning cost alone when there are no build rows — [] and null alike', () => {
    expect(grandTotalUsd(planning, [])).toBe(0.1234)
    expect(grandTotalUsd(planning, null)).toBe(0.1234)
  })

  it('is zero when there is nothing at all', () => {
    expect(grandTotalUsd(null, [])).toBe(0)
  })

  it('survives IEEE-754 drift: the raw sum may be inexact, the 4dp display never is', () => {
    // 0.1 + 0.2 is the canonical float trap: the sum is 0.30000000000000004.
    const total = grandTotalUsd(
      { costUsd: 0.1 },
      [{ costUsd: 0.2, ticketIdentifier: 'DAN-1', leg: 'develop', model: 'm' }],
    )
    expect(total).toBeCloseTo(0.3, 10)
    expect(formatUsd(total)).toBe('$0.3000')
  })
})

describe('DAN-103 4dp display formatting', () => {
  it('rounds to four decimal places', () => {
    expect(formatUsd(0.12346)).toBe('$0.1235')
  })

  it('pads to four decimal places — zero included', () => {
    expect(formatUsd(1.5)).toBe('$1.5000')
    expect(formatUsd(0)).toBe('$0.0000')
  })
})

describe('DAN-103 cost breakdown rendering', () => {
  it('renders the planning line, one row per build leg (badge, leg, model, 4dp dollars), and the grand total', () => {
    render(<CostBreakdown planningCost={planning} rows={rows} />)

    const section = screen.getByRole('region', { name: 'Cost breakdown' })

    // The planning line, deliberately labeled "Planning" — the header stat
    // owns the phrase "Planning cost".
    expect(within(section).getByText('Planning')).toBeInTheDocument()
    expect(within(section).getByText('$0.1234')).toBeInTheDocument()

    // One row per TicketCost entry, in server (recordedAt) order.
    const listed = within(section).getAllByRole('listitem')
    expect(listed).toHaveLength(5) // planning + 3 rows + grand total
    expect(listed[1]).toHaveTextContent('DAN-90')
    expect(listed[1]).toHaveTextContent('develop')
    expect(listed[1]).toHaveTextContent('claude-opus-5')
    expect(listed[1]).toHaveTextContent('$0.2100')
    expect(listed[2]).toHaveTextContent('DAN-90')
    expect(listed[2]).toHaveTextContent('test')
    expect(listed[2]).toHaveTextContent('gpt-5.6-terra')
    expect(listed[2]).toHaveTextContent('$0.0900')
    expect(listed[3]).toHaveTextContent('DAN-91')
    expect(listed[3]).toHaveTextContent('$0.1000')

    // The grand total row shows the one-place computation, rounded for
    // display: 0.1234 + 0.21 + 0.09 + 0.1 = 0.5234.
    const total = listed[4]
    expect(total).toHaveTextContent('Grand total')
    expect(total).toHaveTextContent('$0.5234')
  })

  it('renders nothing at all for empty or never-fetched rows — the legacy view keeps its planning-only layout', () => {
    const { container, rerender } = render(
      <CostBreakdown planningCost={planning} rows={[]} />,
    )
    expect(container).toBeEmptyDOMElement()

    rerender(<CostBreakdown planningCost={planning} rows={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('omits the planning line when no ledger has loaded, and totals the build rows alone', () => {
    render(<CostBreakdown planningCost={null} rows={rows} />)

    const section = screen.getByRole('region', { name: 'Cost breakdown' })
    expect(within(section).queryByText('Planning')).not.toBeInTheDocument()
    const listed = within(section).getAllByRole('listitem')
    expect(listed).toHaveLength(4) // 3 rows + grand total
    expect(listed[3]).toHaveTextContent('Grand total')
    expect(listed[3]).toHaveTextContent('$0.4000')
  })
})
