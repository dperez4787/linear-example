// DAN-52 tester verification. Independent of the developer's
// featureRequestProgress.test.js — its own fixtures, ids, and fakes.
//
// What this suite locks, beyond re-proving the criteria with different values:
//
//   1. All FIVE wire states in one response, in filed-ticket order, with the
//      exact seven criterion-1 keys per node (Object.keys, order included).
//   2. A PR attachment never overrides an active/terminal state: DONE with a
//      PR stays DONE, started with a PR stays IN_PROGRESS — the PR only
//      bounces backlog-family states.
//   3. The In Review name match survives case and whitespace variants
//      ("in review", "IN REVIEW", "  In Review  ").
//   4. An unknown state type (canceled) follows the dev's documented mapping:
//      backlog-family behavior — BACKLOG without a PR, BOUNCED with one.
//   5. blockedBy: only `type: "blocks"` inverseRelations count; relates /
//      duplicate entries and a blocks entry with no issue id are ignored.
//   6. The ~10s cache, over the wire: two reads inside the TTL cost ONE
//      issuesProgress call; a different promptId gets its own read;
//      CRITICALLY, a foreign uid gets NOT_FOUND even when the cache is warm
//      for that exact promptId (the uid-scoped session read is never cached),
//      and the warm entry still serves the owner afterwards with no new read.
//   7. TTL expiry at exactly PROGRESS_CACHE_TTL_MS via the injectable clock.
//   8. A ticket deleted in Linear (id stored in the session, absent from the
//      response) is skipped, not fabricated — node COUNT asserted.
//   9. An unapproved session returns [] with ZERO linearClient calls.
//  10. Schema fidelity for DAN-55: introspection shows TicketProgress has
//      exactly the seven contract fields with the contract nullability.
//
// The injected linearClient is this suite's own counting fake returning
// scripted Linear nodes — no test reaches real Linear. Needs a reachable
// mongod via MONGODB_URI (ambient or app/backend/.env); MONGODB_DB is forced
// to the scratch database. Run with: npm test
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
  featureRequestProgress,
  clearFeatureRequestProgressCache,
  PROGRESS_CACHE_TTL_MS,
} = await import('./featureRequests.js')
const { ObjectId } = await import('mongodb')

// --- this suite's own fixtures (values distinct from the developer's) ---

const STATES = {
  backlog: { name: 'Icebox', type: 'backlog' },
  unstarted: { name: 'Todo', type: 'unstarted' },
  started: { name: 'Doing The Work', type: 'started' },
  inReview: { name: 'In Review', type: 'started' },
  completed: { name: 'Shipped', type: 'completed' },
  canceled: { name: 'Canceled', type: 'canceled' },
}

const T52_PR = {
  url: 'https://github.com/dperez4787/linear-example/pull/5252',
  sourceType: 'github',
}
// A non-PR attachment (e.g. a Slack link) that must never become prUrl.
const T52_SLACK = {
  url: 'https://example.slack.com/archives/C052/p52',
  sourceType: 'slack',
}

function node({ id, identifier, title, state, attachments = [], inverse = [] }) {
  return {
    id,
    identifier,
    title: title ?? `t52 ${identifier}`,
    url: `https://linear.app/t52/issue/${identifier}`,
    state,
    attachments: { nodes: attachments },
    inverseRelations: { nodes: inverse },
  }
}

// Counting fake: records every issuesProgress argument, answers from a mutable
// nodes-by-id table so every test controls Linear's view exactly.
function countingLinearClient(nodes = []) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const calls = []
  return {
    calls,
    byId,
    async issuesProgress(issueIds) {
      calls.push([...issueIds])
      return issueIds.map((id) => byId.get(id)).filter(Boolean)
    },
  }
}

// --- app plumbing: stub verifier, two users ---

const TOKENS = {
  't52-token-owner': { uid: 'uid-t52-owner' },
  't52-token-intruder': { uid: 'uid-t52-intruder' },
}
const OWNER = 't52-token-owner'
const INTRUDER = 't52-token-intruder'
const stubVerify = async (token) => {
  if (!TOKENS[token]) throw new Error('invalid token')
  return TOKENS[token]
}
const makeApp = (linearClient) => createApp({ verifyToken: stubVerify, linearClient })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

