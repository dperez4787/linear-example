// Verifies DAN-5 db.js criteria. Run with the plain project script:
//   npm test          (node --test, no experimental flags)
//
// The data layer is unit-testable against a scratch database (see
// docs/architecture.md), so connect()/getDb() are exercised against the real
// test cluster rather than a mocked driver. Each test that needs a clean
// module-level `db` re-imports db.js with a cache-busting query string, which
// gives it a fresh module instance (and therefore a fresh, uncached client).
// Every MongoClient opened here is closed so `node --test` exits on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

// Load MONGODB_URI from app/backend/.env if it isn't already in the
// environment. process.loadEnvFile reads the file into process.env without
// echoing its contents anywhere.
if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // No .env — MONGODB_URI must then come from the ambient environment.
  }
}

// A fresh module instance each call, so its module-level `db` starts unset.
let importCounter = 0
function freshDb() {
  return import(`./db.js?fresh=${importCounter++}`)
}

test('getDb() before an awaited connect() throws', async () => {
  const { getDb } = await freshDb()
  assert.throws(() => getDb(), /connect\(\) must be awaited/)
})

test('connect() reads MONGODB_URI and connects a single MongoClient; getDb() returns the cached db; a second connect() reuses the same client', async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for this test')
  // Never point data operations at the app database.
  process.env.MONGODB_DB = 'linear_example_test'

  const { connect, getDb } = await freshDb()
  const db1 = await connect()
  try {
    // A real ping proves connect() built a client from MONGODB_URI and
    // actually connected it to the cluster.
    const pong = await db1.command({ ping: 1 })
    assert.equal(pong.ok, 1, 'ping succeeds against the connected cluster')
    assert.equal(db1.databaseName, 'linear_example_test', 'uses MONGODB_DB')

    // getDb() hands back the same cached handle.
    assert.strictEqual(getDb(), db1, 'getDb() returns the cached db')

    // A second connect() returns the very same db object, so no second
    // MongoClient was constructed or connected.
    const db2 = await connect()
    assert.strictEqual(db2, db1, 'second connect() reuses the existing client')
    assert.strictEqual(getDb(), db2)
  } finally {
    await db1.client.close()
  }
})

test('MONGODB_DB defaults to linear_example when unset', async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for this test')
  delete process.env.MONGODB_DB

  const { connect } = await freshDb()
  const db = await connect()
  try {
    // Reading the name opens no collection and issues no command against the
    // app database — it only inspects the handle connect() built.
    assert.equal(db.databaseName, 'linear_example', 'defaults to linear_example')
  } finally {
    await db.client.close()
  }
})
