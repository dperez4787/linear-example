import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-54: the model picker, the entrance-criteria checklist, the quota meter,
// the friendly quota-exhausted state, and the Approve button — tested against a
// mocked api.js exactly as the DAN-53 suite does: no fetch, no Firebase, and
// everything asserted via roles and accessible text, never styles.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
}))

// A FeatureRequest in the agreed DAN-50/51 shape: entranceCriteria is null
// until the first evaluation, approvable is a Boolean the server owns.
function makeRequest(overrides = {}) {
  return {
    id: 'fr1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z',
    messages: [],
    entranceCriteria: null,
    approvable: false,
    ...overrides,
  }
}

const passingCriteria = {
  notTooBig: { pass: true, reason: 'Fits in a single ticket' },
  notAmbiguous: { pass: true, reason: 'Scope is concrete' },
  noBlockedDependencies: { pass: true, reason: 'No dependencies are blocked' },
}

const failingCriteria = {
  notTooBig: { pass: false, reason: 'Needs to be split into two tickets' },
  notAmbiguous: { pass: true, reason: 'Scope is concrete' },
  noBlockedDependencies: {
    pass: false,
    reason: 'Depends on DAN-40, which is blocked',
  },
}

const firstExchange = [
  { role: 'user', content: 'Please add CSV export' },
  { role: 'product-owner', content: 'I will slice this into a ticket' },
]

// A rejection shaped exactly as api.js throws it: the GraphQL error's
// extensions attached to the Error, code QUOTA_EXHAUSTED.
function quotaError() {
  const err = new Error('Ran out of AI budget for this billing period')
  err.extensions = { code: 'QUOTA_EXHAUSTED' }
  return err
}

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 3, totalTokens: 1200 })
})

function typeAndSend(text) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('DAN-54 model picker', () => {
  // DAN-66: the three former coming-soon models are live through the gateway
  // now, so this asserts all four roster models as enabled radios rather than
  // claude-opus-5 alone.
  it('offers all four roster models selectable, claude-opus-5 checked by default, and the tools as display-only text', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    // Let the mount-time usage fetch settle so the test stays act()-quiet.
    await screen.findByText('Requests')

    const opus = screen.getByRole('radio', { name: 'claude-opus-5' })
    expect(opus).toBeEnabled()
    expect(opus).toBeChecked()

    for (const name of ['gpt-5.6-terra', 'gemini-3.6-flash', 'gpt-oss-120b']) {
      const radio = screen.getByRole('radio', { name })
      expect(radio).toBeEnabled()
      expect(radio).not.toBeChecked()
    }

    for (const name of ['Copilot', 'Cursor', 'Amp']) {
      // Present as text, but with no selectable control at all.
      expect(screen.getByText(`${name} (display only)`)).toBeInTheDocument()
      expect(
        screen.queryByRole('radio', { name: new RegExp(name) }),
      ).not.toBeInTheDocument()
    }

    // Exactly the four model radios — the tools never gain an input.
    expect(screen.getAllByRole('radio')).toHaveLength(4)
  })

  it('locks the whole picker once the session starts', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({ messages: firstExchange }),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    await screen.findByRole('list', { name: 'Conversation' })

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled()
    }
    expect(startFeatureRequest).toHaveBeenCalledWith('claude-opus-5')
  })
})

describe('DAN-54 entrance-criteria checklist', () => {
  it('names the three gates as not-yet-evaluated before the first evaluation', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    // Let the mount-time usage fetch settle so the test stays act()-quiet.
    await screen.findByText('Requests')

    const checklist = screen.getByRole('region', { name: 'Entrance criteria' })
    const items = within(checklist).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('not-too-big')
    expect(items[1]).toHaveTextContent('not-ambiguous')
    expect(items[2]).toHaveTextContent('no-blocked-dependencies')
    for (const item of items) {
      expect(item).toHaveTextContent('Not yet evaluated')
    }
  })

  it('shows pass/fail state and the reason text from entranceCriteria after an exchange', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({ messages: firstExchange, entranceCriteria: failingCriteria }),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    await screen.findByRole('list', { name: 'Conversation' })

    const checklist = screen.getByRole('region', { name: 'Entrance criteria' })
    const items = within(checklist).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('not-too-big')
    expect(items[0]).toHaveTextContent('Fail')
    expect(items[0]).toHaveTextContent('Needs to be split into two tickets')
    expect(items[1]).toHaveTextContent('not-ambiguous')
    expect(items[1]).toHaveTextContent('Pass')
    expect(items[1]).toHaveTextContent('Scope is concrete')
    expect(items[2]).toHaveTextContent('no-blocked-dependencies')
    expect(items[2]).toHaveTextContent('Fail')
    expect(items[2]).toHaveTextContent('Depends on DAN-40, which is blocked')
  })

  it('updates after every exchange', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValueOnce(
      makeRequest({ messages: firstExchange, entranceCriteria: failingCriteria }),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    await screen.findByRole('list', { name: 'Conversation' })
    expect(
      screen.getByRole('region', { name: 'Entrance criteria' }),
    ).toHaveTextContent('Needs to be split into two tickets')

    vi.mocked(sendFeatureRequestMessage).mockResolvedValueOnce(
      makeRequest({
        messages: [...firstExchange, { role: 'user', content: 'Split it, then' }],
        entranceCriteria: passingCriteria,
        approvable: true,
      }),
    )
    typeAndSend('Split it, then')

    const checklist = screen.getByRole('region', { name: 'Entrance criteria' })
    await waitFor(() =>
      expect(checklist).toHaveTextContent('Fits in a single ticket'),
    )
    expect(checklist).not.toHaveTextContent('Needs to be split into two tickets')
    const items = within(checklist).getAllByRole('listitem')
    for (const item of items) {
      expect(item).toHaveTextContent('Pass')
    }
  })
})