// The DAN-55 contract query — exactly the seven criterion-1 field names.
const PROGRESS = `query ($promptId: ID!) {
  featureRequestProgress(promptId: $promptId) {
    issueId identifier title state issueUrl prUrl blockedBy
  }
}`

const featureRequests = () => getDb().collection('feature_requests')

// Seed a session in the DAN-51 stored shape directly; the approval pipeline
// is DAN-51's tested territory, not this suite's.
async function seedSession({ uid = 'uid-t52-owner', status = 'building', tickets } = {}) {
  const doc = {
    uid,
    status,
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 't52: watch it build', createdAt: new Date() }],
    createdAt: new Date(),
  }
  if (tickets !== undefined) doc.tickets = tickets
  const { insertedId } = await featureRequests().insertOne(doc)
  return insertedId.toString()
}

const ticketRef = (n) => ({
  key: `K${n}`,
  linearIssueId: `t52-iss-${n}`,
  identifier: `T52-${n}`,
  url: `https://linear.app/t52/issue/T52-${n}`,
})

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must point at a test mongod')
  await connect()
})

beforeEach(async () => {
  await featureRequests().deleteMany({})
  clearFeatureRequestProgressCache()
})

after(async () => {
  await featureRequests().deleteMany({})
  // Repo convention (see records.test.js): close the shared client so the
  // test process exits cleanly without --test-force-exit.
  await getDb().client.close()
})

// --- 1. all five states in one response, exact wire shape, filed order ---

