import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import ActivityTimeline from './ActivityTimeline.jsx'

// DAN-84: the presentational half of the live activity pane — every event kind
// rendered through accessible text, expand/collapse on comment bodies, and the
// only-when-at-bottom auto-scroll. WatchBuild owns the fetch; here events
// arrive as a prop, so there is nothing to mock but jsdom's scroll metrics
// (jsdom does no layout — scrollHeight/clientHeight are defined per test).

const comment = {
  ts: '2026-08-27T10:05:00.000Z',
  ticketIdentifier: 'DAN-101',
  kind: 'comment',
  summary: 'tester commented on DAN-101',
  body: 'Suites are **green**.\n\n- api\n- component',
  url: 'https://linear.app/daniel-perez/issue/DAN-101#comment-1',
}

const stateChange = {
  ts: '2026-08-27T10:00:00.000Z',
  ticketIdentifier: 'DAN-101',
  kind: 'state',
  summary: 'DAN-101: Backlog → In Progress',
  body: null,
  url: null,
}

const prOpened = {
  ts: '2026-08-27T10:10:00.000Z',
  ticketIdentifier: 'DAN-101',
  kind: 'pr',
  summary: 'draft PR opened for DAN-101',
  body: null,
  url: 'https://github.com/dperez4787/linear-example/pull/73',
}

const prMerged = {
  ts: '2026-08-27T10:20:00.000Z',
  ticketIdentifier: 'DAN-102',
  kind: 'pr',
  summary: 'PR merged for DAN-102',
  body: null,
  url: 'https://github.com/dperez4787/linear-example/pull/74',
}

const allKinds = [stateChange, comment, prOpened, prMerged]

// jsdom computes no layout, so the scroll geometry the component reads is
// defined explicitly. scrollTop stays a real writable property, which is what
// the auto-scroll assertions read back.
function mockScrollMetrics(el, { scrollHeight, clientHeight }) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  })
}

describe('DAN-84 ActivityTimeline rendering', () => {
  it('renders every event kind with time, ticket badge, and summary as accessible text', () => {
    render(<ActivityTimeline events={allKinds} />)

    const log = screen.getByRole('log', { name: 'Activity events' })
    // Ascending by ts — newest at the bottom, in server order.
    const summaries = [
      'DAN-101: Backlog → In Progress',
      'tester commented on DAN-101',
      'draft PR opened for DAN-101',
      'PR merged for DAN-102',
    ]
    const text = log.textContent
    let last = -1
    for (const s of summaries) {
      const at = text.indexOf(s)
      expect(at).toBeGreaterThan(last)
      last = at
    }
    // Ticket badges are visible text, and the machine-readable instant stays
    // on each <time> element.
    expect(within(log).getAllByText('DAN-101')).not.toHaveLength(0)
    expect(within(log).getByText('PR merged for DAN-102')).toBeInTheDocument()
    const stamped = log.querySelectorAll('time[datetime]')
    expect(stamped).toHaveLength(allKinds.length)
    expect(stamped[0]).toHaveAttribute('dateTime', stateChange.ts)
  })

  it('links a summary to its url in a new tab, and renders url-less summaries as plain text', () => {
    render(<ActivityTimeline events={[stateChange, prMerged]} />)

    const link = screen.getByRole('link', { name: 'PR merged for DAN-102' })
    expect(link).toHaveAttribute('href', prMerged.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/\bnoopener\b/)
    expect(
      screen.queryByRole('link', { name: 'DAN-101: Backlog → In Progress' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('DAN-101: Backlog → In Progress'),
    ).toBeInTheDocument()
  })

  it('renders "PR closed for…" and other summary variants verbatim — text, never parsed', () => {
    const closed = { ...prMerged, summary: 'PR closed for DAN-102' }
    render(<ActivityTimeline events={[closed]} />)
    expect(
      screen.getByRole('link', { name: 'PR closed for DAN-102' }),
    ).toBeInTheDocument()
  })

  it('shows a loading line before the first feed and an empty line for an empty feed', () => {
    const { rerender } = render(<ActivityTimeline events={null} />)
    expect(screen.getByText('Loading activity…')).toBeInTheDocument()
    expect(screen.queryByRole('log')).not.toBeInTheDocument()

    rerender(<ActivityTimeline events={[]} />)
    expect(screen.getByText('No activity yet.')).toBeInTheDocument()
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
  })
})

describe('DAN-84 comment expand/collapse', () => {
  it('hides the body behind a real button with aria-expanded, and renders it as DAN-79 markdown when opened', () => {
    render(<ActivityTimeline events={allKinds} />)

    // Only the comment event grows a toggle — state/pr events have no body.
    const toggles = screen.getAllByRole('button', { name: 'Show comment' })
    expect(toggles).toHaveLength(1)
    const toggle = toggles[0]
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('green')).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('Hide comment')
    // The body went through renderMarkdown: **green** is a <strong>, the
    // dashes are a real list — not raw asterisks in a text node.
    const bold = screen.getByText('green')
    expect(bold.tagName).toBe('STRONG')
    const items = screen.getAllByRole('listitem')
    expect(items.some((li) => li.textContent === 'api')).toBe(true)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('green')).not.toBeInTheDocument()
  })

  it('keeps an expanded body open when the feed grows', () => {
    const { rerender } = render(<ActivityTimeline events={[stateChange, comment]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show comment' }))
    expect(screen.getByText('green')).toBeInTheDocument()

    rerender(<ActivityTimeline events={[stateChange, comment, prOpened]} />)
    expect(screen.getByText('green')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Hide comment' }),
    ).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('DAN-84 auto-scroll', () => {
  it('pins to the newest entry when the feed grows while the reader is at the bottom', () => {
    const { rerender } = render(<ActivityTimeline events={[stateChange]} />)
    const log = screen.getByRole('log')
    mockScrollMetrics(log, { scrollHeight: 400, clientHeight: 100 })

    // Reader sits at the bottom (400 - 300 - 100 = 0 <= epsilon).
    log.scrollTop = 300
    fireEvent.scroll(log)

    rerender(<ActivityTimeline events={[stateChange, comment]} />)
    expect(log.scrollTop).toBe(400)
  })

  it('leaves the viewport alone when the reader has scrolled up into history', () => {
    const { rerender } = render(<ActivityTimeline events={[stateChange]} />)
    const log = screen.getByRole('log')
    mockScrollMetrics(log, { scrollHeight: 400, clientHeight: 100 })

    // Reader scrolled up to read an earlier event.
    log.scrollTop = 40
    fireEvent.scroll(log)

    rerender(<ActivityTimeline events={[stateChange, comment]} />)
    expect(log.scrollTop).toBe(40)
  })

  it('resumes pinning after the reader scrolls back to the bottom', () => {
    const { rerender } = render(<ActivityTimeline events={[stateChange]} />)
    const log = screen.getByRole('log')
    mockScrollMetrics(log, { scrollHeight: 400, clientHeight: 100 })

    log.scrollTop = 40
    fireEvent.scroll(log)
    rerender(<ActivityTimeline events={[stateChange, comment]} />)
    expect(log.scrollTop).toBe(40)

    // Back within the at-bottom epsilon: 400 - 298 - 100 = 2.
    log.scrollTop = 298
    fireEvent.scroll(log)
    rerender(<ActivityTimeline events={[stateChange, comment, prOpened]} />)
    expect(log.scrollTop).toBe(400)
  })
})
