import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sendFeatureRequestMessage, startFeatureRequest, myAiUsage } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-66: the full model roster is selectable. The three DAN-54 "coming soon"
// models are live through the gateway and accepted by the backend (DAN-65), so
// the picker now offers all four as enabled radios. Tested against a mocked
// api.js exactly as the DAN-53/54 suites do: no fetch, no Firebase, roles and
// accessible text only. One test per roster model proves the selected value —
// not a hardcoded default — is what reaches startFeatureRequest.
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

function makeRequest(overrides = {}) {
  return {
    id: 'fr-dan66',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T00:00:00.000Z',
    messages: [],
    entranceCriteria: null,
    approvable: false,
    ...overrides,
  }
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

describe('DAN-66 full model roster', () => {
  it('renders all four roster models as enabled radios with claude-opus-5 the default selection', async () => {
    await renderSettled()

    for (const name of ROSTER) {
      expect(screen.getByRole('radio', { name })).toBeEnabled()
    }
    expect(screen.getByRole('radio', { name: 'claude-opus-5' })).toBeChecked()
    // Exactly the roster — the coding tools still contribute no radio.
    expect(screen.getAllByRole('radio')).toHaveLength(ROSTER.length)
  })

  // One test per model: selecting it is what startFeatureRequest receives.
  for (const model of ROSTER) {
    it(`selecting ${model} sends it to startFeatureRequest`, async () => {
      const user = userEvent.setup()
      vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest({ model }))
      vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
        makeRequest({
          model,
          messages: [
            { role: 'user', content: 'Add CSV export' },
            { role: 'product-owner', content: 'Drafting a ticket' },
          ],
        }),
      )
      await renderSettled()

      await user.click(screen.getByRole('radio', { name: model }))
      expect(screen.getByRole('radio', { name: model })).toBeChecked()

      await send(user, 'Add CSV export')

      await waitFor(() => expect(startFeatureRequest).toHaveBeenCalledTimes(1))
      expect(startFeatureRequest).toHaveBeenCalledWith(model)
    })
  }

  it('keeps Copilot, Cursor, and Amp display-only with no input', async () => {
    const user = userEvent.setup()
    await renderSettled()

    for (const name of ['Copilot', 'Cursor', 'Amp']) {
      expect(screen.getByText(`${name} (display only)`)).toBeInTheDocument()
      expect(
        screen.queryByRole('radio', { name: new RegExp(name) }),
      ).not.toBeInTheDocument()
      // Clicking the text row selects nothing and starts nothing.
      await user.click(screen.getByText(`${name} (display only)`))
    }
    expect(screen.getByRole('radio', { name: 'claude-opus-5' })).toBeChecked()
    expect(startFeatureRequest).not.toHaveBeenCalled()
  })

  it('still locks every roster radio once the session starts', async () => {
    const user = userEvent.setup()
    vi.mocked(startFeatureRequest).mockResolvedValue(
      makeRequest({ model: 'gemini-3.6-flash' }),
    )
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({
        model: 'gemini-3.6-flash',
        messages: [
          { role: 'user', content: 'Add CSV export' },
          { role: 'product-owner', content: 'Drafting a ticket' },
        ],
      }),
    )
    await renderSettled()

    await user.click(screen.getByRole('radio', { name: 'gemini-3.6-flash' }))
    await send(user, 'Add CSV export')
    await screen.findByRole('list', { name: 'Conversation' })

    for (const name of ROSTER) {
      expect(screen.getByRole('radio', { name })).toBeDisabled()
    }
    // The locked-in selection is the one the session was started with.
    expect(
      screen.getByRole('radio', { name: 'gemini-3.6-flash' }),
    ).toBeChecked()
  })
})
