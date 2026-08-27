// DAN-67 tester verification. Independent of the developer's own
// FeatureRequestView.dan67.test.jsx. Locks the ticket's acceptance criteria:
//  - On Send the user's message renders in the transcript immediately
//    (optimistic), labeled as the user's, and the composer clears at once —
//    asserted synchronously while the round's promise still hangs, for BOTH
//    the first send (start-then-send path) and a follow-up send.
//  - While in flight, a "product-owner is thinking…" indicator with
//    role="status" holds the reply's place; when the server transcript
//    arrives it swaps out and the canonical row replaces the optimistic one —
//    exactly one copy of the message text, counted.
//  - A failed round keeps the message in the transcript marked "not
//    delivered" with a retry control that resends the same content (call args
//    asserted); two independently failed messages coexist and each retry
//    resends its own content. The plain-error alert and the QUOTA_EXHAUSTED
//    panel keep their DAN-53/54 behavior.
//  - Role labels (user / product-owner / architect) group with their message
//    content inside the same transcript item; alignment itself is CSS and
//    user-attested, per the repo rule that tests assert roles and accessible
//    text, never styles.
//  - Auto-scroll: the transcript-end sentinel's scrollIntoView fires on the
//    optimistic append / thinking indicator and again when the reply lands
//    (jsdom does not implement it; stubbed on Element.prototype).
//
// api.js is fully mocked; every round is driven by a deferred promise the
// test controls.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendFeatureRequestMessage, startFeatureRequest } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  // Resolves to nothing so the meter skips its state update and the suite
  // stays act()-quiet (same shape as the DAN-53/54 suites).
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
}))

// A distinctive id, so a hardcoded 'fr1' in the component cannot pass the
// call-args assertions.
const STARTED_ID = 'fr-tester-67'

function makeRequest(messages = []) {
  return {
    id: STARTED_ID,
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z',
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

function transcriptItems() {
  return within(transcript()).getAllByRole('listitem')
}

const FIRST_EXCHANGE = [
  { role: 'user', content: 'Add CSV export' },
  { role: 'product-owner', content: 'Slicing this into a ticket' },
  { role: 'architect', content: 'Stream it from the backend' },
]

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  // jsdom has no scrollIntoView; the stub both keeps the component's call
  // safe and lets the auto-scroll tests count invocations.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  delete Element.prototype.scrollIntoView
})

describe('DAN-67 tester · optimistic first send (start + send path)', () => {
  it('renders the message as the user’s and clears the composer while the send hangs; resolve leaves exactly one copy and no indicator', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')

    // Synchronously after the click — the round has not resolved anything.
    const optimistic = within(transcript()).getByText('Add CSV export')
    expect(optimistic).toBeInTheDocument()
    // Grouped under the user's role label in the same transcript item.
    const item = optimistic.closest('li')
    expect(within(item).getByText('user')).toBeInTheDocument()
    expect(composer()).toHaveValue('')

    // The thinking indicator holds the reply's place as a status.
    const indicator = await screen.findByRole('status')
    expect(indicator).toHaveTextContent('product-owner is thinking…')
    const items = transcriptItems()
    expect(items[items.length - 1]).toHaveTextContent(
      'product-owner is thinking…',
    )

    d.resolve(makeRequest(FIRST_EXCHANGE))

    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    )
    // The canonical transcript replaced the optimistic copy — one copy only.
    expect(screen.getAllByText('Add CSV export')).toHaveLength(1)
    expect(transcriptItems()).toHaveLength(3)
    expect(screen.queryByText('not delivered')).not.toBeInTheDocument()
    expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
      STARTED_ID,
      'Add CSV export',
    )
  })

  it('is already optimistic while startFeatureRequest itself still hangs', () => {
    vi.mocked(startFeatureRequest).mockReturnValue(deferred().promise)
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')

    expect(within(transcript()).getByText('Add CSV export')).toBeInTheDocument()
    expect(composer()).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent(
      'product-owner is thinking…',
    )
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
  })
})

