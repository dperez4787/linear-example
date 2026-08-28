// DAN-98: unit tests for the scan job's reconciliation + dependent-promotion
// pass (linear-loop-scan.mjs). Zero-dep node:test, mirroring the backend's
// test style. Run with: node --test .github/scripts/
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SCAN_QUERY,
  inScope,
  hasPromptLabel,
  hasPrAttachment,
  allBlockersResolved,
  reconcileCandidates,
  promoteCandidates,
  run,
} from './linear-loop-scan.mjs'

const ENV = {
  LINEAR_API_KEY: 'lin_api_test_key_never_logged',
  LINEAR_TEAM_KEY: 'DAN',
  EXCLUDED_LINEAR_PROJECT: 'ai-gateway',
  STATE_IN_PROGRESS: 'state-in-progress',
  STATE_IN_REVIEW: 'state-in-review',
  STATE_READY_FOR_DEV: 'state-ready-for-dev',
}

// ---------- fixture builders (shape mirrors Linear GraphQL responses) ----------

const labels = (...names) => ({ nodes: names.map((name) => ({ name })) })

const inProgressIssue = (over = {}) => ({
  id: 'issue-95',
  identifier: 'DAN-95',
  project: { name: 'prompt-a-feature' },
  labels: labels('agent:claude', 'prompt:abc123'),
  attachments: { nodes: [{ url: 'https://github.com/dperez4787/linear-example/pull/81' }] },
  ...over,
})

const blockedIssue = (over = {}) => ({
  id: 'issue-96',
  identifier: 'DAN-96',
  state: { id: 'state-todo', type: 'unstarted' },
  project: { name: 'prompt-a-feature' },
  labels: labels('agent:claude', 'prompt:abc123'),
  inverseRelations: {
    nodes: [{ type: 'blocks', issue: { identifier: 'DAN-95', state: { type: 'completed' } } }],
  },
  ...over,
})

// ---------- predicates ----------

test('inScope: known non-excluded project in scope; excluded or unknown project out', () => {
  assert.equal(inScope({ project: { name: 'prompt-a-feature' } }, 'ai-gateway'), true)
  assert.equal(inScope({ project: { name: 'ai-gateway' } }, 'ai-gateway'), false)
  assert.equal(inScope({ project: null }, 'ai-gateway'), false)
  assert.equal(inScope({}, 'ai-gateway'), false)
  assert.equal(inScope({ project: { name: null } }, 'ai-gateway'), false)
})

test('hasPromptLabel: prompt:* counts; other labels and no labels do not', () => {
  assert.equal(hasPromptLabel({ labels: labels('prompt:abc') }), true)
  assert.equal(hasPromptLabel({ labels: labels('agent:claude', 'agent-tested') }), false)
  assert.equal(hasPromptLabel({ labels: { nodes: [] } }), false)
  assert.equal(hasPromptLabel({}), false)
})

test('hasPrAttachment: only a github.com .../pull/N url counts', () => {
  assert.equal(hasPrAttachment(inProgressIssue()), true)
  assert.equal(
    hasPrAttachment({ attachments: { nodes: [{ url: 'https://github.com/dperez4787/linear-example/issues/81' }] } }),
    false,
    'a GitHub issue link is not a PR',
  )
  assert.equal(
    hasPrAttachment({ attachments: { nodes: [{ url: 'https://example.com/pull/81' }] } }),
    false,
    'a non-GitHub host is not a PR attachment',
  )
  assert.equal(hasPrAttachment({ attachments: { nodes: [] } }), false)
  assert.equal(hasPrAttachment({}), false)
})

test('allBlockersResolved: every "blocked by" completed → true; any open blocker → false', () => {
  assert.equal(allBlockersResolved(blockedIssue()), true)
  const oneOpen = blockedIssue({
    inverseRelations: {
      nodes: [
        { type: 'blocks', issue: { identifier: 'DAN-95', state: { type: 'completed' } } },
        { type: 'blocks', issue: { identifier: 'DAN-97', state: { type: 'started' } } },
      ],
    },
  })
  assert.equal(allBlockersResolved(oneOpen), false)
})

test('allBlockersResolved: a canceled blocker counts as resolved (it will never finish)', () => {
  const canceled = blockedIssue({
    inverseRelations: {
      nodes: [{ type: 'blocks', issue: { identifier: 'DAN-95', state: { type: 'canceled' } } }],
    },
  })
  assert.equal(allBlockersResolved(canceled), true)
})

test('allBlockersResolved: canceled + one still-open blocker → false', () => {
  const mixed = blockedIssue({
    inverseRelations: {
      nodes: [
        { type: 'blocks', issue: { identifier: 'DAN-95', state: { type: 'canceled' } } },
        { type: 'blocks', issue: { identifier: 'DAN-97', state: { type: 'unstarted' } } },
      ],
    },
  })
  assert.equal(allBlockersResolved(mixed), false)
})

