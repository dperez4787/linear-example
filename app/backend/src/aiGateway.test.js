// AI Gateway client tests (DAN-48). Mongo-free and network-free by design: the
// transport (fetch) and the usage recorder are both injected, so every request
// is captured in-process and NO test performs a real network call.
//
// Run with: node --test src/aiGateway.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { buildSchema } from 'graphql'
import { createHandler } from 'graphql-http/lib/use/express'
import request from 'supertest'

import { createAiGateway, GatewayError, QuotaExhaustedError } from './aiGateway.js'
import { resolver } from './graphql.js'
import { createApp } from './index.js'

const GATEWAY_URL = 'https://gateway.test'
const GATEWAY_KEY = 'stub-gateway-key'

// Each test states its own env explicitly and restores whatever was there, so
// the suite is immune to an ambient AI_GATEWAY_* from the shell.
function withEnv(t, { url, key }) {
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

// --- fixtures (DAN-48 criterion 7) ---

// A successful chat completion, with a usage block.
export const successFixture = {
  id: 'cmpl-fixture-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Here is your feature.' } }],
  usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
}

// The gateway saying "quota exhausted".
export const quotaFixture = {
  status: 429,
  body: { error: { message: 'rate limit exceeded for on_behalf_of user' } },
}

// The gateway falling over.
export const serverErrorFixture = {
  status: 503,
  body: { error: { message: 'upstream provider unavailable' } },
}

// An injected fetch that records every call and replies with a canned response.
function stubFetch({ status = 200, body = successFixture } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  fn.calls = calls
  return fn
}

// An injected usage recorder that records its calls (no Mongo in this file).
function stubRecordUsage() {
  const calls = []
  const fn = async (uid, totalTokens) => {
    calls.push({ uid, totalTokens })
  }
  fn.calls = calls
  return fn
}

const CHAT_ARGS = {
  uid: 'user-123',
  promptId: 'prompt-abc',
  role: 'builder',
  model: 'some-model',
  messages: [{ role: 'user', content: 'Build me a widget' }],
}

// --- criterion 1: the captured request ---

test('chat() POSTs to ${AI_GATEWAY_URL}/v1/chat/completions with the bearer key and attribution metadata', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const fetch = stubFetch()
  const recordUsage = stubRecordUsage()
  const gateway = createAiGateway({ fetch, recordUsage })

  const result = await gateway.chat(CHAT_ARGS)

  assert.equal(fetch.calls.length, 1, 'exactly one request')
  const { url, init } = fetch.calls[0]
  assert.equal(url, `${GATEWAY_URL}/v1/chat/completions`)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, `Bearer ${GATEWAY_KEY}`)
  assert.equal(init.headers['Content-Type'], 'application/json')

  const body = JSON.parse(init.body)
  assert.deepEqual(body.metadata, {
    on_behalf_of: 'user-123',
    feature: 'prompt-a-feature',
    prompt_id: 'prompt-abc',
    role: 'builder',
  })
  // The conversational payload passes through untouched.
  assert.equal(body.model, 'some-model')
  assert.deepEqual(body.messages, CHAT_ARGS.messages)
  // uid/promptId/role are attribution, not request-body fields of their own.
  assert.equal(body.uid, undefined)
  assert.equal(body.promptId, undefined)

  assert.deepEqual(result, successFixture, 'the parsed gateway response is returned')
})

test('no provider API key: the request carries ONLY the gateway bearer key', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const fetch = stubFetch()
  const gateway = createAiGateway({ fetch, recordUsage: stubRecordUsage() })
  await gateway.chat(CHAT_ARGS)
  const { init } = fetch.calls[0]
  assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type'])
  assert.equal(init.headers.Authorization, `Bearer ${GATEWAY_KEY}`)
})

// --- criterion 4 (the gateway side): usage recorded on success only ---

test('a successful call records usage: the caller uid and response.usage.total_tokens', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const recordUsage = stubRecordUsage()
  const gateway = createAiGateway({ fetch: stubFetch(), recordUsage })
  await gateway.chat(CHAT_ARGS)
  assert.deepEqual(recordUsage.calls, [{ uid: 'user-123', totalTokens: 42 }])
})

test('a successful response with no usage block records the request with zero tokens', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const recordUsage = stubRecordUsage()
  const { usage, ...noUsage } = successFixture
  const gateway = createAiGateway({ fetch: stubFetch({ body: noUsage }), recordUsage })
  await gateway.chat(CHAT_ARGS)
  assert.deepEqual(recordUsage.calls, [{ uid: 'user-123', totalTokens: 0 }])
})

// --- criteria 6+7: 429 and 5xx fixtures throw typed errors, record nothing ---

