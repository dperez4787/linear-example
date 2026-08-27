import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-54 tester suite — independent verification of the ticket's acceptance
// criteria, written against a mocked api.js exactly as the project's component
// tests do (no fetch, no Firebase). Everything is asserted through roles and
// accessible text. The developer's own suite lives in
// FeatureRequestView.dan54.test.jsx; this file deliberately re-derives the
// criteria rather than trusting it, with extra weight on the negative space:
// disabled entries that must not become selected, the locked picker, the
// selected-model plumbing, verdicts that must *swap* between exchanges, and
// failure paths that must leave the view usable.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
}))

// DAN-66 graduated the former coming-soon models to selectable radios — the
// gateway now serves all four and the backend accepts them (DAN-65). The
// criterion-1 assertions below were updated to that reality; the tools remain
// display-only.
const GATEWAY_MODELS = ['gpt-5.6-terra', 'gemini-3.6-flash', 'gpt-oss-120b']
const DISPLAY_ONLY = ['Copilot', 'Cursor', 'Amp']

function makeRequest(overrides = {}) {
  return {
    id: 'fr-tester-1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z',
    messages: [],
    entranceCriteria: null,
    approvable: false,
    ...overrides,
  }
}

// Two distinct verdict fixtures whose reason strings share no substring, so an
// assertion that the old reason is gone cannot pass by accident.
const failingVerdicts = {
  notTooBig: { pass: false, reason: 'Spans four subsystems at once' },
  notAmbiguous: { pass: false, reason: 'Which table is unspecified' },
  noBlockedDependencies: { pass: false, reason: 'Waits on the frozen schema' },
}

const passingVerdicts = {
  notTooBig: { pass: true, reason: 'One component, one ticket' },
  notAmbiguous: { pass: true, reason: 'Concrete acceptance wording' },
  noBlockedDependencies: { pass: true, reason: 'Nothing upstream is blocked' },
}

const exchangeOne = [
  { role: 'user', content: 'Export the table as CSV' },
  { role: 'product-owner', content: 'Sliced into a draft ticket' },
]

function quotaError() {
  const err = new Error('AI request quota exhausted')
  err.extensions = { code: 'QUOTA_EXHAUSTED' }
  return err
}

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 1, totalTokens: 100 })
})

// Wait out the mount-time usage fetch so tests stay act()-quiet.
async function renderSettled(ui) {
  render(ui)
  await screen.findByText('Requests')
}

async function send(user, text) {
  await user.type(screen.getByLabelText('Message'), text)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

const checkedRadioNames = () =>
  screen
    .getAllByRole('radio')
    .filter((r) => r.checked)
    .map((r) => r.value)

describe('DAN-54 tester · criterion 1: model picker', () => {
  it('offers all four roster models as enabled radios (DAN-66); tools have no control at all', async () => {
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    const opus = screen.getByRole('radio', { name: 'claude-opus-5' })
    expect(opus).toBeEnabled()

    for (const name of GATEWAY_MODELS) {
      const radio = screen.getByRole('radio', { name })
      expect(radio).toBeEnabled()
    }
    for (const name of DISPLAY_ONLY) {
      expect(screen.getByText(`${name} (display only)`)).toBeInTheDocument()
    }
    // The three tools never render a form control: the only radios are the
    // four models, and every one of them is enabled pre-session.
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(4)
    expect(radios.filter((r) => !r.disabled)).toHaveLength(4)
  })

  it('clicking a display-only entry never changes the selection or starts a session', async () => {
    const user = userEvent.setup()
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    expect(checkedRadioNames()).toEqual(['claude-opus-5'])

    for (const name of DISPLAY_ONLY) {
      await user.click(screen.getByText(`${name} (display only)`))
      expect(checkedRadioNames()).toEqual(['claude-opus-5'])
    }
    // Nothing above started a session either.
    expect(startFeatureRequest).not.toHaveBeenCalled()
  })

  it('locks the picker as soon as startFeatureRequest resolves, before the first send completes', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    // The send never resolves, so any lock observed here came from the session
    // starting — not from the exchange finishing.
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(new Promise(() => {}))
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    await send(user, 'Export the table as CSV')

    await waitFor(() => {
      for (const radio of screen.getAllByRole('radio')) {
        expect(radio).toBeDisabled()
      }
    })
  })

  it('passes the user-picked model to startFeatureRequest (the picker state, not a hardcoded string)', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({ messages: exchangeOne }),
    )
    // Seed the picker's initial selection through the `model` seam with a
    // sentinel, so the assertion below can only pass if the click on the opus
    // radio actually drove the value sent.
    await renderSettled(
      <FeatureRequestView model="sentinel-initial" onBack={() => {}} />,
    )

    await user.click(screen.getByRole('radio', { name: 'claude-opus-5' }))
    await send(user, 'Export the table as CSV')

    await waitFor(() => expect(startFeatureRequest).toHaveBeenCalledTimes(1))
    expect(startFeatureRequest).toHaveBeenCalledWith('claude-opus-5')
  })

  it('sends the current selection state, not the literal claude-opus-5', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({ messages: exchangeOne }),
    )
    // No click this time: the selection stays the seeded sentinel, and that is
    // what must reach the API. A hardcoded 'claude-opus-5' would fail here.
    await renderSettled(
      <FeatureRequestView model="sentinel-initial" onBack={() => {}} />,
    )

    await send(user, 'Export the table as CSV')

    await waitFor(() => expect(startFeatureRequest).toHaveBeenCalledTimes(1))
    expect(startFeatureRequest).toHaveBeenCalledWith('sentinel-initial')
  })
})

