// HTTP-level tests for /api/records via supertest. Run with: npm test
//
// Validation (400) responses are proven without any Mongo connection —
// createRecord validates before touching the driver. The 200/201 success paths
// need a real round-trip, so they run against the scratch test database.
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

const app = createApp()

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
  const res = await request(app).get('/api/records')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { records: [] })
  assert.ok(!Array.isArray(res.body), 'body is an object, never a bare array')
})

test('POST /api/records with a valid body returns 201 with {record} (string id, timestamps)', async () => {
  const res = await request(app)
    .post('/api/records')
    .send({ name: 'Widget', status: 'active', amount: 9.99, notes: 'ok' })

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
  const list = await request(app).get('/api/records')
  assert.equal(list.body.records.length, 1)
  assert.equal(list.body.records[0].id, record.id)
})

test('POST ignores a client-supplied id/_id', async () => {
  const res = await request(app)
    .post('/api/records')
    .send({ _id: 'evil', id: 'evil', name: 'NoInject', status: 'pending', amount: 1 })
  assert.equal(res.status, 201)
  assert.notEqual(res.body.record.id, 'evil')
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
    const res = await request(app).post('/api/records').send(body)
    assert.equal(res.status, 400)
    assert.equal(res.body.error.field, field)
    assert.equal(typeof res.body.error.message, 'string')
  })
}
