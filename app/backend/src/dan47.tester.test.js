// DAN-47 tester verification — independent of the developer's featureRequests.test.js.
//
// Drives POST /api/graphql end to end against the scratch test database
// (linear_example_test) and asserts the ticket's acceptance criteria directly on
// the wire, plus the one seam change this ticket makes: the auth gate now keeps
// the decoded token (req.auth) and index.js threads { uid } into the GraphQL
// context. So this file also proves the gate's PRIOR contract is intact — the
// exact 401 body shape, and the missing/malformed-header short-circuit that must
// never call the verifier (asserted with a spying verifier, not by inference).
//
// Ownership is exercised with two stub-verified uids of this file's own choosing.
// The indistinguishability check deep-equals the ENTIRE response body for a
// foreign id vs a nonexistent id — not just the code — because "another user's
// session never appears" is only true if the two failures cannot be told apart.
//
// Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { ObjectId } from 'mongodb'

if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // No .env — MONGODB_URI must come from the ambient environment.
  }
}
process.env.MONGODB_DB = 'linear_example_test'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')

// Two stub-verified users plus a call log, so the short-circuit criterion can be
// proven directly: if the gate ever calls the verifier for a missing/non-Bearer
// header, `calls` records it.
const USERS = {
  'dan47-token-one': { uid: 'dan47-uid-one' },
  'dan47-token-two': { uid: 'dan47-uid-two' },
}
const USER_ONE = 'dan47-token-one'
const USER_TWO = 'dan47-token-two'

const verifierCalls = []
const stubVerify = async (token) => {
  verifierCalls.push(token)
  const decoded = USERS[token]
  if (!decoded) throw new Error('unknown token')
  return decoded
}

const app = createApp({ verifyToken: stubVerify })

const FIELDS = 'id status model createdAt messages { role content }'
const START = `mutation ($input: StartFeatureRequestInput!) { startFeatureRequest(input: $input) { ${FIELDS} } }`
const LIST = `{ featureRequests { ${FIELDS} } }`
const ONE = `query ($id: ID!) { featureRequest(id: $id) { ${FIELDS} } }`

const NONEXISTENT_ID = 'ffffffffffffffffffffffff'

function gql(token, query, variables) {
  const req = request(app).post('/api/graphql')
  if (token !== null) req.set('Authorization', `Bearer ${token}`)
  return req.send({ query, variables })
}

function coll() {
  return getDb().collection('feature_requests')
}

async function start(token, model = 'claude-opus-5') {
  const res = await gql(token, START, { input: { model } })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, 'session creation must not error')
  return res.body.data.startFeatureRequest
}

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await coll().deleteMany({})
})

after(async () => {
  await coll().deleteMany({})
  await getDb().client.close()
})

// --- Criterion 1: startFeatureRequest happy path + stored document ---

test('startFeatureRequest returns the FeatureRequest shape and persists a uid-carrying document (mutation-then-read round trip)', async () => {
  const res = await gql(USER_ONE, START, { input: { model: 'claude-opus-5' } })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)

  const fr = res.body.data.startFeatureRequest
  assert.equal(typeof fr.id, 'string', 'id (the promptId) is a string')
  assert.ok(ObjectId.isValid(fr.id), 'id round-trips as an ObjectId string')
  assert.equal(fr.status, 'gathering')
  assert.equal(fr.model, 'claude-opus-5')
  assert.deepEqual(fr.messages, [], 'messages starts empty')
  assert.equal(new Date(fr.createdAt).toISOString(), fr.createdAt, 'createdAt is ISO-8601')

  // The document exists in feature_requests and carries the caller's Firebase uid.
  const doc = await coll().findOne({ _id: new ObjectId(fr.id) })
  assert.ok(doc, 'a feature_requests document exists under the returned id')
  assert.equal(doc.uid, 'dan47-uid-one', "the stored document carries the caller's uid")
  assert.equal(doc.status, 'gathering')
  assert.equal(doc.model, 'claude-opus-5')
  assert.deepEqual(doc.messages, [])
  assert.ok(doc.createdAt instanceof Date)
  assert.equal(await coll().countDocuments(), 1, 'exactly one document was written')

  // Round trip: the same session is readable back through featureRequest(id)
  // by its owner, byte-identical to what the mutation returned.
  const read = await gql(USER_ONE, ONE, { id: fr.id })
  assert.equal(read.status, 200)
  assert.equal(read.body.errors, undefined)
  assert.deepEqual(read.body.data.featureRequest, fr, 'read-back equals the mutation payload')
})

test('neither _id nor uid ever crosses the wire', async () => {
  const fr = await start(USER_ONE)
  const list = await gql(USER_ONE, LIST)
  const one = await gql(USER_ONE, ONE, { id: fr.id })
  for (const body of [list.body, one.body]) {
    const s = JSON.stringify(body)
    assert.ok(!s.includes('_id'), '_id must not appear in any response')
    assert.ok(!s.includes('dan47-uid-one'), 'uid must not appear in any response')
  }
})

// --- Criterion 2: invalid model -> BAD_USER_INPUT on "model", nothing written ---

