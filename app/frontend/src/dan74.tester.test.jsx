import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  featureRequestProgress,
  listFeatureRequests,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'
import { POLL_INTERVAL_MS } from './WatchBuild.jsx'

// DAN-74 — independent tester suite, written from the acceptance criteria
// (not from the developer's tests).
//
// Criteria under test:
//   1. The request-a-feature view shows a "My requests" list from
//      featureRequests, NEWEST FIRST (proved with deliberately out-of-order
//      input), each row carrying the first user message (truncated when
//      long), the status, and the created date.
//   2. Clicking a `building` request opens straight into the watch-it-build
//      DAG, polling featureRequestProgress with exactly that promptId.
//   3. Clicking a `gathering` request reopens the chat: the full transcript
//      is visible on the very first render (no typewriter replay of
//      historical replies), gates render from the session, and the composer
//      resumes the SAME session id — no startFeatureRequest.
//   4. A NEW reply arriving after the reopen still animates (the pre-seeding
//      must not kill DAN-79 for post-reopen replies).
//   5. Starting a brand-new request stays the default flow and works with
//      the list present; the list unmounts once a session is active.
//   6. Empty state ("No requests yet") and a quiet, non-alert failure state
//      that never blocks starting a new request.

vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  listFeatureRequests: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Fixtures — my own, distinct from the developer's.
// ---------------------------------------------------------------------------

const LONG_MESSAGE =
  'Please add a bulk archive action to the records table so operations can ' +
  'clear out hundreds of stale rows at once instead of clicking through them ' +
  'one at a time every Friday afternoon'

// Middle-aged, gathering (mid-conversation with one failing gate).
const gatherMid = {
  id: 'fr-tester-gather',
  status: 'gathering',
  model: 'gemini-3.6-flash',
  createdAt: '2026-08-25T12:00:00.000Z',
  messages: [
    { role: 'user', content: 'Let users pin favorite records' },
    { role: 'product-owner', content: 'Should pins be per-user or shared?' },
  ],
  entranceCriteria: {
    notTooBig: { pass: true, reason: 'Single surface' },
    notAmbiguous: { pass: false, reason: 'Pin scope undecided' },
    noBlockedDependencies: { pass: true, reason: 'Independent' },
  },
  approvable: false,
  linearProjectUrl: null,
}

// Oldest, building, with the LONG first message (truncation) and a project URL.
const buildOld = {
  id: 'fr-tester-build',
  status: 'building',
  model: 'claude-opus-5',
  createdAt: '2026-08-20T12:00:00.000Z',
  messages: [
    { role: 'user', content: LONG_MESSAGE },
    { role: 'product-owner', content: 'Approved and filed.' },
  ],
  entranceCriteria: {
    notTooBig: { pass: true, reason: 'Bounded' },
    notAmbiguous: { pass: true, reason: 'Concrete' },
    noBlockedDependencies: { pass: true, reason: 'None' },
  },
  approvable: false,
  linearProjectUrl: 'https://linear.app/tester/project/bulk-archive',
}

// Newest, gathering.
const gatherNew = {
  id: 'fr-tester-newest',
  status: 'gathering',
  model: 'claude-opus-5',
  createdAt: '2026-08-27T12:00:00.000Z',
  messages: [{ role: 'user', content: 'Dark mode for the whole app' }],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: null,
}

function listRegion() {
  return screen.getByRole('region', { name: 'My requests' })
}

async function listRows() {
  return await within(listRegion()).findAllByRole('button')
}

// Motion allowed — without this stub jsdom has no matchMedia and the view
// renders everything instantly, which would make the no-replay assertions
// vacuous. With it, an un-revealed reply WOULD animate.
function allowMotion() {
  window.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(listFeatureRequests).mockReset()
  vi.mocked(featureRequestProgress).mockReset()
  // Deliberately shuffled: middle, oldest, newest. The component must sort.
  vi.mocked(listFeatureRequests).mockResolvedValue([
    gatherMid,
    buildOld,
    gatherNew,
  ])
})

afterEach(() => {
  vi.useRealTimers()
  delete window.matchMedia
})

