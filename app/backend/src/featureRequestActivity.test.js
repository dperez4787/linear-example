// featureRequestActivity (DAN-83): the build narrated from the ticket trail —
// Linear comments, state changes, and the PR attachment, merged
// chronologically across all filed tickets. Tested over HTTP via supertest
// against the in-process app, same harness as featureRequestProgress.test.js.
// Run with: npm test
//
// The injected linearClient is a FAKE that records every issuesActivity call
// and returns scripted Linear issue nodes — no test reaches real Linear.
// Sessions are seeded directly into the scratch collection so each test
// controls the filed tickets exactly; Mongo (linear_example_test) is the only
// external dependency, same as the sibling suites.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import request from 'supertest'

if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // No .env — MONGODB_URI must then come from the ambient environment.
  }
}
process.env.MONGODB_DB = 'linear_example_test'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const {
  featureRequestActivity,
  clearFeatureRequestActivityCache,
  ACTIVITY_CACHE_TTL_MS,
  ACTIVITY_COMMENT_BODY_MAX,
} = await import('./featureRequests.js')

// --- fixtures ---

// A Linear issue node exactly as linearClient.issuesActivity returns it:
// comments as { nodes: [{ body, createdAt, url }] }, history as
// { nodes: [{ createdAt, fromState: { name }, toState: { name } }] },
// attachments as { nodes: [{ url, sourceType, createdAt, metadata }] }.
function linearIssue({ id, identifier, comments = [], history = [], attachments = [] }) {
  return {
    id,
    identifier,
    url: `https://linear.app/fixture/issue/${identifier}`,
    comments: { nodes: comments },
    history: { nodes: history },
    attachments: { nodes: attachments },
  }
}

const stateChange = (createdAt, from, to) => ({
  createdAt,
  fromState: from === null ? null : { name: from },
  toState: to === null ? null : { name: to },
})

const comment = (createdAt, body, url) => ({ body, createdAt, url })

const prAttachment = (createdAt, { draft, url = 'https://github.com/dperez4787/linear-example/pull/99' } = {}) => ({
  url,
  sourceType: 'github',
  createdAt,
  metadata: draft === undefined ? {} : { status: draft ? 'draft' : 'open' },
})

// The recording fake: issuesActivity pushes its argument onto `calls` and
// returns the scripted node arrays in order (the last script repeats, so
// cache tests can call freely) — the exact shape of the DAN-52 progress fake.
function fakeLinearClient(...scriptedNodes) {
  const calls = []
  return {
    calls,
    async issuesActivity(issueIds) {
      calls.push(issueIds)
      return scriptedNodes.length > 1 ? scriptedNodes.shift() : (scriptedNodes[0] ?? [])
    },
  }
}

// --- app plumbing (stub verifier, injected fake linearClient) ---

const TOKENS = {
  'stub-token-alice': { uid: 'uid-alice' },
  'stub-token-bob': { uid: 'uid-bob' },
}
const ALICE = 'stub-token-alice'
const BOB = 'stub-token-bob'

const stubVerify = async (token) => {
  const decoded = TOKENS[token]
  if (!decoded) throw new Error('invalid token')
  return decoded
}

const makeApp = (linearClient) => createApp({ verifyToken: stubVerify, linearClient })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

// Exactly the ActivityEvent field names — the DAN-84 frontend contract.
const ACTIVITY = `query ($promptId: ID!) {
  featureRequestActivity(promptId: $promptId) {
    ts ticketIdentifier kind summary body url
  }
}`

const featureRequests = () => getDb().collection('feature_requests')

// Seed a session document directly — the filing pipeline is not under test,
// reading the trail of its stored outcome is. `tickets` is the DAN-51 stored
// shape: { key, linearIssueId, identifier, url }.
async function seedSession({ uid = 'uid-alice', status = 'building', tickets } = {}) {
  const doc = {
    uid,
    status,
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Please add CSV export', createdAt: new Date() }],
    createdAt: new Date(),
  }
  if (tickets !== undefined) {
    doc.tickets = tickets
    doc.linearProjectId = 'project-fixture-id'
  }
  const { insertedId } = await featureRequests().insertOne(doc)
  return insertedId.toString()
}

const ticketRef = (key, issueId, identifier) => ({
  key,
  linearIssueId: issueId,
  identifier,
  url: `https://linear.app/fixture/issue/${identifier}`,
})

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await featureRequests().deleteMany({})
  clearFeatureRequestActivityCache()
})

