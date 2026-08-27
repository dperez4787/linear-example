import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featureRequestProgress } from './api.js'
import WatchBuild, { POLL_INTERVAL_MS } from './WatchBuild.jsx'

// DAN-55 tester suite — independent verification of the watch-it-build DAG
// view against the ticket's acceptance criteria. api.js is mocked exactly as
// the project's component suites do (which itself proves the view reaches the
// backend only through the api.js export, never fetch). Everything is asserted
// through accessible text, roles, and document order — never styles.
//
// One deliberate difference from the developer's fixtures: the diamond fixture
// references blockers by *issueId*, because the live DAN-52 backend emits
// blockedBy as Linear issue ids (rel.issue.id), not identifiers. The view must
// resolve those to identifiers for the "blocked by" text.
vi.mock('./api.js', () => ({
  featureRequestProgress: vi.fn(),
}))

function ticket(overrides) {
  return {
    prUrl: null,
    blockedBy: [],
    ...overrides,
  }
}

// Diamond: A blocks B and C; B and C block D. blockedBy carries issueIds,
// mirroring the live backend.
function diamond() {
  return [
    ticket({
      issueId: 'iss-a',
      identifier: 'DAN-80',
      title: 'Alpha root',
      state: 'IN_PROGRESS',
      issueUrl: 'https://linear.app/daniel-perez/issue/DAN-80',
    }),
    ticket({
      issueId: 'iss-b',
      identifier: 'DAN-81',
      title: 'Beta left',
      state: 'BACKLOG',
      issueUrl: 'https://linear.app/daniel-perez/issue/DAN-81',
      blockedBy: ['iss-a'],
    }),
    ticket({
      issueId: 'iss-c',
      identifier: 'DAN-82',
      title: 'Gamma right',
      state: 'BACKLOG',
      issueUrl: 'https://linear.app/daniel-perez/issue/DAN-82',
      blockedBy: ['iss-a'],
    }),
    ticket({
      issueId: 'iss-d',
      identifier: 'DAN-83',
      title: 'Delta join',
      state: 'BACKLOG',
      issueUrl: 'https://linear.app/daniel-perez/issue/DAN-83',
      blockedBy: ['iss-b', 'iss-c'],
    }),
  ]
}

// All five states in one list, with links and one PR.
const fiveStates = [
  ticket({
    issueId: 'iss-1',
    identifier: 'DAN-90',
    title: 'Queued one',
    state: 'BACKLOG',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-90',
  }),
  ticket({
    issueId: 'iss-2',
    identifier: 'DAN-91',
    title: 'Implementing one',
    state: 'IN_PROGRESS',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-91',
  }),
  ticket({
    issueId: 'iss-3',
    identifier: 'DAN-92',
    title: 'Reviewing one',
    state: 'IN_REVIEW',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-92',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/92',
  }),
  ticket({
    issueId: 'iss-4',
    identifier: 'DAN-93',
    title: 'Done one',
    state: 'DONE',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-93',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/93',
  }),
  ticket({
    issueId: 'iss-5',
    identifier: 'DAN-94',
    title: 'Bounced one',
    state: 'BOUNCED',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-94',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/94',
  }),
]

function nodeOf(identifier) {
  return screen.getByRole('link', { name: identifier }).closest('li')
}