for (const model of ['claude-sonnet-4-5', 'gpt-5', '', 'CLAUDE-OPUS-5']) {
  test(`startFeatureRequest(model: ${JSON.stringify(model)}) → 200, BAD_USER_INPUT field "model", nothing written`, async () => {
    const res = await gql(USER_ONE, START, { input: { model } })
    assert.equal(res.status, 200, 'a domain validation failure is in-band, never an HTTP 4xx/5xx')
    assert.deepEqual(
      res.body.errors[0].extensions,
      { code: 'BAD_USER_INPUT', field: 'model' },
      'extensions is exactly { code: BAD_USER_INPUT, field: model }',
    )
    assert.equal(res.body.data, null, 'non-null mutation return type nulls data overall')
    assert.equal(await coll().countDocuments(), 0, 'a rejected mutation writes nothing')
  })
}

// --- Criterion 3: per-user scoping, newest first (two-uid isolation) ---

test('featureRequests is scoped to the caller and ordered newest first; the other uid never leaks through', async () => {
  // Interleave the two users so scoping cannot pass by accident of ordering.
  const one1 = await start(USER_ONE)
  const two1 = await start(USER_TWO)
  const one2 = await start(USER_ONE)
  const two2 = await start(USER_TWO)
  const one3 = await start(USER_ONE)

  const listOne = await gql(USER_ONE, LIST)
  assert.equal(listOne.status, 200)
  assert.equal(listOne.body.errors, undefined)
  assert.deepEqual(
    listOne.body.data.featureRequests.map((f) => f.id),
    [one3.id, one2.id, one1.id],
    "exactly the caller's three sessions, newest first",
  )
  const idsTwo = new Set([two1.id, two2.id])
  for (const f of listOne.body.data.featureRequests) {
    assert.ok(!idsTwo.has(f.id), "another user's session id must never appear")
  }

  const listTwo = await gql(USER_TWO, LIST)
  assert.deepEqual(
    listTwo.body.data.featureRequests.map((f) => f.id),
    [two2.id, two1.id],
    'the second user sees only their own two, newest first',
  )
})

test('featureRequests with no sessions is an empty list, not an error', async () => {
  await start(USER_TWO) // someone ELSE has data
  const res = await gql(USER_ONE, LIST)
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequests, [])
})

// --- Criterion 4: NOT_FOUND for unknown AND foreign ids — indistinguishably ---

test('featureRequest(id): foreign id and nonexistent id produce IDENTICAL response payloads (200 + NOT_FOUND)', async () => {
  const foreign = await start(USER_TWO) // exists, but belongs to USER_TWO

  const foreignRes = await gql(USER_ONE, ONE, { id: foreign.id })
  const missingRes = await gql(USER_ONE, ONE, { id: NONEXISTENT_ID })

  for (const res of [foreignRes, missingRes]) {
    assert.equal(res.status, 200)
    assert.equal(res.body.data.featureRequest, null)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  }

  // The whole bodies must be identical — a caller must not be able to probe
  // whether someone else's session id exists.
  assert.deepEqual(
    foreignRes.body,
    missingRes.body,
    'a foreign session must be indistinguishable from a nonexistent one',
  )
})

test('featureRequest(id) with a malformed id is the same NOT_FOUND, never a 5xx', async () => {
  const res = await gql(USER_ONE, ONE, { id: 'definitely-not-an-objectid' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.featureRequest, null)
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
})

// --- Criterion 5 + the seam change: the gate's prior contract is intact ---

test('missing Authorization header → HTTP 401, exact prior shape, verifier NEVER called, nothing written', async () => {
  verifierCalls.length = 0
  const res = await gql(null, START, { input: { model: 'claude-opus-5' } })
  assert.equal(res.status, 401)
  assert.deepEqual(
    res.body,
    { error: { message: 'Missing or malformed Authorization header' } },
    'the 401 body is byte-for-byte the prior { error: { message } } shape',
  )
  assert.equal(res.body.errors, undefined, 'HTTP-level error, not a GraphQL response')
  assert.equal(verifierCalls.length, 0, 'the gate short-circuits BEFORE the verifier')
  assert.equal(await coll().countDocuments(), 0)
})

test('non-Bearer header → HTTP 401 without calling the verifier', async () => {
  verifierCalls.length = 0
  const res = await request(app)
    .post('/api/graphql')
    .set('Authorization', 'Basic dXNlcjpwYXNz')
    .send({ query: LIST })
  assert.equal(res.status, 401)
  assert.deepEqual(res.body, { error: { message: 'Missing or malformed Authorization header' } })
  assert.equal(verifierCalls.length, 0)
})

test('rejected token → HTTP 401, exact prior shape, execution never reached, nothing written', async () => {
  const res = await gql('dan47-bogus-token', START, { input: { model: 'claude-opus-5' } })
  assert.equal(res.status, 401)
  assert.deepEqual(res.body, { error: { message: 'Invalid or expired token' } })
  assert.equal(await coll().countDocuments(), 0, 'nothing written behind a failed gate')
})

test('the 401 comes before GraphQL parsing: a syntactically INVALID query still 401s anonymously', async () => {
  const res = await request(app)
    .post('/api/graphql')
    .send({ query: '{{{ not graphql at all' })
  assert.equal(res.status, 401, 'the gate answers before the query is ever parsed')
  assert.deepEqual(res.body, { error: { message: 'Missing or malformed Authorization header' } })
})

// --- Criterion 6: /health untouched ---

test('GET /health is 200 { status: "ok" } with no auth and no Mongo dependency', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})
