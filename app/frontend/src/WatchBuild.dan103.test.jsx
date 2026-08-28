import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  featureRequestActivity,
  featureRequestCost,
  featureRequestProgress,
  ticketCosts,
} from './api.js'
import WatchBuild, { POLL_INTERVAL_MS } from './WatchBuild.jsx'

// DAN-103: the ticketCosts read rides WatchBuild's one poll tick exactly like
// the DAN-81 cost read and the DAN-84 activity read — fetched alongside the
// progress poll, awaited before the next hop, one timer total — and its
// failures are equally soft. Mocked api.js, accessible-text assertions, fake
// timers advanced one POLL_INTERVAL_MS hop at a time, same idiom as
// WatchBuild.dan81.test.jsx / WatchBuild.dan84.test.jsx.
vi.mock('./api.js', () => ({
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
  featureRequestActivity: vi.fn(),
  ticketCosts: vi.fn(),
}))

const oneInFlight = [
  {
    issueId: 'iss-1',
    identifier: 'DAN-90',
    title: 'Backend contract',
    state: 'IN_PROGRESS',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-90',
    prUrl: null,
    blockedBy: [],
  },
]

const allDone = [{ ...oneInFlight[0], state: 'DONE' }]

const planning = { calls: 7, tokensIn: 5120, tokensOut: 2048, costUsd: 0.1234 }

const firstRows = [
  {
    ticketIdentifier: 'DAN-90',
    leg: 'develop',
    model: 'claude-opus-5',
    costUsd: 0.21,
    recordedAt: '2026-08-27T10:00:00.000Z',
  },
]

const laterRows = [
  ...firstRows,
  {
    ticketIdentifier: 'DAN-90',
    leg: 'test',
    model: 'gpt-5.6-terra',
    costUsd: 0.09,
    recordedAt: '2026-08-27T10:05:00.000Z',
  },
]

function breakdown() {
  return screen.getByRole('region', { name: 'Cost breakdown' })
}

beforeEach(() => {
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(featureRequestActivity).mockReset()
  vi.mocked(ticketCosts).mockReset()
  vi.mocked(featureRequestProgress).mockResolvedValue(oneInFlight)
  vi.mocked(featureRequestCost).mockResolvedValue(planning)
  vi.mocked(featureRequestActivity).mockResolvedValue([])
  vi.mocked(ticketCosts).mockResolvedValue(firstRows)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DAN-103 cost breakdown in the build view', () => {
  it('renders planning line, per-ticket rows, and the grand total from the two reads', async () => {
    render(<WatchBuild promptId="fr1" />)

    await screen.findByRole('region', { name: 'Cost breakdown' })
    const section = breakdown()
    expect(within(section).getByText('Planning')).toBeInTheDocument()
    expect(within(section).getByText('$0.1234')).toBeInTheDocument()
    expect(within(section).getByText('develop')).toBeInTheDocument()
    expect(within(section).getByText('claude-opus-5')).toBeInTheDocument()
    expect(within(section).getByText('$0.2100')).toBeInTheDocument()
    // Grand total = planning 0.1234 + develop 0.21, displayed to 4dp.
    const rows = within(section).getAllByRole('listitem')
    const total = rows[rows.length - 1]
    expect(total).toHaveTextContent('Grand total')
    expect(total).toHaveTextContent('$0.3334')

    // The DAN-81 header stat is untouched — planning still has its home.
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')
  })

  it('rides the progress poll tick — one shared timer, no second cadence', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)

    // The mount-time tick fetches all four.
    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestCost).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
    expect(ticketCosts).toHaveBeenCalledTimes(1)
    expect(ticketCosts).toHaveBeenCalledWith('fr1')

    // One interval later a second leg has been recorded; the rows and the
    // grand total follow, and all four reads stay in lockstep.
    vi.mocked(ticketCosts).mockResolvedValue(laterRows)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestCost).toHaveBeenCalledTimes(2)
    expect(featureRequestActivity).toHaveBeenCalledTimes(2)
    expect(ticketCosts).toHaveBeenCalledTimes(2)
    const section = breakdown()
    expect(within(section).getByText('test')).toBeInTheDocument()
    expect(within(section).getByText('gpt-5.6-terra')).toBeInTheDocument()
    // 0.1234 + 0.21 + 0.09 = 0.4234.
    expect(within(section).getByText('$0.4234')).toBeInTheDocument()

    // Between ticks nothing fires: advancing less than a full interval adds
    // no calls, so there is provably no second timer at its own cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(ticketCosts).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good rows when a ticketCosts read fails, without staling the DAG', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    expect(within(breakdown()).getByText('$0.2100')).toBeInTheDocument()

    vi.mocked(ticketCosts).mockRejectedValue(new Error('gateway timeout'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    // The breakdown keeps its last value; staleness stays the progress
    // poll's signal alone.
    expect(within(breakdown()).getByText('$0.2100')).toBeInTheDocument()
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
  })

  it('renders planning-only — no breakdown section — for an empty or legacy ticketCosts result', async () => {
    vi.mocked(ticketCosts).mockResolvedValue([])
    render(<WatchBuild promptId="fr1" />)

    await screen.findByRole('link', { name: 'DAN-90' })
    await act(async () => {})
    expect(
      screen.queryByRole('region', { name: 'Cost breakdown' }),
    ).not.toBeInTheDocument()
    // The DAN-81 stat is exactly as before — the empty case is today's layout.
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')
  })

  it('stops reading when every ticket is DONE — the rider stops with the poll', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue(allDone)
    render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    expect(ticketCosts).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(ticketCosts).toHaveBeenCalledTimes(1)
    // The final breakdown stays on screen for the finished build.
    expect(within(breakdown()).getByText('$0.2100')).toBeInTheDocument()
  })
})
