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

// DAN-76: proper error handling for plan approval failures. Before this
// ticket a failed approveFeatureRequestPlan rendered as a bare "Internal
// Server Error" line under the transcript; now it renders as a styled
// role="alert" panel next to the Approve button, the button stays enabled,
// and a second click re-attempts. Mocked api.js, roles and accessible text
// only, exactly as the DAN-53/54/66/67 suites do — the panel's visual
// styling is CSS and therefore user-attested, per the repo convention that
// tests never assert styles.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  // WatchBuild mounts on the success hand-off and polls these.
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
}))

const GENERIC_COPY = "Couldn't file the plan — nothing was created. Try again."

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

const firstExchange = [
  { role: 'user', content: 'Please add CSV export' },
  { role: 'product-owner', content: 'I will slice this into a ticket' },
]

// Rejections shaped exactly as api.js throws them: the GraphQL error's
// extensions object attached to the Error, so callers branch on
// extensions.code.
function gqlError(message, code) {
  const err = new Error(message)
  if (code) err.extensions = { code }
  return err
}

const buildingRequest = () =>
  makeRequest({
    status: 'building',
    messages: firstExchange,
    entranceCriteria: passingCriteria,
    approvable: false,
  })

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 3, totalTokens: 1200 })
  vi.mocked(featureRequestProgress).mockResolvedValue([])
  vi.mocked(featureRequestCost).mockResolvedValue(null)
})

// Drive the view to the approvable state: one delivered exchange whose
// server verdict passes every gate.
async function reachApprovable() {
  vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
  vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
    makeRequest({
      messages: firstExchange,
      entranceCriteria: passingCriteria,
      approvable: true,
    }),
  )
  render(<FeatureRequestView onBack={() => {}} />)
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: 'Please add CSV export' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByRole('list', { name: 'Conversation' })
  const approve = screen.getByRole('button', { name: 'Approve plan' })
  await waitFor(() => expect(approve).toBeEnabled())
  return approve
}

describe('DAN-76 · generic approval failure', () => {
  it('renders the styled alert panel with the retry guidance near the Approve button, not a bare server message', async () => {
    const approve = await reachApprovable()
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      gqlError('Internal Server Error', 'INTERNAL_SERVER_ERROR'),
    )

    fireEvent.click(approve)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(GENERIC_COPY)
    // The server's own text stays visible as the diagnostic detail inside
    // the same panel — no second, bare error line elsewhere.
    expect(alert).toHaveTextContent('Internal Server Error')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // Near the button: the panel lives inside the entrance-criteria section
    // the Approve button belongs to.
    const gates = screen.getByRole('region', { name: 'Entrance criteria' })
    expect(within(gates).getByRole('alert')).toBe(alert)
  })

  it('keeps the Approve button enabled and a second click re-attempts; success clears the panel and hands off to building', async () => {
    const approve = await reachApprovable()
    vi.mocked(approveFeatureRequestPlan)
      .mockRejectedValueOnce(gqlError('Internal Server Error'))
      .mockResolvedValueOnce(buildingRequest())

    fireEvent.click(approve)
    await screen.findByRole('alert')
    expect(approve).toBeEnabled()

    fireEvent.click(approve)

    await waitFor(() =>
      expect(approveFeatureRequestPlan).toHaveBeenCalledTimes(2),
    )
    expect(approveFeatureRequestPlan).toHaveBeenNthCalledWith(2, 'fr1')
    // Success path unchanged: the building hand-off replaces the composer,
    // and the failure panel is gone.
    const handOff = await screen.findByRole('status')
    expect(handOff).toHaveTextContent(/building/i)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(GENERIC_COPY)).not.toBeInTheDocument()
  })

  it('a re-attempt that fails again re-raises the panel (cleared while in flight, so it announces anew)', async () => {
    const approve = await reachApprovable()
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      gqlError('Internal Server Error'),
    )

    fireEvent.click(approve)
    await screen.findByRole('alert')
    fireEvent.click(approve)

    await waitFor(() =>
      expect(approveFeatureRequestPlan).toHaveBeenCalledTimes(2),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_COPY)
    expect(approve).toBeEnabled()
  })
})

describe('DAN-76 · BAD_USER_INPUT approval failure', () => {
  it("shows the server's message text — it is user guidance by design — in the same panel, without the generic headline", async () => {
    const approve = await reachApprovable()
    const guidance =
      'There is no plan to approve yet — keep the conversation going until the architect produces one.'
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      gqlError(guidance, 'BAD_USER_INPUT'),
    )

    fireEvent.click(approve)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(guidance)
    // The guidance IS the message: the generic not-created headline would
    // only muddy it.
    expect(alert).not.toHaveTextContent(GENERIC_COPY)
    // Still retryable: guidance is about what to do next, not a dead end.
    expect(approve).toBeEnabled()
  })
})

describe('DAN-76 · QUOTA_EXHAUSTED approval failure', () => {
  it('keeps the existing friendly quota panel behavior — no approval-failure panel appears', async () => {
    const approve = await reachApprovable()
    vi.mocked(approveFeatureRequestPlan).mockRejectedValue(
      gqlError('AI request quota exhausted', 'QUOTA_EXHAUSTED'),
    )

    fireEvent.click(approve)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/out of AI quota/i)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByText(GENERIC_COPY)).not.toBeInTheDocument()
    expect(
      screen.queryByText('AI request quota exhausted'),
    ).not.toBeInTheDocument()
    // The sticky quota state disables the composer, exactly as before.
    expect(screen.getByLabelText('Message')).toBeDisabled()
  })
})

describe('DAN-76 · success path unchanged', () => {
  it('a first-click success hands off to building with no alert at any point', async () => {
    const approve = await reachApprovable()
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue(buildingRequest())

    fireEvent.click(approve)

    const handOff = await screen.findByRole('status')
    expect(handOff).toHaveTextContent(/building/i)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Approve plan' }),
    ).not.toBeInTheDocument()
  })
})
