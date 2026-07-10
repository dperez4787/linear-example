// App-level tests (no Mongo, no port bind). Run with: node --test src/index.test.js
//
// DAN-25 moved the records surface from five REST routes to POST /api/graphql.
// These assert the health check, that GraphQL validation is reported inside the
// response without a Mongo connection, and that the five old REST routes are gone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from './index.js'

test('GET /health returns 200 and does not touch Mongo (createApp never connects)', async () => {
  // No MONGODB_URI is set here and createApp() does not call connect(),
  // so a 200 proves the health check is independent of any Mongo access.
  const app = createApp()
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})

// DAN-18: /healthz was renamed to /health because the platform in front of Cloud
// Run swallows the exact path /healthz before it reaches the container. Assert the
// old path is genuinely gone (Express 404), not merely aliased.
test('GET /healthz is no longer registered (404 from Express)', async () => {
  const app = createApp()
  const res = await request(app).get('/healthz')
  assert.equal(res.status, 404)
})

// A stub verifier (resolves for the known token, rejects otherwise) is injected
// through createApp so the request gets past the gate without firebase-admin.
const VALID_TOKEN = 'stub-valid-token'
const stubVerify = async (token) => {
  if (token === VALID_TOKEN) return { uid: 'test-uid' }
  throw new Error('invalid token')
}

// DAN-25: a validation failure is now reported inside the GraphQL response (200 +
// errors[].extensions), not as a shaped HTTP 400. createRecord validates before
// touching the driver, so an invalid input surfaces a BAD_USER_INPUT error with no
// Mongo connection at all — the execution-layer error mapper end to end.
test('GraphQL reports a validation error as BAD_USER_INPUT without a Mongo connection', async () => {
  const app = createApp({ verifyToken: stubVerify })
  const res = await request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${VALID_TOKEN}`)
    .send({
      query: 'mutation ($input: CreateRecordInput!) { createRecord(input: $input) { id } }',
      variables: { input: { name: '', status: 'active', amount: 1 } },
    })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(res.body.errors[0].extensions.field, 'name')
})

test('unknown routes still 404', async () => {
  const app = createApp()
  const res = await request(app).get('/api/nope')
  assert.equal(res.status, 404)
})

// DAN-25: the five REST routes are removed, not aliased. The GraphQL endpoint lives
// at /api/graphql; nothing answers under /api/records any more. Each must be a plain
// 404 (no gate, no handler). The auth gate is mounted only on /api/graphql now, so a
// /api/records request no longer even reaches an authenticated 401 — it just 404s.
const goneRestRoutes = [
  ['get', '/api/records'],
  ['post', '/api/records'],
  ['get', '/api/records/0123456789abcdef01234567'],
  ['patch', '/api/records/0123456789abcdef01234567'],
  ['delete', '/api/records/0123456789abcdef01234567'],
]

for (const [method, path] of goneRestRoutes) {
  test(`${method.toUpperCase()} ${path} is gone (404) — the REST surface was removed`, async () => {
    const app = createApp({ verifyToken: stubVerify })
    const res = await request(app)[method](path)
    assert.equal(res.status, 404, 'the old REST route must return 404, not be aliased or gated')
  })
}
