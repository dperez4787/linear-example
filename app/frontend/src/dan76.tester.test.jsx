import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  featureRequestCost,
  featureRequestProgress,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-76 — independent tester suite (written from the acceptance criteria,
// not from the developer's tests). Verifies:
//   1. generic approval failure -> styled role="alert" panel with the exact
//      required copy, positioned in the entrance-criteria/approve region;
//   2. Approve stays enabled after failure; a second click re-issues the
//      mutation and a retry success hands off to building;
//   3. BAD_USER_INPUT -> the server's own guidance text in the panel;
//   4. QUOTA_EXHAUSTED -> the existing quota panel only, never a second alert;
//   5. success on first try -> no alert, building hand-off;
//   6. regression: send-path errors (DAN-67) still render their own error.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
}))

const REQUIRED_COPY = "Couldn't file the plan — nothing was created. Try again."

const allPass = {
  notTooBig: { pass: true, reason: 'small enough' },
  notAmbiguous: { pass: true, reason: 'clear enough' },
  noBlockedDependencies: { pass: true, reason: 'nothing blocked' },
}

const exchange = [
  { role: 'user', content: 'Add a export button' },
  { role: 'product-owner', content: 'Plan drafted.' },
]

function req(overrides = {}) {
  return {
    id: 'req-1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T00:00:00.000Z',
    messages: [],
    entranceCriteria: null,
    approvable: false,
    ...overrides,
  }
}

// Errors shaped the way api.js gql() throws them: message from the GraphQL
// error, extensions attached when present.
function apiError(message, code) {
  const e = new Error(message)
  if (code) e.extensions = { code }
  return e
}

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(myAiUsage).mockReset().mockResolvedValue({ requests: 1, totalTokens: 42 })
  vi.mocked(featureRequestProgress).mockReset().mockResolvedValue([])
  vi.mocked(featureRequestCost).mockReset().mockResolvedValue(null)
})

// Drive the view to an approvable plan: one delivered round whose server
// verdict passes all gates and flips approvable.
async function renderApprovable() {
  vi.mocked(startFeatureRequest).mockResolvedValue(req())
  vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
    req({ messages: exchange, entranceCriteria: allPass, approvable: true }),
  )
  render(<FeatureRequestView onBack={() => {}} />)
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: 'Add a export button' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  const approve = await screen.findByRole('button', { name: 'Approve plan' })
  await waitFor(() => expect(approve).toBeEnabled())
  return approve
}

describe('DAN-76 tester · generic approval failure', () => {
  it('shows the exact required copy in a role="alert" panel inside the entrance-criteria region', async () => {
    const approve = await renderApprovable()
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      apiError('Internal Server Error', 'INTERNAL_SERVER_ERROR'),
    )

    fireEvent.click(approve)

    const alert = await screen.findByRole('alert')
    // Exact required copy, character for character (em dash included).
    expect(screen.getByText(REQUIRED_COPY)).toBeInTheDocument()
    expect(alert).toHaveTextContent(REQUIRED_COPY)
    // Positioned near the Approve button: inside the entrance-criteria
    // section, which also contains the button.
    const region = screen.getByRole('region', { name: 'Entrance criteria' })
    expect(within(region).getByRole('alert')).toBe(alert)
    expect(within(region).getByRole('button', { name: 'Approve plan' })).toBe(
      approve,
    )
    // Only one alert on the page — no duplicate bare error line elsewhere.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('also failing on a network-style error with no extensions at all', async () => {
    const approve = await renderApprovable()
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      new Error('Failed to fetch'),
    )

    fireEvent.click(approve)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(REQUIRED_COPY)
  })

  it('keeps the Approve button enabled after the failure', async () => {
    const approve = await renderApprovable()
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      apiError('Internal Server Error', 'INTERNAL_SERVER_ERROR'),
    )

    fireEvent.click(approve)

    await screen.findByRole('alert')
    expect(approve).toBeEnabled()
    expect(approve).not.toHaveAttribute('disabled')
  })

  it('a second click re-issues the mutation (call count 2) and a retry success lands in the building view', async () => {
    const approve = await renderApprovable()
    vi.mocked(approveFeatureRequestPlan)
      .mockRejectedValueOnce(apiError('Internal Server Error', 'INTERNAL_SERVER_ERROR'))
      .mockResolvedValueOnce(
        req({
          status: 'building',
          messages: exchange,
          entranceCriteria: allPass,
          approvable: false,
        }),
      )

    fireEvent.click(approve)
    await screen.findByRole('alert')
    expect(approveFeatureRequestPlan).toHaveBeenCalledTimes(1)

    fireEvent.click(approve)

    await waitFor(() =>
      expect(approveFeatureRequestPlan).toHaveBeenCalledTimes(2),
    )
    expect(approveFeatureRequestPlan).toHaveBeenNthCalledWith(1, 'req-1')
    expect(approveFeatureRequestPlan).toHaveBeenNthCalledWith(2, 'req-1')
    // Retry success: the building hand-off appears and the failure panel is gone.
    await screen.findByText(/team is building/i)
    expect(screen.queryByText(REQUIRED_COPY)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Approve plan' }),
    ).not.toBeInTheDocument()
  })
})

