// DAN-97 TESTER · the seam between the frontend and DAN-96's backend.
//
// The client-side criteria are verified in the frontend suite
// (`app/frontend/src/dan97.tester.test.jsx`, real HTTP; and
// `languagePreference.tester.test.jsx`, hook lifecycle). Both of those talk to
// a stand-in server, because CI has no Firebase and jsdom cannot host Express.
// So there is exactly one thing left that neither can prove: that the GraphQL
// documents DAN-97 actually ships in `app/frontend/src/api.js` are accepted by
// the real schema and really persist.
//
// This file closes that. The documents are not retyped here — they are
// EXTRACTED FROM api.js's source text at run time, so if a future edit changes
// the client's query shape, this test starts exercising the new shape and fails
// if the server does not accept it. They are then POSTed to the real Express
// app listening on a real ephemeral port, against the real Mongo, and every
// storage claim is checked through a SECOND MongoClient that never goes through
// db.js — so "it persisted" means bytes in the collection, not what the app's
// own read function is willing to say.
//
// Environment: any reachable mongod via MONGODB_URI (.env or ambient),
// MONGODB_DB forced to linear_example_test. Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'

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

// --- the client's own documents, lifted out of its source --------------------

const API_SOURCE = fileURLToPath(new URL('../../frontend/src/api.js', import.meta.url))
const source = await readFile(API_SOURCE, 'utf8')
// Backticks appear in this file's prose comments too (`languagePreference`),
// so a bare backtick-pair match would happily return a one-word "document".
// Only strings that actually open with a GraphQL operation qualify.
const templates = [...source.matchAll(/`([^`]*)`/g)]
  .map((m) => m[1].trim())
  .filter((doc) => /^(query|mutation)\b/.test(doc) && doc.includes('{'))

const READ_DOC = templates.find(
  (doc) => /\blanguagePreference\b/.test(doc) && !/setLanguagePreference/.test(doc),
)
const WRITE_DOC = templates.find((doc) => /setLanguagePreference/.test(doc))

// --- the live server, and a Mongo client that shares nothing with db.js ------

const TOKENS = { 'tok-a': 'dan97-tester-user', 'tok-b': 'dan97-tester-user-2' }
const UIDS = Object.values(TOKENS)
const verifyToken = async (token) => {
  const uid = TOKENS[token]
  if (!uid) throw new Error('nope')
  return { uid }
}

let baseUrl
let server
let probe
let rows

async function post(token, body) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}/api/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

// Exactly the request api.js's gql() builds: the extracted document, and
// `variables` present on both operations (it passes undefined for the read,
// which JSON.stringify drops).
const read = (token) => post(token, { query: READ_DOC })
const write = (token, language) => post(token, { query: WRITE_DOC, variables: { language } })

const stored = () => rows.find({ _id: { $in: UIDS } }).toArray()

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()

  probe = new MongoClient(process.env.MONGODB_URI)
  await probe.connect()
  rows = probe.db('linear_example_test').collection('user_prefs')

  const app = createApp({ verifyToken })
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

beforeEach(async () => {
  await rows.deleteMany({ _id: { $in: UIDS } })
})

after(async () => {
  await rows.deleteMany({ _id: { $in: UIDS } })
  await probe.close()
  await new Promise((resolve) => server.close(resolve))
  await getDb().client.close()
})

// --- the extraction itself has to be trustworthy -----------------------------

test('both DAN-97 documents are present in the frontend api.js source', () => {
  assert.ok(READ_DOC, `no languagePreference query found in ${API_SOURCE}`)
  assert.ok(WRITE_DOC, `no setLanguagePreference mutation found in ${API_SOURCE}`)
  // Guard the property the whole uid-scoping design rests on: the client never
  // names a user. If a future edit adds a uid argument, this fails here rather
  // than shipping a client-supplied identity.
  assert.doesNotMatch(READ_DOC, /uid/i)
  assert.doesNotMatch(WRITE_DOC, /uid/i)
  assert.match(WRITE_DOC, /\$language:\s*String!/)
})

// --- the cross-device claim, against the real server -------------------------

test('an unset preference reads back as null, not an error', async () => {
  const res = await read('tok-a')

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.languagePreference, null)
  assert.deepEqual(await stored(), [])
})

test('a write on one connection is readable on the next, and is really in Mongo', async () => {
  const written = await write('tok-a', 'es')
  assert.equal(written.status, 200)
  assert.equal(written.body.errors, undefined)
  assert.equal(written.body.data.setLanguagePreference, 'es')

  // The second device: a separate request, resolved from storage.
  const readBack = await read('tok-a')
  assert.equal(readBack.body.data.languagePreference, 'es')

  // And the independent client agrees, byte for byte.
  assert.deepEqual(await stored(), [{ _id: 'dan97-tester-user', language: 'es' }])
})

test('switching back overwrites rather than accumulating a second row', async () => {
  await write('tok-a', 'es')
  const second = await write('tok-a', 'en')

  assert.equal(second.body.data.setLanguagePreference, 'en')
  assert.equal((await read('tok-a')).body.data.languagePreference, 'en')
  assert.deepEqual(await stored(), [{ _id: 'dan97-tester-user', language: 'en' }])
})

test("one user's preference is invisible to another, in both directions", async () => {
  await write('tok-a', 'es')

  assert.equal((await read('tok-b')).body.data.languagePreference, null)

  await write('tok-b', 'en')
  assert.equal((await read('tok-a')).body.data.languagePreference, 'es')
  assert.deepEqual(
    (await stored()).sort((x, y) => x._id.localeCompare(y._id)),
    [
      { _id: 'dan97-tester-user', language: 'es' },
      { _id: 'dan97-tester-user-2', language: 'en' },
    ],
  )
})

// --- what the client's soft-failure path is actually catching ----------------

test('a language this build does not ship is BAD_USER_INPUT on field "language"', async () => {
  await write('tok-a', 'es')

  const res = await write('tok-a', 'fr')

  // 200 with an errors array is the execution-level channel api.js's gql()
  // turns into a thrown Error carrying extensions.field — which is what
  // useLanguagePreference swallows.
  assert.equal(res.status, 200)
  assert.equal(res.body.errors.length, 1)
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(res.body.errors[0].extensions.field, 'language')
  // The previously stored value survives the rejection.
  assert.deepEqual(await stored(), [{ _id: 'dan97-tester-user', language: 'es' }])
})

test('an unauthenticated read is a 401, before GraphQL runs', async () => {
  const res = await read(null)

  assert.equal(res.status, 401)
  assert.equal(res.body.data, undefined)
})
