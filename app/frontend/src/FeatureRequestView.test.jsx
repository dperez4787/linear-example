import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sendFeatureRequestMessage, startFeatureRequest } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-53: the chat pane, tested against a mocked api.js exactly as the other
// component tests do — no fetch, no Firebase. State and visuals are asserted
// via roles and accessible text, never styles.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  // DAN-54: the view now also reads the quota meter and exposes approval. The
  // meter default resolves to nothing (the view then skips the state update,
  // keeping these older tests act()-quiet); the meter and approval themselves
  // are asserted in FeatureRequestView.dan54.test.jsx.
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
  }
}

const firstExchange = [
  { role: 'user', content: 'Please add CSV export' },
  { role: 'product-owner', content: 'I will slice this into a ticket' },
  { role: 'architect', content: 'Stream the CSV from the backend' },
]

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
})

function typeAndSend(text) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('FeatureRequestView first message', () => {
  it('calls startFeatureRequest with the default model, then sendFeatureRequestMessage with its id and the content', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(makeRequest(firstExchange))
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith('fr1', 'Please add CSV export'),
    )
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
    expect(startFeatureRequest).toHaveBeenCalledWith('claude-opus-5')
    // start must have gone out before send.
    expect(
      vi.mocked(startFeatureRequest).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(sendFeatureRequestMessage).mock.invocationCallOrder[0])
  })

  it('shows the returned transcript: the user message and each reply visibly labeled with its role', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(makeRequest(firstExchange))
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    const transcript = await screen.findByRole('list', { name: 'Conversation' })
    const items = within(transcript).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('user')
    expect(items[0]).toHaveTextContent('Please add CSV export')
    expect(items[1]).toHaveTextContent('product-owner')
    expect(items[1]).toHaveTextContent('I will slice this into a ticket')
    expect(items[2]).toHaveTextContent('architect')
    expect(items[2]).toHaveTextContent('Stream the CSV from the backend')
  })

  it('sends a later message to the same conversation without starting a second one', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(makeRequest(firstExchange))
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    await screen.findByRole('list', { name: 'Conversation' })

    const followUp = [...firstExchange, { role: 'user', content: 'Excel too, please' }]
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(makeRequest(followUp))
    typeAndSend('Excel too, please')

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenLastCalledWith('fr1', 'Excel too, please'),
    )
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
  })
})

describe('FeatureRequestView while a send is in flight', () => {
  it('disables the input, shows a busy indicator, and clears both when the send resolves', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    let resolveSend
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve
      }),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    resolveSend(makeRequest(firstExchange))

    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    )
    expect(screen.getByLabelText('Message')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    // The accepted message left the composer.
    expect(screen.getByLabelText('Message')).toHaveValue('')
  })
})

describe('FeatureRequestView on API rejection', () => {
  // DAN-67: the failure contract changed from "the draft survives in the
  // composer" to "the optimistic message survives in the transcript with a
  // retry control" — the chat-grade version of not eating the input.
  it('shows the error, re-enables the input, and keeps the message in the transcript marked not delivered', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(new Error('Internal Server Error'))
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Internal Server Error')
    expect(screen.getByLabelText('Message')).toBeEnabled()
    // The composer cleared on Send and stays clear; the message lives on in
    // the transcript instead, flagged undelivered with a retry control.
    expect(screen.getByLabelText('Message')).toHaveValue('')
    const transcript = screen.getByRole('list', { name: 'Conversation' })
    const item = within(transcript).getByRole('listitem')
    expect(item).toHaveTextContent('Please add CSV export')
    expect(item).toHaveTextContent('not delivered')
    expect(within(item).getByRole('button', { name: 'retry' })).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('retries against the already-started conversation after a failed first send', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValueOnce(new Error('boom'))
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    await screen.findByRole('alert')

    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(makeRequest(firstExchange))
    // DAN-67: the resend goes through the failed message's retry control.
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Conversation' })).getAllByRole('listitem'),
      ).toHaveLength(3),
    )
    // The conversation was started exactly once; the retry reused its id.
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
    expect(sendFeatureRequestMessage).toHaveBeenLastCalledWith('fr1', 'Please add CSV export')
    // The delivered message appears once — the canonical copy replaced the
    // optimistic one.
    expect(screen.getAllByText('Please add CSV export')).toHaveLength(1)
    expect(screen.queryByText('not delivered')).not.toBeInTheDocument()
  })

  it('surfaces a startFeatureRequest failure the same way', async () => {
    vi.mocked(startFeatureRequest).mockRejectedValue(new Error('unauthorized'))
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('unauthorized')
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Message')).toBeEnabled()
  })
})

describe('FeatureRequestView back control', () => {
  it('invokes onBack when the back control is clicked', () => {
    const onBack = vi.fn()
    render(<FeatureRequestView onBack={onBack} />)

    fireEvent.click(screen.getByRole('button', { name: 'Back to records' }))

    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
