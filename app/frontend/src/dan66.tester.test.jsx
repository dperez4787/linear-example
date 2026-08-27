import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sendFeatureRequestMessage, startFeatureRequest, myAiUsage } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-66 tester suite — independent verification of the ticket's acceptance
// criteria, written against a mocked api.js exactly as the DAN-54 tester suite
// is (no fetch, no Firebase; roles and accessible text only). Deliberately
// re-derives the criteria rather than trusting the developer's
// FeatureRequestView.dan66.test.jsx: each roster model is driven through a
// real click-then-send and the exact string reaching startFeatureRequest is
// asserted; the three tools are checked for the *absence* of any form control,
// not just the absence of a radio; and the DAN-54 negative space (session
// lock, quota panel) is re-proved with a non-default model selected, since
// DAN-66 is the first ticket where a non-default selection can exist at all.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
}))

const ROSTER = [
  'claude-opus-5',
  'gpt-5.6-terra',
  'gemini-3.6-flash',
  'gpt-oss-120b',
]
const DISPLAY_ONLY = ['Copilot', 'Cursor', 'Amp']

function makeRequest(overrides = {}) {
  return {
    id: 'fr-tester-66',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T00:00:00.000Z',
    messages: [],
    entranceCriteria: null,
    approvable: false,
    ...overrides,
  }
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
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 1, totalTokens: 100 })
})

// Wait out the mount-time usage fetch so tests stay act()-quiet.
async function renderSettled() {
  render(<FeatureRequestView onBack={() => {}} />)
  await screen.findByText('Requests')
}

async function send(user, text) {
  await user.type(screen.getByLabelText('Message'), text)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

describe('DAN-66 tester · criterion 1: every roster model is selectable and is what starts the session', () => {
  // One test per roster model — including the old default — so a regression
  // that pins any single model (or maps a radio to the wrong value) fails on
  // its own named test.
  for (const model of ROSTER) {
    it(`clicking ${model} pre-session checks it, and Send passes exactly '${model}' to startFeatureRequest`, async () => {
      const user = userEvent.setup()
      vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest({ model }))
      vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
        makeRequest({ model, messages: exchangeOne }),
      )
      await renderSettled()

      const radio = screen.getByRole('radio', { name: model })
      expect(radio).toBeEnabled()
      await user.click(radio)
      expect(radio).toBeChecked()
      // Radios are exclusive: no other roster model stayed checked.
      for (const other of ROSTER.filter((m) => m !== model)) {
        expect(screen.getByRole('radio', { name: other })).not.toBeChecked()
      }

      await send(user, 'Export the table as CSV')

      await waitFor(() => expect(startFeatureRequest).toHaveBeenCalledTimes(1))
      expect(startFeatureRequest).toHaveBeenCalledWith(model)
    })
  }
})

describe('DAN-66 tester · criterion 2: tools stay display-only, picker still locks', () => {
  it('renders exactly four radios and no form control of any kind for Copilot, Cursor, or Amp', async () => {
    await renderSettled()

    // Exactly the roster — nothing graduated in that shouldn't have, and the
    // tools contributed no radio.
    expect(screen.getAllByRole('radio')).toHaveLength(4)

    const picker = screen.getByRole('group', { name: 'Model' })
    for (const name of DISPLAY_ONLY) {
      const row = screen.getByText(`${name} (display only)`)
      expect(picker).toContainElement(row)
      // No input of any kind inside the tool rows — not disabled, absent.
      expect(row.querySelectorAll('input, button, select, textarea')).toHaveLength(0)
    }
    // The picker's only inputs are the four model radios.
    expect(picker.querySelectorAll('input')).toHaveLength(4)
  })

  it('clicking a tool row changes nothing and starts nothing', async () => {
    const user = userEvent.setup()
    await renderSettled()

    for (const name of DISPLAY_ONLY) {
      await user.click(screen.getByText(`${name} (display only)`))
    }
    expect(screen.getByRole('radio', { name: 'claude-opus-5' })).toBeChecked()
    expect(startFeatureRequest).not.toHaveBeenCalled()
  })

  it('locks all four radios once a session starts with a non-default model, which stays the checked one', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(
      makeRequest({ model: 'gpt-oss-120b' }),
    )
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({ model: 'gpt-oss-120b', messages: exchangeOne }),
    )
    await renderSettled()

    await user.click(screen.getByRole('radio', { name: 'gpt-oss-120b' }))
    await send(user, 'Export the table as CSV')
    await screen.findByRole('list', { name: 'Conversation' })

    for (const name of ROSTER) {
      expect(screen.getByRole('radio', { name })).toBeDisabled()
    }
    // The locked-in selection is the one the session started with, not a
    // snap-back to the default.
    expect(screen.getByRole('radio', { name: 'gpt-oss-120b' })).toBeChecked()
    expect(
      screen.getByRole('radio', { name: 'claude-opus-5' }),
    ).not.toBeChecked()
  })
})

describe('DAN-66 tester · criterion 3: DAN-54 behavior holds with a non-default model', () => {
  it('QUOTA_EXHAUSTED still shows the friendly panel and disables the composer when gemini-3.6-flash is selected', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(
      makeRequest({ model: 'gemini-3.6-flash' }),
    )
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(quotaError())
    await renderSettled()

    await user.click(screen.getByRole('radio', { name: 'gemini-3.6-flash' }))
    await send(user, 'Export the table as CSV')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/quota/i)
    expect(alert).not.toHaveTextContent('AI request quota exhausted')
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    // And the session's model selection survived the failure, still locked.
    expect(startFeatureRequest).toHaveBeenCalledWith('gemini-3.6-flash')
    expect(
      screen.getByRole('radio', { name: 'gemini-3.6-flash' }),
    ).toBeChecked()
  })
})
