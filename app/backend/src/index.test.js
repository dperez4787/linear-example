// Verifies DAN-5 index.js criteria at the app level (no Mongo, no port bind).
// Run with: node --test src/index.test.js
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

// DAN-6 mounted /api/records. A validation failure exercises the single error
// middleware end to end without needing a Mongo connection: createRecord()
// validates before touching the driver, so an invalid POST throws a
// ValidationError that the middleware maps to a shaped 400.
test('the error middleware maps a validation error to a shaped 400 (no Mongo needed)', async () => {
  const app = createApp()
  const res = await request(app).post('/api/records').send({ amount: 1, status: 'active' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.field, 'name')
  assert.equal(typeof res.body.error.message, 'string')
})

test('unknown routes still 404', async () => {
  const app = createApp()
  const res = await request(app).get('/api/nope')
  assert.equal(res.status, 404)
})