describe('DAN-74 tester — the list itself', () => {
  it('renders newest first even when the server returns rows out of order', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    const rows = await listRows()

    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Dark mode for the whole app')
    expect(rows[1]).toHaveTextContent('Let users pin favorite records')
    expect(rows[2]).toHaveTextContent('bulk archive action')
  })

  it('shows status and created date on every row', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    const rows = await listRows()

    expect(rows[0]).toHaveTextContent('gathering')
    expect(rows[0]).toHaveTextContent('Aug 27, 2026')
    expect(rows[1]).toHaveTextContent('gathering')
    expect(rows[1]).toHaveTextContent('Aug 25, 2026')
    expect(rows[2]).toHaveTextContent('building')
    expect(rows[2]).toHaveTextContent('Aug 20, 2026')
  })

  it('truncates a long first message with an ellipsis', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    const rows = await listRows()
    const buildingRow = rows[2]

    // The full 200-char message must NOT be on the row; a visibly shorter
    // prefix ending in an ellipsis must be.
    expect(buildingRow).not.toHaveTextContent(LONG_MESSAGE)
    const preview = buildingRow.querySelector('.my-requests__preview')
    expect(preview.textContent.endsWith('…')).toBe(true)
    expect(preview.textContent.length).toBeLessThan(LONG_MESSAGE.length)
    expect(LONG_MESSAGE.startsWith(preview.textContent.slice(0, -1))).toBe(true)
  })

  it('shows the empty state when the caller has no requests', async () => {
    vi.mocked(listFeatureRequests).mockResolvedValue([])
    render(<FeatureRequestView onBack={() => {}} />)

    expect(
      await within(listRegion()).findByText('No requests yet.'),
    ).toBeInTheDocument()
  })

  it('degrades quietly on load failure — inline note, no alert, new requests still start', async () => {
    vi.mocked(listFeatureRequests).mockRejectedValue(new Error('network down'))
    render(<FeatureRequestView onBack={() => {}} />)

    expect(
      await within(listRegion()).findByText(/load your past requests/),
    ).toBeInTheDocument()
    // Quiet: no alert anywhere, and the raw error message never surfaces.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument()

    // The failure never blocks the primary flow: a new request still starts.
    const started = {
      ...gatherNew,
      id: 'fr-after-failure',
      messages: [],
      entranceCriteria: null,
    }
    vi.mocked(startFeatureRequest).mockResolvedValue(started)
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...started,
      messages: [
        { role: 'user', content: 'Fresh idea despite the broken list' },
        { role: 'product-owner', content: 'Noted.' },
      ],
    })
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Fresh idea despite the broken list' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const transcript = await screen.findByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText('Fresh idea despite the broken list'),
    ).toBeInTheDocument()
    expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
      'fr-after-failure',
      'Fresh idea despite the broken list',
    )
  })
})

describe('DAN-74 tester — reopening a gathering session', () => {
  it('shows the FULL transcript on the first render after the click — no typewriter replay', async () => {
    allowMotion()
    render(<FeatureRequestView onBack={() => {}} />)
    const rows = await listRows()

    fireEvent.click(rows[1]) // gatherMid

    // Synchronous assertions, no waitFor: if the historical agent reply were
    // animating, this very render would show an empty (or partial) bubble.
    const transcript = screen.getByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText('Let users pin favorite records'),
    ).toBeInTheDocument()
    expect(
      within(transcript).getByText('Should pins be per-user or shared?'),
    ).toBeInTheDocument()
  })

  it('renders the session gates, locks the picker to the session model, keeps the composer live', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    const rows = await listRows()
    fireEvent.click(rows[1]) // gatherMid, model gemini-3.6-flash

    const gates = screen.getByRole('region', { name: 'Entrance criteria' })
    expect(within(gates).getByText('Pin scope undecided')).toBeInTheDocument()
    expect(within(gates).getByText('Fail')).toBeInTheDocument()

    const radio = screen.getByRole('radio', { name: 'gemini-3.6-flash' })
    expect(radio).toBeChecked()
    expect(radio).toBeDisabled()

    expect(screen.getByLabelText('Message')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()

    // The list is gone the moment a session is active.
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
  })

  it('a send after reopening resumes the SAME session — no startFeatureRequest', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    const rows = await listRows()
    fireEvent.click(rows[1]) // gatherMid

    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...gatherMid,
      messages: [
        ...gatherMid.messages,
        { role: 'user', content: 'Per-user pins' },
        { role: 'product-owner', content: 'Great, updating the plan.' },
      ],
    })
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Per-user pins' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
        'fr-tester-gather',
        'Per-user pins',
      ),
    )
    expect(startFeatureRequest).not.toHaveBeenCalled()
  })

  it('a NEW reply after the reopen still animates: progressive growth under fake timers', async () => {
    allowMotion()
    render(<FeatureRequestView onBack={() => {}} />)
    const rows = await listRows()
    fireEvent.click(rows[1]) // gatherMid

    const newReply =
      'Per-user pins it is. I will scope the ticket to a pins table keyed by ' +
      'caller identity and a star toggle on each row.'
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...gatherMid,
      messages: [
        ...gatherMid.messages,
        { role: 'user', content: 'Per-user pins' },
        { role: 'product-owner', content: newReply },
      ],
    })

    vi.useFakeTimers()
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Per-user pins' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // Flush the mocked round without advancing the reveal interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const transcript = screen.getByRole('list', { name: 'Conversation' })
    // Historical reply stayed complete throughout; the new one has not
    // finished (it may not have started ticking yet).
    expect(
      within(transcript).getByText('Should pins be per-user or shared?'),
    ).toBeInTheDocument()
    expect(within(transcript).queryByText(newReply)).not.toBeInTheDocument()

    // One 25ms tick: exactly a prefix is showing — proof of progressive
    // growth, not instant render.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25)
    })
    const text = transcript.textContent
    expect(text).toContain(newReply.slice(0, 20))
    expect(text).not.toContain(newReply)

    // Let the reveal run out: the full reply lands.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(within(transcript).getByText(newReply)).toBeInTheDocument()
  })
})

