// DAN-94: a feature-request session reaches a TERMINAL status. The bug was that
// status only ever moved gathering -> building, so a request whose every filed
// ticket was Done, whose PR was merged and deployed, still said "building" in
// the My-requests list forever.
//
// The fix is a self-healing write on the existing progress poll: when
// featureRequestProgress observes that every ticket it is about to serve is
// DONE, it persists SHIPPED_STATUS once, idempotently, and never flips back.
// This suite is that behaviour's contract — the flip, its once-only-ness, its
// one-way-ness, the two cases that must NOT flip, the uid scoping (including
// the DAN-52 warm-cache proof), and the status arriving on the wire.
//
// Sessions are seeded straight into the scratch collection (the DAN-51
// approval pipeline is not under test here) and Linear is a recording fake —
// no test reaches real Linear. Needs a reachable mongod via MONGODB_URI;
// MONGODB_DB is forced to the scratch database. Run with: npm test
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
  SHIPPED_STATUS,
} = await import('./featureRequests.js')

// --- fixtures ---

const DONE_STATE = { name: 'Done', type: 'completed' }
const STARTED_STATE = { name: 'In Progress', type: 'started' }
const BACKLOG_STATE = { name: 'Backlog', type: 'backlog' }

function linearIssue({ id, identifier, state }) {
  return {
    id,
    identifier,
    title: `title of ${identifier}`,
    url: `https://linear.app/fixture/issue/${identifier}`,
    state,
    attachments: { nodes: [] },
    inverseRelations: { nodes: [] },
  }
}

// A fake whose per-issue states are mutable, so one test can watch Linear's
// truth change between reads. Records every issuesProgress argument list.
function mutableLinearClient(issues) {
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const calls = []
  return {
    calls,
    setState(issueId, state) {
      byId.get(issueId).state = state
    },
    async issuesProgress(issueIds) {
      calls.push([...issueIds])
      return issueIds.map((id) => byId.get(id)).filter(Boolean)
    },
  }
}

// --- app plumbing (stub verifier, two users) ---

const TOKENS = {
  'dan94-token-owner': { uid: 'uid-dan94-owner' },
  'dan94-token-other': { uid: 'uid-dan94-other' },
}
const OWNER_UID = 'uid-dan94-owner'
const OWNER = 'dan94-token-owner'
const OTHER = 'dan94-token-other'

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

const PROGRESS = `query ($promptId: ID!) {
  featureRequestProgress(promptId: $promptId) {
    issueId identifier title state issueUrl prUrl blockedBy
  }
}`

const REQUESTS = `query { featureRequests { id status } }`

const featureRequests = () => getDb().collection('feature_requests')

async function seedSession({ uid = OWNER_UID, status = 'building', tickets } = {}) {
  const doc = {
    uid,
    status,
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Please add CSV export', createdAt: new Date() }],
    createdAt: new Date(),
  }
  if (tickets !== undefined) {
    doc.tickets = tickets
    doc.linearProjectId = 'project-dan94'
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

// The stored session, read straight from Mongo — the flip is a persistence
// claim, so it is checked in the database, not only on the wire.
async function storedSession(id) {
  const docs = await featureRequests().find({}).toArray()
  return docs.find((doc) => doc._id.toString() === id)
}

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await featureRequests().deleteMany({})
  clearFeatureRequestProgressCache()
})

after(async () => {
  await featureRequests().deleteMany({})
  await getDb().client.close()
})

// --- the status string itself ---

test('the terminal status is "shipped" — a session word, distinct from Linear\'s "completed" state type', () => {
  assert.equal(SHIPPED_STATUS, 'shipped')
})

// --- criterion 1: all tickets DONE -> the terminal status, persisted, once ---

test('a session whose filed tickets are all DONE flips to the terminal status on a progress read', async () => {
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
    linearIssue({ id: 'iss-2', identifier: 'DAN-102', state: DONE_STATE }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [ticketRef('T1', 'iss-1', 'DAN-101'), ticketRef('T2', 'iss-2', 'DAN-102')],
  })

  assert.equal((await storedSession(id)).status, 'building', 'precondition')

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  // The read still answers the question it was asked — the heal is a side
  // effect of the poll, never a replacement for its payload.
  assert.deepEqual(
    res.body.data.featureRequestProgress.map((n) => n.state),
    ['DONE', 'DONE'],
  )

  const doc = await storedSession(id)
  assert.equal(doc.status, SHIPPED_STATUS, 'the flip is persisted, not derived per read')
  assert.ok(doc.shippedAt instanceof Date, 'the flip stamps when it happened')
})