describe('DAN-67 tester · optimistic follow-up send', () => {
  it('the second message is optimistic against the existing canonical transcript, then reconciles to one copy', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValueOnce(
      makeRequest(FIRST_EXCHANGE),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')
    await waitFor(() => expect(transcriptItems()).toHaveLength(3))

    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValueOnce(d.promise)
    typeAndSend('Excel too, please')

    // Hanging: canonical 3 + optimistic user message + thinking indicator.
    const items = transcriptItems()
    expect(items).toHaveLength(5)
    expect(items[3]).toHaveTextContent('user')
    expect(items[3]).toHaveTextContent('Excel too, please')
    expect(items[4]).toHaveTextContent('product-owner is thinking…')
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(composer()).toHaveValue('')

    d.resolve(
      makeRequest([
        ...FIRST_EXCHANGE,
        { role: 'user', content: 'Excel too, please' },
        { role: 'product-owner', content: 'Noted, adding Excel' },
      ]),
    )

    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    )
    expect(screen.getAllByText('Excel too, please')).toHaveLength(1)
    expect(transcriptItems()).toHaveLength(5)
    // No conversation restart on a follow-up.
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
    expect(sendFeatureRequestMessage).toHaveBeenLastCalledWith(
      STARTED_ID,
      'Excel too, please',
    )
  })
})

describe('DAN-67 tester · failed round keeps the message, retry resends it', () => {
  it('marks the message "not delivered" with a retry that resends the same content and reconciles into the transcript', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValueOnce(
      new Error('gateway timeout'),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('gateway timeout')
    // The message survived the failure, in the transcript, flagged.
    const item = within(transcript()).getByRole('listitem')
    expect(item).toHaveTextContent('Add CSV export')
    expect(item).toHaveTextContent('not delivered')
    expect(composer()).toHaveValue('')
    expect(composer()).toBeEnabled()

    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest(FIRST_EXCHANGE),
    )
    fireEvent.click(within(item).getByRole('button', { name: 'retry' }))

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(2),
    )
    // Same content, same conversation, no second start.
    expect(sendFeatureRequestMessage).toHaveBeenNthCalledWith(
      2,
      STARTED_ID,
      'Add CSV export',
    )
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)

    await waitFor(() =>
      expect(screen.queryByText('not delivered')).not.toBeInTheDocument(),
    )
    expect(screen.getAllByText('Add CSV export')).toHaveLength(1)
    expect(transcriptItems()).toHaveLength(3)
  })

  it('two failed messages coexist and each retry resends its own content', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage)
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockRejectedValueOnce(new Error('gateway timeout'))
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')
    await screen.findByRole('alert')
    typeAndSend('Excel too, please')
    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(2),
    )

    // Both undelivered messages stand in the transcript, each with its own
    // retry control.
    const failed = transcriptItems().filter((li) =>
      /not delivered/.test(li.textContent),
    )
    expect(failed).toHaveLength(2)
    expect(failed[0]).toHaveTextContent('Add CSV export')
    expect(failed[1]).toHaveTextContent('Excel too, please')

    // Retry the SECOND one: only its content is resent.
    vi.mocked(sendFeatureRequestMessage).mockResolvedValueOnce(
      makeRequest([
        { role: 'user', content: 'Excel too, please' },
        { role: 'product-owner', content: 'Noted' },
      ]),
    )
    fireEvent.click(within(failed[1]).getByRole('button', { name: 'retry' }))
    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenNthCalledWith(
        3,
        STARTED_ID,
        'Excel too, please',
      ),
    )
    await waitFor(() =>
      expect(screen.getAllByText('Excel too, please')).toHaveLength(1),
    )
    // The first failure is still there, still retryable.
    const stillFailed = transcriptItems().filter((li) =>
      /not delivered/.test(li.textContent),
    )
    expect(stillFailed).toHaveLength(1)
    expect(stillFailed[0]).toHaveTextContent('Add CSV export')

    // Retry the FIRST one: its own content goes out.
    vi.mocked(sendFeatureRequestMessage).mockResolvedValueOnce(
      makeRequest([
        { role: 'user', content: 'Excel too, please' },
        { role: 'product-owner', content: 'Noted' },
        { role: 'user', content: 'Add CSV export' },
        { role: 'product-owner', content: 'CSV noted as well' },
      ]),
    )
    fireEvent.click(
      within(stillFailed[0]).getByRole('button', { name: 'retry' }),
    )
    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenNthCalledWith(
        4,
        STARTED_ID,
        'Add CSV export',
      ),
    )
    await waitFor(() =>
      expect(screen.queryByText('not delivered')).not.toBeInTheDocument(),
    )
    expect(screen.getAllByText('Add CSV export')).toHaveLength(1)
    expect(screen.getAllByText('Excel too, please')).toHaveLength(1)
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
  })

  it('QUOTA_EXHAUSTED: friendly panel, composer disabled (DAN-54 behavior), and the retry control disabled with it', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(quotaError())
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/out of AI quota/i)
    // The friendly panel, not the raw gateway message.
    expect(
      screen.queryByText('AI request quota exhausted'),
    ).not.toBeInTheDocument()
    expect(composer()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    // The message is still visible (not eaten), and the retry control is
    // disabled in lockstep with the composer — the UI does not offer a resend
    // it knows would be refused.
    const item = within(transcript()).getByRole('listitem')
    expect(item).toHaveTextContent('Add CSV export')
    expect(item).toHaveTextContent('not delivered')
    expect(within(item).getByRole('button', { name: 'retry' })).toBeDisabled()
  })
})

