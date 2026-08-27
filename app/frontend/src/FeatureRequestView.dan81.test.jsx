import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

// DAN-81 at the view level: the Linear link and the planning-cost stat exist
// only on approved sessions — before approval WatchBuild never mounts, so
// neither renders and featureRequestCost is never called. Mocked api.js,
// accessible-text assertions, same idiom as the DAN-55 hand-off suite.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
}))

const LINEAR_URL = 'https://linear.app/daniel-perez/project/csv-export-1a2b3c'

const passingCriteria = {
  notTooBig: { pass: true, reason: 'Fits in a single ticket' },
  notAmbiguous: { pass: true, reason: 'Scope is concrete' },
  noBlockedDependencies: { pass: true, reason: 'No dependencies are blocked' },
}

function makeRequest(overrides = {}) {
  return {
    id: 'fr1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T00:00:00.000Z',
    messages: [],
    entranceCriteria: null,
    approvable: false,
    linearProjectUrl: null,
    ...overrides,
  }
}

const exchange = [
  { role: 'user', content: 'Please add CSV export' },
  { role: 'product-owner', content: 'Filed as tickets' },
]

const progress = [
  {
    issueId: 'iss-1',
    identifier: 'DAN-90',
    title: 'Backend contract',
    state: 'IN_PROGRESS',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-90',
    prUrl: null,
    blockedBy: [],
  },
]

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 3, totalTokens: 1200 })
  vi.mocked(featureRequestProgress).mockResolvedValue(progress)
  vi.mocked(featureRequestCost).mockResolvedValue({
    calls: 7,
    tokensIn: 5120,
    tokensOut: 2048,
    costUsd: 0.1234,
  })
})

// Drive the DAN-53/54 flow up to an approvable plan.
async function reachApprovable() {
  vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
  vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
    makeRequest({
      messages: exchange,
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
}

describe('DAN-81 pre-approval', () => {
  it('shows neither the Linear link nor the cost stat, and never fetches the cost', async () => {
    await reachApprovable()

    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Planning cost/)).not.toBeInTheDocument()
    expect(featureRequestCost).not.toHaveBeenCalled()
  })
})

describe('DAN-81 approved session', () => {
  it('links the building view to the approved request’s linearProjectUrl and shows its planning cost', async () => {
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue(
      makeRequest({
        status: 'building',
        messages: exchange,
        entranceCriteria: passingCriteria,
        linearProjectUrl: LINEAR_URL,
      }),
    )
    await reachApprovable()
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))

    await screen.findByRole('region', { name: 'Build progress' })
    const link = await screen.findByRole('link', { name: 'View in Linear' })
    expect(link).toHaveAttribute('href', LINEAR_URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/\bnoopener\b/)

    await waitFor(() =>
      expect(featureRequestCost).toHaveBeenCalledWith('fr1'),
    )
    const stat = await screen.findByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.1234')
    expect(stat).toHaveTextContent('7 calls')
  })

  it('hides the link (but keeps the cost stat) when linearProjectUrl is null', async () => {
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue(
      makeRequest({
        status: 'building',
        messages: exchange,
        entranceCriteria: passingCriteria,
        linearProjectUrl: null,
      }),
    )
    await reachApprovable()
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))

    await screen.findByRole('region', { name: 'Build progress' })
    await screen.findByText(/Planning cost/)
    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
  })
})
