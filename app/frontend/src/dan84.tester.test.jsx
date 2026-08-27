import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ActivityTimeline from './ActivityTimeline.jsx'
import {
  featureRequestActivity,
  featureRequestCost,
  featureRequestProgress,
} from './api.js'
import WatchBuild, { POLL_INTERVAL_MS } from './WatchBuild.jsx'

// DAN-84 tester suite — independent verification against the ticket's
// acceptance criteria, written from the criteria rather than the developer's
// tests. Rendering criteria go straight at ActivityTimeline (events arrive as
// a prop); lifecycle and failure-softness criteria go through WatchBuild with
// api.js mocked module-wide and fake timers advanced one POLL_INTERVAL_MS hop
// at a time, so "one shared timer" is proven, not assumed. Every assertion is
// accessible text, roles, and attributes — never styles.
vi.mock('./api.js', () => ({
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
  featureRequestActivity: vi.fn(),
}))

// --- Fixtures: one event of every wire kind (DAN-83 contract) -----------------

const evState = {
  ts: '2026-08-27T14:00:00.000Z',
  ticketIdentifier: 'DAN-77',
  kind: 'state',
  summary: 'DAN-77: Backlog → In Progress',
  body: null,
  url: null,
}

const evComment = {
  ts: '2026-08-27T14:03:00.000Z',
  ticketIdentifier: 'DAN-77',
  kind: 'comment',
  summary: 'tester commented on DAN-77',
  body: 'Verified **end-to-end**:\n\n- render\n- polling',
  url: 'https://linear.app/tester-org/issue/DAN-77#comment-9',
}

const evPrOpened = {
  ts: '2026-08-27T14:06:00.000Z',
  ticketIdentifier: 'DAN-77',
  kind: 'pr',
  summary: 'draft PR opened for DAN-77',
  body: null,
  url: 'https://github.com/tester-org/repo/pull/9',
}

const evPrMerged = {
  ts: '2026-08-27T14:09:00.000Z',
  ticketIdentifier: 'DAN-78',
  kind: 'pr',
  summary: 'PR merged for DAN-78',
  body: null,
  url: 'https://github.com/tester-org/repo/pull/10',
}

const allKinds = [evState, evComment, evPrOpened, evPrMerged]

const inFlightTicket = {
  issueId: 'iss-t84',
  identifier: 'DAN-77',
  title: 'Tester ticket',
  state: 'IN_PROGRESS',
  issueUrl: 'https://linear.app/tester-org/issue/DAN-77',
  prUrl: null,
  blockedBy: [],
}

beforeEach(() => {
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(featureRequestActivity).mockReset()
  vi.mocked(featureRequestProgress).mockResolvedValue([inFlightTicket])
  vi.mocked(featureRequestCost).mockResolvedValue({
    calls: 3,
    tokensIn: 2100,
    tokensOut: 900,
    costUsd: 0.05,
  })
  vi.mocked(featureRequestActivity).mockResolvedValue(allKinds)
})

afterEach(() => {
  vi.useRealTimers()
})

// jsdom computes no layout; the auto-scroll code reads scrollHeight and
// clientHeight, so both are stubbed with live getters over a mutable geometry
// object — growing `scrollHeight` between rerenders simulates appended rows.
function stubGeometry(el, geometry) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  })
}

// --- Criterion: every kind renders with accessible time/badge/summary ---------