test('allBlockersResolved: zero blockers → false (never re-queue bounced tickets)', () => {
  assert.equal(allBlockersResolved(blockedIssue({ inverseRelations: { nodes: [] } })), false)
  assert.equal(allBlockersResolved(blockedIssue({ inverseRelations: null })), false)
})

test('allBlockersResolved: "related"/"duplicate" relations are not blockers', () => {
  const related = blockedIssue({
    inverseRelations: {
      nodes: [
        { type: 'related', issue: { identifier: 'DAN-1', state: { type: 'started' } } },
        { type: 'duplicate', issue: { identifier: 'DAN-2', state: { type: 'started' } } },
      ],
    },
  })
  // only non-blocks relations → no blockers → not promoted
  assert.equal(allBlockersResolved(related), false)
})

// ---------- reconciliation candidates (B) ----------

test('reconcile: In Progress + prompt label + PR attachment + no agent-tested → candidate (heals DAN-95)', () => {
  const out = reconcileCandidates([inProgressIssue()], ENV)
  assert.deepEqual(out.map((i) => i.identifier), ['DAN-95'])
})

test('reconcile: In Progress WITHOUT a PR attachment → untouched (active dev run guard)', () => {
  const out = reconcileCandidates([inProgressIssue({ attachments: { nodes: [] } })], ENV)
  assert.deepEqual(out, [])
})

test('reconcile: agent-tested ticket (tester already ran, e.g. FAIL verdict) → untouched', () => {
  const out = reconcileCandidates(
    [inProgressIssue({ labels: labels('prompt:abc123', 'agent-tested') })],
    ENV,
  )
  assert.deepEqual(out, [])
})

test('reconcile: ticket without a prompt:* label → never touched', () => {
  const out = reconcileCandidates([inProgressIssue({ labels: labels('agent:claude') })], ENV)
  assert.deepEqual(out, [])
})

test('reconcile: excluded-project and unknown-project tickets → untouched (DAN-44 partition)', () => {
  const out = reconcileCandidates(
    [inProgressIssue({ project: { name: 'ai-gateway' } }), inProgressIssue({ project: null })],
    ENV,
  )
  assert.deepEqual(out, [])
})

// ---------- promotion candidates (C) ----------

test('promote: unstarted prompt-labeled ticket, all blockers completed → candidate', () => {
  const out = promoteCandidates([blockedIssue()], ENV)
  assert.deepEqual(out.map((i) => i.identifier), ['DAN-96'])
})

test('promote: backlog-family state qualifies too', () => {
  const out = promoteCandidates([blockedIssue({ state: { id: 'state-backlog', type: 'backlog' } })], ENV)
  assert.equal(out.length, 1)
})

test('promote: sole blocker canceled → promoted (canceled resolves the block)', () => {
  const out = promoteCandidates(
    [
      blockedIssue({
        inverseRelations: {
          nodes: [{ type: 'blocks', issue: { identifier: 'DAN-95', state: { type: 'canceled' } } }],
        },
      }),
    ],
    ENV,
  )
  assert.deepEqual(out.map((i) => i.identifier), ['DAN-96'])
})

test('promote: canceled blocker + still-open blocker → untouched', () => {
  const out = promoteCandidates(
    [
      blockedIssue({
        inverseRelations: {
          nodes: [
            { type: 'blocks', issue: { identifier: 'DAN-95', state: { type: 'canceled' } } },
            { type: 'blocks', issue: { identifier: 'DAN-97', state: { type: 'backlog' } } },
          ],
        },
      }),
    ],
    ENV,
  )
  assert.deepEqual(out, [])
})

test('promote: any non-completed blocker → untouched', () => {
  const out = promoteCandidates(
    [
      blockedIssue({
        inverseRelations: {
          nodes: [
            { type: 'blocks', issue: { identifier: 'DAN-95', state: { type: 'completed' } } },
            { type: 'blocks', issue: { identifier: 'DAN-97', state: { type: 'unstarted' } } },
          ],
        },
      }),
    ],
    ENV,
  )
  assert.deepEqual(out, [])
})

test('promote: ticket with no blockers → untouched (bounced-to-Todo tickets stay put)', () => {
  const out = promoteCandidates([blockedIssue({ inverseRelations: { nodes: [] } })], ENV)
  assert.deepEqual(out, [])
})

test('promote: ticket without a prompt:* label → never touched', () => {
  const out = promoteCandidates([blockedIssue({ labels: labels('agent:claude') })], ENV)
  assert.deepEqual(out, [])
})

test('promote: ticket already in Ready for Dev → untouched (no self-churn)', () => {
  const out = promoteCandidates(
    [blockedIssue({ state: { id: ENV.STATE_READY_FOR_DEV, type: 'unstarted' } })],
    ENV,
  )
  assert.deepEqual(out, [])
})

test('promote: excluded-project ticket → untouched (DAN-44 partition)', () => {
  const out = promoteCandidates([blockedIssue({ project: { name: 'ai-gateway' } })], ENV)
  assert.deepEqual(out, [])
})