test('gateway 429 throws QuotaExhaustedError with a human-readable message; no usage recorded', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const recordUsage = stubRecordUsage()
  const gateway = createAiGateway({ fetch: stubFetch(quotaFixture), recordUsage })
  await assert.rejects(gateway.chat(CHAT_ARGS), QuotaExhaustedError)
  await assert.rejects(gateway.chat(CHAT_ARGS), (err) => {
    assert.match(err.message, /quota/i, 'the message is human-readable')
    return true
  })
  assert.equal(recordUsage.calls.length, 0, 'a failed call must not count against the ledger')
})

test('gateway 5xx throws GatewayError (never QuotaExhaustedError); no usage recorded', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const recordUsage = stubRecordUsage()
  const gateway = createAiGateway({ fetch: stubFetch(serverErrorFixture), recordUsage })
  await assert.rejects(gateway.chat(CHAT_ARGS), GatewayError)
  assert.equal(recordUsage.calls.length, 0)
})

test('a network-level fetch failure throws GatewayError; no usage recorded', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const recordUsage = stubRecordUsage()
  const gateway = createAiGateway({
    fetch: async () => {
      throw new Error('ECONNREFUSED')
    },
    recordUsage,
  })
  await assert.rejects(gateway.chat(CHAT_ARGS), GatewayError)
  assert.equal(recordUsage.calls.length, 0)
})

// --- criterion 3: env is read lazily, never at import/construction ---

test('missing AI_GATEWAY_URL/KEY: chat() throws GatewayError without ever calling fetch', async (t) => {
  withEnv(t, { url: undefined, key: undefined })
  const fetch = stubFetch()
  // Construction itself must not read env — only chat() does.
  const gateway = createAiGateway({ fetch, recordUsage: stubRecordUsage() })
  await assert.rejects(gateway.chat(CHAT_ARGS), GatewayError)
  assert.equal(fetch.calls.length, 0, 'no request is attempted without configuration')
})

test('booting with no AI_GATEWAY_URL/AI_GATEWAY_KEY still serves GET /health 200', async (t) => {
  withEnv(t, { url: undefined, key: undefined })
  // Default seams throughout — this is exactly the bare-boot path. createApp
  // constructs the default gateway; nothing may read the missing env.
  const app = createApp()
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})

// --- criterion 6, end to end over HTTP ---
//
// No operation on origin/main calls the gateway yet (DAN-47 adds the mutation
// that does), so these mount the REAL chain a production resolver uses — the
// exported resolver wrapper (and its error mapper) inside a real graphql-http
// handler — over a one-field probe schema, and drive it with supertest. The
// gateway instance is a real createAiGateway with a fixture transport.

function probeApp(gateway) {
  const schema = buildSchema('type Query { probe: String! }')
  const rootValue = {
    probe: resolver(async (_args, context) => {
      const completion = await context.aiGateway.chat({
        uid: context.uid,
        promptId: 'prompt-abc',
        role: 'builder',
        messages: [{ role: 'user', content: 'hi' }],
      })
      return completion.choices[0].message.content
    }),
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/graphql',
    createHandler({ schema, rootValue, context: () => ({ uid: 'user-123', aiGateway: gateway }) }),
  )
  return app
}

test('a gateway 429 surfaces as HTTP 200 with errors[].extensions.code QUOTA_EXHAUSTED', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const gateway = createAiGateway({ fetch: stubFetch(quotaFixture), recordUsage: stubRecordUsage() })
  const res = await request(probeApp(gateway)).post('/graphql').send({ query: '{ probe }' })

  assert.equal(res.status, 200, 'quota exhaustion is a domain error, not an HTTP failure')
  assert.equal(res.body.errors[0].extensions.code, 'QUOTA_EXHAUSTED')
  assert.match(res.body.errors[0].message, /quota/i, 'the message is human-readable')
})

test('any other gateway failure maps to INTERNAL without leaking gateway details', async (t) => {
  withEnv(t, { url: GATEWAY_URL, key: GATEWAY_KEY })
  const errors = t.mock.method(console, 'error', () => {})
  const gateway = createAiGateway({
    fetch: stubFetch(serverErrorFixture),
    recordUsage: stubRecordUsage(),
  })
  const res = await request(probeApp(gateway)).post('/graphql').send({ query: '{ probe }' })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')
  const wire = JSON.stringify(res.body)
  assert.ok(!wire.includes('503'), 'the gateway status must not leak')
  assert.ok(!/gateway/i.test(wire), 'gateway details must not leak')
  assert.ok(errors.mock.callCount() >= 1, 'the real error is logged server-side')
})
