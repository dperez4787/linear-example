// Verifies DAN-5 index.js criteria at the app level (no Mongo, no port bind).
// Run with: node --test src/index.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from './index.js'

test('GET /healthz returns 200 and does not touch Mongo (createApp never connects)', async () => {
  // No MONGODB_URI is set here and createApp() does not call connect(),
  // so a 200 proves the health check is independent of any Mongo access.
  const app = createApp()
  const res = await request(app).get('/healthz')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})

test('no /api/records routes exist yet (404)', async () => {
  const app = createApp()
  const res = await request(app).get('/api/records')
  assert.equal(res.status, 404)
})