// ---------- run(): wiring, ordering, dry-run, fail-loudly ----------

const scanResponse = (reconcileNodes, promoteNodes) => ({
  data: { reconcile: { nodes: reconcileNodes }, promote: { nodes: promoteNodes } },
})

// A fetch stub: first call returns the scan query response, subsequent calls
// (mutations) return issueUpdate success and record what was sent.
function fetchStub(firstResponse, { mutationResponse } = {}) {
  const calls = []
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body })
    const isMutation = body.query.trimStart().startsWith('mutation')
    const payload = isMutation
      ? (mutationResponse ?? { data: { issueUpdate: { success: true } } })
      : firstResponse
    return { ok: true, status: 200, json: async () => payload }
  }
  return { impl, calls }
}

test('run: reconciles then promotes, in that order, one mutation each', async () => {
  const { impl, calls } = fetchStub(scanResponse([inProgressIssue()], [blockedIssue()]))
  const logs = []
  const result = await run({ env: ENV, fetchImpl: impl, log: (l) => logs.push(l) })

  assert.deepEqual(result.toReview.map((i) => i.identifier), ['DAN-95'])
  assert.deepEqual(result.toReady.map((i) => i.identifier), ['DAN-96'])

  const mutations = calls.filter((c) => c.body.query.trimStart().startsWith('mutation'))
  assert.equal(mutations.length, 2)
  // completions-processing (reconciliation) strictly before promotion
  assert.deepEqual(mutations[0].body.variables, { id: 'issue-95', state: ENV.STATE_IN_REVIEW })
  assert.deepEqual(mutations[1].body.variables, { id: 'issue-96', state: ENV.STATE_READY_FOR_DEV })
  // the scan query carries the right variables
  assert.equal(calls[0].body.query, SCAN_QUERY)
  assert.deepEqual(calls[0].body.variables, { inProgress: ENV.STATE_IN_PROGRESS, teamKey: ENV.LINEAR_TEAM_KEY })
})

test('run: logs identifiers and state names only — never the API key', async () => {
  const { impl } = fetchStub(scanResponse([inProgressIssue()], [blockedIssue()]))
  const logs = []
  await run({ env: ENV, fetchImpl: impl, log: (l) => logs.push(l) })
  assert.ok(logs.some((l) => l.includes('DAN-95 → In Review')))
  assert.ok(logs.some((l) => l.includes('DAN-96 → Ready for Dev')))
  assert.ok(!logs.join('\n').includes(ENV.LINEAR_API_KEY))
})

test('run --check: reports planned moves, sends NO mutations', async () => {
  const { impl, calls } = fetchStub(scanResponse([inProgressIssue()], [blockedIssue()]))
  const logs = []
  const result = await run({ env: ENV, fetchImpl: impl, check: true, log: (l) => logs.push(l) })
  assert.equal(result.toReview.length, 1)
  assert.equal(result.toReady.length, 1)
  assert.equal(calls.length, 1, 'only the scan query — no mutations in --check mode')
  assert.ok(logs.some((l) => l.includes('[check] would move DAN-95 → In Review')))
  assert.ok(logs.some((l) => l.includes('[check] would move DAN-96 → Ready for Dev')))
})

test('run: nothing to do → zero mutations, "none" summary', async () => {
  const { impl, calls } = fetchStub(scanResponse([], []))
  const logs = []
  await run({ env: ENV, fetchImpl: impl, log: (l) => logs.push(l) })
  assert.equal(calls.length, 1)
  assert.ok(logs.some((l) => l === 'Reconciled to In Review: none'))
  assert.ok(logs.some((l) => l === 'Promoted to Ready for Dev: none'))
})

test('run: GraphQL errors fail loudly', async () => {
  const { impl } = fetchStub({ errors: [{ message: 'boom' }] })
  await assert.rejects(() => run({ env: ENV, fetchImpl: impl, log: () => {} }), /GraphQL errors/)
})

test('run: HTTP failure fails loudly', async () => {
  const impl = async () => ({ ok: false, status: 500, json: async () => ({}) })
  await assert.rejects(() => run({ env: ENV, fetchImpl: impl, log: () => {} }), /HTTP 500/)
})

test('run: issueUpdate success:false fails loudly with the ticket identifier', async () => {
  const { impl } = fetchStub(scanResponse([inProgressIssue()], []), {
    mutationResponse: { data: { issueUpdate: { success: false } } },
  })
  await assert.rejects(
    () => run({ env: ENV, fetchImpl: impl, log: () => {} }),
    /issueUpdate failed moving DAN-95/,
  )
})

test('run: a missing required env var fails loudly before any network call', async () => {
  let called = false
  const impl = async () => {
    called = true
    return { ok: true, status: 200, json: async () => scanResponse([], []) }
  }
  const { LINEAR_API_KEY, ...rest } = ENV
  await assert.rejects(() => run({ env: rest, fetchImpl: impl, log: () => {} }), /LINEAR_API_KEY/)
  assert.equal(called, false)
})
