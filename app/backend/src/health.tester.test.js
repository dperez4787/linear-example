// DAN-18 tester verification (added by the tester, not the developer).
//
// The ticket's load-bearing claim is that /healthz must return *Express's own*
// 404 — proving the route was genuinely removed, not aliased to /health. Inside
// createApp() every 404 is Express's, so the distinction we can assert here is the
// x-powered-by: Express marker plus the exact "Cannot GET /healthz" body: if a
// future change re-adds /healthz as an alias, the 404 assertion below fails.
//
// The equivalent check against the live Cloud Run URL — where the marker's ABSENCE
// is what proved the platform was swallowing /healthz — is user-attested and can
// only be observed after a merge redeploys the service.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from './index.js'

test('DAN-18: GET /health answers 200 {status:ok} with x-powered-by: Express, no Mongo', async () => {
  // No MONGODB_URI and createApp() never calls connect(): a 200 proves the health
  // check is independent of any Mongo access.
  const app = createApp()
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
  assert.equal(res.headers['x-powered-by'], 'Express')
})

test('DAN-18: GET /healthz is removed, not aliased — Express 404 "Cannot GET /healthz"', async () => {
  const app = createApp()
  const res = await request(app).get('/healthz')
  assert.equal(res.status, 404)
  // x-powered-by: Express marks this as Express's own default 404 handler firing
  // because no route matched — an alias would have returned 200 instead.
  assert.equal(res.headers['x-powered-by'], 'Express')
  assert.match(res.text, /Cannot GET \/healthz/)
})