describe('DAN-76 tester · BAD_USER_INPUT approval failure', () => {
  it("shows the server's message text in the same alert panel and stays retryable", async () => {
    const approve = await renderApprovable()
    const serverGuidance =
      'No plan exists yet — continue the conversation until the architect drafts one.'
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      apiError(serverGuidance, 'BAD_USER_INPUT'),
    )

    fireEvent.click(approve)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(serverGuidance)
    // Same panel, same place: inside the entrance-criteria region.
    const region = screen.getByRole('region', { name: 'Entrance criteria' })
    expect(within(region).getByRole('alert')).toBe(alert)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // Button remains available for another attempt.
    expect(approve).toBeEnabled()
  })
})

describe('DAN-76 tester · QUOTA_EXHAUSTED approval failure', () => {
  it('keeps the existing quota panel and never raises the approve-error alert (exactly one alert)', async () => {
    const approve = await renderApprovable()
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      apiError('AI request quota exhausted', 'QUOTA_EXHAUSTED'),
    )

    fireEvent.click(approve)

    const alert = await screen.findByRole('alert')
    // The friendly quota panel, exactly as before DAN-76.
    expect(alert).toHaveTextContent(/out of AI quota/i)
    expect(alert).toHaveTextContent(/nothing was lost/i)
    // Never a double alert, and none of the approve-panel copy anywhere.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByText(REQUIRED_COPY)).not.toBeInTheDocument()
    // Sticky quota state still disables the composer (pre-existing behavior).
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('DAN-76 tester · success path unchanged', () => {
  it('first-click success hands off to building with no alert ever shown', async () => {
    const approve = await renderApprovable()
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue(
      req({
        status: 'building',
        messages: exchange,
        entranceCriteria: allPass,
        approvable: false,
      }),
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(approve)

    await screen.findByText(/team is building/i)
    expect(approveFeatureRequestPlan).toHaveBeenCalledTimes(1)
    expect(approveFeatureRequestPlan).toHaveBeenCalledWith('req-1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(REQUIRED_COPY)).not.toBeInTheDocument()
    // Composer is replaced by the hand-off, as before.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })
})

describe('DAN-76 tester · send-path regression (DAN-67 behavior untouched)', () => {
  it('a failed sendMessage still renders its own error and the not-delivered retry row, with no approve-panel copy', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(req())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(
      apiError('Internal Server Error', 'INTERNAL_SERVER_ERROR'),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Add a export button' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // The send error surfaces exactly as before: its own alert carrying the
    // raw server message — not the approve panel's copy.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Internal Server Error')
    expect(screen.queryByText(REQUIRED_COPY)).not.toBeInTheDocument()
    // And the DAN-67 transcript treatment survives: message kept, marked not
    // delivered, with a retry control.
    expect(screen.getByText('Add a export button')).toBeInTheDocument()
    expect(screen.getByText(/not delivered/i)).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'retry' })
    expect(retry).toBeEnabled()

    // Retrying resends the same content against the same conversation.
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      req({ messages: exchange, entranceCriteria: allPass, approvable: true }),
    )
    fireEvent.click(retry)
    await screen.findByRole('button', { name: 'Approve plan' })
    expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(2)
    expect(sendFeatureRequestMessage).toHaveBeenLastCalledWith(
      'req-1',
      'Add a export button',
    )
    expect(screen.queryByText(/not delivered/i)).not.toBeInTheDocument()
  })
})