describe('DAN-74 tester — reopening a building session', () => {
  it('opens straight into the build DAG and polls with exactly that promptId', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue([
      {
        issueId: 'iss-arch-1',
        identifier: 'DAN-101',
        title: 'Bulk archive mutation',
        state: 'IN_PROGRESS',
        issueUrl: 'https://linear.app/tester/issue/DAN-101',
        prUrl: null,
        blockedBy: [],
      },
    ])
    render(<FeatureRequestView onBack={() => {}} />)
    const rows = await listRows()

    vi.useFakeTimers()
    fireEvent.click(rows[2]) // buildOld
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // The DAG view is mounted, fed by that session's id — once so far.
    expect(
      screen.getByRole('region', { name: 'Build progress' }),
    ).toBeInTheDocument()
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestProgress).toHaveBeenCalledWith('fr-tester-build')
    expect(screen.getByRole('link', { name: 'DAN-101' })).toBeInTheDocument()

    // The session's Linear project link rides along.
    expect(
      screen.getByRole('link', { name: 'View in Linear' }),
    ).toHaveAttribute('href', 'https://linear.app/tester/project/bulk-archive')

    // It is genuinely POLLING: the next hop fires with the same id.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestProgress).toHaveBeenLastCalledWith('fr-tester-build')

    // Full hand-off: no composer, no list.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
  })
})

describe('DAN-74 tester — the list never interferes with starting fresh', () => {
  it('the new-request flow stays the default action and unmounts the list once used', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    await listRows()

    // With the list showing, the composer and default model picker are live
    // and untouched by the list.
    expect(screen.getByLabelText('Message')).toBeEnabled()
    expect(screen.getByRole('radio', { name: 'claude-opus-5' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'claude-opus-5' })).toBeEnabled()

    const started = {
      id: 'fr-brand-new',
      status: 'gathering',
      model: 'claude-opus-5',
      createdAt: '2026-08-27T13:00:00.000Z',
      messages: [],
      entranceCriteria: null,
      approvable: false,
      linearProjectUrl: null,
    }
    vi.mocked(startFeatureRequest).mockResolvedValue(started)
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...started,
      messages: [
        { role: 'user', content: 'Export records as CSV' },
        { role: 'product-owner', content: 'Which delimiter?' },
      ],
    })

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Export records as CSV' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // The list disappears as soon as the message is in flight — it must
    // never sit under an active conversation.
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()

    await screen.findByRole('list', { name: 'Conversation' })
    expect(startFeatureRequest).toHaveBeenCalledWith('claude-opus-5')
    expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
      'fr-brand-new',
      'Export records as CSV',
    )
    // A brand-new session was started; nothing was "reopened".
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
  })
})
