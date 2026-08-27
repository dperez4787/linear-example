// AI usage ledger tests (DAN-48): the aiUsage.js data layer against the scratch
// test database, the myAiUsage GraphQL query over HTTP, and the full recording
// chain — a successful gateway call (fixture transport, no network) incrementing
// the caller's ledger that myAiUsage then reads back.
//
// Same environment contract as graphql.test.js: any reachable mongod via
// MONGODB_URI (.env or ambient), MONGODB_DB forced to linear_example_test.
//
// Run with: npm test
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
const { recordUsage, getUsage } = await import('./aiUsage.js')
const { createAiGateway } = await import('./aiGateway.js')

// Stub verifier mapping distinct tokens to distinct uids, so uid isolation is
// assertable. Same seam as every other HTTP-level suite.
const TOKENS = { 'token-alice': 'uid-alice', 'token-bob': 'uid-bob' }
const stubVerify = async (token) => {
  const uid = TOKENS[token]
  if (!uid) throw new Error('invalid token')
  return { uid }
}

function myAiUsage(app, token) {
  return request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query: '{ myAiUsage { requests totalTokens } }' })
}

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await getDb().collection('ai_usage').deleteMany({})
})

after(async () => {
  await getDb().collection('ai_usage').deleteMany({})
  await getDb().client.close()
})

// --- data layer ---

test('getUsage returns zeros for a user with no usage', async () => {
  assert.deepEqual(await getUsage('uid-nobody'), { requests: 0, totalTokens: 0 })
})

test('recordUsage upserts on first call and increments on subsequent calls', async () => {
  await recordUsage('uid-alice', 42)
  assert.deepEqual(await getUsage('uid-alice'), { requests: 1, totalTokens: 42 })

  await recordUsage('uid-alice', 58)
  assert.deepEqual(await getUsage('uid-alice'), { requests: 2, totalTokens: 100 })
})

test('recordUsage with a missing/non-finite token count still counts the request', async () => {
  await recordUsage('uid-alice', undefined)
  assert.deepEqual(await getUsage('uid-alice'), { requests: 1, totalTokens: 0 })
})

test('usage is per-user: one caller\'s ledger never bleeds into another\'s', async () => {
  await recordUsage('uid-alice', 10)
  await recordUsage('uid-bob', 7)
  assert.deepEqual(await getUsage('uid-alice'), { requests: 1, totalTokens: 10 })
  assert.deepEqual(await getUsage('uid-bob'), { requests: 1, totalTokens: 7 })
})

// --- criterion 5: the myAiUsage query ---

test('myAiUsage returns zeros over HTTP when the caller has no usage', async () => {
  const app = createApp({ verifyToken: stubVerify })
  const res = await myAiUsage(app, 'token-alice')
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.myAiUsage, { requests: 0, totalTokens: 0 })
})

test('myAiUsage returns the CALLER\'s totals — the uid comes from the verified token, not an argument', async () => {
  await recordUsage('uid-alice', 42)
  await recordUsage('uid-bob', 999)

  const app = createApp({ verifyToken: stubVerify })
  const res = await myAiUsage(app, 'token-alice')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.myAiUsage, { requests: 1, totalTokens: 42 })
})

// --- criterion 4, end to end: a successful gateway call shows up in myAiUsage ---

test('a successful gateway call increments the ledger that myAiUsage reads back', async (t) => {
  process.env.AI_GATEWAY_URL = 'https://gateway.test'
  process.env.AI_GATEWAY_KEY = 'stub-gateway-key'
  t.after(() => {
    delete process.env.AI_GATEWAY_URL
    delete process.env.AI_GATEWAY_KEY
  })

  // Real client, real (default) recordUsage into Mongo — only the transport is
  // a fixture, so no network call happens.
  const completion = {
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 5, completion_tokens: 37, total_tokens: 42 },
  }
  const gateway = createAiGateway({
    fetch: async () => ({ ok: true, status: 200, json: async () => completion }),
  })

  await gateway.chat({ uid: 'uid-alice', promptId: 'p-1', role: 'builder', messages: [] })
  await gateway.chat({ uid: 'uid-alice', promptId: 'p-2', role: 'builder', messages: [] })

  const app = createApp({ verifyToken: stubVerify, aiGateway: gateway })
  const res = await myAiUsage(app, 'token-alice')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.myAiUsage, { requests: 2, totalTokens: 84 })

  // And the other user saw nothing.
  const other = await myAiUsage(app, 'token-bob')
  assert.deepEqual(other.body.data.myAiUsage, { requests: 0, totalTokens: 0 })
})