describe('DAN-84 tester · event rendering', () => {
  it('renders comment, state, and pr events with a <time> stamp, ticket badge, and verbatim summary, ascending', () => {
    render(<ActivityTimeline events={allKinds} />)

    const log = screen.getByRole('log')
    // Verbatim server text, including the "PR merged for…" variant — never
    // parsed or rephrased.
    const summaries = [
      'DAN-77: Backlog → In Progress',
      'tester commented on DAN-77',
      'draft PR opened for DAN-77',
      'PR merged for DAN-78',
    ]
    for (const s of summaries) {
      expect(within(log).getByText(s)).toBeInTheDocument()
    }
    // Ascending by ts: server order preserved, newest last.
    const text = log.textContent
    let previous = -1
    for (const s of summaries) {
      const at = text.indexOf(s)
      expect(at).toBeGreaterThan(previous)
      previous = at
    }
    // Each entry carries a machine-readable <time> with the ISO instant.
    const items = within(log).getAllByRole('listitem')
    expect(items).toHaveLength(4)
    allKinds.forEach((event, i) => {
      const time = items[i].querySelector('time')
      expect(time).not.toBeNull()
      expect(time).toHaveAttribute('dateTime', event.ts)
      // The ticket badge is visible text inside the same entry.
      expect(items[i].textContent).toContain(event.ticketIdentifier)
    })
    // Both ticket identifiers appear as text.
    expect(within(log).getAllByText('DAN-77').length).toBeGreaterThan(0)
    expect(within(log).getAllByText('DAN-78').length).toBeGreaterThan(0)
  })

  it('renders a url-bearing summary as a new-tab link and a url-less summary as plain text', () => {
    render(<ActivityTimeline events={allKinds} />)

    const merged = screen.getByRole('link', { name: 'PR merged for DAN-78' })
    expect(merged).toHaveAttribute('href', evPrMerged.url)
    expect(merged).toHaveAttribute('target', '_blank')
    expect((merged.getAttribute('rel') ?? '').split(/\s+/)).toContain('noopener')

    const opened = screen.getByRole('link', { name: 'draft PR opened for DAN-77' })
    expect(opened).toHaveAttribute('href', evPrOpened.url)

    // The state event has url: null — text, not an anchor.
    expect(
      screen.queryByRole('link', { name: 'DAN-77: Backlog → In Progress' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('DAN-77: Backlog → In Progress')).toBeInTheDocument()
  })

  it('renders an empty session as an accessible empty pane without crashing', () => {
    render(<ActivityTimeline events={[]} />)

    const pane = screen.getByRole('region', { name: 'Live activity' })
    expect(within(pane).getByText('No activity yet.')).toBeInTheDocument()
    // No log yet, no stray buttons or links.
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
    expect(within(pane).queryAllByRole('button')).toHaveLength(0)
  })
})

// --- Criterion: expand/collapse on comment bodies -----------------------------

describe('DAN-84 tester · comment expand/collapse', () => {
  it('hides the body initially behind a real button whose aria-expanded flips false→true, with the body as rendered markdown', () => {
    render(<ActivityTimeline events={allKinds} />)

    // Body content is not on screen before expanding — neither rendered nor raw.
    expect(screen.queryByText('end-to-end')).not.toBeInTheDocument()
    expect(screen.queryByText(/\*\*end-to-end\*\*/)).not.toBeInTheDocument()

    // Exactly one toggle: only the comment event has a body.
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-expanded'))
    expect(buttons).toHaveLength(1)
    const toggle = buttons[0]
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle.tagName).toBe('BUTTON')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // **end-to-end** became a real <strong>, not literal asterisks.
    const strong = screen.getByText('end-to-end')
    expect(strong.tagName).toBe('STRONG')
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument()
    // The dashed lines became real list items.
    const bodyItems = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(bodyItems).toContain('render')
    expect(bodyItems).toContain('polling')

    // Collapse hides it again and the button reports collapsed.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('end-to-end')).not.toBeInTheDocument()
  })
})

// --- Criterion: activity rides the DAG's single poll --------------------------

describe('DAN-84 tester · polling lifecycle', () => {
  it('grows the feed across poll ticks in lockstep with progress — appended events, one shared timer', async () => {
    vi.useFakeTimers()
    const firstFeed = [evState, evComment]
    vi.mocked(featureRequestActivity).mockResolvedValue(firstFeed)
    render(<WatchBuild promptId="fr-t84" />)

    // Mount tick: exactly one activity read, keyed by the promptId.
    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledWith('fr-t84')
    let log = screen.getByRole('log')
    expect(within(log).getAllByRole('listitem')).toHaveLength(2)

    // Anything short of a full interval fires nothing — a second timer at its
    // own cadence would be caught in this window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)

    // The hop completes: N -> N+2, appended after the originals, in order.
    vi.mocked(featureRequestActivity).mockResolvedValue(allKinds)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestActivity).toHaveBeenCalledTimes(2)
    log = screen.getByRole('log')
    const rows = within(log).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toContain('DAN-77: Backlog → In Progress')
    expect(rows[2].textContent).toContain('draft PR opened for DAN-77')
    expect(rows[3].textContent).toContain('PR merged for DAN-78')

    // Next hop: still 1:1 with the progress poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(3)
    expect(featureRequestActivity).toHaveBeenCalledTimes(3)
  })

  it('stops the activity read when every ticket is DONE — all-DONE stops both', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue([
      { ...inFlightTicket, state: 'DONE' },
    ])
    render(<WatchBuild promptId="fr-t84" />)

    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
    screen.getByText('Build complete — every ticket is done.')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
    // The final feed stays on screen.
    expect(within(screen.getByRole('log')).getAllByRole('listitem')).toHaveLength(4)
  })

  it('stops the activity read on unmount, with no act/state warnings', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error')
    const { unmount } = render(<WatchBuild promptId="fr-t84" />)

    await act(async () => {})
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestActivity).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

// --- Criterion: failure softness, mirrored from DAN-81 ------------------------

describe('DAN-84 tester · failure softness', () => {
  it('keeps the last feed on an activity failure, never marks the DAG stale, and recovers on a later tick', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestActivity).mockResolvedValue([evState, evComment])
    render(<WatchBuild promptId="fr-t84" />)
    await act(async () => {})
    expect(within(screen.getByRole('log')).getAllByRole('listitem')).toHaveLength(2)

    vi.mocked(featureRequestActivity).mockRejectedValue(new Error('503'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    // Last-good feed intact; the stale note (the progress poll's signal) absent.
    const log = screen.getByRole('log')
    expect(within(log).getAllByRole('listitem')).toHaveLength(2)
    expect(within(log).getByText('tester commented on DAN-77')).toBeInTheDocument()
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument()
    // The DAG itself is untouched.
    expect(screen.getByRole('link', { name: 'DAN-77' })).toBeInTheDocument()

    // The blip did not kill the shared timer: a later tick recovers the feed.
    vi.mocked(featureRequestActivity).mockResolvedValue(allKinds)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestActivity).toHaveBeenCalledTimes(3)
    expect(within(screen.getByRole('log')).getAllByRole('listitem')).toHaveLength(4)
  })

  it('stales the DAG on a progress failure while the feed keeps its events (and still updates)', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestActivity).mockResolvedValue([evState])
    render(<WatchBuild promptId="fr-t84" />)
    await act(async () => {})
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument()

    vi.mocked(featureRequestProgress).mockRejectedValue(new Error('502'))
    vi.mocked(featureRequestActivity).mockResolvedValue([evState, evComment, evPrMerged])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    // The stale note appears, the last good DAG stays rendered, and the feed
    // was neither blanked nor frozen.
    expect(screen.getByText(/Live view stale — retrying\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'DAN-77' })).toBeInTheDocument()
    const log = screen.getByRole('log')
    expect(within(log).getAllByRole('listitem')).toHaveLength(3)
    expect(within(log).getByText('PR merged for DAN-78')).toBeInTheDocument()
  })

  it('shows an accessible empty pane when the server reports zero events', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestActivity).mockResolvedValue([])
    render(<WatchBuild promptId="fr-t84" />)
    await act(async () => {})

    const pane = screen.getByRole('region', { name: 'Live activity' })
    expect(within(pane).getByText('No activity yet.')).toBeInTheDocument()
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
    // The DAG rendered alongside it — no crash, no blank view.
    expect(screen.getByRole('link', { name: 'DAN-77' })).toBeInTheDocument()
  })
})

