import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  featureRequest,
  featureRequestActivity,
  featureRequestCost,
  featureRequestProgress,
  myAiUsage,
} from './api.js'
import FeatureRequestView, { BUILD_HANDOFF_STATUSES } from './FeatureRequestView.jsx'

// DAN-94 at the view level: a session that has reached the terminal "shipped"
// status must still open its build view. The DAG is the record of what was
// built — losing it the moment the work finished would trade one bug for
// another — so a shipped session mounts WatchBuild exactly as a building one
// does, and WatchBuild's existing all-DONE handling renders it complete.
//
// Deep-linked via the DAN-82 `requestId` prop, which is the real cold path a
// user takes when reopening a shipped request from My requests or a bookmark.
// Mocked api.js and accessible-text assertions, same idiom as the DAN-55/81/84
// suites.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
  featureRequestActivity: vi.fn(),
  listFeatureRequests: vi.fn(),
}))

const passingCriteria = {
  notTooBig: { pass: true, reason: 'Fits in a handful of tickets' },
  notAmbiguous: { pass: true, reason: 'Scope is concrete' },
  noBlockedDependencies: { pass: true, reason: 'Nothing is blocked' },
}

function shippedSession(overrides = {}) {
  return {
    id: 'fr-shipped',
    status: 'shipped',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T00:00:00.000Z',
    title: 'add_csv_export',
    messages: [
      { role: 'user', content: 'Please add CSV export' },
      { role: 'product-owner', content: 'Filed as tickets.' },
    ],
    entranceCriteria: passingCriteria,
    approvable: false,
    linearProjectUrl: 'https://linear.app/daniel-perez/project/csv-export',
    ...overrides,
  }
}

// Every filed ticket done — what a shipped session's DAG looks like.
const finishedProgress = [
  {
    issueId: 'iss-1',
    identifier: 'DAN-101',
    title: 'Backend contract',
    state: 'DONE',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-101',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/101',
    blockedBy: [],
  },
  {
    issueId: 'iss-2',
    identifier: 'DAN-102',
    title: 'Frontend view',
    state: 'DONE',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-102',
    prUrl: null,
    blockedBy: ['iss-1'],
  },
]

beforeEach(() => {
  vi.mocked(featureRequest).mockReset()
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(featureRequestActivity).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 9, totalTokens: 4200 })
  vi.mocked(featureRequestProgress).mockResolvedValue(finishedProgress)
  vi.mocked(featureRequestCost).mockResolvedValue({
    calls: 11,
    tokensIn: 8000,
    tokensOut: 3000,
    costUsd: 0.2345,
  })
  vi.mocked(featureRequestActivity).mockResolvedValue([])
})

describe('DAN-94 · a shipped session still opens the build view', () => {
  it('mounts the DAG for a shipped session and shows it complete', async () => {
    vi.mocked(featureRequest).mockResolvedValue(shippedSession())
    render(<FeatureRequestView onBack={() => {}} requestId="fr-shipped" />)

    const build = await screen.findByRole('region', { name: 'Build progress' })
    expect(build).toBeTruthy()
    // The DAG's own completion line, and both nodes rendered done.
    expect(
      await screen.findByText(/Build complete — every ticket is done\./),
    ).toBeTruthy()
    expect(screen.getByText('DAN-101')).toBeTruthy()
    expect(screen.getByText('DAN-102')).toBeTruthy()
    expect(screen.getAllByText('done')).toHaveLength(2)
    // The header pieces a shipped session keeps: its title and its project link.
    expect(screen.getByText('add_csv_export')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View in Linear' })).toBeTruthy()
  })

  it('hides the composer and the Approve button for a shipped session', async () => {
    vi.mocked(featureRequest).mockResolvedValue(shippedSession())
    render(<FeatureRequestView onBack={() => {}} requestId="fr-shipped" />)

    await screen.findByRole('region', { name: 'Build progress' })
    // The backend refuses approval outside "gathering", so the button must not
    // be offered — the same reason it is hidden while building.
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
    expect(screen.queryByLabelText('Message')).toBeNull()
  })

  it('still opens the build view for a building session (no regression)', async () => {
    vi.mocked(featureRequest).mockResolvedValue(
      shippedSession({ id: 'fr-building', status: 'building' }),
    )
    vi.mocked(featureRequestProgress).mockResolvedValue([
      { ...finishedProgress[0], state: 'IN_PROGRESS' },
    ])
    render(<FeatureRequestView onBack={() => {}} requestId="fr-building" />)

    await screen.findByRole('region', { name: 'Build progress' })
    expect(
      screen.getByText(/Plan approved — the team is building this feature\./),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
  })

  it('a gathering session keeps the chat surface, not the DAG', async () => {
    vi.mocked(featureRequest).mockResolvedValue(
      shippedSession({ id: 'fr-gathering', status: 'gathering', approvable: true }),
    )
    render(<FeatureRequestView onBack={() => {}} requestId="fr-gathering" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve plan' })).toBeTruthy()
    })
    expect(screen.queryByRole('region', { name: 'Build progress' })).toBeNull()
    expect(featureRequestProgress).not.toHaveBeenCalled()
  })

  it('the hand-off vocabulary is exactly the two approved-and-filed statuses', () => {
    // Pinned so a fourth status cannot silently start (or stop) mounting the
    // DAG: "gathering" must stay out, and "shipped" must stay in.
    expect(BUILD_HANDOFF_STATUSES).toEqual(['building', 'shipped'])
  })
})
