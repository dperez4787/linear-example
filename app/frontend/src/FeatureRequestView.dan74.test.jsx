import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  featureRequestProgress,
  listFeatureRequests,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'
import { PREVIEW_MAX_CHARS } from './MyRequests.jsx'

// DAN-74: the "My requests" list — past sessions listed newest first on the
// request-a-feature view, each reopenable into the state it persisted in: a
// gathering session back into the live chat (transcript + gates + composer,
// and crucially WITHOUT replaying DAN-79's typewriter on historical replies),
// a building session straight into the DAN-55 build DAG, polling with that
// session's id. Mocked api.js, accessible-text assertions, same idiom as the
// DAN-53..81 suites; matchMedia is stubbed motion-allowed (the DAN-79 idiom)
// precisely so the no-replay assertions mean something.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  listFeatureRequests: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
}))

const LONG_FIRST_MESSAGE =
  'Nightly usage report emailed to admins, with a per-team breakdown and a CSV attachment for the finance folks'

// A gathering session mid-conversation (newer of the two).
const gatheringRequest = {
  id: 'fr-gathering',
  status: 'gathering',
  model: 'gpt-5.6-terra',
  createdAt: '2026-08-27T10:00:00.000Z',
  messages: [
    { role: 'user', content: 'Add CSV export to the records table' },
    {
      role: 'product-owner',
      content: 'Which columns should the export include?',
    },
  ],
  entranceCriteria: {
    notTooBig: { pass: true, reason: 'Fits in one ticket' },
    notAmbiguous: { pass: false, reason: 'Columns unspecified' },
    noBlockedDependencies: { pass: true, reason: 'Nothing blocked' },
  },
  approvable: false,
  linearProjectUrl: null,
}

// An approved session already building (older; long first message to exercise
// truncation).
const buildingRequest = {
  id: 'fr-building',
  status: 'building',
  model: 'claude-opus-5',
  createdAt: '2026-08-26T09:00:00.000Z',
  messages: [
    { role: 'user', content: LONG_FIRST_MESSAGE },
    { role: 'product-owner', content: 'Filed as tickets.' },
  ],
  entranceCriteria: {
    notTooBig: { pass: true, reason: 'Fits' },
    notAmbiguous: { pass: true, reason: 'Concrete' },
    noBlockedDependencies: { pass: true, reason: 'Clear' },
  },
  approvable: false,
  linearProjectUrl: 'https://linear.app/daniel-perez/project/nightly-report',
}

function myRequests() {
  return screen.getByRole('region', { name: 'My requests' })
}

function rows() {
  return within(myRequests()).getAllByRole('button')
}

// Motion allowed — the DAN-79 typewriter WOULD animate if a message were not
// pre-seeded as revealed. That is what makes the reopen tests meaningful.
function stubMatchMediaMotionAllowed() {
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(listFeatureRequests).mockReset()
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 1, totalTokens: 100 })
  vi.mocked(listFeatureRequests).mockResolvedValue([
    // Deliberately oldest first: the list must render newest first regardless.
    buildingRequest,
    gatheringRequest,
  ])
})

afterEach(() => {
  delete window.matchMedia
})