after(async () => {
  await featureRequests().deleteMany({})
  await getDb().client.close()
})

// --- criterion 1: merged chronological events across tickets, exact shape ---

test('events from all filed tickets merge into one chronological feed with the exact ActivityEvent shape, in ONE Linear query', async () => {
  // The trail interleaves across tickets: DAN-102's comment lands between
  // DAN-101's state change and DAN-101's PR — the merge must sort globally by
  // timestamp, not concatenate per ticket.
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-1',
      identifier: 'DAN-101',
      history: [stateChange('2026-08-26T10:00:00.000Z', 'Backlog', 'In Progress')],
      comments: [
        comment(
          '2026-08-26T10:30:00.000Z',
          'Claimed the ticket; the developer branch is up.',
          'https://linear.app/fixture/comment/c1',
        ),
      ],
      attachments: [prAttachment('2026-08-26T11:00:00.000Z', { draft: true })],
    }),
    linearIssue({
      id: 'issue-2',
      identifier: 'DAN-102',
      comments: [
        comment('2026-08-26T10:45:00.000Z', 'Waiting on DAN-101 to land first.'),
      ],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [ticketRef('T1', 'issue-1', 'DAN-101'), ticketRef('T2', 'issue-2', 'DAN-102')],
  })

  const res = await gql(app, ALICE, ACTIVITY, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, JSON.stringify(res.body.errors))
  assert.deepEqual(res.body.data.featureRequestActivity, [
    {
      ts: '2026-08-26T10:00:00.000Z',
      ticketIdentifier: 'DAN-101',
      kind: 'state',
      summary: 'DAN-101: Backlog → In Progress',
      body: null,
      url: 'https://linear.app/fixture/issue/DAN-101',
    },
    {
      ts: '2026-08-26T10:30:00.000Z',
      ticketIdentifier: 'DAN-101',
      kind: 'comment',
      summary: 'developer commented on DAN-101',
      body: 'Claimed the ticket; the developer branch is up.',
      url: 'https://linear.app/fixture/comment/c1',
    },
    {
      ts: '2026-08-26T10:45:00.000Z',
      ticketIdentifier: 'DAN-102',
      kind: 'comment',
      summary: 'agent commented on DAN-102',
      body: 'Waiting on DAN-101 to land first.',
      // A comment without its own url falls back to the issue url.
      url: 'https://linear.app/fixture/issue/DAN-102',
    },
    {
      ts: '2026-08-26T11:00:00.000Z',
      ticketIdentifier: 'DAN-101',
      kind: 'pr',
      summary: 'draft PR opened for DAN-101',
      body: null,
      url: 'https://github.com/dperez4787/linear-example/pull/99',
    },
  ])
  assert.equal(linear.calls.length, 1, 'ONE Linear query for the whole session')
  assert.deepEqual(linear.calls[0], ['issue-1', 'issue-2'], 'queried by the stored linearIssueIds')
})

// --- comment author labels: simple content heuristics ---

test('comment author labels: tester vocabulary → "tester", developer vocabulary → "developer", anything else → "agent" (tester wins ties)', async () => {
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-1',
      identifier: 'DAN-101',
      comments: [
        comment('2026-08-26T10:00:00.000Z', 'Verdict: PASS — every acceptance criterion holds.'),
        comment('2026-08-26T10:01:00.000Z', 'Opened a draft PR from the ticket branch.'),
        comment('2026-08-26T10:02:00.000Z', 'Kicking off the build now.'),
        // Both vocabularies present: the tester label wins — its verdicts
        // routinely quote the developer's work.
        comment('2026-08-26T10:03:00.000Z', 'Tester here: reviewed the developer implementation, all good.'),
      ],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'issue-1', 'DAN-101')] })

  const res = await gql(app, ALICE, ACTIVITY, { promptId: id })

  assert.deepEqual(
    res.body.data.featureRequestActivity.map((e) => e.summary),
    [
      'tester commented on DAN-101',
      'developer commented on DAN-101',
      'agent commented on DAN-101',
      'tester commented on DAN-101',
    ],
  )
})

// --- comment bodies truncate at ~500 chars ---

