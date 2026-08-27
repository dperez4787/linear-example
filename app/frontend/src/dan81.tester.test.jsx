import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  featureRequestCost,
  featureRequestProgress,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'
import WatchBuild, { POLL_INTERVAL_MS } from './WatchBuild.jsx'

// DAN-81 tester suite — independent verification against the ticket's
// acceptance criteria, written from the criteria rather than the developer's
// tests. api.js is mocked module-wide (the DAN-49..55 idiom) and every
// assertion goes through accessible text, roles, and attributes — never
// styles. Fake timers advance one POLL_INTERVAL_MS hop at a time, which is
// what lets the "one shared timer, no second cadence" claims be proven rather
// than assumed.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
}))

const LINEAR_URL = 'https://linear.app/tester-org/project/widget-export-9z8y7x'

function ticket(overrides) {
  return {
    issueId: 'iss-t1',
    identifier: 'DAN-95',
    title: 'Tester ticket',
    state: 'IN_PROGRESS',
    issueUrl: 'https://linear.app/tester-org/issue/DAN-95',
    prUrl: null,
    blockedBy: [],
    ...overrides,
  }
}

const ledger = (calls, costUsd) => ({
  calls,
  tokensIn: calls * 700,
  tokensOut: calls * 300,
  costUsd,
})

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(myAiUsage).mockReset()
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 1, totalTokens: 400 })
  vi.mocked(featureRequestProgress).mockResolvedValue([ticket()])
  vi.mocked(featureRequestCost).mockResolvedValue(ledger(7, 0.1234))
})

afterEach(() => {
  vi.useRealTimers()
})

// --- Criterion 1: the Linear link on the building-view header -----------------

describe('DAN-81 tester · Linear link', () => {
  it('renders "View in Linear" with the exact href, target=_blank, and rel containing noopener', async () => {
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)

    const link = await screen.findByRole('link', { name: 'View in Linear' })
    expect(link).toHaveAttribute('href', LINEAR_URL)
    expect(link).toHaveAttribute('target', '_blank')
    // rel must neutralize the opener; noreferrer alone would also do it, but
    // the ticket names noopener — accept it anywhere in the token list.
    expect((link.getAttribute('rel') ?? '').split(/\s+/)).toContain('noopener')
    // It lives in the header region of the build view, not among the DAG nodes.
    const region = screen.getByRole('region', { name: 'Build progress' })
    expect(within(region).getByRole('link', { name: 'View in Linear' })).toBe(link)
  })

  it('renders no Linear link at all when linearProjectUrl is null', async () => {
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={null} />)

    // Wait for the view to be fully rendered before asserting absence.
    await screen.findByRole('link', { name: 'DAN-95' })
    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
    // No stray anchor points at a Linear *project* either (the DAG's issue
    // links are a different, pre-existing surface).
    for (const a of screen.getAllByRole('link')) {
      expect(a.getAttribute('href') ?? '').not.toContain('/project/')
    }
  })

  it('renders no Linear link when the prop is omitted entirely (default)', async () => {
    render(<WatchBuild promptId="fr-t1" />)

    await screen.findByRole('link', { name: 'DAN-95' })
    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
  })
})

// --- Criterion 2: planning-cost formatting ------------------------------------

describe('DAN-81 tester · planning-cost formatting', () => {
  it('renders the cost as $ with exactly four decimals plus the call count', async () => {
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)

    const stat = await screen.findByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.1234')
    expect(stat).toHaveTextContent(/7\s*calls/)
  })

  it('pads short figures to four decimals ($0.5000, not $0.5)', async () => {
    vi.mocked(featureRequestCost).mockResolvedValue(ledger(3, 0.5))
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)

    const stat = await screen.findByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.5000')
    expect(stat).not.toHaveTextContent('$0.5 ')
    expect(stat).toHaveTextContent(/3\s*calls/)
  })

  it('renders a zero-cost ledger as $0.0000 with 0 calls — present, not hidden', async () => {
    vi.mocked(featureRequestCost).mockResolvedValue({
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    })
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)

    const stat = await screen.findByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.0000')
    expect(stat).toHaveTextContent(/0\s*calls/)
  })

  it('shows no stat before the first successful cost read (server has no ledger yet)', async () => {
    vi.mocked(featureRequestCost).mockResolvedValue(null)
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)

    await screen.findByRole('link', { name: 'DAN-95' })
    expect(screen.queryByText(/Planning cost/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument()
  })
})

// --- Criterion 3: the stat refreshes on the progress poll tick ----------------