test('the flip happens exactly once: a later read rewrites neither the status nor shippedAt', async () => {
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'iss-1', 'DAN-101')] })

  await gql(app, OWNER, PROGRESS, { promptId: id })
  const first = await storedSession(id)
  assert.equal(first.status, SHIPPED_STATUS)

  // Past the cache, so the second read takes the same fetch-and-heal path the
  // first one did rather than being short-circuited by a warm entry.
  clearFeatureRequestProgressCache()
  await gql(app, OWNER, PROGRESS, { promptId: id })

  const second = await storedSession(id)
  assert.equal(second.status, SHIPPED_STATUS)
  assert.deepEqual(
    second.shippedAt,
    first.shippedAt,
    'a second write would have moved the timestamp — this session shipped once',
  )
  assert.equal(linear.calls.length, 2, 'both reads did go to Linear; only the first wrote')
})

test('the terminal status never flips back, even if Linear later says a ticket is in progress', async () => {
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'iss-1', 'DAN-101')] })

  await gql(app, OWNER, PROGRESS, { promptId: id })
  const shippedAt = (await storedSession(id)).shippedAt

  // Someone reopens the ticket in Linear. The session has shipped; the DAG can
  // say IN_PROGRESS again, but the session status is terminal.
  linear.setState('iss-1', STARTED_STATE)
  clearFeatureRequestProgressCache()
  const res = await gql(app, OWNER, PROGRESS, { promptId: id })

  assert.equal(
    res.body.data.featureRequestProgress[0].state,
    'IN_PROGRESS',
    'the per-ticket wire state still tracks Linear',
  )
  const doc = await storedSession(id)
  assert.equal(doc.status, SHIPPED_STATUS, 'the session status is one-way')
  assert.deepEqual(doc.shippedAt, shippedAt)
})

// --- criterion 2: the two cases that must NOT flip ---

test('a session with any ticket not DONE stays "building"', async () => {
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
    linearIssue({ id: 'iss-2', identifier: 'DAN-102', state: STARTED_STATE }),
    linearIssue({ id: 'iss-3', identifier: 'DAN-103', state: BACKLOG_STATE }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [
      ticketRef('T1', 'iss-1', 'DAN-101'),
      ticketRef('T2', 'iss-2', 'DAN-102'),
      ticketRef('T3', 'iss-3', 'DAN-103'),
    ],
  })

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.deepEqual(
    res.body.data.featureRequestProgress.map((n) => n.state),
    ['DONE', 'IN_PROGRESS', 'BACKLOG'],
  )
  assert.equal((await storedSession(id)).status, 'building')
  assert.equal((await storedSession(id)).shippedAt, undefined)

  // And it flips the moment the last two land — the heal is not a one-shot
  // opportunity the first poll burns.
  linear.setState('iss-2', DONE_STATE)
  linear.setState('iss-3', DONE_STATE)
  clearFeatureRequestProgressCache()
  await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal((await storedSession(id)).status, SHIPPED_STATUS)
})

test('a session with zero filed tickets stays as it was, and never reaches Linear', async () => {
  const linear = mutableLinearClient([])
  const app = makeApp(linear)
  // Both flavours of "no filed tickets": never approved (no `tickets` field at
  // all) and approved-with-an-empty-list.
  const gathering = await seedSession({ status: 'gathering' })
  const emptyTickets = await seedSession({ status: 'building', tickets: [] })

  for (const id of [gathering, emptyTickets]) {
    const res = await gql(app, OWNER, PROGRESS, { promptId: id })
    assert.equal(res.body.errors, undefined)
    assert.deepEqual(res.body.data.featureRequestProgress, [])
  }

  assert.equal((await storedSession(gathering)).status, 'gathering')
  assert.equal((await storedSession(emptyTickets)).status, 'building')
  assert.equal(linear.calls.length, 0, 'no tickets, no Linear read — and no flip')
})

// --- criterion 3: the status is on the wire and drives My requests ---

test('the terminal status appears on the FeatureRequest wire type after the progress read heals it', async () => {
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'iss-1', 'DAN-101')] })

  // Before: the My-requests list — a pure Mongo read, no Linear call — still
  // says "building". This IS the reported bug, and the migration story for
  // sessions that shipped before this ticket.
  const before = await gql(app, OWNER, REQUESTS)
  assert.deepEqual(before.body.data.featureRequests, [{ id, status: 'building' }])

  await gql(app, OWNER, PROGRESS, { promptId: id })

  const after = await gql(app, OWNER, REQUESTS)
  assert.equal(after.body.errors, undefined)
  assert.deepEqual(
    after.body.data.featureRequests,
    [{ id, status: SHIPPED_STATUS }],
    'the list query serves the healed status with no Linear call of its own',
  )
  assert.equal(linear.calls.length, 1, 'only the progress read talked to Linear')
})

