// HTTP-level tests for POST /api/graphql via supertest. Run with: npm test
//
// This replaces routes.test.js: the records surface is now a single GraphQL
// endpoint, so the queries and mutations are exercised here instead of the five
// REST routes. Domain outcomes (validation, not-found) are asserted on
// body.data / body.errors[].extensions — NOT on HTTP status — because inside
// GraphQL execution a well-formed request is always 200 and reports failures in
// the errors array (see docs/architecture.md, Error mapping).
//
// Same auth pattern as before: the app is built with an injected stub verifier
// (no firebase-admin, no network) and every request carries a bearer token to get
// past the gate. The success paths need a real round-trip, so they run against the
// scratch test database (linear_example_test).
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

// Stub verifier: resolves for the known fake token, rejects everything else.
const VALID_TOKEN = 'stub-valid-token'
const stubVerify = async (token) => {
  if (token === VALID_TOKEN) return { uid: 'test-uid' }
  throw new Error('invalid token')
}

const app = createApp({ verifyToken: stubVerify })

// POST a GraphQL operation with the bearer token attached. supertest's .send(obj)
// sets Content-Type: application/json, which is what graphql-http expects.
function gql(query, variables) {
  return request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${VALID_TOKEN}`)
    .send({ query, variables })
}

const RECORD_FIELDS = 'id name status amount notes createdAt updatedAt'

// A well-formed ObjectId (24 hex chars) that nothing was inserted under, plus a
// string that isn't a valid ObjectId at all.
const MISSING_ID = '0123456789abcdef01234567'
const MALFORMED_ID = 'not-an-object-id'

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

async function seed(overrides = {}) {
  const input = { name: 'Seed', status: 'active', amount: 1, notes: 'orig', ...overrides }
  const res = await gql(
    `mutation ($input: CreateRecordInput!) { createRecord(input: $input) { ${RECORD_FIELDS} } }`,
    { input },
  )
  return res.body.data.createRecord
}

// --- records query ---

test('records query returns 200 with every record; id is a string and _id appears nowhere', async () => {
  await seed({ name: 'One' })
  await seed({ name: 'Two' })

  const res = await gql(`{ records { ${RECORD_FIELDS} } }`)
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.records.length, 2)
  for (const record of res.body.data.records) {
    assert.equal(typeof record.id, 'string')
  }
  assert.ok(
    !JSON.stringify(res.body).includes('_id'),
    'the string "_id" must not appear anywhere in the response body',
  )
})

// --- record(id) query ---

test('record(id) with an existing id returns that record', async () => {
  const seeded = await seed({ name: 'Findable' })
  const res = await gql(`query ($id: ID!) { record(id: $id) { ${RECORD_FIELDS} } }`, {
    id: seeded.id,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.record.id, seeded.id)
  assert.equal(res.body.data.record.name, 'Findable')
})

for (const [label, id] of [
  ['nonexistent', MISSING_ID],
  ['malformed', MALFORMED_ID],
]) {
  test(`record(id) with a ${label} id → 200, data.record null, NOT_FOUND error (never 5xx)`, async () => {
    const res = await gql(`query ($id: ID!) { record(id: $id) { ${RECORD_FIELDS} } }`, { id })
    assert.equal(res.status, 200, 'a domain not-found is never an HTTP 5xx')
    assert.equal(res.body.data.record, null)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  })
}

// --- createRecord mutation ---

test('createRecord with valid input returns the new record with id and timestamps; records includes it', async () => {
  const input = { name: 'Widget', status: 'active', amount: 9.99, notes: 'ok' }
  const res = await gql(
    `mutation ($input: CreateRecordInput!) { createRecord(input: $input) { ${RECORD_FIELDS} } }`,
    { input },
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  const record = res.body.data.createRecord
  assert.equal(typeof record.id, 'string')
  assert.equal(record.name, 'Widget')
  assert.equal(record.status, 'active')
  assert.equal(record.amount, 9.99)
  assert.ok(record.createdAt, 'createdAt is set')
  assert.ok(record.updatedAt, 'updatedAt is set')

  const list = await gql(`{ records { id } }`)
  assert.equal(list.body.data.records.length, 1)
  assert.equal(list.body.data.records[0].id, record.id)
})

const invalidCreates = [
  ['negative amount', { name: 'x', status: 'active', amount: -1 }, 'amount'],
  ['empty name', { name: '', status: 'active', amount: 1 }, 'name'],
  ['name over 120 chars', { name: 'y'.repeat(121), status: 'active', amount: 1 }, 'name'],
  ['status outside the allowed set', { name: 'x', status: 'nope', amount: 1 }, 'status'],
  ['notes over 1000 chars', { name: 'x', status: 'active', amount: 1, notes: 'z'.repeat(1001) }, 'notes'],
]

for (const [label, input, field] of invalidCreates) {
  test(`createRecord with ${label} fails naming "${field}" and creates nothing`, async () => {
    const res = await gql(
      `mutation ($input: CreateRecordInput!) { createRecord(input: $input) { ${RECORD_FIELDS} } }`,
      { input },
    )
    assert.equal(res.status, 200)
    const error = res.body.errors[0]
    assert.equal(error.extensions.code, 'BAD_USER_INPUT')
    assert.equal(error.extensions.field, field, 'the error names the offending field')
    assert.match(error.message, new RegExp(field))

    const list = await gql(`{ records { id } }`)
    assert.equal(list.body.data.records.length, 0, 'nothing was created')
  })
}

// --- updateRecord mutation ---

test('updateRecord changing only status leaves other fields intact and advances updatedAt', async () => {
  const seeded = await seed({ name: 'Keep', status: 'active', amount: 5, notes: 'keep' })
  await new Promise((r) => setTimeout(r, 5))

  const res = await gql(
    `mutation ($id: ID!, $input: UpdateRecordInput!) { updateRecord(id: $id, input: $input) { ${RECORD_FIELDS} } }`,
    { id: seeded.id, input: { status: 'archived' } },
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  const updated = res.body.data.updateRecord
  assert.equal(updated.status, 'archived')
  assert.equal(updated.name, 'Keep', 'name unchanged')
  assert.equal(updated.amount, 5, 'amount unchanged')
  assert.equal(updated.notes, 'keep', 'notes unchanged')
  assert.equal(updated.createdAt, seeded.createdAt, 'createdAt unchanged')
  assert.ok(
    new Date(updated.updatedAt).getTime() > new Date(seeded.updatedAt).getTime(),
    'updatedAt advanced',
  )
})

test('updateRecord with an invalid partial (negative amount) is rejected field-scoped; stored record unchanged', async () => {
  const seeded = await seed({ amount: 7 })
  const res = await gql(
    `mutation ($id: ID!, $input: UpdateRecordInput!) { updateRecord(id: $id, input: $input) { ${RECORD_FIELDS} } }`,
    { id: seeded.id, input: { amount: -1 } },
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.data, null, 'a failed non-null mutation nulls data')
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(res.body.errors[0].extensions.field, 'amount')

  const after = await gql(`query ($id: ID!) { record(id: $id) { amount } }`, { id: seeded.id })
  assert.equal(after.body.data.record.amount, 7, 'the stored record is unchanged')
})

for (const [label, id] of [
  ['nonexistent', MISSING_ID],
  ['malformed', MALFORMED_ID],
]) {
  test(`updateRecord with a ${label} id → 200, NOT_FOUND error, never 5xx`, async () => {
    const res = await gql(
      `mutation ($id: ID!, $input: UpdateRecordInput!) { updateRecord(id: $id, input: $input) { ${RECORD_FIELDS} } }`,
      { id, input: { name: 'x' } },
    )
    assert.equal(res.status, 200)
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  })

  test(`deleteRecord with a ${label} id → 200, NOT_FOUND error, never 5xx`, async () => {
    const res = await gql(`mutation ($id: ID!) { deleteRecord(id: $id) }`, { id })
    assert.equal(res.status, 200)
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  })
}

// --- deleteRecord mutation ---

test('deleteRecord with an existing id succeeds and records no longer includes it', async () => {
  const seeded = await seed({ name: 'ToDelete' })
  const res = await gql(`mutation ($id: ID!) { deleteRecord(id: $id) }`, { id: seeded.id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.deleteRecord, seeded.id, 'the deleted id is echoed back')

  const list = await gql(`{ records { id } }`)
  assert.equal(list.body.data.records.length, 0, 'the record is gone')
})
