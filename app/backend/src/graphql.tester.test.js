// DAN-25 tester verification — independent of the developer's graphql.test.js.
//
// Drives POST /api/graphql end to end against the scratch test database
// (linear_example_test) and asserts the acceptance criteria directly on the wire:
// the auth gate (including the verifier-rejects-a-token 401, which the developer's
// real-default suite only exercises for header short-circuits), a full
// create→read→update→delete lifecycle, field-scoped validation with a
// no-side-effect check, the not-found contract (200 + NOT_FOUND, never 5xx), and
// that _id never crosses the wire.
//
// Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import request from 'supertest'

if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // No .env — MONGODB_URI must come from the ambient environment.
  }
}
process.env.MONGODB_DB = 'linear_example_test'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')

const VALID_TOKEN = 'tester-valid-token'
const REJECTED_TOKEN = 'tester-rejected-token'
// Resolves only for VALID_TOKEN; every other token (including REJECTED_TOKEN) is
// rejected, so we can assert the "verifier rejects the token" 401 path explicitly.
const stubVerify = async (token) => {
  if (token === VALID_TOKEN) return { uid: 'tester-uid' }
  throw new Error('rejected')
}

const app = createApp({ verifyToken: stubVerify })

const RECORD_FIELDS = 'id name status amount notes createdAt updatedAt'

function gql(query, variables, token = VALID_TOKEN) {
  const req = request(app).post('/api/graphql')
  if (token !== null) req.set('Authorization', `Bearer ${token}`)
  return req.send({ query, variables })
}

async function create(input) {
  const res = await gql(
    `mutation ($input: CreateRecordInput!) { createRecord(input: $input) { ${RECORD_FIELDS} } }`,
    { input },
  )
  return res
}

const MISSING_ID = '0123456789abcdef01234567'
const MALFORMED_ID = 'xyz'

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

// --- auth gate (DAN-22 semantics carried over) ---

test('no Authorization header → 401 { error: { message } }, no record data', async () => {
  const res = await gql(`{ records { id } }`, undefined, null)
  assert.equal(res.status, 401)
  assert.equal(typeof res.body.error.message, 'string')
  assert.equal(res.body.data, undefined)
})

test('non-Bearer Authorization header → 401', async () => {
  const res = await request(app)
    .post('/api/graphql')
    .set('Authorization', 'Basic Zm9vOmJhcg==')
    .send({ query: `{ records { id } }` })
  assert.equal(res.status, 401)
  assert.equal(typeof res.body.error.message, 'string')
})

test('a token the verifier REJECTS → 401, shaped, execution never reached', async () => {
  const res = await gql(`{ records { id } }`, undefined, REJECTED_TOKEN)
  assert.equal(res.status, 401)
  assert.equal(typeof res.body.error.message, 'string')
  assert.equal(res.body.data, undefined)
})

// --- full CRUD lifecycle over the wire ---

test('create → records → record(id) → update → delete lifecycle', async () => {
  const created = (await create({ name: 'Alpha', status: 'pending', amount: 3.5, notes: 'n' }))
    .body.data.createRecord
  assert.equal(typeof created.id, 'string')
  assert.ok(created.createdAt && created.updatedAt)

  // records includes it, id is a string, _id nowhere in the body
  const list = await gql(`{ records { ${RECORD_FIELDS} } }`)
  assert.equal(list.status, 200)
  assert.equal(list.body.data.records.length, 1)
  assert.equal(typeof list.body.data.records[0].id, 'string')
  assert.ok(!JSON.stringify(list.body).includes('_id'), '_id must not cross the wire')

  // record(id) returns it
  const one = await gql(`query ($id: ID!) { record(id: $id) { id name } }`, { id: created.id })
  assert.equal(one.body.data.record.id, created.id)
  assert.equal(one.body.data.record.name, 'Alpha')

  // partial update: only status changes, others intact, updatedAt advances
  await new Promise((r) => setTimeout(r, 5))
  const upd = await gql(
    `mutation ($id: ID!, $input: UpdateRecordInput!) { updateRecord(id: $id, input: $input) { ${RECORD_FIELDS} } }`,
    { id: created.id, input: { status: 'archived' } },
  )
  const updated = upd.body.data.updateRecord
  assert.equal(updated.status, 'archived')
  assert.equal(updated.name, 'Alpha')
  assert.equal(updated.amount, 3.5)
  assert.equal(updated.notes, 'n')
  assert.equal(updated.createdAt, created.createdAt, 'createdAt unchanged')
  assert.ok(
    new Date(updated.updatedAt).getTime() > new Date(created.updatedAt).getTime(),
    'updatedAt advanced',
  )

  // delete: succeeds, then gone
  const del = await gql(`mutation ($id: ID!) { deleteRecord(id: $id) }`, { id: created.id })
  assert.equal(del.status, 200)
  assert.equal(del.body.data.deleteRecord, created.id)
  const after = await gql(`{ records { id } }`)
  assert.equal(after.body.data.records.length, 0)
})