test('all five states in one response: one node per filed ticket, filed order, exact seven keys per node', async () => {
  const linear = countingLinearClient([
    node({ id: 't52-iss-1', identifier: 'T52-1', state: STATES.backlog }),
    node({ id: 't52-iss-2', identifier: 'T52-2', state: STATES.started }),
    node({ id: 't52-iss-3', identifier: 'T52-3', state: STATES.inReview, attachments: [T52_PR] }),
    node({ id: 't52-iss-4', identifier: 'T52-4', state: STATES.completed }),
    node({
      id: 't52-iss-5',
      identifier: 'T52-5',
      state: STATES.unstarted,
      attachments: [T52_SLACK, T52_PR],
      inverse: [{ type: 'blocks', issue: { id: 't52-iss-1' } }],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [1, 2, 3, 4, 5].map(ticketRef) })

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)

  const nodes = res.body.data.featureRequestProgress
  assert.equal(nodes.length, 5, 'one node per filed ticket')
  assert.deepEqual(
    nodes.map((n) => n.state),
    ['BACKLOG', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BOUNCED'],
    'all five wire states, in filed-ticket order',
  )
  // Field-name fidelity for DAN-55: exactly the seven keys, in contract order.
  for (const n of nodes) {
    assert.deepEqual(
      Object.keys(n),
      ['issueId', 'identifier', 'title', 'state', 'issueUrl', 'prUrl', 'blockedBy'],
    )
  }
  assert.deepEqual(nodes[0], {
    issueId: 't52-iss-1',
    identifier: 'T52-1',
    title: 't52 T52-1',
    state: 'BACKLOG',
    issueUrl: 'https://linear.app/t52/issue/T52-1',
    prUrl: null,
    blockedBy: [],
  })
  // The bounced node: PR url surfaced (not the Slack attachment), blocker listed.
  assert.deepEqual(nodes[4], {
    issueId: 't52-iss-5',
    identifier: 'T52-5',
    title: 't52 T52-5',
    state: 'BOUNCED',
    issueUrl: 'https://linear.app/t52/issue/T52-5',
    prUrl: T52_PR.url,
    blockedBy: ['t52-iss-1'],
  })
  // The in-review node carries its PR url too — prUrl is attachment-driven,
  // independent of state.
  assert.equal(nodes[2].prUrl, T52_PR.url)
  assert.equal(linear.calls.length, 1, 'one Linear round trip for the whole session')
  assert.deepEqual(linear.calls[0], ['t52-iss-1', 't52-iss-2', 't52-iss-3', 't52-iss-4', 't52-iss-5'])
})

// --- 2. a PR never overrides an active/terminal state ---

test('a PR attachment only bounces backlog-family states: DONE stays DONE, started stays IN_PROGRESS', async () => {
  const linear = countingLinearClient([
    node({ id: 't52-iss-1', identifier: 'T52-1', state: STATES.completed, attachments: [T52_PR] }),
    node({ id: 't52-iss-2', identifier: 'T52-2', state: STATES.started, attachments: [T52_PR] }),
    node({ id: 't52-iss-3', identifier: 'T52-3', state: STATES.backlog, attachments: [T52_PR] }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [1, 2, 3].map(ticketRef) })

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal(res.body.errors, undefined)
  const nodes = res.body.data.featureRequestProgress
  assert.deepEqual(
    nodes.map((n) => [n.state, n.prUrl]),
    [
      ['DONE', T52_PR.url],
      ['IN_PROGRESS', T52_PR.url],
      ['BOUNCED', T52_PR.url],
    ],
  )
})

// --- 3. In Review name match is case- and whitespace-insensitive ---

test('the In Review state maps to IN_REVIEW whatever its casing', async () => {
  const linear = countingLinearClient([
    node({ id: 't52-iss-1', identifier: 'T52-1', state: { name: 'in review', type: 'started' } }),
    node({ id: 't52-iss-2', identifier: 'T52-2', state: { name: 'IN REVIEW', type: 'started' } }),
    node({ id: 't52-iss-3', identifier: 'T52-3', state: { name: '  In Review  ', type: 'started' } }),
    node({ id: 't52-iss-4', identifier: 'T52-4', state: { name: 'Reviewing', type: 'started' } }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [1, 2, 3, 4].map(ticketRef) })

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(
    res.body.data.featureRequestProgress.map((n) => n.state),
    ['IN_REVIEW', 'IN_REVIEW', 'IN_REVIEW', 'IN_PROGRESS'],
    'name match ignores case and padding; a differently NAMED started state stays IN_PROGRESS',
  )
})

// --- 4. unknown state type -> documented backlog-family behavior ---

test('an unknown state type (canceled) maps to the backlog family: BACKLOG bare, BOUNCED with a PR', async () => {
  const linear = countingLinearClient([
    node({ id: 't52-iss-1', identifier: 'T52-1', state: STATES.canceled }),
    node({ id: 't52-iss-2', identifier: 'T52-2', state: STATES.canceled, attachments: [T52_PR] }),
    // A missing state object must not crash the mapper either.
    node({ id: 't52-iss-3', identifier: 'T52-3', state: null }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [1, 2, 3].map(ticketRef) })

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(
    res.body.data.featureRequestProgress.map((n) => n.state),
    ['BACKLOG', 'BOUNCED', 'BACKLOG'],
    'the wire vocabulary is always one of the five states, never Linear passthrough',
  )
})

// --- 5. blockedBy filters to blocks relations with a real blocker id ---

test('blockedBy lists only inverse "blocks" blockers; relates/duplicate and id-less entries are ignored', async () => {
  const linear = countingLinearClient([
    node({
      id: 't52-iss-1',
      identifier: 'T52-1',
      state: STATES.backlog,
      inverse: [
        { type: 'blocks', issue: { id: 't52-iss-8' } },
        { type: 'relates', issue: { id: 't52-iss-9' } },
        { type: 'duplicate', issue: { id: 't52-iss-10' } },
        { type: 'blocks', issue: null },
        { type: 'blocks', issue: { id: 't52-iss-11' } },
      ],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [1].map(ticketRef) })

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestProgress[0].blockedBy, [
    't52-iss-8',
    't52-iss-11',
  ])
})

// --- 6. the cache, over the wire: hits, per-promptId keys, and uid scoping ---

test('cache: two reads inside the TTL cost one Linear call; another promptId reads on its own; a warm cache never bypasses the uid check', async () => {
  const linear = countingLinearClient([
    node({ id: 't52-iss-1', identifier: 'T52-1', state: STATES.started }),
    node({ id: 't52-iss-2', identifier: 'T52-2', state: STATES.completed }),
  ])
  const app = makeApp(linear)
  const idA = await seedSession({ tickets: [1].map(ticketRef) })
  const idB = await seedSession({ tickets: [2].map(ticketRef) })

  // Two owner reads of session A inside the window -> ONE issuesProgress call.
  const first = await gql(app, OWNER, PROGRESS, { promptId: idA })
  const second = await gql(app, OWNER, PROGRESS, { promptId: idA })
  assert.equal(first.body.errors, undefined)
  assert.deepEqual(second.body.data, first.body.data, 'the cached nodes are what is served')
  assert.equal(linear.calls.length, 1, 'second read within ~10s is served from the cache')

  // A DIFFERENT promptId is its own cache key -> its own Linear read.
  const other = await gql(app, OWNER, PROGRESS, { promptId: idB })
  assert.equal(other.body.errors, undefined)
  assert.equal(other.body.data.featureRequestProgress[0].state, 'DONE')
  assert.equal(linear.calls.length, 2, 'each promptId gets its own Linear read')

  // CRITICAL: the cache for idA is warm, but a foreign uid must still get
  // NOT_FOUND — the uid-scoped session read runs on every call, cached or not.
  const intruder = await gql(app, INTRUDER, PROGRESS, { promptId: idA })
  assert.equal(intruder.status, 200)
  assert.equal(intruder.body.data, null)
  assert.equal(intruder.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(intruder.body.errors[0].message, 'feature request not found')
  assert.equal(linear.calls.length, 2, 'the intruder read never reached Linear either')

  // And the warm entry still serves the owner afterwards, no new read.
  const third = await gql(app, OWNER, PROGRESS, { promptId: idA })
  assert.deepEqual(third.body.data, first.body.data)
  assert.equal(linear.calls.length, 2)
})

// --- 7. TTL expiry at exactly PROGRESS_CACHE_TTL_MS (injectable clock) ---

test('the cache expires after PROGRESS_CACHE_TTL_MS and a stale read refetches (data layer, fake clock)', async () => {
  assert.equal(PROGRESS_CACHE_TTL_MS, 10_000, 'the ticket says ~10 seconds')
  const linear = countingLinearClient([
    node({ id: 't52-iss-1', identifier: 'T52-1', state: STATES.started }),
  ])
  const id = await seedSession({ tickets: [1].map(ticketRef) })

  let clock = 1_000_000
  const now = () => clock

  await featureRequestProgress('uid-t52-owner', id, linear, now)
  clock += PROGRESS_CACHE_TTL_MS - 1
  await featureRequestProgress('uid-t52-owner', id, linear, now)
  assert.equal(linear.calls.length, 1, 'TTL-1 ms later: still cached')

  clock += 1 // exactly TTL since the cached read
  linear.byId.get('t52-iss-1').state = STATES.completed
  const refreshed = await featureRequestProgress('uid-t52-owner', id, linear, now)
  assert.equal(linear.calls.length, 2, 'at the TTL boundary the entry is stale')
  assert.equal(refreshed[0].state, 'DONE', 'the refetch sees Linear\'s new truth')
})

// --- 8. a ticket deleted in Linear is skipped, not fabricated ---

test('a filed ticket absent from Linear\'s response is skipped: count drops, nothing is invented', async () => {
  // Session stores THREE tickets; Linear only knows two of them.
  const linear = countingLinearClient([
    node({ id: 't52-iss-1', identifier: 'T52-1', state: STATES.completed }),
    node({ id: 't52-iss-3', identifier: 'T52-3', state: STATES.started }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [1, 2, 3].map(ticketRef) })

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal(res.body.errors, undefined)
  const nodes = res.body.data.featureRequestProgress
  assert.equal(nodes.length, 2, 'exactly the tickets Linear still returns')
  assert.deepEqual(nodes.map((n) => n.identifier), ['T52-1', 'T52-3'])
  assert.ok(
    !nodes.some((n) => n.issueId === 't52-iss-2'),
    'the deleted ticket is not fabricated from the stored session data',
  )
  // All three ids were still ASKED for — the skip happened on the answer.
  assert.deepEqual(linear.calls[0], ['t52-iss-1', 't52-iss-2', 't52-iss-3'])
})

// --- 9. unapproved session -> [] and Linear untouched ---

test('an unapproved session returns an empty list with zero linearClient calls', async () => {
  const linear = countingLinearClient()
  const app = makeApp(linear)
  const gathering = await seedSession({ status: 'gathering' }) // no tickets field at all
  const emptyTickets = await seedSession({ status: 'building', tickets: [] })

  for (const id of [gathering, emptyTickets]) {
    const res = await gql(app, OWNER, PROGRESS, { promptId: id })
    assert.equal(res.status, 200)
    assert.equal(res.body.errors, undefined)
    assert.deepEqual(res.body.data.featureRequestProgress, [])
  }
  assert.equal(linear.calls.length, 0, 'progress is approved-only data; Linear was never read')
})

// --- 10. unknown / malformed / foreign promptId -> NOT_FOUND, Linear untouched ---

test('unknown, malformed, and another user\'s promptId all yield NOT_FOUND with zero Linear calls', async () => {
  const linear = countingLinearClient([
    node({ id: 't52-iss-1', identifier: 'T52-1', state: STATES.started }),
  ])
  const app = makeApp(linear)
  const owned = await seedSession({ tickets: [1].map(ticketRef) })

  const attempts = [
    ['unknown promptId', OWNER, new ObjectId().toString()],
    ['malformed promptId', OWNER, 'definitely-not-an-objectid'],
    ["another user's promptId", INTRUDER, owned],
  ]
  for (const [label, token, promptId] of attempts) {
    const res = await gql(app, token, PROGRESS, { promptId })
    assert.equal(res.status, 200, label)
    assert.equal(res.body.data, null, label)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND', label)
    assert.equal(res.body.errors[0].message, 'feature request not found', label)
  }
  assert.equal(linear.calls.length, 0)
})

// --- 11. DAN-55 schema fidelity: the seven fields, by introspection ---

test('TicketProgress exposes exactly the seven contract fields with contract nullability', async () => {
  const app = makeApp(countingLinearClient())
  const res = await gql(
    app,
    OWNER,
    `{ __type(name: "TicketProgress") { fields { name type { kind ofType { kind name } name } } } }`,
  )
  assert.equal(res.body.errors, undefined)
  const fields = res.body.data.__type.fields
  assert.deepEqual(
    fields.map((f) => f.name),
    ['issueId', 'identifier', 'title', 'state', 'issueUrl', 'prUrl', 'blockedBy'],
    'exactly the seven DAN-55 field names, nothing extra, nothing renamed',
  )
  const byName = Object.fromEntries(fields.map((f) => [f.name, f.type]))
  for (const required of ['issueId', 'identifier', 'title', 'state', 'issueUrl']) {
    assert.equal(byName[required].kind, 'NON_NULL', `${required} is non-nullable`)
  }
  assert.equal(byName.prUrl.kind, 'SCALAR', 'prUrl is nullable (String)')
  assert.equal(byName.prUrl.name, 'String')
  assert.equal(byName.blockedBy.kind, 'NON_NULL', 'blockedBy is a non-null list')

  // And the query root takes promptId: ID! returning [TicketProgress!]!
  const q = await gql(
    app,
    OWNER,
    `{ __schema { queryType { fields { name args { name type { kind ofType { name } } } } } } }`,
  )
  const progressField = q.body.data.__schema.queryType.fields.find(
    (f) => f.name === 'featureRequestProgress',
  )
  assert.ok(progressField, 'featureRequestProgress is a root query field')
  assert.deepEqual(progressField.args.map((a) => a.name), ['promptId'])
  assert.equal(progressField.args[0].type.kind, 'NON_NULL')
  assert.equal(progressField.args[0].type.ofType.name, 'ID')
})