function precedes(a, b) {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

beforeEach(() => {
  vi.mocked(featureRequestProgress).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DAN-55 tester · criterion 1: DAG layout (diamond, issueId edges)', () => {
  it('renders one node per ticket with blockers before dependents in document order', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(diamond())
    render(<WatchBuild promptId="fr-diamond" />)
    await screen.findByRole('link', { name: 'DAN-80' })

    for (const t of diamond()) {
      expect(nodeOf(t.identifier)).toHaveTextContent(t.title)
    }
    // Exactly four ticket nodes — one per ticket, no extras.
    const dag = screen.getByRole('list', { name: 'Build stages' })
    expect(within(dag).getAllByRole('link', { name: /DAN-8\d/ })).toHaveLength(4)

    // A before B and C; B and C before D.
    expect(precedes(nodeOf('DAN-80'), nodeOf('DAN-81'))).toBe(true)
    expect(precedes(nodeOf('DAN-80'), nodeOf('DAN-82'))).toBe(true)
    expect(precedes(nodeOf('DAN-81'), nodeOf('DAN-83'))).toBe(true)
    expect(precedes(nodeOf('DAN-82'), nodeOf('DAN-83'))).toBe(true)
  })

  it('names the right blockers by identifier even though edges arrive as issueIds', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(diamond())
    render(<WatchBuild promptId="fr-diamond" />)
    await screen.findByRole('link', { name: 'DAN-83' })

    expect(nodeOf('DAN-81')).toHaveTextContent('blocked by DAN-80')
    expect(nodeOf('DAN-82')).toHaveTextContent('blocked by DAN-80')
    expect(nodeOf('DAN-83')).toHaveTextContent('blocked by DAN-81, DAN-82')
    // The root is blocked by nothing.
    expect(nodeOf('DAN-80')).not.toHaveTextContent('blocked by')
  })

  it('drops a blocker from the dependents\' blocked-by text once it is DONE', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue(diamond())
    render(<WatchBuild promptId="fr-diamond" />)
    await act(async () => {})
    expect(nodeOf('DAN-81')).toHaveTextContent('blocked by DAN-80')

    // A finishes: B and C are no longer blocked; D still waits on B and C.
    const next = diamond().map((t) =>
      t.identifier === 'DAN-80' ? { ...t, state: 'DONE' } : t,
    )
    vi.mocked(featureRequestProgress).mockResolvedValue(next)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(nodeOf('DAN-81')).not.toHaveTextContent('blocked by')
    expect(nodeOf('DAN-82')).not.toHaveTextContent('blocked by')
    expect(nodeOf('DAN-83')).toHaveTextContent('blocked by DAN-81, DAN-82')
  })
})

