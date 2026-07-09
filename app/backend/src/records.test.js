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
const { listRecords, createRecord, updateRecord, deleteRecord, NotFoundError } = await import(
  './records.js'
)

// A well-formed ObjectId (24 hex chars) that nothing was inserted under.
const MISSING_ID = '0123456789abcdef01234567'

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

// --- updateRecord ---

test('updateRecord applies a partial change, bumps updatedAt, leaves createdAt', async () => {
  const created = await createRecord({ name: 'Before', status: 'active', amount: 1 })
  // Ensure a measurable gap so updatedAt is strictly greater.
  await new Promise((r) => setTimeout(r, 5))

  const updated = await updateRecord(created.id, { name: 'After', amount: 99 })

  assert.equal(updated.id, created.id)
  assert.equal(updated.name, 'After')
  assert.equal(updated.amount, 99)
  assert.equal(updated.status, 'active', 'unspecified field is left unchanged')
  assert.equal(
    updated.createdAt.getTime(),
    created.createdAt.getTime(),
    'createdAt is unchanged',
  )
  assert.ok(updated.updatedAt.getTime() > created.updatedAt.getTime(), 'updatedAt is bumped')

  // Persisted, not just returned.
  const [stored] = await listRecords()
  assert.equal(stored.name, 'After')
  assert.equal(stored.amount, 99)
})

test('updateRecord validates the body with create rules (throws 400)', async () => {
  const created = await createRecord({ name: 'X', status: 'active', amount: 1 })
  await assert.rejects(() => updateRecord(created.id, { amount: -5 }), (err) => {
    assert.equal(err.status, 400)
    assert.equal(err.field, 'amount')
    return true
  })
  // The invalid update did not persist.
  const [stored] = await listRecords()
  assert.equal(stored.amount, 1)
})

test('updateRecord throws 404 (NotFoundError) for a well-formed but missing id', async () => {
  await assert.rejects(() => updateRecord(MISSING_ID, { name: 'nope' }), (err) => {
    assert.ok(err instanceof NotFoundError)
    assert.equal(err.status, 404)
    return true
  })
})

test('updateRecord throws 404 for a malformed id (before any DB write)', async () => {
  await assert.rejects(() => updateRecord('not-an-object-id', { name: 'nope' }), (err) => {
    assert.equal(err.status, 404)
    return true
  })
})

// --- deleteRecord ---

test('deleteRecord removes an existing record and returns nothing', async () => {
  const created = await createRecord({ name: 'ToDelete', status: 'pending', amount: 3 })
  const result = await deleteRecord(created.id)
  assert.equal(result, undefined, 'no body to return')
  assert.equal((await listRecords()).length, 0, 'record is gone')
})

test('deleteRecord throws 404 for a well-formed but missing id', async () => {
  await assert.rejects(() => deleteRecord(MISSING_ID), (err) => {
    assert.ok(err instanceof NotFoundError)
    assert.equal(err.status, 404)
    return true
  })
})

test('deleteRecord throws 404 for a malformed id', async () => {
  await assert.rejects(() => deleteRecord('not-an-object-id'), (err) => {
    assert.equal(err.status, 404)
    return true
  })
})
