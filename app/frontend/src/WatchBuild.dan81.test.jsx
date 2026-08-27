import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featureRequestCost, featureRequestProgress } from './api.js'
import WatchBuild, { POLL_INTERVAL_MS } from './WatchBuild.jsx'

// DAN-81: the building-view header — the "View in Linear" link and the
// "Planning cost" stat. Mocked api.js, accessible-text assertions, fake timers
// advanced one POLL_INTERVAL_MS hop at a time, same idiom as WatchBuild.test.jsx.
vi.mock('./api.js', () => ({
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
}))

const LINEAR_URL = 'https://linear.app/daniel-perez/project/csv-export-1a2b3c'

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

const firstCost = { calls: 7, tokensIn: 5120, tokensOut: 2048, costUsd: 0.1234 }
const laterCost = { calls: 9, tokensIn: 7040, tokensOut: 3110, costUsd: 0.2018 }

beforeEach(() => {
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(featureRequestProgress).mockResolvedValue(oneInFlight)
  vi.mocked(featureRequestCost).mockResolvedValue(firstCost)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DAN-81 View in Linear link', () => {
  it('links the header to linearProjectUrl in a new tab with rel noopener', async () => {
    render(<WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} />)

    const link = await screen.findByRole('link', { name: 'View in Linear' })
    expect(link).toHaveAttribute('href', LINEAR_URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/\bnoopener\b/)
  })

  it('renders no link when linearProjectUrl is null', async () => {
    render(<WatchBuild promptId="fr1" linearProjectUrl={null} />)

    await screen.findByRole('link', { name: 'DAN-90' })
    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
  })
})

describe('DAN-81 planning cost stat', () => {
  it('renders the ledger as $X.XXXX plus the call count', async () => {
    render(<WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} />)

    const stat = await screen.findByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.1234')
    expect(stat).toHaveTextContent('7 calls')
  })

  it('renders the zero-cost ledger as $0.0000 and 0 calls, not as missing', async () => {
    vi.mocked(featureRequestCost).mockResolvedValue({
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    })
    render(<WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} />)

    const stat = await screen.findByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.0000')
    expect(stat).toHaveTextContent('0 calls')
  })

  it('refreshes on the progress poll tick — one shared timer, no second cadence', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} />)

    // The mount-time tick fetches both.
    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestCost).toHaveBeenCalledTimes(1)
    expect(featureRequestCost).toHaveBeenCalledWith('fr1')
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')

    // One interval later the ledger has grown; the stat follows, and the two
    // reads stay in lockstep — the cost fetch rides the progress timer.
    vi.mocked(featureRequestCost).mockResolvedValue(laterCost)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestCost).toHaveBeenCalledTimes(2)
    const stat = screen.getByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.2018')
    expect(stat).toHaveTextContent('9 calls')

    // Between ticks nothing fires: advancing less than a full interval adds no
    // calls, so there is provably no second timer running at its own cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestCost).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good figure when a cost read fails, without staling the DAG', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} />)

    await act(async () => {})
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')

    vi.mocked(featureRequestCost).mockRejectedValue(new Error('gateway timeout'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    // The stat keeps its last value; staleness stays the progress poll's signal.
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
  })

  it('shows no stat before the first successful cost read', async () => {
    vi.mocked(featureRequestCost).mockResolvedValue(null)
    render(<WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} />)

    await screen.findByRole('link', { name: 'DAN-90' })
    expect(screen.queryByText(/Planning cost/)).not.toBeInTheDocument()
  })
})
