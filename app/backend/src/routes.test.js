// HTTP-level tests for /api/records via supertest. Run with: npm test
//
// Validation (400) responses are proven without any Mongo connection —
// createRecord validates before touching the driver. The 200/201 success paths
// need a real round-trip, so they run against the scratch test database.
//
// DAN-22: /api/records is now behind the auth gate. Every request here must carry a
// valid bearer token to reach the router. The verifier is a stub injected through
// createApp (no firebase-admin, no emulator, no network) — the design's test seam —
// and `authed()` attaches the bearer token to each supertest request. That the GET
// below returns 200 { records: [] } is itself the "valid token reaches the route"
// acceptance criterion. The dedicated 401 paths live in auth.test.js.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
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

// Stub verifier: resolves for the known fake token, rejects everything else. No
// firebase-admin, no network — the injectable seam the design mandates.
const VALID_TOKEN = 'stub-valid-token'
const stubVerify = async (token) => {
  if (token === VALID_TOKEN) return { uid: 'test-uid' }
  throw new Error('invalid token')
}
const authed = (req) => req.set('Authorization', `Bearer ${VALID_TOKEN}`)

const app = createApp({ verifyToken: stubVerify })

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await getDb().collection('records').deleteMany({})
})

after(async () => {
  await getDb().collection('records').deleteMany({})
  await getDb().client.close()
})

test('GET /api/records returns 200 and {records: []} for an empty collection', async () => {
  const res = await authed(request(app).get('/api/records'))
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { records: [] })
  assert.ok(!Array.isArray(res.body), 'body is an object, never a bare array')
})

test('POST /api/records with a valid body returns 201 with {record} (string id, timestamps)', async () => {
  const res = await authed(request(app).post('/api/records')).send({
    name: 'Widget',
    status: 'active',
    amount: 9.99,
    notes: 'ok',
  })

  assert.equal(res.status, 201)
  const { record } = res.body
  assert.equal(typeof record.id, 'string')
  assert.equal(record._id, undefined)
  assert.equal(record.name, 'Widget')
  assert.equal(record.status, 'active')
  assert.equal(record.amount, 9.99)
  assert.ok(record.createdAt, 'createdAt is set')
  assert.ok(record.updatedAt, 'updatedAt is set')

  // GET now returns the created record.
  const list = await authed(request(app).get('/api/records'))
  assert.equal(list.body.records.length, 1)
  assert.equal(list.body.records[0].id, record.id)
})

test('POST ignores a client-supplied id/_id', async () => {
  const res = await authed(request(app).post('/api/records')).send({
    _id: 'evil',
    id: 'evil',
    name: 'NoInject',
    status: 'pending',
    amount: 1,
  })
  assert.equal(res.status, 201)
  assert.notEqual(res.body.record.id, 'evil')
})

// --- PATCH /api/records/:id ---

// A well-formed ObjectId (24 hex chars) that nothing was inserted under.
const MISSING_ID = '0123456789abcdef01234567'

async function seed() {
  const res = await authed(request(app).post('/api/records')).send({
    name: 'Seed',
    status: 'active',
    amount: 1,
    notes: 'orig',
  })
  return res.body.record
}

test('PATCH with a partial valid body returns 200, reflects the change, bumps updatedAt', async () => {
  const record = await seed()
  await new Promise((r) => setTimeout(r, 5))

  const res = await authed(request(app).patch(`/api/records/${record.id}`)).send({ name: 'Edited' })

  assert.equal(res.status, 200)
  const updated = res.body.record
  assert.equal(updated.id, record.id)
  assert.equal(updated.name, 'Edited')
  assert.equal(updated.status, 'active', 'unspecified field unchanged')
  assert.equal(updated.createdAt, record.createdAt, 'createdAt unchanged')
  assert.ok(
    new Date(updated.updatedAt).getTime() > new Date(record.updatedAt).getTime(),
    'updatedAt bumped',
  )
})

test('PATCH with an invalid field returns 400 with { error: { message, field } }', async () => {
  const record = await seed()
  const res = await authed(request(app).patch(`/api/records/${record.id}`)).send({ amount: -1 })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.field, 'amount')
  assert.equal(typeof res.body.error.message, 'string')
})

test('PATCH to a well-formed but non-existent id returns 404', async () => {
  const res = await authed(request(app).patch(`/api/records/${MISSING_ID}`)).send({ name: 'x' })
  assert.equal(res.status, 404)
  assert.equal(typeof res.body.error.message, 'string')
})

test('PATCH to a malformed id returns 404, not 400', async () => {
  const res = await authed(request(app).patch('/api/records/not-an-object-id')).send({ name: 'x' })
  assert.equal(res.status, 404)
})

// --- DELETE /api/records/:id ---

test('DELETE of an existing record returns 204 with no body', async () => {
  const record = await seed()
  const res = await authed(request(app).delete(`/api/records/${record.id}`))
  assert.equal(res.status, 204)
  assert.deepEqual(res.body, {}, 'no body')

  // It is actually gone.
  const list = await authed(request(app).get('/api/records'))
  assert.equal(list.body.records.length, 0)
})

test('DELETE of a well-formed but non-existent id returns 404', async () => {
  const res = await authed(request(app).delete(`/api/records/${MISSING_ID}`))
  assert.equal(res.status, 404)
})

test('DELETE of a malformed id returns 404, not 400', async () => {
  const res = await authed(request(app).delete('/api/records/not-an-object-id'))
  assert.equal(res.status, 404)
})

// --- Validation: 400 with { error: { message, field } }, no DB needed ---

const cases = [
  ['missing name', { status: 'active', amount: 1 }, 'name'],
  ['empty name', { name: '', status: 'active', amount: 1 }, 'name'],
  ['negative amount', { name: 'x', status: 'active', amount: -1 }, 'amount'],
  ['non-finite amount', { name: 'x', status: 'active', amount: 'nan' }, 'amount'],
  ['bad status', { name: 'x', status: 'nope', amount: 1 }, 'status'],
  ['notes too long', { name: 'x', status: 'active', amount: 1, notes: 'y'.repeat(1001) }, 'notes'],
]

for (const [label, body, field] of cases) {
  test(`POST with ${label} returns 400 with field "${field}"`, async () => {
    const res = await authed(request(app).post('/api/records')).send(body)
    assert.equal(res.status, 400)
    assert.equal(res.body.error.field, field)
    assert.equal(typeof res.body.error.message, 'string')
  })
}