describe('DAN-54 tester · criterion 2: entrance-criteria checklist', () => {
  it('names all three gates and shows Not yet evaluated before any exchange', async () => {
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    const checklist = screen.getByRole('region', { name: 'Entrance criteria' })
    const items = within(checklist).getAllByRole('listitem')
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('not-too-big'),
      expect.stringContaining('not-ambiguous'),
      expect.stringContaining('no-blocked-dependencies'),
    ])
    for (const item of items) {
      expect(item).toHaveTextContent('Not yet evaluated')
    }
  })

  it('renders each verdict and reason after an exchange, then swaps them wholesale on the next exchange', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValueOnce(
      makeRequest({ messages: exchangeOne, entranceCriteria: failingVerdicts }),
    )
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    // Exchange one: all three fail, with the failing reasons verbatim.
    await send(user, 'Export the table as CSV')
    const checklist = screen.getByRole('region', { name: 'Entrance criteria' })
    await waitFor(() =>
      expect(checklist).toHaveTextContent('Spans four subsystems at once'),
    )
    let items = within(checklist).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Fail')
    expect(items[0]).toHaveTextContent('Spans four subsystems at once')
    expect(items[1]).toHaveTextContent('Fail')
    expect(items[1]).toHaveTextContent('Which table is unspecified')
    expect(items[2]).toHaveTextContent('Fail')
    expect(items[2]).toHaveTextContent('Waits on the frozen schema')
    expect(checklist).not.toHaveTextContent('Not yet evaluated')

    // Exchange two: verdicts flip to pass; the old reasons must be gone and
    // the new ones present, row by row.
    vi.mocked(sendFeatureRequestMessage).mockResolvedValueOnce(
      makeRequest({
        messages: [
          ...exchangeOne,
          { role: 'user', content: 'Only the records table, one button' },
        ],
        entranceCriteria: passingVerdicts,
        approvable: true,
      }),
    )
    await send(user, 'Only the records table, one button')

    await waitFor(() =>
      expect(checklist).toHaveTextContent('One component, one ticket'),
    )
    items = within(checklist).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Pass')
    expect(items[0]).not.toHaveTextContent('Spans four subsystems at once')
    expect(items[1]).toHaveTextContent('Pass')
    expect(items[1]).toHaveTextContent('Concrete acceptance wording')
    expect(items[1]).not.toHaveTextContent('Which table is unspecified')
    expect(items[2]).toHaveTextContent('Pass')
    expect(items[2]).toHaveTextContent('Nothing upstream is blocked')
    expect(items[2]).not.toHaveTextContent('Waits on the frozen schema')
  })
})

describe('DAN-54 tester · criterion 3: quota meter', () => {
  it('fetches myAiUsage once on mount and renders requests and totalTokens', async () => {
    vi.mocked(myAiUsage).mockResolvedValue({ requests: 12, totalTokens: 34567 })
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    expect(myAiUsage).toHaveBeenCalledTimes(1)
    const meter = screen.getByRole('region', { name: 'AI usage' })
    expect(meter).toHaveTextContent('12')
    expect(meter).toHaveTextContent('34567')
  })

  it('refreshes after each exchange: a changed ledger renders its new numbers', async () => {
    const user = userEvent.setup()
    vi.mocked(myAiUsage)
      .mockResolvedValueOnce({ requests: 12, totalTokens: 34567 })
      .mockResolvedValueOnce({ requests: 13, totalTokens: 40001 })
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({ messages: exchangeOne }),
    )
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    const meter = screen.getByRole('region', { name: 'AI usage' })
    await waitFor(() => expect(meter).toHaveTextContent('34567'))

    await send(user, 'Export the table as CSV')

    await waitFor(() => expect(meter).toHaveTextContent('40001'))
    expect(meter).toHaveTextContent('13')
    expect(meter).not.toHaveTextContent('34567')
    expect(myAiUsage).toHaveBeenCalledTimes(2)
  })
})

