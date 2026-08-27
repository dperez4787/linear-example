import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendFeatureRequestMessage, startFeatureRequest } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-67: the chat-grade sending experience — the optimistic user message, the
// animated "product-owner is thinking…" indicator, the not-delivered/retry
// affordance, and transcript auto-scroll. Mocked api.js, roles and accessible
// text only, exactly as the DAN-53/54/66 suites do. Alignment (user right,
// replies left) is CSS and therefore user-attested, per the repo convention
// that tests never assert styles — the role labels the layout hangs off are
// asserted here instead.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  // Resolves to nothing so the view skips the meter's state update and the
  // suite stays act()-quiet (same trick as the DAN-53 suite).
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
}))

function makeRequest(messages = []) {
  return {
    id: 'fr1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z',
    messages,
    entranceCriteria: null,
    approvable: false,
  }
}

const firstExchange = [
  { role: 'user', content: 'Please add CSV export' },
  { role: 'product-owner', content: 'I will slice this into a ticket' },
  { role: 'architect', content: 'Stream the CSV from the backend' },
]

function deferred() {
  let resolve_, reject_
  const promise = new Promise((res, rej) => {
    resolve_ = res
    reject_ = rej
  })
  return { promise, resolve: resolve_, reject: reject_ }
}

function quotaError() {
  const err = new Error('AI request quota exhausted')
  err.extensions = { code: 'QUOTA_EXHAUSTED' }
  return err
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

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  // jsdom does not implement scrollIntoView; the component's optional call
  // (`?.()`) makes its absence safe, and stubbing it here lets the auto-scroll
  // tests assert the call.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  delete Element.prototype.scrollIntoView
})

describe('DAN-67 · optimistic send', () => {
  it('renders the user message in the transcript immediately and clears the composer at once, while the send still hangs', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(deferred().promise)
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    // Synchronously after Send: the message is in the transcript as the
    // user's, and the composer already let go of the draft.
    const items = within(transcript()).getAllByRole('listitem')
    expect(within(items[0]).getByText('user')).toBeInTheDocument()
    expect(
      within(items[0]).getByText('Please add CSV export'),
    ).toBeInTheDocument()
    expect(composer()).toHaveValue('')
  })

  it('renders the optimistic message even while startFeatureRequest itself still hangs', () => {
    vi.mocked(startFeatureRequest).mockReturnValue(deferred().promise)
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    expect(
      within(transcript()).getByText('Please add CSV export'),
    ).toBeInTheDocument()
    expect(composer()).toHaveValue('')
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
  })

  it('replaces the optimistic message with the canonical transcript on arrival — no duplicate', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    expect(
      within(transcript()).getByText('Please add CSV export'),
    ).toBeInTheDocument()

    d.resolve(makeRequest(firstExchange))

    await waitFor(() =>
      expect(within(transcript()).getAllByRole('listitem')).toHaveLength(3),
    )
    // Exactly one copy of the delivered message survives the reconciliation.
    expect(
      within(transcript()).getAllByText('Please add CSV export'),
    ).toHaveLength(1)
    expect(screen.queryByText('not delivered')).not.toBeInTheDocument()
  })
})

describe('DAN-67 · thinking indicator', () => {
  it('shows "product-owner is thinking…" as a status where the reply will appear while the round hangs, and swaps it out when the transcript arrives', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    const indicator = await screen.findByRole('status')
    expect(indicator).toHaveTextContent('product-owner is thinking…')
    // It holds the reply's place: the last item of the transcript, after the
    // optimistic user message.
    const items = within(transcript()).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[1]).toHaveTextContent('product-owner is thinking…')

    d.resolve(makeRequest(firstExchange))

    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    )
    expect(
      screen.queryByText('product-owner is thinking…'),
    ).not.toBeInTheDocument()
    // The real replies stand where the indicator was.
    const settled = within(transcript()).getAllByRole('listitem')
    expect(settled).toHaveLength(3)
    expect(settled[1]).toHaveTextContent('product-owner')
    expect(settled[1]).toHaveTextContent('I will slice this into a ticket')
  })
})

describe('DAN-67 · failed round keeps the message with a retry affordance', () => {
  it('marks the optimistic message "not delivered" with a retry control that resends the same content', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValueOnce(
      new Error('gateway timeout'),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('gateway timeout')
    const item = within(transcript()).getByRole('listitem')
    expect(item).toHaveTextContent('Please add CSV export')
    expect(item).toHaveTextContent('not delivered')

    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest(firstExchange),
    )
    fireEvent.click(within(item).getByRole('button', { name: 'retry' }))

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(2),
    )
    // The retry resent exactly the original content to the same conversation.
    expect(sendFeatureRequestMessage).toHaveBeenNthCalledWith(
      1,
      'fr1',
      'Please add CSV export',
    )
    expect(sendFeatureRequestMessage).toHaveBeenNthCalledWith(
      2,
      'fr1',
      'Please add CSV export',
    )
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByText('not delivered')).not.toBeInTheDocument(),
    )
    expect(
      within(transcript()).getAllByText('Please add CSV export'),
    ).toHaveLength(1)
  })

  it('a failed message remains in the transcript while a later message is composed and delivered', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValueOnce(
      new Error('gateway timeout'),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    await screen.findByRole('alert')

    const laterExchange = [
      { role: 'user', content: 'Excel too, please' },
      { role: 'product-owner', content: 'Noted' },
    ]
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest(laterExchange),
    )
    typeAndSend('Excel too, please')

    await waitFor(() => expect(screen.getByText('Noted')).toBeInTheDocument())
    // The undelivered first message did not get eaten by the second send.
    const failed = within(transcript())
      .getAllByRole('listitem')
      .find((item) => /not delivered/.test(item.textContent))
    expect(failed).toBeDefined()
    expect(failed).toHaveTextContent('Please add CSV export')
    expect(within(failed).getByRole('button', { name: 'retry' })).toBeEnabled()
  })

  it('a QUOTA_EXHAUSTED failure keeps the friendly panel behavior and disables retry', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(quotaError())
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/out of AI quota/i)
    expect(
      screen.queryByText('AI request quota exhausted'),
    ).not.toBeInTheDocument()
    expect(composer()).toBeDisabled()
    // The message still was not eaten — but resending against an exhausted
    // quota is pointless, so the retry control disables with the composer.
    const item = within(transcript()).getByRole('listitem')
    expect(item).toHaveTextContent('not delivered')
    expect(within(item).getByRole('button', { name: 'retry' })).toBeDisabled()
  })
})

describe('DAN-67 · auto-scroll', () => {
  it('scrolls the transcript end into view when the optimistic message and thinking indicator appear, and again when the reply lands', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    render(<FeatureRequestView onBack={() => {}} />)

    // Nothing to scroll to before the transcript exists.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()

    typeAndSend('Please add CSV export')

    // The optimistic append (and the indicator) triggered a scroll.
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled(),
    )
    const callsWhileThinking =
      vi.mocked(Element.prototype.scrollIntoView).mock.calls.length

    d.resolve(makeRequest(firstExchange))

    // The canonical transcript append scrolled again.
    await waitFor(() =>
      expect(
        vi.mocked(Element.prototype.scrollIntoView).mock.calls.length,
      ).toBeGreaterThan(callsWhileThinking),
    )
  })
})