// --- Criterion: auto-scroll only when already at the bottom -------------------

describe('DAN-84 tester · auto-scroll', () => {
  it('scrolls a pinned-at-bottom feed to the new bottom when events append', () => {
    const { rerender } = render(<ActivityTimeline events={[evState, evComment]} />)
    const log = screen.getByRole('log')
    const geometry = { scrollHeight: 400, clientHeight: 100 }
    stubGeometry(log, geometry)

    // The reader sits exactly at the bottom: 400 - 300 - 100 = 0.
    log.scrollTop = 300
    fireEvent.scroll(log)

    // Two more events arrive and the content grows.
    geometry.scrollHeight = 520
    rerender(<ActivityTimeline events={allKinds} />)
    expect(log.scrollTop).toBe(520)
  })

  it('leaves scrollTop untouched when the reader has scrolled up into history', () => {
    const { rerender } = render(<ActivityTimeline events={[evState, evComment]} />)
    const log = screen.getByRole('log')
    const geometry = { scrollHeight: 400, clientHeight: 100 }
    stubGeometry(log, geometry)

    // Scrolled well above the bottom: 400 - 120 - 100 = 180 > epsilon.
    log.scrollTop = 120
    fireEvent.scroll(log)

    geometry.scrollHeight = 520
    rerender(<ActivityTimeline events={allKinds} />)
    expect(log.scrollTop).toBe(120)
  })
})