describe('DAN-81 tester · poll-tick refresh', () => {
  it('advances the cost read in lockstep with the progress poll — no extra timer at any cadence', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)

    // Mount tick: exactly one of each, cost keyed by the promptId.
    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestCost).toHaveBeenCalledTimes(1)
    expect(featureRequestCost).toHaveBeenCalledWith('fr-t1')
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')

    // Anything short of a full interval fires nothing — if a second timer
    // existed at its own cadence, this window would catch it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestCost).toHaveBeenCalledTimes(1)

    // The final millisecond of hop 1: both fire together and the stat updates.
    vi.mocked(featureRequestCost).mockResolvedValue(ledger(9, 0.2018))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestCost).toHaveBeenCalledTimes(2)
    let stat = screen.getByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.2018')
    expect(stat).toHaveTextContent(/9\s*calls/)

    // Hop 2: still 1:1 with the poll.
    vi.mocked(featureRequestCost).mockResolvedValue(ledger(11, 0.3333))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(3)
    expect(featureRequestCost).toHaveBeenCalledTimes(3)
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.3333')
  })

  it('stops fetching the cost when the poll stops (all tickets DONE) — the ride ends with the timer', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue([
      ticket({ state: 'DONE' }),
    ])
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)

    await act(async () => {})
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestCost).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    })
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(featureRequestCost).toHaveBeenCalledTimes(1)
    // The final tick's figure stays on screen.
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')
  })

  it('makes no further cost reads after unmount and logs no act/state warnings', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error')
    const { unmount } = render(
      <WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />,
    )
    await act(async () => {})
    expect(featureRequestCost).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    })
    expect(featureRequestCost).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

// --- Criterion 4: cost-read failure degrades silently -------------------------

describe('DAN-81 tester · cost-read failure', () => {
  it('keeps the last good figure on failure and never marks the DAG stale', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)

    await act(async () => {})
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument()

    // The cost read fails while the progress poll keeps succeeding: the stat
    // keeps its last value and the stale note — the progress poll's signal —
    // must NOT appear.
    vi.mocked(featureRequestCost).mockRejectedValue(new Error('503'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    const stat = screen.getByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.1234')
    expect(stat).toHaveTextContent(/7\s*calls/)
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument()
    // The DAG itself is untouched.
    expect(screen.getByRole('link', { name: 'DAN-95' })).toBeInTheDocument()

    // Recovery on a later tick updates the figure again.
    vi.mocked(featureRequestCost).mockResolvedValue(ledger(12, 0.4567))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.4567')
  })

  it('a failing cost read alongside a failing poll still shows the stale note only for the poll, keeping both last-good values', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} />)
    await act(async () => {})

    vi.mocked(featureRequestProgress).mockRejectedValue(new Error('502'))
    vi.mocked(featureRequestCost).mockRejectedValue(new Error('502'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    // Stale comes from the progress poll; the DAG and the stat both keep
    // their last good content.
    expect(screen.getByText(/stale/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'DAN-95' })).toBeInTheDocument()
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')
  })
})

// --- Criterion 5: nothing renders (or fetches) pre-approval -------------------

const passingCriteria = {
  notTooBig: { pass: true, reason: 'Fits one ticket' },
  notAmbiguous: { pass: true, reason: 'Concrete scope' },
  noBlockedDependencies: { pass: true, reason: 'Nothing blocked' },
}

function makeRequest(overrides = {}) {
  return {
    id: 'fr-view',
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
  { role: 'user', content: 'Export widgets as CSV' },
  { role: 'product-owner', content: 'Plan drafted' },
]

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
    target: { value: 'Export widgets as CSV' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByRole('list', { name: 'Conversation' })
}

describe('DAN-81 tester · pre-approval view', () => {
  it('shows no Linear link, no cost stat, and never calls featureRequestCost before approval', async () => {
    await reachApprovable()

    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Planning cost/)).not.toBeInTheDocument()
    expect(featureRequestCost).not.toHaveBeenCalled()
    expect(featureRequestProgress).not.toHaveBeenCalled()
  })

  it('after approval, the building view links the request\'s linearProjectUrl and shows the cost', async () => {
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

    const link = await screen.findByRole('link', { name: 'View in Linear' })
    expect(link).toHaveAttribute('href', LINEAR_URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect((link.getAttribute('rel') ?? '').split(/\s+/)).toContain('noopener')

    const stat = await screen.findByText(/Planning cost/)
    expect(stat).toHaveTextContent('$0.1234')
    expect(stat).toHaveTextContent(/7\s*calls/)
    // The cost is fetched for the approved request's id.
    expect(featureRequestCost).toHaveBeenCalledWith('fr-view')
  })

  it('after approval with a null linearProjectUrl, the cost renders but no link does', async () => {
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

    await screen.findByText(/Planning cost/)
    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
  })
})