// --- criterion 4: scoping — the write is the caller's own session only ---

test('a foreign uid gets NOT_FOUND and cannot flip the owner\'s session, warm cache or not (DAN-52 pattern)', async () => {
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'iss-1', 'DAN-101')] })

  // Cold cache: the intruder is refused before Linear and before any write.
  const cold = await gql(app, OTHER, PROGRESS, { promptId: id })
  assert.equal(cold.body.data, null)
  assert.equal(cold.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(cold.body.errors[0].message, 'feature request not found')
  assert.equal(linear.calls.length, 0)
  assert.equal((await storedSession(id)).status, 'building', 'no foreign write')

  // Now warm the cache with the owner's own read, which also heals the status.
  await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal((await storedSession(id)).status, SHIPPED_STATUS)

  // Hand the session back to "building" and let the intruder read it with the
  // cache warm for this exact promptId: the uid-scoped session read runs on
  // every call, so it is still NOT_FOUND — and the status stays untouched.
  await featureRequests().updateOne(
    { _id: (await storedSession(id))._id },
    { $set: { status: 'building' }, $unset: { shippedAt: '' } },
  )
  const warm = await gql(app, OTHER, PROGRESS, { promptId: id })
  assert.equal(warm.body.data, null)
  assert.equal(warm.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(linear.calls.length, 1, 'the intruder never reached Linear')
  assert.equal(
    (await storedSession(id)).status,
    'building',
    'a warm cache cannot make one user\'s read write another user\'s session',
  )
})

test('a session another user owns is never healed by this user\'s poll', async () => {
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
  ])
  const app = makeApp(linear)
  const theirs = await seedSession({
    uid: 'uid-dan94-other',
    tickets: [ticketRef('T1', 'iss-1', 'DAN-101')],
  })

  const res = await gql(app, OWNER, PROGRESS, { promptId: theirs })
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal((await storedSession(theirs)).status, 'building')
})

// --- the write rides the fetch, not the cache ---

test('a cache-served read performs no write at all — the heal rides the Linear fetch', async () => {
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
  ])
  const id = await seedSession({ tickets: [ticketRef('T1', 'iss-1', 'DAN-101')] })

  let clock = 5_000_000
  const now = () => clock

  await featureRequestProgress(OWNER_UID, id, linear, now)
  assert.equal((await storedSession(id)).status, SHIPPED_STATUS)
  assert.equal(linear.calls.length, 1)

  // Put the session back to "building" behind the cache's back. Inside the
  // TTL the read is served from the cached nodes and writes nothing, which is
  // exactly why a warm cache can never carry a write across users.
  await featureRequests().updateOne(
    { _id: (await storedSession(id))._id },
    { $set: { status: 'building' }, $unset: { shippedAt: '' } },
  )
  clock += PROGRESS_CACHE_TTL_MS - 1
  await featureRequestProgress(OWNER_UID, id, linear, now)
  assert.equal(linear.calls.length, 1, 'still inside the TTL: served from cache')
  assert.equal((await storedSession(id)).status, 'building', 'a cache hit writes nothing')

  // Past the TTL the fetch happens again, and with it the heal.
  clock += 1
  await featureRequestProgress(OWNER_UID, id, linear, now)
  assert.equal(linear.calls.length, 2)
  assert.equal((await storedSession(id)).status, SHIPPED_STATUS)
})

// --- a ticket deleted in Linear follows the DAG's own definition of "done" ---

test('"finished" is the DAG\'s rule: nodes actually served, at least one, all DONE', async () => {
  // The session filed two tickets; one was deleted by hand in Linear, so the
  // progress read serves a single node (never fabricating the missing one).
  // The DAG calls that "Build complete" and stops polling, so the session
  // status agrees rather than contradicting the screen the user is looking at.
  const linear = mutableLinearClient([
    linearIssue({ id: 'iss-1', identifier: 'DAN-101', state: DONE_STATE }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [ticketRef('T1', 'iss-1', 'DAN-101'), ticketRef('T2', 'iss-gone', 'DAN-102')],
  })

  const res = await gql(app, OWNER, PROGRESS, { promptId: id })
  assert.equal(res.body.data.featureRequestProgress.length, 1)
  assert.equal((await storedSession(id)).status, SHIPPED_STATUS)
})