describe('DAN-54 quota meter', () => {
  it('shows myAiUsage requests and totalTokens on mount', async () => {
    render(<FeatureRequestView onBack={() => {}} />)

    const meter = screen.getByRole('region', { name: 'AI usage' })
    await waitFor(() => expect(meter).toHaveTextContent('Requests'))
    expect(meter).toHaveTextContent('3')
    expect(meter).toHaveTextContent('Tokens')
    expect(meter).toHaveTextContent('1200')
  })

  it('refreshes after each exchange', async () => {
    vi.mocked(myAiUsage)
      .mockResolvedValueOnce({ requests: 3, totalTokens: 1200 })
      .mockResolvedValueOnce({ requests: 4, totalTokens: 1950 })
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({ messages: firstExchange }),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    const meter = screen.getByRole('region', { name: 'AI usage' })
    await waitFor(() => expect(meter).toHaveTextContent('1200'))

    typeAndSend('Please add CSV export')

    await waitFor(() => expect(meter).toHaveTextContent('1950'))
    expect(meter).toHaveTextContent('4')
    expect(myAiUsage).toHaveBeenCalledTimes(2)
  })
})

describe('DAN-54 quota exhaustion', () => {
  it('replaces the raw error with a friendly panel and disables the input when a send rejects with QUOTA_EXHAUSTED', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(quotaError())
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('out of AI quota')
    // The raw server message is replaced, not echoed.
    expect(
      screen.queryByText('Ran out of AI budget for this billing period'),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('keeps the generic DAN-53 message for every other error', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(
      new Error('Internal Server Error'),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Internal Server Error')
    expect(screen.getByLabelText('Message')).toBeEnabled()
  })
})

describe('DAN-54 approve', () => {
  it('renders the Approve button disabled while approvable is false', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({
        messages: firstExchange,
        entranceCriteria: failingCriteria,
        approvable: false,
      }),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    // Disabled before any session exists…
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeDisabled()

    typeAndSend('Please add CSV export')
    await screen.findByRole('list', { name: 'Conversation' })

    // …and still disabled while the server says the gates do not all pass.
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeDisabled()
    expect(approveFeatureRequestPlan).not.toHaveBeenCalled()
  })

  it('enables when approvable, calls approveFeatureRequestPlan(id), and shows the building hand-off on success', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({
        messages: firstExchange,
        entranceCriteria: passingCriteria,
        approvable: true,
      }),
    )
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue(
      makeRequest({
        status: 'building',
        messages: firstExchange,
        entranceCriteria: passingCriteria,
        approvable: false,
      }),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    await screen.findByRole('list', { name: 'Conversation' })

    const approve = screen.getByRole('button', { name: 'Approve plan' })
    expect(approve).toBeEnabled()
    fireEvent.click(approve)

    await waitFor(() =>
      expect(approveFeatureRequestPlan).toHaveBeenCalledWith('fr1'),
    )
    const handOff = await screen.findByRole('status')
    expect(handOff).toHaveTextContent(/building/i)
    // The conversation is handed off: no composer, no further approval.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Approve plan' }),
    ).not.toBeInTheDocument()
  })

  it('surfaces an approval failure as the generic alert and re-enables the button', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({
        messages: firstExchange,
        entranceCriteria: passingCriteria,
        approvable: true,
      }),
    )
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      new Error('feature request not found'),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    typeAndSend('Please add CSV export')
    await screen.findByRole('list', { name: 'Conversation' })

    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('feature request not found')
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeEnabled()
  })
})
