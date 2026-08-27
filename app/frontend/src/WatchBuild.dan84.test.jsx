import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  featureRequestActivity,
  featureRequestCost,
  featureRequestProgress,
} from './api.js'
import WatchBuild, { POLL_INTERVAL_MS } from './WatchBuild.jsx'

// DAN-84: the activity feed's ride on the progress poll — one shared timer
// (the DAN-81 cost-read pattern), lockstep start/stop with the DAG lifecycle,
// and failure softness: an activity blip keeps the last feed and never stales
// the DAG. Mocked api.js, fake timers advanced one POLL_INTERVAL_MS hop at a
// time, everything asserted through accessible text — same idiom as
// WatchBuild.dan81.test.jsx.
vi.mock('./api.js', () => ({
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
  featureRequestActivity: vi.fn(),
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

const oneDone = [{ ...oneInFlight[0], state: 'DONE' }]

const cost = { calls: 7, tokensIn: 5120, tokensOut: 2048, costUsd: 0.1234 }

const firstFeed = [
  {
    ts: '2026-08-27T10:00:00.000Z',
    ticketIdentifier: 'DAN-90',
    kind: 'state',
    summary: 'DAN-90: Backlog → In Progress',
    body: null,
    url: null,
  },
]

// The same feed one poll later — append-only growth, ascending by ts.
const grownFeed = [
  ...firstFeed,
  {
    ts: '2026-08-27T10:04:30.000Z',
    ticketIdentifier: 'DAN-90',
    kind: 'comment',
    summary: 'tester commented on DAN-90',
    body: 'Ship it.',
    url: null,
  },
  {
    ts: '2026-08-27T10:05:00.000Z',
    ticketIdentifier: 'DAN-90',
    kind: 'pr',
    summary: 'draft PR opened for DAN-90',
    body: null,
    url: 'https://github.com/dperez4787/linear-example/pull/73',
  },
]

beforeEach(() => {
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(featureRequestActivity).mockReset()
  vi.mocked(featureRequestProgress).mockResolvedValue(oneInFlight)
  vi.mocked(featureRequestCost).mockResolvedValue(cost)
  vi.mocked(featureRequestActivity).mockResolvedValue(firstFeed)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DAN-84 activity rides the progress poll', () => {
  it('fetches activity on the same tick as progress — one shared timer, no second cadence', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)

    // The mount-time tick fetches all three.
    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledWith('fr1')
    within(screen.getByRole('log', { name: 'Activity events' })).getByText(
      'DAN-90: Backlog → In Progress',
    )

    // One interval later the feed has grown; the pane follows in lockstep.
    vi.mocked(featureRequestActivity).mockResolvedValue(grownFeed)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestActivity).toHaveBeenCalledTimes(2)
    const log = screen.getByRole('log', { name: 'Activity events' })
    within(log).getByText('tester commented on DAN-90')
    within(log).getByRole('link', { name: 'draft PR opened for DAN-90' })
    // Ascending order — the newest event is last in the log.
    const text = log.textContent
    expect(text.indexOf('DAN-90: Backlog → In Progress')).toBeLessThan(
      text.indexOf('tester commented on DAN-90'),
    )
    expect(text.indexOf('tester commented on DAN-90')).toBeLessThan(
      text.indexOf('draft PR opened for DAN-90'),
    )

    // Between ticks nothing fires: provably no second timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestActivity).toHaveBeenCalledTimes(2)
  })

  it('stops fetching activity when every ticket is DONE — the shared timer stops both', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue(oneDone)
    render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
    screen.getByText('Build complete — every ticket is done.')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
  })

  it('stops fetching activity on unmount', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
  })
})

describe('DAN-84 failure softness', () => {
  it('keeps the last feed when an activity read fails, without staling the DAG', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    within(screen.getByRole('log', { name: 'Activity events' })).getByText(
      'DAN-90: Backlog → In Progress',
    )

    vi.mocked(featureRequestActivity).mockRejectedValue(
      new Error('feature request not found'),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    // Last-good feed stays; staleness stays the progress poll's signal alone.
    within(screen.getByRole('log', { name: 'Activity events' })).getByText(
      'DAN-90: Backlog → In Progress',
    )
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
    // And the poll keeps going — the blip did not kill the timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestActivity).toHaveBeenCalledTimes(3)
  })

  it('keeps the feed when the progress poll fails — the DAG stales, the timeline does not blank', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    vi.mocked(featureRequestProgress).mockRejectedValue(new Error('boom'))
    vi.mocked(featureRequestActivity).mockResolvedValue(grownFeed)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    screen.getByText(/Live view stale — retrying\./)
    // The DAG kept its last good nodes, and the feed still updated.
    screen.getByRole('link', { name: 'DAN-90' })
    within(screen.getByRole('log', { name: 'Activity events' })).getByText(
      'tester commented on DAN-90',
    )
  })

  it('shows the loading line until the first successful activity read', async () => {
    vi.mocked(featureRequestActivity).mockRejectedValue(new Error('boom'))
    render(<WatchBuild promptId="fr1" />)

    await screen.findByRole('link', { name: 'DAN-90' })
    expect(screen.getByText('Loading activity…')).toBeInTheDocument()
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
  })
})