describe('DAN-55 tester · criterion 2: per-state visuals via accessible text', () => {
  it('labels all five states distinctly, spinners as role=status with different text', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr-states" />)
    await screen.findByRole('link', { name: 'DAN-90' })

    // BACKLOG: dimming is backed by a visible textual label.
    expect(within(nodeOf('DAN-90')).getByText('queued')).toBeInTheDocument()
    // IN_PROGRESS and IN_REVIEW: both live spinners (role=status), with
    // different accessible text so they are distinguishable without styles.
    const implementing = within(nodeOf('DAN-91')).getByRole('status')
    const review = within(nodeOf('DAN-92')).getByRole('status')
    expect(implementing).toHaveTextContent('implementing')
    expect(review).toHaveTextContent('under review')
    expect(implementing.textContent).not.toBe(review.textContent)
    // DONE: a check, textually "done".
    expect(within(nodeOf('DAN-93')).getByText(/done/)).toBeInTheDocument()
    // BOUNCED: a warning, textually "sent back".
    expect(within(nodeOf('DAN-94')).getByText(/sent back/)).toBeInTheDocument()
    // The non-spinner states carry no role=status.
    expect(within(nodeOf('DAN-90')).queryByRole('status')).not.toBeInTheDocument()
    expect(within(nodeOf('DAN-93')).queryByRole('status')).not.toBeInTheDocument()
    expect(within(nodeOf('DAN-94')).queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('DAN-55 tester · criterion 3: links', () => {
  it('links each node to its Linear issue, and only prUrl nodes to their PR', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue(fiveStates)
    render(<WatchBuild promptId="fr-states" />)
    await screen.findByRole('link', { name: 'DAN-90' })

    for (const t of fiveStates) {
      expect(screen.getByRole('link', { name: t.identifier })).toHaveAttribute(
        'href',
        t.issueUrl,
      )
      const pr = within(nodeOf(t.identifier)).queryByRole('link', { name: 'PR' })
      if (t.prUrl) {
        expect(pr).toHaveAttribute('href', t.prUrl)
      } else {
        expect(pr).not.toBeInTheDocument()
      }
    }
  })
})

describe('DAN-55 tester · criterion 4: polling', () => {
  it('polls every ~5s, re-renders each transition, and stops for good on all-DONE', async () => {
    expect(POLL_INTERVAL_MS).toBe(5000)
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error')

    const p0 = diamond()
    vi.mocked(featureRequestProgress).mockResolvedValue(p0)
    render(<WatchBuild promptId="fr-poll" />)
    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestProgress).toHaveBeenCalledWith('fr-poll')
    expect(within(nodeOf('DAN-80')).getByRole('status')).toHaveTextContent(
      'implementing',
    )

    // Interval 1: A done, B starts.
    const p1 = p0.map((t) =>
      t.identifier === 'DAN-80'
        ? { ...t, state: 'DONE' }
        : t.identifier === 'DAN-81'
          ? { ...t, state: 'IN_PROGRESS' }
          : t,
    )
    vi.mocked(featureRequestProgress).mockResolvedValue(p1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(within(nodeOf('DAN-80')).getByText(/done/)).toBeInTheDocument()
    expect(within(nodeOf('DAN-81')).getByRole('status')).toHaveTextContent(
      'implementing',
    )

    // Interval 2: B and C in review.
    const p2 = p1.map((t) =>
      t.identifier === 'DAN-81' || t.identifier === 'DAN-82'
        ? { ...t, state: 'IN_REVIEW' }
        : t,
    )
    vi.mocked(featureRequestProgress).mockResolvedValue(p2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(3)
    expect(within(nodeOf('DAN-81')).getByRole('status')).toHaveTextContent(
      'under review',
    )

    // Interval 3: everything DONE — the view says so, then polling stops.
    const p3 = p2.map((t) => ({ ...t, state: 'DONE' }))
    vi.mocked(featureRequestProgress).mockResolvedValue(p3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(4)
    expect(screen.getByRole('status')).toHaveTextContent(/Build complete/)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(4)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('unmounting mid-poll stops polling with no act() warnings and no post-unmount state updates', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error')

    // First poll resolves; the second is left in flight across the unmount.
    let resolveInFlight
    vi.mocked(featureRequestProgress)
      .mockResolvedValueOnce(diamond())
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveInFlight = resolve)),
      )

    const { unmount } = render(<WatchBuild promptId="fr-unmount" />)
    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)

    // Fire the second poll, then unmount while it is still awaiting.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    unmount()

    // The in-flight response lands after unmount: no state update, no reschedule.
    await act(async () => {
      resolveInFlight(diamond())
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('DAN-55 tester · criterion 5: stale view and recovery', () => {
  it('keeps the last good DAG with a stale note on failure, clears it on recovery', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue(diamond())
    render(<WatchBuild promptId="fr-stale" />)
    await act(async () => {})
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument()

    // Poll fails: every node stays, a stale note appears, nothing blanks.
    vi.mocked(featureRequestProgress).mockRejectedValue(new Error('502'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    for (const t of diamond()) {
      expect(nodeOf(t.identifier)).toHaveTextContent(t.title)
    }
    expect(screen.getByText(/stale/i)).toBeInTheDocument()

    // Recovery: stale note gone, fresh data rendered.
    const recovered = diamond().map((t) =>
      t.identifier === 'DAN-80' ? { ...t, state: 'DONE' } : t,
    )
    vi.mocked(featureRequestProgress).mockResolvedValue(recovered)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument()
    expect(within(nodeOf('DAN-80')).getByText(/done/)).toBeInTheDocument()
  })
})

describe('DAN-55 tester · cycle guard', () => {
  it('a blockedBy cycle renders both nodes with their blocked-by text instead of hanging or crashing', async () => {
    const cycle = [
      ticket({
        issueId: 'iss-x',
        identifier: 'DAN-96',
        title: 'Cycle one',
        state: 'IN_PROGRESS',
        issueUrl: 'https://linear.app/daniel-perez/issue/DAN-96',
        blockedBy: ['iss-y'],
      }),
      ticket({
        issueId: 'iss-y',
        identifier: 'DAN-97',
        title: 'Cycle two',
        state: 'BACKLOG',
        issueUrl: 'https://linear.app/daniel-perez/issue/DAN-97',
        blockedBy: ['iss-x'],
      }),
    ]
    vi.mocked(featureRequestProgress).mockResolvedValue(cycle)
    render(<WatchBuild promptId="fr-cycle" />)

    // The test completing at all proves no infinite recursion; both nodes
    // render with mutual blocked-by text.
    await screen.findByRole('link', { name: 'DAN-96' })
    expect(nodeOf('DAN-96')).toHaveTextContent('Cycle one')
    expect(nodeOf('DAN-97')).toHaveTextContent('Cycle two')
    expect(nodeOf('DAN-96')).toHaveTextContent('blocked by DAN-97')
    expect(nodeOf('DAN-97')).toHaveTextContent('blocked by DAN-96')
    expect(
      screen.getByRole('region', { name: 'Build progress' }),
    ).toBeInTheDocument()
  })
})
