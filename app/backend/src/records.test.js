// Integration tests for the data layer, run against the scratch test database
// (linear_example_test), never the app database. Run with: npm test
//
// These exercise real Mongo round-trips because that is the point of records.js
// — that _id becomes a string id, that timestamps are set on insert, and that a
// validated payload is what actually lands in the collection.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

// Load MONGODB_URI from app/backend/.env if not already in the environment,
// without echoing its contents anywhere.
if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // No .env — MONGODB_URI must then come from the ambient environment.
  }
}
// Never point data operations at the app database.
process.env.MONGODB_DB = 'linear_example_test'

const { connect, getDb } = await import('./db.js')
const { listRecords, createRecord } = await import('./records.js')

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

test('listRecords returns [] for an empty collection', async () => {
  assert.deepEqual(await listRecords(), [])
})

test('createRecord inserts, returns a string id (not _id), and sets timestamps', async () => {
  const record = await createRecord({ name: 'Widget', status: 'active', amount: 42, notes: 'hi' })

  assert.equal(typeof record.id, 'string')
  assert.equal(record._id, undefined)
  assert.equal(record.name, 'Widget')
  assert.equal(record.status, 'active')
  assert.equal(record.amount, 42)
  assert.equal(record.notes, 'hi')
  assert.ok(record.createdAt instanceof Date)
  assert.ok(record.updatedAt instanceof Date)

  // It is actually persisted and comes back through listRecords.
  const all = await listRecords()
  assert.equal(all.length, 1)
  assert.equal(all[0].id, record.id)
})

test('createRecord ignores a client-supplied id/_id — the stored doc gets a Mongo id', async () => {
  const record = await createRecord({
    _id: 'client-chosen',
    id: 'client-chosen',
    name: 'NoInject',
    status: 'pending',
    amount: 1,
  })
  assert.notEqual(record.id, 'client-chosen')

  const [stored] = await getDb().collection('records').find().toArray()
  assert.notEqual(stored._id, 'client-chosen')
  assert.equal(stored.id, undefined, 'no stray id field persisted')
})

test('createRecord throws (does not insert) on an invalid payload', async () => {
  await assert.rejects(() => createRecord({ status: 'active', amount: 1 }), /name/)
  assert.equal((await listRecords()).length, 0, 'nothing was inserted')
})
