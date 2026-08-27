import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featureRequestProgress } from './api.js'
import WatchBuild, { POLL_INTERVAL_MS } from './WatchBuild.jsx'

// DAN-55: the watch-it-build DAG view, tested against a mocked api.js exactly
// as the other component suites do — no fetch, no Firebase, everything asserted
// through accessible text and roles, never styles or class names. Polling is
// exercised with vi.useFakeTimers, advancing one POLL_INTERVAL_MS hop at a time.
vi.mock('./api.js', () => ({
  featureRequestProgress: vi.fn(),
}))

function ticket(overrides = {}) {
  return {
    issueId: 'iss-0',
    identifier: 'DAN-0',
    title: 'A ticket',
    state: 'BACKLOG',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-0',
    prUrl: null,
    blockedBy: [],
    ...overrides,
  }
}

// A DAG covering all five states: two roots (one DONE, one BOUNCED), two
// dependents in flight (IN_PROGRESS and IN_REVIEW, both blocked by the DONE
// root), and a leaf still queued behind both in-flight tickets.
const fiveStates = [
  ticket({
    issueId: 'iss-67',
    identifier: 'DAN-67',
    title: 'Backend contract',
    state: 'DONE',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-67',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/61',
  }),
  ticket({
    issueId: 'iss-71',
    identifier: 'DAN-71',
    title: 'Docs pass',
    state: 'BOUNCED',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-71',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/64',
  }),
  ticket({
    issueId: 'iss-68',
    identifier: 'DAN-68',
    title: 'API layer',
    state: 'IN_PROGRESS',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-68',
    blockedBy: ['DAN-67'],
  }),
  ticket({
    issueId: 'iss-69',
    identifier: 'DAN-69',
    title: 'Schema migration',
    state: 'IN_REVIEW',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-69',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/63',
    blockedBy: ['DAN-67'],
  }),
  ticket({
    issueId: 'iss-70',
    identifier: 'DAN-70',
    title: 'Frontend view',
    state: 'BACKLOG',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-70',
    blockedBy: ['DAN-68', 'DAN-69'],
  }),
]

// The same DAG one transition later: DAN-68 finished implementing.
const afterTransition = fiveStates.map((t) =>
  t.identifier === 'DAN-68' ? { ...t, state: 'DONE' } : t,
)

const everyoneDone = fiveStates.map((t) => ({ ...t, state: 'DONE' }))

// The <li> node a ticket renders as, found by its identifier link.
function nodeOf(identifier) {
  return screen.getByRole('link', { name: identifier }).closest('li')
}

beforeEach(() => {
  vi.mocked(featureRequestProgress).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DAN-55 DAG layout', () => {
  it('renders one node per ticket, laid out in stages so blockers precede dependents', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr1" />)

    await screen.findByRole('link', { name: 'DAN-67' })

    // One node per ticket.
    for (const t of fiveStates) {
      expect(nodeOf(t.identifier)).toHaveTextContent(t.title)
    }

    // Three topological layers, in depth order.
    const stages = screen.getAllByRole('heading', { level: 3 })
    expect(stages.map((h) => h.textContent)).toEqual([
      'Stage 1',
      'Stage 2',
      'Stage 3',
    ])

    // Blockers appear in the document before their dependents.
    const precedes = (a, b) =>
      // eslint-disable-next-line no-bitwise
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(precedes(nodeOf('DAN-67'), nodeOf('DAN-68'))).toBe(true)
    expect(precedes(nodeOf('DAN-67'), nodeOf('DAN-69'))).toBe(true)
    expect(precedes(nodeOf('DAN-68'), nodeOf('DAN-70'))).toBe(true)
    expect(precedes(nodeOf('DAN-69'), nodeOf('DAN-70'))).toBe(true)
  })

  it('names unresolved blockers on the dependent node, and drops blockers that are DONE', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr1" />)
    await screen.findByRole('link', { name: 'DAN-70' })

    // DAN-70 waits on both in-flight tickets.
    expect(nodeOf('DAN-70')).toHaveTextContent('blocked by DAN-68, DAN-69')
    // DAN-68's only blocker (DAN-67) is DONE, so it is unblocked — no text.
    expect(nodeOf('DAN-68')).not.toHaveTextContent('blocked by')
  })
})

