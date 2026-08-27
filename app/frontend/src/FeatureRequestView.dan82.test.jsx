import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  featureRequest,
  featureRequestProgress,
  listFeatureRequests,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-82, component level: the two routing props. `requestId` makes the view
// load that session (fetch by id, then the DAN-74 adoption path — so the
// transcript arrives pre-revealed and the picker locks to the session's
// model); `onNavigate` is called at exactly the two moments a session
// acquires a URL — opening a list entry and the approval hand-off. Prop
// transitions stand in for the URL moving under a mounted instance (App keeps
// one instance across /requests ⇄ /requests/:id): id→null is browser back to
// the bare list, null→id is forward re-entry. Mocked api.js throughout, same
// idiom as the DAN-53..81 suites.
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

const gatheringRequest = {
  id: 'fr-g',
  status: 'gathering',
  model: 'gpt-5.6-terra',
  createdAt: '2026-08-27T10:00:00.000Z',
  messages: [
    { role: 'user', content: 'Add CSV export to the records table' },
    { role: 'product-owner', content: 'Which columns should the export include?' },
  ],
  entranceCriteria: {
    notTooBig: { pass: true, reason: 'Fits in one ticket' },
    notAmbiguous: { pass: false, reason: 'Columns unspecified' },
    noBlockedDependencies: { pass: true, reason: 'Nothing blocked' },
  },
  approvable: false,
  linearProjectUrl: null,
}

const buildingRequest = {
  ...gatheringRequest,
  id: 'fr-b',
  status: 'building',
  model: 'claude-opus-5',
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Motion allowed, so the adoption tests prove the typewriter does NOT replay
// (with matchMedia missing the reveal is skipped anyway and the assertions
// would be vacuous) — the DAN-74/79 idiom.
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
  vi.mocked(featureRequest).mockReset()
  vi.mocked(listFeatureRequests).mockReset().mockResolvedValue([gatheringRequest])
  vi.mocked(myAiUsage).mockReset().mockResolvedValue({ requests: 1, totalTokens: 100 })
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(featureRequestProgress).mockReset().mockResolvedValue([])
})

afterEach(() => {
  delete window.matchMedia
})

