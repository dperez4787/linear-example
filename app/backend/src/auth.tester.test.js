// DAN-22 tester verification. Independent of the developer's auth.test.js.
//
// The developer's suite always INJECTS a stub verifier through createApp. That is
// correct for exercising the happy path without a network, but it means no test in
// the suite runs the app with its REAL default verifier (the firebase-admin wrapper).
// This file closes that gap for the paths that are safe to run offline:
//
//   1. Built with the production default (createApp() — no injected verifier), an
//      anonymous request to every /api/records method returns 401 with the
//      { error: { message } } shape and never reaches the data layer. This exercises
//      the exact object main() constructs, not a stubbed one.
//   2. firebase-admin must NOT initialize at boot or on the anonymous-401 path — an
//      eager initializeApp() would reach for ADC/credentials on a cold container and
//      break DAN-17's no-.env boot path. Proven directly: getApps() stays empty after
//      building the real app, serving /health, and 401-ing anonymous requests, because
//      the missing/non-Bearer header short-circuits BEFORE the verifier is ever called.
//
// Only the header short-circuit paths (no header / non-Bearer / empty Bearer) are
// exercised against the real verifier — those never call firebaseVerifyToken, so this
// file stays network-free and deterministic. The real verifyIdToken path (signature,
// expiry, aud/iss) is user-attested per the design; no offline test can prove it.
//
// Run with: node --test src/auth.tester.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { getApps } from 'firebase-admin/app'
import { createApp } from './index.js'

const methods = [
  ['get', '/api/records'],
  ['post', '/api/records'],
  ['get', '/api/records/0123456789abcdef01234567'],
  ['patch', '/api/records/0123456789abcdef01234567'],
  ['delete', '/api/records/0123456789abcdef01234567'],
]

test('firebase-admin is NOT initialized at import/boot (lazy) — getApps() is empty before any request', () => {
  createApp() // production default verifier, exactly what main() builds
  assert.equal(getApps().length, 0, 'creating the app must not initialize firebase-admin')
})

test('REAL default gate: anonymous request to every /api/records method → 401, shaped, data layer unreached', async () => {
  const app = createApp() // no injected verifier — the firebase-admin wrapper is the default
  for (const [method, path] of methods) {
    const res = await request(app)[method](path)
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} anonymous must be 401, never 500`)
    assert.equal(typeof res.body.error.message, 'string', 'shape is { error: { message } }')
    assert.equal(res.body.error.field, undefined)
  }
})

test('REAL default gate: non-Bearer and empty-Bearer headers → 401 without initializing firebase-admin', async () => {
  const app = createApp()
  for (const header of ['Basic dXNlcjpwYXNz', 'token abc', 'Bearer ']) {
    const res = await request(app).get('/api/records').set('Authorization', header)
    assert.equal(res.status, 401, `"${header}" must 401 at the gate`)
    assert.equal(typeof res.body.error.message, 'string')
  }
})

test('GET /health is 200 on the real default app and still no firebase-admin init', async () => {
  const app = createApp()
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
  // After building the real app, serving /health, and 401-ing anonymous requests,
  // the header short-circuit means the verifier was never called — so firebase-admin
  // was never initialized. This is the boot-time credential-free guarantee (DAN-17).
  assert.equal(getApps().length, 0, 'firebase-admin must not initialize on the boot/health/anonymous paths')
})
