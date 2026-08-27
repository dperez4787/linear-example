import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  featureRequestProgress,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-55: approving in DAN-54's flow hands the view off to the live build DAG —
// the composer is gone and WatchBuild polls featureRequestProgress with the
// approved request's id. Mocked api.js, accessible-text assertions, same idiom
// as the DAN-53/54 suites.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(),
}))

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
    createdAt: '2026-08-26T00:00:00.000Z',
    messages: [],
    entranceCriteria: null,
    approvable: false,
    ...overrides,
  }
}

const exchange = [
  { role: 'user', content: 'Please add CSV export' },
  { role: 'product-owner', content: 'Filed as tickets' },
]

const progress = [
  {
    issueId: 'iss-67',
    identifier: 'DAN-67',
    title: 'Backend contract',
    state: 'DONE',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-67',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/61',
    blockedBy: [],
  },
  {
    issueId: 'iss-68',
    identifier: 'DAN-68',
    title: 'API layer',
    state: 'IN_PROGRESS',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-68',
    prUrl: null,
    blockedBy: ['DAN-67'],
  },
]

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 3, totalTokens: 1200 })
})

describe('DAN-55 hand-off from approval', () => {
  it('approving swaps the composer for the build DAG, polling with the approved request id', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest({
        messages: exchange,
        entranceCriteria: passingCriteria,
        approvable: true,
      }),
    )
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue(
      makeRequest({
        status: 'building',
        messages: exchange,
        entranceCriteria: passingCriteria,
      }),
    )
    vi.mocked(featureRequestProgress).mockResolvedValue(progress)
    render(<FeatureRequestView onBack={() => {}} />)

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Please add CSV export' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('list', { name: 'Conversation' })

    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))

    // The DAG view mounts and polls progress for this request.
    await screen.findByRole('region', { name: 'Build progress' })
    await waitFor(() =>
      expect(featureRequestProgress).toHaveBeenCalledWith('fr1'),
    )
    const issueLink = await screen.findByRole('link', { name: 'DAN-68' })
    expect(issueLink).toHaveAttribute(
      'href',
      'https://linear.app/daniel-perez/issue/DAN-68',
    )
    // Handed off: no composer, no approve button.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Approve plan' }),
    ).not.toBeInTheDocument()
  })
})
