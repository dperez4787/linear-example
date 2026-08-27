// DAN-94 TESTER · independent verification of the terminal status at the two
// surfaces a user actually sees it: the My-requests row, and the session view
// that must still open its build DAG once the work has shipped.
//
// Written from the acceptance criteria. Two things the criteria are explicit
// about, and that this suite therefore refuses to take on trust:
//
//  1. "renders it distinctly from building and gathering" — a chip that merely
//     RENDERS for a shipped session proves nothing, because the component
//     interpolates whatever string the server sends. So the assertions here
//     compare the three states against each other: three different words AND
//     three different modifier classes, with the shipped chip's class checked
//     for not being any of the other two. Colours are not asserted (repo rule:
//     tests do not assert on styles) — the class is the hook, the word is the
//     signal.
//  2. "the build view still opens for a shipped session and shows its
//     completed DAG" — asserted as the DAG being there AND the chat surface
//     being gone, in the same test, so a view that rendered both would fail.
//
// api.js is mocked, the DAN-55/74/91 idiom.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  featureRequest,
  featureRequestActivity,
  featureRequestCost,
  featureRequestProgress,
  listFeatureRequests,
  myAiUsage,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'
import MyRequests from './MyRequests.jsx'

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

const PASSING_CRITERIA = {
  notTooBig: { pass: true, reason: 'Fits in a handful of tickets' },
  notAmbiguous: { pass: true, reason: 'Scope is concrete' },
  noBlockedDependencies: { pass: true, reason: 'Nothing is blocked' },
}

function session(overrides = {}) {
  return {
    id: 'fr-t94',
    status: 'gathering',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T09:00:00.000Z',
    title: null,
    messages: [
      { role: 'user', content: 'Please add CSV export' },
      { role: 'product-owner', content: 'Filed as tickets.' },
    ],
    entranceCriteria: PASSING_CRITERIA,
    approvable: false,
    linearProjectUrl: 'https://linear.app/fixture/project/csv-export',
    ...overrides,
  }
}

const DONE_NODES = [
  {
    issueId: 'iss-1',
    identifier: 'DAN-301',
    title: 'Backend contract',
    state: 'DONE',
    issueUrl: 'https://linear.app/fixture/issue/DAN-301',
    prUrl: 'https://github.com/dperez4787/linear-example/pull/301',
    blockedBy: [],
  },
  {
    issueId: 'iss-2',
    identifier: 'DAN-302',
    title: 'Frontend view',
    state: 'DONE',
    issueUrl: 'https://linear.app/fixture/issue/DAN-302',
    prUrl: null,
    blockedBy: ['iss-1'],
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 3, totalTokens: 1200 })
  vi.mocked(featureRequestProgress).mockResolvedValue(DONE_NODES)
  vi.mocked(featureRequestCost).mockResolvedValue({
    calls: 4,
    tokensIn: 900,
    tokensOut: 300,
    costUsd: 0.0421,
  })
  vi.mocked(featureRequestActivity).mockResolvedValue([])
})

// --- My requests: three states, three appearances ----------------------------

describe('DAN-94 tester · the My-requests row renders the terminal status distinctly', () => {
  const SHIPPED = session({
    id: 'fr-shipped',
    status: 'shipped',
    title: 'add_csv_export',
    createdAt: '2026-08-27T12:00:00.000Z',
  })
  const BUILDING = session({
    id: 'fr-building',
    status: 'building',
    title: 'add_dark_mode',
    createdAt: '2026-08-27T11:00:00.000Z',
  })
  const GATHERING = session({
    id: 'fr-gathering',
    status: 'gathering',
    title: 'rename_the_widget',
    createdAt: '2026-08-27T10:00:00.000Z',
  })

  const chipInRowLabelled = async (label) => {
    const title = await screen.findByText(label)
    const row = title.closest('button')
    return within(row)
      .getAllByText(/^(shipped|building|gathering)$/)
      .at(0)
  }

  beforeEach(() => {
    vi.mocked(listFeatureRequests).mockResolvedValue([SHIPPED, BUILDING, GATHERING])
  })

  it('shows the shipped session as shipped — not as building, and not as gathering', async () => {
    render(<MyRequests onOpen={() => {}} />)

    const shippedTitle = await screen.findByText('add_csv_export')
    const row = within(shippedTitle.closest('button'))
    expect(row.getByText('shipped')).toBeTruthy()
    expect(row.queryByText('building')).toBeNull()
    expect(row.queryByText('gathering')).toBeNull()
  })

  it('gives the three states three different words and three different classes', async () => {
    render(<MyRequests onOpen={() => {}} />)
    await screen.findByText('add_csv_export')

    const shipped = await chipInRowLabelled('add_csv_export')
    const building = await chipInRowLabelled('add_dark_mode')
    const gathering = await chipInRowLabelled('rename_the_widget')

    // The words.
    const words = [shipped, building, gathering].map((el) => el.textContent.trim())
    expect(words).toEqual(['shipped', 'building', 'gathering'])
    expect(new Set(words).size).toBe(3)

    // The classes. Not "shipped has a class" — shipped's class differs from
    // both of the others', which is what "distinctly" means.
    const classes = [shipped, building, gathering].map((el) => el.className)
    expect(new Set(classes).size).toBe(3)
    expect(shipped.className).not.toBe(building.className)
    expect(shipped.className).not.toBe(gathering.className)
    expect(shipped.className).toContain('my-requests__status--shipped')
    expect(shipped.className).not.toContain('--building')
    expect(shipped.className).not.toContain('--gathering')
  })

  it('the stylesheet gives the shipped chip its own rule, not the building one', () => {
    // The class is only a distinction if something hangs off it. Read as text
    // rather than asserting a computed colour: jsdom resolves neither var()
    // nor cascade, and the claim under test is "there is a separate rule with
    // a different declaration", not "it is purple".
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'),
      'utf8',
    )
    const bodyOf = (selector) => {
      const at = css.indexOf(`${selector} {`)
      expect(at, `${selector} has its own rule`).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    const shipped = bodyOf('.my-requests__status--shipped')
    const building = bodyOf('.my-requests__status--building')
    const gathering = css.includes('.my-requests__status--gathering {')
      ? bodyOf('.my-requests__status--gathering')
      : '' // gathering inherits the chip's base colour — still a third look.
    expect(shipped).not.toEqual(building)
    expect(shipped).not.toEqual(gathering)
  })

  it('opening a shipped row hands the whole shipped request to the caller', async () => {
    const onOpen = vi.fn()
    render(<MyRequests onOpen={onOpen} />)
    const title = await screen.findByText('add_csv_export')
    title.closest('button').click()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0].status).toBe('shipped')
  })
})