describe('DAN-67 tester · in-flight lockout (no interleaved second send)', () => {
  it('while a round hangs the composer and Send are disabled, and a forced submit sends nothing extra', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    const { container } = render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')
    await waitFor(() => expect(composer()).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    // Even a programmatic submit (keyboard, form quirks) cannot start a
    // second round while the first is in flight.
    fireEvent.submit(container.querySelector('form.chat-composer'))
    expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(1)
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)

    d.resolve(makeRequest(FIRST_EXCHANGE))
    await waitFor(() => expect(composer()).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(1)
  })

  it('a retry control is disabled while another round is in flight', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValueOnce(
      new Error('gateway timeout'),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')
    await screen.findByRole('alert')

    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    typeAndSend('Excel too, please')

    // The first failure's retry cannot fire mid-flight.
    const failed = transcriptItems().find((li) =>
      /not delivered/.test(li.textContent),
    )
    expect(
      within(failed).getByRole('button', { name: 'retry' }),
    ).toBeDisabled()

    d.resolve(
      makeRequest([
        { role: 'user', content: 'Excel too, please' },
        { role: 'product-owner', content: 'Noted' },
      ]),
    )
    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    )
    // Once settled, the surviving failure's retry re-enables.
    const stillFailed = transcriptItems().find((li) =>
      /not delivered/.test(li.textContent),
    )
    expect(
      within(stillFailed).getByRole('button', { name: 'retry' }),
    ).toBeEnabled()
  })
})

describe('DAN-67 tester · role labels and grouping', () => {
  it('labels every delivered message with its role inside its own transcript item', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest(FIRST_EXCHANGE),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Add CSV export')

    await waitFor(() => expect(transcriptItems()).toHaveLength(3))
    const items = transcriptItems()
    expect(within(items[0]).getByText('user')).toBeInTheDocument()
    expect(within(items[0]).getByText('Add CSV export')).toBeInTheDocument()
    expect(within(items[1]).getByText('product-owner')).toBeInTheDocument()
    expect(
      within(items[1]).getByText('Slicing this into a ticket'),
    ).toBeInTheDocument()
    expect(within(items[2]).getByText('architect')).toBeInTheDocument()
    expect(
      within(items[2]).getByText('Stream it from the backend'),
    ).toBeInTheDocument()
  })
})

describe('DAN-67 tester · auto-scroll to the newest message', () => {
  it('fires on the optimistic append / thinking indicator and again when the reply lands', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    render(<FeatureRequestView onBack={() => {}} />)

    // No transcript yet, nothing scrolled.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()

    typeAndSend('Add CSV export')
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled(),
    )
    const duringFlight =
      vi.mocked(Element.prototype.scrollIntoView).mock.calls.length

    d.resolve(makeRequest(FIRST_EXCHANGE))
    await waitFor(() =>
      expect(
        vi.mocked(Element.prototype.scrollIntoView).mock.calls.length,
      ).toBeGreaterThan(duringFlight),
    )
  })
})