// --- validation is field-scoped and has no side effect ---

for (const [label, input, field] of [
  ['negative amount', { name: 'x', status: 'active', amount: -0.01 }, 'amount'],
  ['empty name', { name: '  ', status: 'active', amount: 1 }, 'name'],
  ['name over 120', { name: 'a'.repeat(121), status: 'active', amount: 1 }, 'name'],
  ['bad status', { name: 'x', status: 'weird', amount: 1 }, 'status'],
  ['notes over 1000', { name: 'x', status: 'active', amount: 1, notes: 'z'.repeat(1001) }, 'notes'],
]) {
  test(`createRecord rejects ${label} naming "${field}" and creates nothing`, async () => {
    const res = await create(input)
    assert.equal(res.status, 200, 'validation is reported in-band, not as HTTP 5xx')
    assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
    assert.equal(res.body.errors[0].extensions.field, field)
    const list = await gql(`{ records { id } }`)
    assert.equal(list.body.data.records.length, 0, 'no record was created')
  })
}

test('invalid partial update is field-scoped and leaves the stored record unchanged', async () => {
  const created = (await create({ name: 'Keep', status: 'active', amount: 42 })).body.data
    .createRecord
  const res = await gql(
    `mutation ($id: ID!, $input: UpdateRecordInput!) { updateRecord(id: $id, input: $input) { id } }`,
    { id: created.id, input: { amount: -5 } },
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.field, 'amount')
  const reread = await gql(`query ($id: ID!) { record(id: $id) { amount } }`, { id: created.id })
  assert.equal(reread.body.data.record.amount, 42, 'stored record unchanged after a rejected update')
})

// --- not-found contract: 200 + NOT_FOUND, never a 5xx ---

for (const [label, id] of [
  ['nonexistent', MISSING_ID],
  ['malformed', MALFORMED_ID],
]) {
  test(`record/update/delete with a ${label} id → 200 + NOT_FOUND, never 5xx`, async () => {
    const q = await gql(`query ($id: ID!) { record(id: $id) { id } }`, { id })
    assert.equal(q.status, 200)
    assert.equal(q.body.data.record, null)
    assert.equal(q.body.errors[0].extensions.code, 'NOT_FOUND')

    const u = await gql(
      `mutation ($id: ID!, $input: UpdateRecordInput!) { updateRecord(id: $id, input: $input) { id } }`,
      { id, input: { name: 'x' } },
    )
    assert.equal(u.status, 200)
    assert.equal(u.body.errors[0].extensions.code, 'NOT_FOUND')

    const d = await gql(`mutation ($id: ID!) { deleteRecord(id: $id) }`, { id })
    assert.equal(d.status, 200)
    assert.equal(d.body.errors[0].extensions.code, 'NOT_FOUND')
  })
}

// --- old REST surface is gone (not aliased) ---

for (const [method, path] of [
  ['get', '/api/records'],
  ['post', '/api/records'],
  ['get', `/api/records/${MISSING_ID}`],
  ['patch', `/api/records/${MISSING_ID}`],
  ['delete', `/api/records/${MISSING_ID}`],
]) {
  test(`${method.toUpperCase()} ${path} is gone (404)`, async () => {
    const res = await request(app)[method](path).set('Authorization', `Bearer ${VALID_TOKEN}`)
    assert.equal(res.status, 404)
  })
}

test('GET /health is 200 with no auth', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})