test('a long comment body is truncated to ACTIVITY_COMMENT_BODY_MAX with an ellipsis; a short one passes through untouched', async () => {
  const long = 'x'.repeat(ACTIVITY_COMMENT_BODY_MAX + 200)
  const short = 'Short note.'
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-1',
      identifier: 'DAN-101',
      comments: [
        comment('2026-08-26T10:00:00.000Z', long),
        comment('2026-08-26T10:01:00.000Z', short),
      ],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'issue-1', 'DAN-101')] })

  const res = await gql(app, ALICE, ACTIVITY, { promptId: id })

  const [truncated, untouched] = res.body.data.featureRequestActivity.map((e) => e.body)
  assert.equal(truncated.length, ACTIVITY_COMMENT_BODY_MAX)
  assert.ok(truncated.endsWith('…'), 'truncation is visible, not silent')
  assert.equal(truncated.slice(0, 10), 'xxxxxxxxxx')
  assert.equal(untouched, short)
})

// --- state changes: from→to summaries; non-transition history rows skipped ---

test('state events carry from→to summaries; history rows without both states (creation, assignments, label edits) are skipped', async () => {
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-1',
      identifier: 'DAN-101',
      history: [
        // The creation row: a to-state with no from-state — not a change.
        stateChange('2026-08-26T09:00:00.000Z', null, 'Ready for Dev'),
        stateChange('2026-08-26T10:00:00.000Z', 'Ready for Dev', 'In Progress'),
        // A non-state history row (an assignment): no states at all.
        stateChange('2026-08-26T10:30:00.000Z', null, null),
        stateChange('2026-08-26T11:00:00.000Z', 'In Progress', 'In Review'),
      ],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'issue-1', 'DAN-101')] })

  const res = await gql(app, ALICE, ACTIVITY, { promptId: id })

  assert.deepEqual(
    res.body.data.featureRequestActivity.map((e) => [e.kind, e.summary]),
    [
      ['state', 'DAN-101: Ready for Dev → In Progress'],
      ['state', 'DAN-101: In Progress → In Review'],
    ],
  )
})

// --- pr events: url, draft state, PR detection ---

test('the pr event reports draft vs open from the attachment metadata, including the boolean `draft` form; non-PR attachments emit nothing', async () => {
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-1',
      identifier: 'DAN-101',
      attachments: [
        // A non-PR attachment (Figma) must not become a pr event.
        { url: 'https://www.figma.com/file/abc', sourceType: 'figma', createdAt: '2026-08-26T09:00:00.000Z' },
        prAttachment('2026-08-26T10:00:00.000Z', {
          draft: true,
          url: 'https://github.com/dperez4787/linear-example/pull/7',
        }),
      ],
    }),
    linearIssue({
      id: 'issue-2',
      identifier: 'DAN-102',
      attachments: [
        prAttachment('2026-08-26T11:00:00.000Z', {
          draft: false,
          url: 'https://github.com/dperez4787/linear-example/pull/8',
        }),
      ],
    }),
    linearIssue({
      id: 'issue-3',
      identifier: 'DAN-103',
      attachments: [
        // The older metadata shape: a boolean `draft`, no `status` string.
        {
          url: 'https://github.com/dperez4787/linear-example/pull/9',
          sourceType: 'github',
          createdAt: '2026-08-26T12:00:00.000Z',
          metadata: { draft: true },
        },
      ],
    }),
    // No metadata at all: still a pr event, reported as open (never an error).
    linearIssue({
      id: 'issue-4',
      identifier: 'DAN-104',
      attachments: [
        {
          url: 'https://github.com/dperez4787/linear-example/pull/10',
          sourceType: 'github',
          createdAt: '2026-08-26T13:00:00.000Z',
        },
      ],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [1, 2, 3, 4].map((n) => ticketRef(`T${n}`, `issue-${n}`, `DAN-10${n}`)),
  })

  const res = await gql(app, ALICE, ACTIVITY, { promptId: id })

  assert.deepEqual(
    res.body.data.featureRequestActivity.map((e) => [e.summary, e.url]),
    [
      ['draft PR opened for DAN-101', 'https://github.com/dperez4787/linear-example/pull/7'],
      ['PR opened for DAN-102', 'https://github.com/dperez4787/linear-example/pull/8'],
      ['draft PR opened for DAN-103', 'https://github.com/dperez4787/linear-example/pull/9'],
      ['PR opened for DAN-104', 'https://github.com/dperez4787/linear-example/pull/10'],
    ],
  )
})