describe('DAN-82 · requestId deep-links a session', () => {
  it('fetches the id and adopts a gathering session: transcript complete, gates, live composer, locked picker', async () => {
    stubMatchMediaMotionAllowed()
    vi.mocked(featureRequest).mockResolvedValue(gatheringRequest)
    render(<FeatureRequestView onBack={() => {}} requestId="fr-g" />)

    await waitFor(() => expect(featureRequest).toHaveBeenCalledWith('fr-g'))
    const transcript = await screen.findByRole('list', { name: 'Conversation' })
    // The historical reply is complete on this same tick — DAN-79's typewriter
    // does not replay on a deep-linked transcript.
    expect(
      within(transcript).getByText('Which columns should the export include?'),
    ).toBeInTheDocument()

    const gates = screen.getByRole('region', { name: 'Entrance criteria' })
    expect(within(gates).getByText('Columns unspecified')).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeEnabled()

    // Picker locked to the session's model, exactly as a DAN-74 reopen.
    const radio = screen.getByRole('radio', { name: 'gpt-5.6-terra' })
    expect(radio).toBeChecked()
    expect(radio).toBeDisabled()

    // A session is active: no list.
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
  })

  it('sending into a deep-linked session resumes that conversation', async () => {
    vi.mocked(featureRequest).mockResolvedValue(gatheringRequest)
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...gatheringRequest,
      messages: [
        ...gatheringRequest.messages,
        { role: 'user', content: 'Name and amount' },
        { role: 'product-owner', content: 'Understood.' },
      ],
    })
    render(<FeatureRequestView onBack={() => {}} requestId="fr-g" />)
    await screen.findByRole('list', { name: 'Conversation' })

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Name and amount' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
        'fr-g',
        'Name and amount',
      ),
    )
    expect(startFeatureRequest).not.toHaveBeenCalled()
  })

  it('deep-links a building session straight into the DAG, polling with that id', async () => {
    vi.mocked(featureRequest).mockResolvedValue(buildingRequest)
    render(<FeatureRequestView onBack={() => {}} requestId="fr-b" />)

    await screen.findByRole('region', { name: 'Build progress' })
    await waitFor(() =>
      expect(featureRequestProgress).toHaveBeenCalledWith('fr-b'),
    )
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('shows a placeholder while the session loads — no composer, no list', async () => {
    const d = deferred()
    vi.mocked(featureRequest).mockReturnValue(d.promise)
    render(<FeatureRequestView onBack={() => {}} requestId="fr-g" />)

    expect(screen.getByText('Loading session…')).toBeInTheDocument()
    // Never a live composer that could start a second session, never the list
    // under a session URL — only the frame and the way back.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Back to records' }),
    ).toBeInTheDocument()

    await act(async () => {
      d.resolve(gatheringRequest)
      await d.promise
    })
    expect(
      await screen.findByRole('list', { name: 'Conversation' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Loading session…')).not.toBeInTheDocument()
  })

  it('a failed load says so and keeps Back as the way out', async () => {
    vi.mocked(featureRequest).mockRejectedValue(
      new Error('Feature request not found'),
    )
    const onBack = vi.fn()
    render(<FeatureRequestView onBack={onBack} requestId="fr-missing" />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Feature request not found')
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to records' }))
    expect(onBack).toHaveBeenCalled()
  })
})

describe('DAN-82 · onNavigate fires when a session acquires a URL', () => {
  it('opening a list entry navigates to /requests/:id and adopts without refetching', async () => {
    const onNavigate = vi.fn()
    render(<FeatureRequestView onBack={() => {}} onNavigate={onNavigate} />)
    const list = screen.getByRole('region', { name: 'My requests' })
    await within(list).findAllByRole('button')

    fireEvent.click(
      screen.getByRole('button', { name: /Add CSV export to the records table/ }),
    )

    expect(onNavigate).toHaveBeenCalledWith('/requests/fr-g')
    // Adoption came from the list's own object — no fetch by id.
    expect(featureRequest).not.toHaveBeenCalled()
    expect(
      screen.getByRole('list', { name: 'Conversation' }),
    ).toBeInTheDocument()
  })

  it('a successful approval navigates to /requests/:id at the hand-off', async () => {
    vi.mocked(featureRequest).mockResolvedValue({
      ...gatheringRequest,
      approvable: true,
    })
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue({
      ...gatheringRequest,
      status: 'building',
      approvable: false,
    })
    const onNavigate = vi.fn()
    render(
      <FeatureRequestView
        onBack={() => {}}
        onNavigate={onNavigate}
        requestId="fr-g"
      />,
    )
    const approve = await screen.findByRole('button', { name: 'Approve plan' })
    await waitFor(() => expect(approve).toBeEnabled())

    fireEvent.click(approve)

    await screen.findByRole('region', { name: 'Build progress' })
    expect(onNavigate).toHaveBeenCalledWith('/requests/fr-g')
  })

  it('a failed approval navigates nowhere', async () => {
    vi.mocked(featureRequest).mockResolvedValue({
      ...gatheringRequest,
      approvable: true,
    })
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      new Error('Internal Server Error'),
    )
    const onNavigate = vi.fn()
    render(
      <FeatureRequestView
        onBack={() => {}}
        onNavigate={onNavigate}
        requestId="fr-g"
      />,
    )
    const approve = await screen.findByRole('button', { name: 'Approve plan' })
    await waitFor(() => expect(approve).toBeEnabled())

    fireEvent.click(approve)

    await screen.findByRole('alert')
    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe('DAN-82 · the URL moving under a mounted instance', () => {
  it('id → null (browser back to /requests) resets to the fresh surface; null → id re-fetches', async () => {
    vi.mocked(featureRequest).mockResolvedValue(gatheringRequest)
    const { rerender } = render(
      <FeatureRequestView onBack={() => {}} requestId="fr-g" />,
    )
    await screen.findByRole('list', { name: 'Conversation' })
    expect(featureRequest).toHaveBeenCalledTimes(1)

    // Back: the bare list URL. Session state clears — empty composer, picker
    // unlocked and returned to the default model, list mounted again.
    rerender(<FeatureRequestView onBack={() => {}} requestId={null} />)
    expect(
      screen.queryByRole('list', { name: 'Conversation' }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveValue('')
    const radio = screen.getByRole('radio', { name: 'claude-opus-5' })
    expect(radio).toBeChecked()
    expect(radio).toBeEnabled()
    expect(
      await screen.findByRole('region', { name: 'My requests' }),
    ).toBeInTheDocument()

    // Forward: the session URL again. Nothing is held any more, so it fetches
    // and adopts afresh.
    rerender(<FeatureRequestView onBack={() => {}} requestId="fr-g" />)
    await screen.findByRole('list', { name: 'Conversation' })
    expect(featureRequest).toHaveBeenCalledTimes(2)
  })

  it('a session started on bare /requests is NOT reset by the null requestId staying null', async () => {
    const started = {
      ...gatheringRequest,
      id: 'fr-new',
      model: 'claude-opus-5',
      messages: [],
      entranceCriteria: null,
    }
    vi.mocked(startFeatureRequest).mockResolvedValue(started)
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...started,
      messages: [
        { role: 'user', content: 'A brand-new idea' },
        { role: 'product-owner', content: 'Tell me more.' },
      ],
    })
    const { rerender } = render(
      <FeatureRequestView onBack={() => {}} requestId={null} />,
    )
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'A brand-new idea' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('list', { name: 'Conversation' })

    // Any parent re-render with requestId still null must leave the live
    // session alone — reset only fires on the id → null transition.
    rerender(<FeatureRequestView onBack={() => {}} requestId={null} />)
    expect(
      screen.getByRole('list', { name: 'Conversation' }),
    ).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Conversation' }))
      .getByText('Tell me more.')).toBeInTheDocument()
  })
})