describe('DAN-55 per-state visuals (accessible text)', () => {
  it('labels BACKLOG queued, DONE done, and BOUNCED sent back', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr1" />)
    await screen.findByRole('link', { name: 'DAN-67' })

    expect(within(nodeOf('DAN-70')).getByText('queued')).toBeInTheDocument()
    expect(within(nodeOf('DAN-67')).getByText(/done/)).toBeInTheDocument()
    expect(within(nodeOf('DAN-71')).getByText(/sent back/)).toBeInTheDocument()
  })

  it('renders the two in-flight states as role=status spinners with distinct labels', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr1" />)
    await screen.findByRole('link', { name: 'DAN-68' })

    const implementing = within(nodeOf('DAN-68')).getByRole('status')
    expect(implementing).toHaveTextContent('implementing')
    const review = within(nodeOf('DAN-69')).getByRole('status')
    expect(review).toHaveTextContent('under review')
  })
})

describe('DAN-55 links', () => {
  it('links every node to its Linear issue, and only prUrl-bearing nodes to a PR', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr1" />)
    await screen.findByRole('link', { name: 'DAN-67' })

    for (const t of fiveStates) {
      expect(screen.getByRole('link', { name: t.identifier })).toHaveAttribute(
        'href',
        t.issueUrl,
      )
    }
    expect(within(nodeOf('DAN-67')).getByRole('link', { name: 'PR' })).toHaveAttribute(
      'href',
      'https://github.com/dperez4787/linear-example/pull/61',
    )
    expect(within(nodeOf('DAN-69')).getByRole('link', { name: 'PR' })).toHaveAttribute(
      'href',
      'https://github.com/dperez4787/linear-example/pull/63',
    )
    // No prUrl yet — no PR link.
    expect(
      within(nodeOf('DAN-68')).queryByRole('link', { name: 'PR' }),
    ).not.toBeInTheDocument()
    expect(
      within(nodeOf('DAN-70')).queryByRole('link', { name: 'PR' }),
    ).not.toBeInTheDocument()
  })
})

describe('DAN-55 polling', () => {
  it('polls every POLL_INTERVAL_MS, re-renders a state transition, and stops when everything is DONE', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr1" />)

    // The mount-time poll.
    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestProgress).toHaveBeenCalledWith('fr1')
    expect(within(nodeOf('DAN-68')).getByRole('status')).toHaveTextContent(
      'implementing',
    )

    // One interval later the fixture has transitioned: DAN-68 is DONE, which
    // both re-labels its node and unblocks nothing-but-DAN-69 for DAN-70.
    vi.mocked(featureRequestProgress).mockResolvedValue(afterTransition)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(within(nodeOf('DAN-68')).getByText(/done/)).toBeInTheDocument()
    expect(nodeOf('DAN-70')).toHaveTextContent('blocked by DAN-69')
    expect(nodeOf('DAN-70')).not.toHaveTextContent('DAN-68,')

    // Next poll reports everything DONE: the view says so and polling stops.
    vi.mocked(featureRequestProgress).mockResolvedValue(everyoneDone)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(3)
    // Every spinner is gone, so the one remaining status is the header line.
    expect(screen.getByRole('status')).toHaveTextContent(/Build complete/)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(3)
  })

  it('stops polling on unmount', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    const { unmount } = render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
  })
})

describe('DAN-55 stale view', () => {
  it('keeps the last good DAG on a failed poll, shows the stale note, and clears it on recovery', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    expect(nodeOf('DAN-67')).toBeInTheDocument()
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument()

    // A poll fails: the DAG stays, a subtle stale note appears, polling keeps going.
    vi.mocked(featureRequestProgress).mockRejectedValue(new Error('gateway timeout'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    for (const t of fiveStates) {
      expect(nodeOf(t.identifier)).toHaveTextContent(t.title)
    }
    expect(screen.getByText(/live view stale — retrying/i)).toBeInTheDocument()

    // The next successful poll clears the note and updates the DAG.
    vi.mocked(featureRequestProgress).mockResolvedValue(afterTransition)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
    expect(within(nodeOf('DAN-68')).getByText(/done/)).toBeInTheDocument()
  })

  it('shows the loading state (not a blank crash) while the first poll has not succeeded', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockRejectedValue(new Error('boom'))
    render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    expect(screen.getByText('Loading build progress…')).toBeInTheDocument()
    expect(screen.getByText(/live view stale — retrying/i)).toBeInTheDocument()
  })
})
