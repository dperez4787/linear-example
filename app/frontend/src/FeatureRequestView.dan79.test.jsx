import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendFeatureRequestMessage, startFeatureRequest } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-79: markdown rendering + typewriter reveal in the chat transcript.
// Mocked api.js, roles and accessible text, per the DAN-53/54/66/67/71 house
// style — plus one deliberate deviation: the typewriter animates only when
// window.matchMedia exists and reports no reduced-motion preference, so these
// tests stub matchMedia (jsdom has none) exactly the way the DAN-67 suite
// stubs scrollIntoView. Suites that don't stub it (all the earlier ones) get
// instant rendering, unchanged behavior.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
}))

function makeRequest(messages = []) {
  return {
    id: 'fr1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T00:00:00.000Z',
    messages,
    entranceCriteria: null,
    approvable: false,
  }
}

function deferred() {
  let resolve_, reject_
  const promise = new Promise((res, rej) => {
    resolve_ = res
    reject_ = rej
  })
  return { promise, resolve: resolve_, reject: reject_ }
}

function composer() {
  return screen.getByLabelText('Message')
}

function typeAndSend(text) {
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

function transcript() {
  return screen.getByRole('list', { name: 'Conversation' })
}

// The transcript's own <li> bubbles — not the <li>s of a markdown list
// rendered inside a reply, which getAllByRole('listitem') would also catch.
function bubbles() {
  return [...transcript().children]
}

function stubMatchMedia(matches) {
  window.matchMedia = vi.fn(() => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

// Deliver one full round: send `content`, resolve with `messages`.
async function completeRound(content, messages) {
  vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
  const d = deferred()
  vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
  typeAndSend(content)
  await act(async () => {
    d.resolve(makeRequest(messages))
  })
}

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  delete Element.prototype.scrollIntoView
  delete window.matchMedia
})

describe('DAN-79 · markdown in agent replies', () => {
  it('renders bold, lists, headings, code, and safe links in an assistant bubble', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    await completeRound('Please add CSV export', [
      { role: 'user', content: 'Please add CSV export' },
      {
        role: 'product-owner',
        content:
          '## Plan\nThis is **important** and *subtle*.\n- first\n- second\n1. step one\nUse `csvStringify` here:\n```\nrows.map(toCsv)\n```\nSee [the docs](https://example.com/csv).',
      },
    ])

    const reply = bubbles()[1]
    expect(within(reply).getByText('product-owner')).toBeInTheDocument()
    expect(
      within(reply).getByRole('heading', { level: 2 }),
    ).toHaveTextContent('Plan')
    expect(reply.querySelector('strong')).toHaveTextContent('important')
    expect(reply.querySelector('em')).toHaveTextContent('subtle')
    expect(reply.querySelector('ul')).toHaveTextContent('first')
    expect(reply.querySelector('ol')).toHaveTextContent('step one')
    expect(reply.querySelector('code')).toHaveTextContent('csvStringify')
    expect(reply.querySelector('pre')).toHaveTextContent('rows.map(toCsv)')
    const link = within(reply).getByRole('link', { name: 'the docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/csv')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('leaves user messages as plain text — markdown syntax stays literal', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    await completeRound('Make it **bold** everywhere', [
      { role: 'user', content: 'Make it **bold** everywhere' },
      { role: 'product-owner', content: 'Understood' },
    ])

    const userBubble = bubbles()[0]
    expect(within(userBubble).getByText('user')).toBeInTheDocument()
    expect(userBubble.querySelector('strong')).toBeNull()
    expect(
      within(userBubble).getByText('Make it **bold** everywhere'),
    ).toBeInTheDocument()
  })

  it('renders malicious reply content inert: literal <script>, no anchor for javascript: hrefs', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    await completeRound('hi', [
      { role: 'user', content: 'hi' },
      {
        role: 'product-owner',
        content: '<script>alert(1)</script> [click](javascript:alert%281%29)',
      },
    ])

    const reply = bubbles()[1]
    expect(reply.querySelector('script')).toBeNull()
    expect(reply.querySelector('a')).toBeNull()
    expect(reply).toHaveTextContent('<script>alert(1)</script>')
  })
})

describe('DAN-79 · typewriter reveal', () => {
  const longReply =
    'The plan is to stream the CSV straight from the backend so the browser never buffers the whole file.'

  function setup() {
    stubMatchMedia(false) // motion allowed
    vi.useFakeTimers()
    render(<FeatureRequestView onBack={() => {}} />)
  }

  it('types a new reply on progressively (~1000 chars/s) instead of appearing at once', async () => {
    setup()
    await completeRound('Please add CSV export', [
      { role: 'user', content: 'Please add CSV export' },
      { role: 'product-owner', content: longReply },
    ])

    // The bubble exists with its role label, but the text has not finished.
    const reply = bubbles()[1]
    expect(within(reply).getByText('product-owner')).toBeInTheDocument()
    expect(within(reply).queryByText(longReply)).not.toBeInTheDocument()

    // Partway in, a prefix is showing but not the whole message.
    act(() => {
      vi.advanceTimersByTime(50) // ~50 chars of a 100-char reply
    })
    expect(reply).toHaveTextContent('The plan is to stream')
    expect(within(reply).queryByText(longReply)).not.toBeInTheDocument()

    // At ~1000 chars/s the 100-char reply completes within 150ms.
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(within(reply).getByText(longReply)).toBeInTheDocument()
  })

  it('completes instantly when the bubble is clicked', async () => {
    setup()
    await completeRound('Please add CSV export', [
      { role: 'user', content: 'Please add CSV export' },
      { role: 'product-owner', content: longReply },
    ])

    const reply = bubbles()[1]
    expect(within(reply).queryByText(longReply)).not.toBeInTheDocument()

    fireEvent.click(reply)

    expect(within(reply).getByText(longReply)).toBeInTheDocument()
    // And it stays complete — no restart on later ticks.
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(within(reply).getByText(longReply)).toBeInTheDocument()
  })

  it('renders instantly under prefers-reduced-motion', async () => {
    stubMatchMedia(true) // reduced motion requested
    vi.useFakeTimers()
    render(<FeatureRequestView onBack={() => {}} />)
    await completeRound('Please add CSV export', [
      { role: 'user', content: 'Please add CSV export' },
      { role: 'product-owner', content: longReply },
    ])

    // No timers advanced: the reply is already complete.
    expect(within(bubbles()[1]).getByText(longReply)).toBeInTheDocument()
  })

  it('never replays a completed reveal on re-render: earlier replies stay complete while a new one types', async () => {
    setup()
    await completeRound('Please add CSV export', [
      { role: 'user', content: 'Please add CSV export' },
      { role: 'product-owner', content: longReply },
    ])
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(within(bubbles()[1]).getByText(longReply)).toBeInTheDocument()

    // A second round arrives. The first reply must not replay; the new one
    // animates from empty.
    const secondReply = 'Good idea — Excel export can reuse the same stream.'
    await completeRound('Excel too, please', [
      { role: 'user', content: 'Please add CSV export' },
      { role: 'product-owner', content: longReply },
      { role: 'user', content: 'Excel too, please' },
      { role: 'architect', content: secondReply },
    ])

    // Immediately, with zero ticks elapsed since the new transcript:
    expect(within(bubbles()[1]).getByText(longReply)).toBeInTheDocument()
    expect(
      within(bubbles()[3]).queryByText(secondReply),
    ).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(within(bubbles()[3]).getByText(secondReply)).toBeInTheDocument()
  })
})