// --- a filed ticket deleted in Linear is skipped, not fabricated ---

test('a filed ticket Linear no longer returns contributes no events rather than invented ones', async () => {
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-2',
      identifier: 'DAN-102',
      comments: [comment('2026-08-26T10:00:00.000Z', 'Still here.')],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [ticketRef('T1', 'issue-1', 'DAN-101'), ticketRef('T2', 'issue-2', 'DAN-102')],
  })

  const res = await gql(app, ALICE, ACTIVITY, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(
    res.body.data.featureRequestActivity.map((e) => e.ticketIdentifier),
    ['DAN-102'],
  )
})

// --- criterion 2: unapproved → [], unknown/foreign/malformed → NOT_FOUND ---

test('a session that has not been approved yet (no filed tickets) returns [] and never calls Linear', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession({ status: 'gathering', tickets: undefined })

  const res = await gql(app, ALICE, ACTIVITY, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestActivity, [])
  assert.equal(linear.calls.length, 0, 'activity is approved-only data — no Linear read')
})

test("unknown, malformed, and another user's promptId all yield the NOT_FOUND shape, with zero Linear calls", async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const aliceSession = await seedSession({
    tickets: [ticketRef('T1', 'issue-1', 'DAN-101')],
  })

  const cases = [
    ['unknown promptId', ALICE, '0123456789abcdef01234567'],
    ['malformed promptId', ALICE, 'not-an-object-id'],
    ["another user's session", BOB, aliceSession],
  ]
  for (const [label, token, promptId] of cases) {
    const res = await gql(app, token, ACTIVITY, { promptId })
    assert.equal(res.status, 200, `${label}: domain errors are never HTTP 4xx`)
    assert.equal(res.body.data, null, `${label}: non-null list type nulls data overall`)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND', label)
    assert.equal(res.body.errors[0].message, 'feature request not found', label)
  }
  assert.equal(linear.calls.length, 0, 'a NOT_FOUND never reaches Linear')
})

// --- the ~10s cache: Linear read only; warm cache is never a scoping bypass ---

test('two reads within the TTL hit Linear once; a warm cache still yields NOT_FOUND for another user; clearing forces a refetch', async () => {
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-1',
      identifier: 'DAN-101',
      comments: [comment('2026-08-26T10:00:00.000Z', 'Building.')],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'issue-1', 'DAN-101')] })

  const first = await gql(app, ALICE, ACTIVITY, { promptId: id })
  const second = await gql(app, ALICE, ACTIVITY, { promptId: id })
  assert.equal(first.body.errors, undefined)
  assert.deepEqual(second.body.data, first.body.data, 'the cached events are what the second read serves')
  assert.equal(linear.calls.length, 1, 'the second read within ~10s is served from the cache')

  // The cache never bypasses the per-user session read: Bob still gets
  // NOT_FOUND on Alice's (cached) session — the DAN-52 proof pattern.
  const bob = await gql(app, BOB, ACTIVITY, { promptId: id })
  assert.equal(bob.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(linear.calls.length, 1, "Bob's probe neither served nor refreshed the cache")

  clearFeatureRequestActivityCache()
  await gql(app, ALICE, ACTIVITY, { promptId: id })
  assert.equal(linear.calls.length, 2, 'a cleared cache refetches from Linear')
})

test('the cache expires after ACTIVITY_CACHE_TTL_MS (injectable clock, data layer)', async () => {
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-1',
      identifier: 'DAN-101',
      history: [stateChange('2026-08-26T10:00:00.000Z', 'In Review', 'Done')],
    }),
  ])
  const id = await seedSession({ tickets: [ticketRef('T1', 'issue-1', 'DAN-101')] })

  let clock = 1_000_000
  const now = () => clock

  await featureRequestActivity('uid-alice', id, linear, now)
  clock += ACTIVITY_CACHE_TTL_MS - 1
  await featureRequestActivity('uid-alice', id, linear, now)
  assert.equal(linear.calls.length, 1, 'one tick inside the TTL still serves the cache')

  clock += 2
  const events = await featureRequestActivity('uid-alice', id, linear, now)
  assert.equal(linear.calls.length, 2, 'past the TTL the cache entry is stale and Linear is re-read')
  assert.equal(events[0].summary, 'DAN-101: In Review → Done')
})
