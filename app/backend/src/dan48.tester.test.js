// DAN-48 tester verification — independent tests, written against the ticket's
// acceptance criteria, not the developer's tests. Covers: the captured-transport
// metadata contract (criterion 1), per-user ledger isolation and accumulation in
// real Mongo read back through the real app's myAiUsage query (criteria 4+5),
// failed-call-records-nothing via a 429-then-success sequence, and wire-leak
// probes on the INTERNAL path (criterion 6) asserting no gateway URL, key,
// status, or upstream detail string ever reaches the client.
//
// Environment contract: same as graphql.test.js / aiUsage.test.js — a reachable
// mongod via MONGODB_URI (.env or ambient), MONGODB_DB forced to the scratch
// test database. Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { buildSchema } from 'graphql'
import { createHandler } from 'graphql-http/lib/use/express'
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
const { createAiGateway, QuotaExhaustedError } = await import('./aiGateway.js')
const { resolver } = await import('./graphql.js')

// Deliberately NOT the developer's fixture values, so a hard-coded match in the
// implementation cannot pass by coincidence.
const T_URL = 'https://tester-gw.invalid'
const T_KEY = 'tester-bearer-9f3a'
// A distinctive upstream detail string: if any fragment of it reaches the wire,
// the leak probe fails.
const UPSTREAM_DETAIL = 'upstream-detail-DO-NOT-LEAK-51c2'

function setGatewayEnv(t, url = T_URL, key = T_KEY) {
  const saved = { url: process.env.AI_GATEWAY_URL, key: process.env.AI_GATEWAY_KEY }
  if (url === undefined) delete process.env.AI_GATEWAY_URL
  else process.env.AI_GATEWAY_URL = url
  if (key === undefined) delete process.env.AI_GATEWAY_KEY
  else process.env.AI_GATEWAY_KEY = key
  t.after(() => {
    if (saved.url === undefined) delete process.env.AI_GATEWAY_URL
    else process.env.AI_GATEWAY_URL = saved.url
    if (saved.key === undefined) delete process.env.AI_GATEWAY_KEY
    else process.env.AI_GATEWAY_KEY = saved.key
  })
}

// A transport whose per-call responses are scripted: pass a list of
// { status, body } and each call consumes the next one. Records every call.
function scriptedFetch(script) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const { status, body } = script[Math.min(calls.length - 1, script.length - 1)]
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  fn.calls = calls
  return fn
}

function completion(totalTokens) {
  return {
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: totalTokens - 1, total_tokens: totalTokens },
  }
}

// Stub verifier with two distinct users, for isolation assertions.
const TOKENS = { 'tok-carol': 'uid-carol-dan48', 'tok-dave': 'uid-dave-dan48' }
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

// --- criterion 1: independent captured-transport assertion ---

test('tester: chat() request shape — URL, POST, bearer key, exact metadata object', async (t) => {
  setGatewayEnv(t)
  const fetch = scriptedFetch([{ status: 200, body: completion(10) }])
  const gateway = createAiGateway({ fetch, recordUsage: async () => {} })

  await gateway.chat({
    uid: 'uid-carol-dan48',
    promptId: 'tester-prompt-77',
    role: 'reviewer',
    model: 'm-1',
    messages: [{ role: 'user', content: 'x' }],
  })

  assert.equal(fetch.calls.length, 1)
  const { url, init } = fetch.calls[0]
  assert.equal(url, `${T_URL}/v1/chat/completions`)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, `Bearer ${T_KEY}`)
  const body = JSON.parse(init.body)
  assert.deepEqual(body.metadata, {
    on_behalf_of: 'uid-carol-dan48',
    feature: 'prompt-a-feature',
    prompt_id: 'tester-prompt-77',
    role: 'reviewer',
  })
  // Attribution fields must not double up as top-level body fields.
  assert.ok(!('uid' in body) && !('promptId' in body) && !('role' in body))
  // The conversational payload passes through.
  assert.equal(body.model, 'm-1')
})

// --- criteria 4+5: real Mongo ledger, read back through the real app ---

test('tester: two-user isolation — each caller reads only their own ledger', async (t) => {
  setGatewayEnv(t)
  const gateway = createAiGateway({ fetch: scriptedFetch([{ status: 200, body: completion(11) }]) })
  await gateway.chat({ uid: 'uid-carol-dan48', promptId: 'p', role: 'r', messages: [] })

  const gateway2 = createAiGateway({ fetch: scriptedFetch([{ status: 200, body: completion(23) }]) })
  await gateway2.chat({ uid: 'uid-dave-dan48', promptId: 'p', role: 'r', messages: [] })

  const app = createApp({ verifyToken: stubVerify, aiGateway: gateway })
  const carol = await myAiUsage(app, 'tok-carol')
  const dave = await myAiUsage(app, 'tok-dave')
  assert.equal(carol.status, 200)
  assert.deepEqual(carol.body.data.myAiUsage, { requests: 1, totalTokens: 11 })
  assert.deepEqual(dave.body.data.myAiUsage, { requests: 1, totalTokens: 23 })
})

