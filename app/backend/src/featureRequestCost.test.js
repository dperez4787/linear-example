// featureRequestCost (DAN-80): what one feature-request session has cost,
// proxied live from the AI gateway's usage ledger and filtered to the
// session's promptId. Tested over HTTP via supertest against the in-process
// app.
// Run with: npm test
//
// The injected aiGateway is a FAKE that records every usage() call and
// returns fixture rows — no test reaches a real gateway. Sessions are seeded
// directly into the scratch collection; Mongo (linear_example_test) is the
// only external dependency, same as the sibling suites.
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
const { GatewayError } = await import('./aiGateway.js')

// --- fixtures ---

// The live response shape of GET /v1/usage?group_by=prompt_id, verified
// against the gateway's source (ai-gateway/src/usage.js): rows keyed by
// `group` (the promptId, or null for unattributed calls), camelCase number
// fields, costUsd rounded server-side, plus a `total` rollup. `usageBody`
// builds the fixture around the session id under test, alongside a decoy row
// and a null-group row that must never bleed into the answer.
function usageBody(promptId) {
  return {
    persona: 'linear-example-backend',
    window: '30d',
    group_by: 'prompt_id',
    rows: [
      { group: 'prompt-decoy', calls: 99, tokensIn: 9999, tokensOut: 8888, costUsd: 12.34 },
      { group: promptId, calls: 4, tokensIn: 120, tokensOut: 260, costUsd: 0.0134 },
      { group: null, calls: 3, tokensIn: 50, tokensOut: 60, costUsd: 0.002 },
    ],
    total: { calls: 106, tokensIn: 10169, tokensOut: 9208, costUsd: 12.3554 },
  }
}

const EXPECTED_COST = { calls: 4, tokensIn: 120, tokensOut: 260, costUsd: 0.0134 }
const ZERO_COST = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }

// The recording fake: usage() pushes its args and returns the canned body
// (or throws the scripted error). chat is present but must never be called.
function fakeAiGateway({ body = usageBody('prompt-nobody-asked-about'), error } = {}) {
  const calls = []
  return {
    calls,
    async chat() {
      throw new Error('featureRequestCost must never call chat()')
    },
    async usage(args) {
      calls.push(args)
      if (error) throw error
      return body
    },
  }
}

// --- app plumbing (stub verifier, injected fake aiGateway) ---

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

const makeApp = (aiGateway) => createApp({ verifyToken: stubVerify, aiGateway })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const COST = `query ($promptId: ID!) {
  featureRequestCost(promptId: $promptId) { calls tokensIn tokensOut costUsd }
}`

const featureRequests = () => getDb().collection('feature_requests')

async function seedSession({ uid = 'uid-alice' } = {}) {
  const { insertedId } = await featureRequests().insertOne({
    uid,
    status: 'gathering',
    model: 'claude-opus-5',
    messages: [],
    createdAt: new Date(),
  })
  return insertedId.toString()
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

// --- criterion 2: the row for exactly that promptId ---

test('featureRequestCost returns the gateway row for exactly the session promptId, requested with group_by prompt_id', async () => {
  const id = await seedSession()
  const gateway = fakeAiGateway({ body: usageBody(id) })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, EXPECTED_COST)
  assert.deepEqual(gateway.calls, [{ groupBy: 'prompt_id' }], 'one usage read, grouped by prompt_id')
})

test('a session the gateway has no row for costs zeros — never null, never an error', async () => {
  const id = await seedSession()
  // Decoy, foreign, and null-group rows only: nothing matches this session's
  // promptId, and the null-group (unattributed) row must not be picked up.
  const gateway = fakeAiGateway({ body: usageBody('prompt-someone-else') })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, ZERO_COST)
})

test('an empty gateway ledger costs zeros', async () => {
  const id = await seedSession()
  const gateway = fakeAiGateway({
    body: {
      persona: 'linear-example-backend',
      window: '30d',
      group_by: 'prompt_id',
      rows: [],
      total: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
    },
  })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, ZERO_COST)
})

// --- criterion 2: uid scoping and id hygiene — same rules as featureRequest ---

test("another user's session → NOT_FOUND, and the gateway is never called", async () => {
  const id = await seedSession({ uid: 'uid-alice' })
  const gateway = fakeAiGateway({ body: usageBody(id) })

  const res = await gql(makeApp(gateway), BOB, COST, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.data, null, 'non-null return type nulls data overall')
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(res.body.errors[0].message, 'feature request not found')
  assert.equal(gateway.calls.length, 0, 'no usage read for a session the caller cannot see')
})

for (const [label, badId] of [
  ['nonexistent', '0123456789abcdef01234567'],
  ['malformed', 'not-an-object-id'],
]) {
  test(`a ${label} promptId → NOT_FOUND, zero gateway calls (never 5xx)`, async () => {
    const gateway = fakeAiGateway()
    const res = await gql(makeApp(gateway), ALICE, COST, { promptId: badId })
    assert.equal(res.status, 200)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
    assert.equal(gateway.calls.length, 0)
  })
}

// --- criterion 2: gateway failure → INTERNAL, nothing leaked ---

test('a gateway failure maps to INTERNAL without leaking gateway details', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  const id = await seedSession()
  const gateway = fakeAiGateway({
    error: new GatewayError('AI gateway responded 503 to the usage read'),
  })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.status, 200, 'a gateway failure is a domain error, not a 5xx')
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')
  const wire = JSON.stringify(res.body)
  assert.ok(!wire.includes('503'), 'the gateway status must not leak')
  assert.ok(!/gateway/i.test(wire), 'gateway details must not leak')
  assert.ok(errors.mock.callCount() >= 1, 'the real error is logged server-side')
})

// --- the auth gate, same as every session operation ---

test('featureRequestCost without a token → HTTP 401 from the gate, zero gateway calls', async () => {
  const gateway = fakeAiGateway()
  const id = await seedSession()
  const res = await request(makeApp(gateway))
    .post('/api/graphql')
    .send({ query: COST, variables: { promptId: id } })
  assert.equal(res.status, 401)
  assert.equal(gateway.calls.length, 0)
})
