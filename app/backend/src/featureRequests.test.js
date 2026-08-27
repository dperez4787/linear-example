// Feature-request sessions (DAN-47): HTTP-level tests for the
// startFeatureRequest mutation and the featureRequest(s) queries, via supertest
// against the in-process app. Run with: npm test
//
// Same pattern as graphql.test.js: the app is built with an injected stub
// verifier (no firebase-admin, no network) and every request carries a bearer
// token to get past the gate. Domain outcomes are asserted on body.data /
// body.errors[].extensions, never on HTTP status (see docs/architecture.md,
// Error mapping). Sessions are per-user, so this suite's stub verifier knows
// TWO tokens mapping to two uids — ownership scoping is asserted by making
// requests as both users against the same scratch database
// (linear_example_test).
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

// Stub verifier with two known users, so ownership scoping is testable.
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

const app = createApp({ verifyToken: stubVerify })

function gql(token, query, variables) {
  return request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })
}

const FR_FIELDS = 'id status model createdAt messages { role content }'

const START = `mutation ($input: StartFeatureRequestInput!) {
  startFeatureRequest(input: $input) { ${FR_FIELDS} }
}`
const LIST = `{ featureRequests { ${FR_FIELDS} } }`
const GET = `query ($id: ID!) { featureRequest(id: $id) { ${FR_FIELDS} } }`

// A well-formed ObjectId (24 hex chars) that nothing was inserted under, plus a
// string that isn't a valid ObjectId at all.
const MISSING_ID = '0123456789abcdef01234567'
const MALFORMED_ID = 'not-an-object-id'

async function start(token, model = 'claude-opus-5') {
  const res = await gql(token, START, { input: { model } })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest
}

function featureRequests() {
  return getDb().collection('feature_requests')
}

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await featureRequests().deleteMany({})
})

after(async () => {
  await featureRequests().deleteMany({})
  await getDb().client.close()
})

// --- startFeatureRequest mutation ---

test('startFeatureRequest with a valid model returns the new session and writes a document carrying the caller uid', async () => {
  const res = await gql(ALICE, START, { input: { model: 'claude-opus-5' } })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)

  const session = res.body.data.startFeatureRequest
  assert.equal(typeof session.id, 'string', 'id (the promptId) is a string')
  assert.equal(session.status, 'gathering')
  assert.equal(session.model, 'claude-opus-5')
  assert.deepEqual(session.messages, [], 'a new session has no messages')
  assert.equal(
    new Date(session.createdAt).toISOString(),
    session.createdAt,
    'createdAt is an ISO-8601 string',
  )

  // The document exists in feature_requests and carries the caller's uid.
  const { ObjectId } = await import('mongodb')
  const doc = await featureRequests().findOne({ _id: new ObjectId(session.id) })
  assert.ok(doc, 'a document exists under the returned id')
  assert.equal(doc.uid, 'uid-alice', 'the document carries the caller Firebase uid')
  assert.equal(doc.status, 'gathering')
  assert.equal(doc.model, 'claude-opus-5')
  assert.deepEqual(doc.messages, [])
  assert.ok(doc.createdAt instanceof Date)
})

test('startFeatureRequest response never exposes _id or uid', async () => {
  const res = await gql(ALICE, START, { input: { model: 'claude-opus-5' } })
  const body = JSON.stringify(res.body)
  assert.ok(!body.includes('_id'), 'the string "_id" must not appear in the response')
  assert.ok(!body.includes('uid-alice'), 'the uid must not appear in the response')
})

test('startFeatureRequest with an unsupported model → 200, BAD_USER_INPUT on field model, nothing written', async () => {
  const res = await gql(ALICE, START, { input: { model: 'claude-haiku-4-5' } })

  assert.equal(res.status, 200, 'a domain validation failure is never an HTTP 4xx/5xx')
  assert.equal(res.body.data, null, 'the mutation return type is non-null, so data nulls overall')
  assert.deepEqual(res.body.errors[0].extensions, {
    code: 'BAD_USER_INPUT',
    field: 'model',
  })
  assert.equal(await featureRequests().countDocuments(), 0, 'a failed mutation writes nothing')
})

// --- featureRequests query ---

test('featureRequests returns only the caller sessions, newest first; another user sessions never appear', async () => {
  const aliceFirst = await start(ALICE)
  const bobOnly = await start(BOB)
  const aliceSecond = await start(ALICE)

  const aliceRes = await gql(ALICE, LIST)
  assert.equal(aliceRes.status, 200)
  assert.equal(aliceRes.body.errors, undefined)
  assert.deepEqual(
    aliceRes.body.data.featureRequests.map((fr) => fr.id),
    [aliceSecond.id, aliceFirst.id],
    'exactly the caller sessions, newest first',
  )

  const bobRes = await gql(BOB, LIST)
  assert.deepEqual(
    bobRes.body.data.featureRequests.map((fr) => fr.id),
    [bobOnly.id],
    'the other user sees only their own session',
  )
})

test('featureRequests with no sessions returns an empty list', async () => {
  const res = await gql(ALICE, LIST)
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequests, [])
})

// --- featureRequest(id) query ---

test('featureRequest(id) returns the caller own session', async () => {
  const session = await start(ALICE)
  const res = await gql(ALICE, GET, { id: session.id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.featureRequest.id, session.id)
  assert.equal(res.body.data.featureRequest.status, 'gathering')
})

test('featureRequest(id) for ANOTHER USER session → 200, data.featureRequest null, NOT_FOUND', async () => {
  const session = await start(ALICE)
  const res = await gql(BOB, GET, { id: session.id })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.featureRequest, null)
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
})

for (const [label, id] of [
  ['nonexistent', MISSING_ID],
  ['malformed', MALFORMED_ID],
]) {
  test(`featureRequest(id) with a ${label} id → 200, data.featureRequest null, NOT_FOUND (never 5xx)`, async () => {
    const res = await gql(ALICE, GET, { id })
    assert.equal(res.status, 200, 'a domain not-found is never an HTTP 5xx')
    assert.equal(res.body.data.featureRequest, null)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  })
}

// --- auth gate (unchanged DAN-22 semantics for the new operations) ---

test('feature-request operations without a token → HTTP 401 from the gate, before GraphQL parsing', async () => {
  const res = await request(app).post('/api/graphql').send({ query: LIST })
  assert.equal(res.status, 401)
  assert.equal(typeof res.body.error.message, 'string', 'shape is { error: { message } }')
  assert.equal(res.body.errors, undefined, 'the 401 is the HTTP-level shape, not a GraphQL response')
})

test('feature-request operations with an invalid token → HTTP 401 from the gate', async () => {
  const res = await request(app)
    .post('/api/graphql')
    .set('Authorization', 'Bearer not-a-real-token')
    .send({ query: START, variables: { input: { model: 'claude-opus-5' } } })
  assert.equal(res.status, 401)
  assert.equal(typeof res.body.error.message, 'string')
  assert.equal(await featureRequests().countDocuments(), 0, 'nothing written behind a failed gate')
})