test('tester: double success accumulates — requests 2, totalTokens summed', async (t) => {
  setGatewayEnv(t)
  const gateway = createAiGateway({
    fetch: scriptedFetch([
      { status: 200, body: completion(17) },
      { status: 200, body: completion(25) },
    ]),
  })
  await gateway.chat({ uid: 'uid-carol-dan48', promptId: 'p1', role: 'r', messages: [] })
  await gateway.chat({ uid: 'uid-carol-dan48', promptId: 'p2', role: 'r', messages: [] })

  const app = createApp({ verifyToken: stubVerify, aiGateway: gateway })
  const res = await myAiUsage(app, 'tok-carol')
  assert.deepEqual(res.body.data.myAiUsage, { requests: 2, totalTokens: 42 })
})

test('tester: a 429 then a success — the 429 recorded nothing', async (t) => {
  setGatewayEnv(t)
  const gateway = createAiGateway({
    fetch: scriptedFetch([
      { status: 429, body: { error: { message: 'rate limited' } } },
      { status: 200, body: completion(19) },
    ]),
  })

  await assert.rejects(
    gateway.chat({ uid: 'uid-carol-dan48', promptId: 'p1', role: 'r', messages: [] }),
    QuotaExhaustedError,
  )
  await gateway.chat({ uid: 'uid-carol-dan48', promptId: 'p2', role: 'r', messages: [] })

  const app = createApp({ verifyToken: stubVerify, aiGateway: gateway })
  const res = await myAiUsage(app, 'tok-carol')
  // Only the successful call may appear: 1 request, 19 tokens — never 2 / never
  // any tokens from the rejected call.
  assert.deepEqual(res.body.data.myAiUsage, { requests: 1, totalTokens: 19 })
})

test('tester: myAiUsage is zeros for a fresh user, not null and not an error', async () => {
  const app = createApp({ verifyToken: stubVerify })
  const res = await myAiUsage(app, 'tok-dave')
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.myAiUsage, { requests: 0, totalTokens: 0 })
})

// --- criterion 6: wire-leak probes ---
//
// No production operation calls the gateway yet (that lands with DAN-47), so the
// probe mounts the exported resolver wrapper — the exact mapping chain a real
// resolver uses — inside a real graphql-http handler, and drives it over HTTP.

function probeApp(gateway) {
  const schema = buildSchema('type Query { probe: String! }')
  const rootValue = {
    probe: resolver(async (_args, context) => {
      const out = await context.aiGateway.chat({
        uid: 'uid-carol-dan48',
        promptId: 'p',
        role: 'r',
        messages: [{ role: 'user', content: 'hi' }],
      })
      return out.choices[0].message.content
    }),
  }
  const app = express()
  app.use(express.json())
  app.use('/graphql', createHandler({ schema, rootValue, context: () => ({ aiGateway: gateway }) }))
  return app
}

test('tester: gateway 5xx → HTTP 200, INTERNAL, and NO gateway URL/key/status/detail on the wire', async (t) => {
  setGatewayEnv(t)
  const logged = t.mock.method(console, 'error', () => {})
  const gateway = createAiGateway({
    fetch: scriptedFetch([{ status: 503, body: { error: { message: UPSTREAM_DETAIL } } }]),
    recordUsage: async () => {},
  })
  const res = await request(probeApp(gateway)).post('/graphql').send({ query: '{ probe }' })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')

  const wire = JSON.stringify(res.body)
  assert.ok(!wire.includes(T_URL), 'gateway URL must not leak')
  assert.ok(!wire.includes('tester-gw'), 'gateway host fragment must not leak')
  assert.ok(!wire.includes(T_KEY), 'gateway key must not leak')
  assert.ok(!wire.includes('503'), 'gateway status must not leak')
  assert.ok(!wire.includes(UPSTREAM_DETAIL), 'upstream detail string must not leak')
  assert.ok(!/gateway/i.test(wire), 'the word "gateway" must not leak')
  assert.ok(logged.mock.callCount() >= 1, 'the real error is logged server-side')
})

test('tester: missing env at call time → structured INTERNAL, no crash, no env-var names on the wire', async (t) => {
  setGatewayEnv(t, undefined, undefined)
  t.mock.method(console, 'error', () => {})
  // Default transport on purpose: with no configuration, chat() must throw
  // before any fetch happens, so no network is touched.
  const gateway = createAiGateway({ recordUsage: async () => {} })
  const res = await request(probeApp(gateway)).post('/graphql').send({ query: '{ probe }' })

  assert.equal(res.status, 200, 'a misconfigured gateway is a domain error, not a 5xx or a crash')
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')
  const wire = JSON.stringify(res.body)
  assert.ok(!wire.includes('AI_GATEWAY_URL') && !wire.includes('AI_GATEWAY_KEY'), 'env var names must not leak')
  assert.ok(!/configured/i.test(wire), 'the configuration message must not leak')
})

test('tester: gateway 429 over the wire → HTTP 200, QUOTA_EXHAUSTED, human-readable', async (t) => {
  setGatewayEnv(t)
  const gateway = createAiGateway({
    fetch: scriptedFetch([{ status: 429, body: { error: { message: 'rate limited' } } }]),
    recordUsage: async () => {},
  })
  const res = await request(probeApp(gateway)).post('/graphql').send({ query: '{ probe }' })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'QUOTA_EXHAUSTED')
  assert.match(res.body.errors[0].message, /quota/i)
})