describe('DAN-74 my-requests list', () => {
  it('lists past sessions newest first with preview, status, and created date', async () => {
    render(<FeatureRequestView onBack={() => {}} />)

    const list = await within(myRequests()).findAllByRole('button')
    expect(list).toHaveLength(2)

    // Newest first even though the mock resolved oldest first.
    expect(list[0]).toHaveTextContent('Add CSV export to the records table')
    expect(list[0]).toHaveTextContent('gathering')
    expect(list[0]).toHaveTextContent('Aug 27, 2026')

    // The long first message is truncated with an ellipsis.
    const truncated = `${LONG_FIRST_MESSAGE.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    expect(list[1]).toHaveTextContent(truncated)
    expect(list[1]).not.toHaveTextContent(LONG_FIRST_MESSAGE)
    expect(list[1]).toHaveTextContent('building')
    expect(list[1]).toHaveTextContent('Aug 26, 2026')
  })

  it('shows the empty state when the caller has no sessions', async () => {
    vi.mocked(listFeatureRequests).mockResolvedValue([])
    render(<FeatureRequestView onBack={() => {}} />)

    expect(
      await within(myRequests()).findByText('No requests yet.'),
    ).toBeInTheDocument()
  })

  it('degrades quietly when the list fails to load — no alert, composer still live', async () => {
    vi.mocked(listFeatureRequests).mockRejectedValue(new Error('boom'))
    render(<FeatureRequestView onBack={() => {}} />)

    expect(
      await within(myRequests()).findByText('Couldn’t load your past requests.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeEnabled()
  })

  it('reopens a gathering session into the chat — transcript complete (no typewriter replay), gates and composer live, picker locked to the session model', async () => {
    stubMatchMediaMotionAllowed()
    render(<FeatureRequestView onBack={() => {}} />)
    await within(myRequests()).findAllByRole('button')

    fireEvent.click(
      screen.getByRole('button', { name: /Add CSV export to the records table/ }),
    )

    // The full transcript is on screen immediately: the historical agent reply
    // renders complete rather than starting DAN-79's character reveal (which
    // would render an empty bubble on this same tick).
    const transcript = screen.getByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText('Add CSV export to the records table'),
    ).toBeInTheDocument()
    expect(
      within(transcript).getByText('Which columns should the export include?'),
    ).toBeInTheDocument()

    // Gates render from the reopened session's entranceCriteria.
    const gates = screen.getByRole('region', { name: 'Entrance criteria' })
    expect(within(gates).getByText('Columns unspecified')).toBeInTheDocument()

    // Composer is live for the next message; Approve stays server-gated off.
    expect(screen.getByLabelText('Message')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeDisabled()

    // The locked picker shows the model the session was started with.
    const radio = screen.getByRole('radio', { name: 'gpt-5.6-terra' })
    expect(radio).toBeChecked()
    expect(radio).toBeDisabled()

    // The list itself is gone — a session is active now.
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
  })

  it('sending a message into a reopened gathering session goes to that session id', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    await within(myRequests()).findAllByRole('button')
    fireEvent.click(
      screen.getByRole('button', { name: /Add CSV export to the records table/ }),
    )

    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...gatheringRequest,
      messages: [
        ...gatheringRequest.messages,
        { role: 'user', content: 'Name, status, and amount' },
        { role: 'product-owner', content: 'Understood.' },
      ],
    })
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Name, status, and amount' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
        'fr-gathering',
        'Name, status, and amount',
      ),
    )
    // No new conversation was started: the reopened one was resumed.
    expect(startFeatureRequest).not.toHaveBeenCalled()
  })

  it('reopens a building session straight into the build DAG, polling with that promptId', async () => {
    vi.mocked(featureRequestProgress).mockResolvedValue([
      {
        issueId: 'iss-1',
        identifier: 'DAN-90',
        title: 'Report backend',
        state: 'IN_PROGRESS',
        issueUrl: 'https://linear.app/daniel-perez/issue/DAN-90',
        prUrl: null,
        blockedBy: [],
      },
    ])
    render(<FeatureRequestView onBack={() => {}} />)
    await within(myRequests()).findAllByRole('button')

    fireEvent.click(screen.getByRole('button', { name: /Nightly usage report/ }))

    // The DAG view mounts and its poll starts with the reopened session's id.
    await screen.findByRole('region', { name: 'Build progress' })
    await waitFor(() =>
      expect(featureRequestProgress).toHaveBeenCalledWith('fr-building'),
    )
    expect(await screen.findByRole('link', { name: 'DAN-90' })).toBeInTheDocument()

    // DAN-81's header link rides along from the persisted session.
    expect(screen.getByRole('link', { name: 'View in Linear' })).toHaveAttribute(
      'href',
      'https://linear.app/daniel-perez/project/nightly-report',
    )

    // Handed off: no composer, and the list is gone.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
  })

  it('starting a brand-new request still works with the list showing, and unmounts it', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    await within(myRequests()).findAllByRole('button')

    const started = {
      ...gatheringRequest,
      id: 'fr-new',
      messages: [],
      entranceCriteria: null,
      model: 'claude-opus-5',
    }
    vi.mocked(startFeatureRequest).mockResolvedValue(started)
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...started,
      messages: [
        { role: 'user', content: 'A brand-new idea' },
        { role: 'product-owner', content: 'Tell me more.' },
      ],
    })

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'A brand-new idea' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await screen.findByRole('list', { name: 'Conversation' })
    expect(startFeatureRequest).toHaveBeenCalledWith('claude-opus-5')
    expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
      'fr-new',
      'A brand-new idea',
    )
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
  })

  it('previews a session that has no messages yet', async () => {
    vi.mocked(listFeatureRequests).mockResolvedValue([
      { ...gatheringRequest, id: 'fr-empty', messages: [] },
    ])
    render(<FeatureRequestView onBack={() => {}} />)

    const [row] = await within(myRequests()).findAllByRole('button')
    expect(row).toHaveTextContent('(no messages yet)')
  })

  it('typewriter still animates for replies that arrive after a reopen', async () => {
    // The pre-seeding must not smother DAN-79: a NEW reply, arriving through
    // the composer after reopening, still types on. Fake timers pin the
    // reveal mid-flight.
    stubMatchMediaMotionAllowed()
    render(<FeatureRequestView onBack={() => {}} />)
    await within(myRequests()).findAllByRole('button')
    fireEvent.click(
      screen.getByRole('button', { name: /Add CSV export to the records table/ }),
    )

    const reply =
      'A reply well past twenty-five characters so the first tick cannot finish it.'
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...gatheringRequest,
      messages: [
        ...gatheringRequest.messages,
        { role: 'user', content: 'More detail' },
        { role: 'product-owner', content: reply },
      ],
    })

    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getByLabelText('Message'), {
        target: { value: 'More detail' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      // Flush the mocked round without advancing the reveal interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      const transcript = screen.getByRole('list', { name: 'Conversation' })
      // Historical reply: still complete. New reply: not yet.
      expect(
        within(transcript).getByText('Which columns should the export include?'),
      ).toBeInTheDocument()
      expect(within(transcript).queryByText(reply)).not.toBeInTheDocument()

      // Let the reveal run out; the full reply lands.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(within(transcript).getByText(reply)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
