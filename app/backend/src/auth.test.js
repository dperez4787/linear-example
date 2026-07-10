// DAN-22 auth gate, now guarding POST /api/graphql (DAN-25). These tests are
// Mongo-free by design.
//
// createApp mounts the gate BEFORE the GraphQL handler, so a request that fails the
// gate never reaches the data layer. This file never calls connect(); therefore any
// request that DID slip past the gate and hit a resolver would call getDb() and, since
// GraphQL execution maps a thrown error to a 200 with an INTERNAL error, surface as a
// 200 carrying extensions.code: 'INTERNAL'. A 401 (never that) is thus positive proof
// the gate short-circuited before execution. A spy verifier additionally proves whether
// the verifier was invoked at all.
//
// The verifier is injected through createApp — the design's test seam — so nothing
// here touches firebase-admin or the network.
//
// Run with: node --test src/auth.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from './index.js'

const VALID_TOKEN = 'stub-valid-token'

// A verifier that records every call so a test can assert the gate did — or did not
// — invoke it. `impl` decides resolve/reject per token.
function spyVerifier(impl) {
  const calls = []
  const fn = async (token) => {
    calls.push(token)
    return impl(token)
  }
  fn.calls = calls
  return fn
}

const acceptValid = (token) => {
  if (token === VALID_TOKEN) return { uid: 'test-uid' }
  throw new Error('invalid token')
}

const RECORDS_QUERY = '{ records { id } }'

test('POST /api/graphql with NO Authorization header → 401, verifier untouched, data layer unreached', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })
  const res = await request(app).post('/api/graphql').send({ query: RECORDS_QUERY })

  assert.equal(res.status, 401, 'missing header must be 401, never reach execution')
  assert.equal(typeof res.body.error.message, 'string', 'shape is { error: { message } }')
  assert.equal(res.body.error.field, undefined)
  assert.equal(verify.calls.length, 0, 'verifier must NOT be called without a Bearer token')
})

test('non-Bearer Authorization header → 401 without calling the verifier', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })

  for (const header of ['Basic dXNlcjpwYXNz', 'token abc123', VALID_TOKEN]) {
    const res = await request(app)
      .post('/api/graphql')
      .set('Authorization', header)
      .send({ query: RECORDS_QUERY })
    assert.equal(res.status, 401, `"${header}" is not a Bearer header → 401`)
    assert.equal(typeof res.body.error.message, 'string')
  }
  assert.equal(verify.calls.length, 0, 'a non-Bearer scheme never reaches the verifier')
})

test('empty Bearer token ("Bearer ") → 401 without calling the verifier', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })
  const res = await request(app)
    .post('/api/graphql')
    .set('Authorization', 'Bearer ')
    .send({ query: RECORDS_QUERY })
  assert.equal(res.status, 401)
  assert.equal(verify.calls.length, 0)
})

test('malformed/invalid bearer token (verifier rejects) → 401 not execution, data layer unreached', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })
  const res = await request(app)
    .post('/api/graphql')
    .set('Authorization', 'Bearer not-a-real-token')
    .send({ query: RECORDS_QUERY })

  assert.equal(res.status, 401, 'a bad token must be 401, never fall through to execution')
  assert.equal(typeof res.body.error.message, 'string')
  assert.equal(verify.calls.length, 1, 'verifier was consulted for a Bearer token')
})

test('valid bearer token passes the gate and REACHES the resolver', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })
  // No Mongo is connected in this file, so reaching a resolver surfaces as an
  // INTERNAL error inside the GraphQL response (getDb() throws, the error mapper
  // maps it, and execution returns HTTP 200 with errors[].extensions.code:
  // 'INTERNAL'). A 200 with that code (rather than a 401) is precisely what proves
  // the gate let the request through to execution. The happy path — the same
  // criterion with Mongo connected — is asserted in graphql.test.js.
  const res = await request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${VALID_TOKEN}`)
    .send({ query: RECORDS_QUERY })

  assert.notEqual(res.status, 401, 'a valid token must pass the gate')
  assert.equal(res.status, 200, 'a well-formed GraphQL request returns 200 even on a resolver error')
  assert.equal(
    res.body.errors[0].extensions.code,
    'INTERNAL',
    'the request reached the resolver, which has no Mongo connection here',
  )
  assert.equal(verify.calls.length, 1)
  assert.deepEqual(verify.calls, [VALID_TOKEN])
})

test('GET /health needs no Authorization header (gate does not cover it) and never touches Mongo', async () => {
  const app = createApp({ verifyToken: spyVerifier(acceptValid) })
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})
