// DAN-60 tester verification — production wiring: IAM id-token + x-gateway-key.
//
// Independent of the developer's aiGateway.test.js: own env harness, own
// captured transport, own fixtures. Mongo-free and network-free — the transport
// is injected for BOTH the gateway call and the metadata-server fetch, so no
// test performs a real network call.
//
// Run with: node --test src/dan60.tester.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { buildSchema } from 'graphql'
import { createHandler } from 'graphql-http/lib/use/express'
import request from 'supertest'

import { createAiGateway, GatewayError } from './aiGateway.js'
import { resolver } from './graphql.js'

// A gateway URL WITH a path component, so the audience assertion proves the
// implementation extracts the ORIGIN rather than echoing the URL back.
const T_URL = 'https://ai-gw-dan60.tester:7443/relay'
const T_ORIGIN = 'https://ai-gw-dan60.tester:7443'
const T_KEY = 'virtual-key-dan60-tester'
// Deliberately JWT-shaped with dots and padding — asserted VERBATIM.
const T_TOKEN = 'eyJ0ZXN0ZXIi.dan60-payload.c2ln=='
const METADATA_HOST = 'http://metadata.google.internal/'
const IDENTITY_PATH =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'

// Own env harness: pins all four variables per test, restores after.
function env(t, { url = T_URL, key = T_KEY, kService, iam } = {}) {
  const wanted = { AI_GATEWAY_URL: url, AI_GATEWAY_KEY: key, K_SERVICE: kService, AI_GATEWAY_IAM: iam }
  const saved = {}
  for (const name of Object.keys(wanted)) saved[name] = process.env[name]
  for (const [name, value] of Object.entries(wanted)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

const completion = {
  id: 'cmpl-dan60',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
}

// Captured transport routing metadata-server URLs and gateway URLs separately.
// `metadata` may be a function so successive token fetches can differ.
function transport({ gateway = { status: 200, body: completion }, metadata = { status: 200, token: T_TOKEN } } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (url.startsWith(METADATA_HOST)) {
      const m = typeof metadata === 'function' ? metadata(fn.metadata().length) : metadata
      if (m.networkError) throw new Error(m.networkError)
      return { ok: m.status >= 200 && m.status < 300, status: m.status, text: async () => m.token }
    }
    return { ok: gateway.status >= 200 && gateway.status < 300, status: gateway.status, json: async () => gateway.body }
  }
  fn.calls = calls
  fn.metadata = () => calls.filter((c) => c.url.startsWith(METADATA_HOST))
  fn.gateway = () => calls.filter((c) => !c.url.startsWith(METADATA_HOST))
  return fn
}

const CHAT = {
  uid: 'uid-dan60',
  promptId: 'prompt-dan60',
  role: 'builder',
  model: 'a-model',
  messages: [{ role: 'user', content: 'hello' }],
}

function headerNames(init) {
  return Object.keys(init.headers).map((h) => h.toLowerCase())
}

// --- criterion 1: Cloud Run path — metadata fetch + both headers ---

test('tester: on Cloud Run the metadata request targets the identity endpoint with audience = AI_GATEWAY_URL ORIGIN and Metadata-Flavor: Google', async (t) => {
  env(t, { kService: 'linear-example-backend' })
  const fetch = transport()
  await createAiGateway({ fetch, recordUsage: async () => {} }).chat(CHAT)

  const meta = fetch.metadata()
  assert.equal(meta.length, 1, 'exactly one metadata fetch')
  const u = new URL(meta[0].url)
  assert.equal(`${u.origin}${u.pathname}`, IDENTITY_PATH, 'the identity endpoint')
  assert.equal(u.searchParams.get('audience'), T_ORIGIN, 'audience is the ORIGIN, not the full URL with path')
  assert.equal(meta[0].init.headers['Metadata-Flavor'], 'Google')
})

test('tester: the fetched token lands VERBATIM in Authorization while x-gateway-key carries the virtual key', async (t) => {
  env(t, { kService: 'linear-example-backend' })
  const fetch = transport()
  await createAiGateway({ fetch, recordUsage: async () => {} }).chat(CHAT)

  const [{ url, init }] = fetch.gateway()
  assert.equal(url, `${T_URL}/v1/chat/completions`)
  assert.equal(init.headers.Authorization, `Bearer ${T_TOKEN}`, 'token verbatim, Bearer-prefixed')
  assert.equal(init.headers['x-gateway-key'], T_KEY, 'virtual key rides in x-gateway-key')
  assert.ok(!init.headers.Authorization.includes(T_KEY), 'the virtual key is NOT in Authorization')
})

test('tester: without K_SERVICE — zero metadata calls and NO Authorization header of any casing', async (t) => {
  env(t, {}) // kService undefined: the local path
  const fetch = transport()
  await createAiGateway({ fetch, recordUsage: async () => {} }).chat(CHAT)

  assert.equal(fetch.metadata().length, 0, 'no metadata call off Cloud Run')
  assert.equal(fetch.calls.length, 1, 'the gateway call is the only request')
  const [{ init }] = fetch.gateway()
  assert.ok(!headerNames(init).includes('authorization'), 'no Authorization is invented')
  assert.equal(init.headers['x-gateway-key'], T_KEY, 'x-gateway-key is still sent')
})

test('tester: AI_GATEWAY_IAM=off with K_SERVICE set — no metadata call, no Authorization', async (t) => {
  env(t, { kService: 'linear-example-backend', iam: 'off' })
  const fetch = transport()
  await createAiGateway({ fetch, recordUsage: async () => {} }).chat(CHAT)

  assert.equal(fetch.metadata().length, 0, 'escape hatch skips the metadata fetch')
  const [{ init }] = fetch.gateway()
  assert.ok(!headerNames(init).includes('authorization'))
  assert.equal(init.headers['x-gateway-key'], T_KEY)
})

// --- token caching ---

test('tester: two chat() calls on one instance make exactly one metadata fetch', async (t) => {
  env(t, { kService: 'linear-example-backend' })
  const fetch = transport()
  const gw = createAiGateway({ fetch, recordUsage: async () => {} })
  await gw.chat(CHAT)
  await gw.chat(CHAT)

  assert.equal(fetch.metadata().length, 1, 'the cached token serves the second call')
  assert.equal(fetch.gateway().length, 2)
  for (const { init } of fetch.gateway()) assert.equal(init.headers.Authorization, `Bearer ${T_TOKEN}`)
})

test('tester: the cache expires — after the ~50-minute TTL a NEW token is fetched and sent', async (t) => {
  env(t, { kService: 'linear-example-backend' })
  t.mock.timers.enable({ apis: ['Date'] })
  // Successive metadata fetches return distinguishable tokens.
  const fetch = transport({ metadata: (n) => ({ status: 200, token: `tok-${n}` }) })
  const gw = createAiGateway({ fetch, recordUsage: async () => {} })

  await gw.chat(CHAT)
  t.mock.timers.tick(49 * 60 * 1000)
  await gw.chat(CHAT)
  assert.equal(fetch.metadata().length, 1, 'still cached at 49 minutes')

  t.mock.timers.tick(2 * 60 * 1000) // 51 minutes since the fetch
  await gw.chat(CHAT)
  assert.equal(fetch.metadata().length, 2, 'expired token is re-fetched')
  const auths = fetch.gateway().map((c) => c.init.headers.Authorization)
  assert.deepEqual(auths, ['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2'], 'the FRESH token replaces the expired one')
})

// --- criterion 2: metadata failure → INTERNAL, no crash, no leak ---

function probeApp(gateway) {
  const schema = buildSchema('type Query { probe: String! }')
  const rootValue = {
    probe: resolver(async (_args, context) => {
      const c = await context.aiGateway.chat(CHAT)
      return c.choices[0].message.content
    }),
  }
  const app = express()
  app.use(express.json())
  app.use('/graphql', createHandler({ schema, rootValue, context: () => ({ aiGateway: gateway }) }))
  return app
}

for (const [label, metadata] of [
  ['metadata 500', { status: 500, token: '' }],
  ['metadata network failure', { networkError: 'EHOSTUNREACH metadata.google.internal' }],
]) {
  test(`tester: ${label} on Cloud Run → HTTP 200 + INTERNAL; no token, no metadata URL, no virtual key on the wire`, async (t) => {
    env(t, { kService: 'linear-example-backend' })
    const errors = t.mock.method(console, 'error', () => {})
    const gateway = createAiGateway({ fetch: transport({ metadata }), recordUsage: async () => {} })
    const res = await request(probeApp(gateway)).post('/graphql').send({ query: '{ probe }' })

    assert.equal(res.status, 200, 'a metadata failure is a mapped domain error, never a crash/5xx')
    assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
    assert.equal(res.body.errors[0].message, 'Internal Server Error')
    const wire = JSON.stringify(res.body)
    assert.ok(!wire.includes(T_TOKEN), 'no token on the wire')
    assert.ok(!wire.includes(T_KEY), 'no virtual key on the wire')
    assert.ok(!/metadata/i.test(wire), 'no metadata internals on the wire')
    assert.ok(!wire.includes('metadata.google.internal'), 'no metadata URL on the wire')
    assert.ok(errors.mock.callCount() >= 1, 'the real error IS logged server-side')
  })
}

test('tester: metadata failure throws GatewayError before any gateway request — the virtual key and token never appear in the error', async (t) => {
  env(t, { kService: 'linear-example-backend' })
  const fetch = transport({ metadata: { status: 403, token: 'should-not-be-read' } })
  const gw = createAiGateway({ fetch, recordUsage: async () => {} })
  await assert.rejects(gw.chat(CHAT), (err) => {
    assert.ok(err instanceof GatewayError)
    assert.ok(!err.message.includes(T_KEY), 'no virtual key in the error message')
    assert.ok(!err.message.includes('should-not-be-read'), 'no token in the error message')
    return true
  })
  assert.equal(fetch.gateway().length, 0, 'the gateway is never called without a token')
})