describe('DAN-54 tester · criterion 4: quota exhaustion vs other errors', () => {
  it('QUOTA_EXHAUSTED from sendFeatureRequestMessage shows the friendly panel, hides the raw message, and disables the input', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(quotaError())
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    await send(user, 'Export the table as CSV')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/quota/i)
    expect(alert).not.toHaveTextContent('AI request quota exhausted')
    expect(
      screen.queryByText('AI request quota exhausted'),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('QUOTA_EXHAUSTED from startFeatureRequest produces the same panel', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockRejectedValue(quotaError())
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    await send(user, 'Export the table as CSV')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/quota/i)
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Message')).toBeDisabled()
  })

  it('any other rejection keeps the DAN-53 generic alert and re-enables the input', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(
      new Error('something broke upstream'),
    )
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    await send(user, 'Export the table as CSV')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('something broke upstream')
    // Not the friendly panel — the raw generic message, and typing continues.
    expect(alert).not.toHaveTextContent(/out of AI quota/i)
    expect(screen.getByLabelText('Message')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })
})

describe('DAN-54 tester · criterion 5: approve', () => {
  async function reachApprovable(user, overrides = {}) {
    vi.mocked(startFeatureRequest).mockResolvedValue(
      makeRequest({ id: 'fr-approve-7', ...overrides }),
    )
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({
        id: 'fr-approve-7',
        messages: exchangeOne,
        entranceCriteria: passingVerdicts,
        approvable: true,
        ...overrides,
      }),
    )
    await renderSettled(<FeatureRequestView onBack={() => {}} />)
    await send(user, 'Export the table as CSV')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Approve plan' }),
      ).toBeEnabled(),
    )
  }

  it('is disabled while approvable is false and never calls the mutation', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({
        messages: exchangeOne,
        entranceCriteria: failingVerdicts,
        approvable: false,
      }),
    )
    await renderSettled(<FeatureRequestView onBack={() => {}} />)

    const approve = screen.getByRole('button', { name: 'Approve plan' })
    expect(approve).toBeDisabled()
    await user.click(approve)
    expect(approveFeatureRequestPlan).not.toHaveBeenCalled()

    await send(user, 'Export the table as CSV')
    await screen.findByRole('list', { name: 'Conversation' })
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Approve plan' }))
    expect(approveFeatureRequestPlan).not.toHaveBeenCalled()
  })

  it('when enabled, clicking passes the session id and success shows the building hand-off', async () => {
    const user = userEvent.setup()
    await reachApprovable(user)
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue(
      makeRequest({
        id: 'fr-approve-7',
        status: 'building',
        messages: exchangeOne,
        entranceCriteria: passingVerdicts,
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Approve plan' }))

    await waitFor(() =>
      expect(approveFeatureRequestPlan).toHaveBeenCalledWith('fr-approve-7'),
    )
    expect(approveFeatureRequestPlan).toHaveBeenCalledTimes(1)
    const handOff = await screen.findByRole('status')
    expect(handOff).toHaveTextContent(/building/i)
    // Handed off: the composer is gone rather than merely disabled.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('a rejected approval leaves the view usable: alert shown, button enabled, retry succeeds', async () => {
    const user = userEvent.setup()
    await reachApprovable(user)
    vi.mocked(approveFeatureRequestPlan)
      .mockRejectedValueOnce(new Error('approval failed transiently'))
      .mockResolvedValueOnce(
        makeRequest({
          id: 'fr-approve-7',
          status: 'building',
          messages: exchangeOne,
          entranceCriteria: passingVerdicts,
        }),
      )

    await user.click(screen.getByRole('button', { name: 'Approve plan' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('approval failed transiently')
    const approve = screen.getByRole('button', { name: 'Approve plan' })
    expect(approve).toBeEnabled()
    expect(screen.getByLabelText('Message')).toBeEnabled()

    // The failure was not terminal: the same button retries and succeeds.
    await user.click(approve)
    const handOff = await screen.findByRole('status')
    expect(handOff).toHaveTextContent(/building/i)
  })
})