// --- the session view: a shipped session opens its finished DAG --------------

describe('DAN-94 tester · a shipped session opens the build view, complete', () => {
  it('mounts the DAG, shows it complete, and shows every node done', async () => {
    vi.mocked(featureRequest).mockResolvedValue(
      session({ id: 'fr-shipped', status: 'shipped', title: 'add_csv_export' }),
    )
    render(<FeatureRequestView onBack={() => {}} requestId="fr-shipped" />)

    const build = await screen.findByRole('region', { name: 'Build progress' })
    expect(within(build).getByText(/Build complete/)).toBeTruthy()
    expect(within(build).queryByText(/the team is building this feature/)).toBeNull()
    expect(within(build).getByText('DAN-301')).toBeTruthy()
    expect(within(build).getByText('DAN-302')).toBeTruthy()
    expect(within(build).getAllByText('done')).toHaveLength(2)
    // The DAG polled for THIS session.
    expect(featureRequestProgress).toHaveBeenCalledWith('fr-shipped')
  })

  it('takes the composer and the Approve button away, exactly as a building session does', async () => {
    // The read-only surfaces a finished session keeps (the historical
    // transcript above the DAG) are DAN-55's existing behaviour and stay; what
    // must go are the two controls that would act on a session nobody can act
    // on any more.
    vi.mocked(featureRequest).mockResolvedValue(
      session({ id: 'fr-shipped', status: 'shipped', approvable: true }),
    )
    render(<FeatureRequestView onBack={() => {}} requestId="fr-shipped" />)

    await screen.findByRole('region', { name: 'Build progress' })
    // approvable:true on purpose — a stale server flag must not resurrect the
    // button once the session is past gathering, because the backend refuses
    // approval outside gathering and the button would promise a lie.
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
    // The transcript is still there, read-only — losing the record would trade
    // one bug for another.
    expect(screen.getByRole('list', { name: 'Conversation' })).toBeTruthy()
  })

  it('is the same hand-off a building session gets — the DAG just reads unfinished', async () => {
    vi.mocked(featureRequest).mockResolvedValue(
      session({ id: 'fr-building', status: 'building' }),
    )
    vi.mocked(featureRequestProgress).mockResolvedValue([
      { ...DONE_NODES[0], state: 'IN_PROGRESS' },
      DONE_NODES[1],
    ])
    render(<FeatureRequestView onBack={() => {}} requestId="fr-building" />)

    const build = await screen.findByRole('region', { name: 'Build progress' })
    expect(within(build).getByText(/the team is building this feature/)).toBeTruthy()
    expect(within(build).queryByText(/Build complete/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
  })

  it('a gathering session is untouched: chat, Approve, and no progress call', async () => {
    vi.mocked(featureRequest).mockResolvedValue(
      session({ id: 'fr-gathering', status: 'gathering', approvable: true }),
    )
    render(<FeatureRequestView onBack={() => {}} requestId="fr-gathering" />)

    expect(await screen.findByRole('button', { name: 'Approve plan' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Build progress' })).toBeNull()
    expect(featureRequestProgress).not.toHaveBeenCalled()
  })

  it('an unknown status is NOT treated as a build hand-off — the vocabulary is closed', async () => {
    // The regression this guards: "anything that is not gathering shows the
    // DAG" would pass every test above and quietly mount the build view for a
    // status nobody has designed for.
    vi.mocked(featureRequest).mockResolvedValue(
      session({ id: 'fr-weird', status: 'archived' }),
    )
    render(<FeatureRequestView onBack={() => {}} requestId="fr-weird" />)

    await screen.findByText('Please add CSV export')
    expect(screen.queryByRole('region', { name: 'Build progress' })).toBeNull()
    expect(featureRequestProgress).not.toHaveBeenCalled()
  })
})
