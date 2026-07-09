// DAN-22: the /api/records auth gate. These tests are Mongo-free by design.
//
// createApp mounts the gate BEFORE the records router, so a request that fails the
// gate never reaches the data layer. This file never calls connect(); therefore any
// request that DID slip past the gate would hit getDb() and surface as a 500. A 401
// (never a 500) is thus positive proof the gate short-circuited before the data
// layer. A spy verifier additionally proves whether the verifier was invoked at all.
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

// Every /api/records method the contract lists. GET /:id has no route handler, but
// the gate is mounted on the whole /api/records prefix, so it must 401 anyway —
// which is exactly what proves the gate covers the entire subtree, not just '/'.
const methods = [
  ['GET', '/api/records'],
  ['POST', '/api/records'],
  ['GET', '/api/records/0123456789abcdef01234567'],
  ['PATCH', '/api/records/0123456789abcdef01234567'],
  ['DELETE', '/api/records/0123456789abcdef01234567'],
]

for (const [method, path] of methods) {
  test(`${method} ${path} with NO Authorization header → 401, verifier untouched, data layer unreached`, async () => {
    const verify = spyVerifier(acceptValid)
    const app = createApp({ verifyToken: verify })
    const res = await request(app)[method.toLowerCase()](path)

    assert.equal(res.status, 401, 'missing header must be 401, never 500')
    assert.equal(typeof res.body.error.message, 'string', 'shape is { error: { message } }')
    assert.equal(res.body.error.field, undefined)
    assert.equal(verify.calls.length, 0, 'verifier must NOT be called without a Bearer token')
  })
}

test('non-Bearer Authorization header → 401 without calling the verifier', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })

  for (const header of ['Basic dXNlcjpwYXNz', 'token abc123', VALID_TOKEN]) {
    const res = await request(app).get('/api/records').set('Authorization', header)
    assert.equal(res.status, 401, `"${header}" is not a Bearer header → 401`)
    assert.equal(typeof res.body.error.message, 'string')
  }
  assert.equal(verify.calls.length, 0, 'a non-Bearer scheme never reaches the verifier')
})

test('empty Bearer token ("Bearer ") → 401 without calling the verifier', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })
  const res = await request(app).get('/api/records').set('Authorization', 'Bearer ')
  assert.equal(res.status, 401)
  assert.equal(verify.calls.length, 0)
})

test('malformed/invalid bearer token (verifier rejects) → 401 not 500, and data layer unreached', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })
  const res = await request(app)
    .get('/api/records')
    .set('Authorization', 'Bearer not-a-real-token')

  assert.equal(res.status, 401, 'a bad token must be 401, never fall through to 500')
  assert.equal(typeof res.body.error.message, 'string')
  assert.equal(verify.calls.length, 1, 'verifier was consulted for a Bearer token')
})

test('valid bearer token passes the gate and REACHES the route', async () => {
  const verify = spyVerifier(acceptValid)
  const app = createApp({ verifyToken: verify })
  // No Mongo is connected in this file, so reaching the data layer surfaces as a 500
  // from getDb(). A 500 (rather than a 401) is precisely what proves the gate let the
  // request through to the router. The 200 { records: [] } happy path — the same
  // criterion with Mongo connected — is asserted in routes.test.js.
  const res = await request(app).get('/api/records').set('Authorization', `Bearer ${VALID_TOKEN}`)

  assert.notEqual(res.status, 401, 'a valid token must pass the gate')
  assert.equal(res.status, 500, 'request reached the data layer, which has no Mongo connection here')
  assert.equal(verify.calls.length, 1)
  assert.deepEqual(verify.calls, [VALID_TOKEN])
})

test('GET /health needs no Authorization header (gate does not cover it) and never touches Mongo', async () => {
  const app = createApp({ verifyToken: spyVerifier(acceptValid) })
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})
