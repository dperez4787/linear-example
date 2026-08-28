// DAN-96 TESTER · independent verification of the language-preference schema
// and its two GraphQL fields, written from the acceptance criteria rather than
// from userPrefs.js.
//
// The instrument is deliberately NOT the one the developer's suite uses. Every
// criterion here is exercised over a REAL socket — the app is listened on an
// ephemeral port and driven with fetch(), so the Express stack, the auth gate,
// graphql-http's parsing and the JSON encoding are all in the loop — and every
// storage claim is checked through a SECOND, independent MongoClient that never
// goes through db.js. That separation is the point: "it upserts one row keyed by
// the uid" is asserted against the bytes in the collection, not against what the
// module's own read function chooses to report.
//
// Environment contract matches the rest of the backend suite: any reachable
// mongod via MONGODB_URI (.env or ambient), MONGODB_DB forced to
// linear_example_test. Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
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

// Two callers whose uids share a prefix, so a sloppy prefix/regex match would
// show up as cross-user bleed rather than passing quietly.
const TOKENS = {
  'tok-a': 'dan96-tester-user',
  'tok-b': 'dan96-tester-user-2',
}
const UIDS = Object.values(TOKENS)
const verifyToken = async (token) => {
  const uid = TOKENS[token]
  if (!uid) throw new Error('nope')
  return { uid }
}

// --- the live server, and a Mongo client that shares nothing with db.js ---

let baseUrl
let server
let probe // independent MongoClient
let rows // independent handle on user_prefs

// Send a GraphQL request over the wire. `token` may be omitted entirely, which
// is how the unauthenticated criterion is exercised.
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

const read = (token) => post(token, { query: '{ languagePreference }' })

const write = (token, language) =>
  post(token, {
    query: 'mutation($l: String!) { setLanguagePreference(language: $l) }',
    variables: { l: language },
  })

// The whole collection, as the database actually holds it. Scoped to this
// suite's uids so a parallel suite's rows can never be mistaken for ours and
// ours are the only thing we ever delete.
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

// --- criterion 1: the write upserts, overwrites, and validates ---

test('setLanguagePreference("es") returns "es" and upserts exactly {_id: uid, language: "es"}', async () => {
  const res = await write('tok-a', 'es')

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.setLanguagePreference, 'es')

  // Asserted with deepEqual, not by field: the ticket specifies the document
  // shape, so an extra field (a stray createdAt, a duplicated uid column) is a
  // deviation from the schema this ticket is about, not an implementation detail.
  assert.deepEqual(await stored(), [{ _id: 'dan96-tester-user', language: 'es' }])
})

test('a second call with "en" overwrites in place — one row, not two', async () => {
  await write('tok-a', 'es')
  const second = await write('tok-a', 'en')

  assert.equal(second.body.data.setLanguagePreference, 'en')
  assert.deepEqual(await stored(), [{ _id: 'dan96-tester-user', language: 'en' }])
})

test('en and es are both accepted, and each round-trips unchanged', async () => {
  for (const language of ['en', 'es']) {
    assert.equal((await write('tok-a', language)).body.data.setLanguagePreference, language)
    assert.equal((await read('tok-a')).body.data.languagePreference, language)
  }
})

// The criterion names "fr", "", "EN" and null. The rest are the neighbouring
// values a caller would plausibly send — a locale tag, whitespace, a
// wrong-typed scalar — which must be refused by the same one rule.
for (const bad of ['fr', '', 'EN', 'ES', 'en-US', 'es_ES', ' es', 'es ', 'de', 'engl']) {
  test(`setLanguagePreference(${JSON.stringify(bad)}) is BAD_USER_INPUT and writes nothing`, async () => {
    const res = await write('tok-a', bad)

    assert.equal(res.status, 200, 'a well-formed GraphQL request still answers 200')
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors.length, 1)

    const [error] = res.body.errors
    assert.equal(error.extensions.code, 'BAD_USER_INPUT')
    assert.equal(error.extensions.field, 'language', 'the error is scoped to the language field')
    // "a message naming the allowed values" — assert both values are named, so
    // a message that merely says "invalid language" cannot pass.
    assert.match(error.message, /\ben\b/)
    assert.match(error.message, /\bes\b/)

    assert.deepEqual(await stored(), [], 'a rejected value must not create a row')
  })
}

test('null is rejected (as a variable and as a literal) and writes nothing', async () => {
  const viaVariable = await write('tok-a', null)
  assert.ok(viaVariable.body.errors?.length >= 1)
  assert.equal(viaVariable.body.data, undefined)

  const viaLiteral = await post('tok-a', {
    query: 'mutation { setLanguagePreference(language: null) }',
  })
  assert.ok(viaLiteral.body.errors?.length >= 1)

  assert.deepEqual(await stored(), [])
})

test('a rejected write does not disturb a preference already stored', async () => {
  await write('tok-a', 'es')
  await write('tok-a', 'fr')

  assert.equal((await read('tok-a')).body.data.languagePreference, 'es')
  assert.deepEqual(await stored(), [{ _id: 'dan96-tester-user', language: 'es' }])
})

// --- criterion 2: the read, and uid scoping ---

test('languagePreference is null — with no error — for a caller who has never written', async () => {
  const res = await read('tok-a')

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, 'absent is the normal first-load state, not an error')
  assert.equal(res.body.data.languagePreference, null)
})

test('a value written by A is invisible to B, and B writing does not move A', async () => {
  await write('tok-a', 'es')

  assert.equal((await read('tok-b')).body.data.languagePreference, null)

  await write('tok-b', 'en')
  assert.equal((await read('tok-a')).body.data.languagePreference, 'es')
  assert.equal((await read('tok-b')).body.data.languagePreference, 'en')

  const docs = (await stored()).sort((x, y) => x._id.localeCompare(y._id))
  assert.deepEqual(docs, [
    { _id: 'dan96-tester-user', language: 'es' },
    { _id: 'dan96-tester-user-2', language: 'en' },
  ])
})

test('interleaved writes from two callers stay on their own rows', async () => {
  // Twenty concurrent writes, alternating owner and value. Whatever order they
  // land in, the invariant is two rows and each caller's read agreeing with its
  // own last write — never a third row and never a value from the other caller.
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => write(i % 2 ? 'tok-b' : 'tok-a', i % 2 ? 'en' : 'es')),
  )

  assert.equal((await stored()).length, 2)
  assert.equal((await read('tok-a')).body.data.languagePreference, 'es')
  assert.equal((await read('tok-b')).body.data.languagePreference, 'en')
})

test('there is no query shape that names another user', async () => {
  await write('tok-a', 'es')

  // An argument the schema does not declare is a validation error, not a
  // silently-ignored extra — so "just add a uid argument" cannot land quietly.
  for (const query of [
    '{ languagePreference(uid: "dan96-tester-user") }',
    '{ languagePreference(_id: "dan96-tester-user") }',
    'mutation { setLanguagePreference(uid: "dan96-tester-user", language: "en") }',
  ]) {
    const res = await post('tok-b', { query })
    assert.ok(res.body.errors?.length >= 1, `${query} must not be a valid query`)
  }

  // Aliasing the field twice does not give a second, differently-scoped read.
  const aliased = await post('tok-b', { query: '{ mine: languagePreference, also: languagePreference }' })
  assert.deepEqual(aliased.body.data, { mine: null, also: null })

  // Nothing above touched A's row.
  assert.deepEqual(await stored(), [{ _id: 'dan96-tester-user', language: 'es' }])
})

test('the uid comes from the token, not from anything the client can send', async () => {
  await write('tok-a', 'es')

  // A header and a query variable that both claim to be the other user are
  // ignored: the response is B's own (absent) preference.
  const res = await fetch(`${baseUrl}/api/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer tok-b',
      'x-uid': 'dan96-tester-user',
    },
    body: JSON.stringify({
      query: '{ languagePreference }',
      variables: { uid: 'dan96-tester-user' },
    }),
  })
  const body = await res.json()
  assert.equal(body.data.languagePreference, null)
})

// --- criterion 3: the existing auth layer rejects before GraphQL ---

test('no Authorization header is 401, for both fields, and writes nothing', async () => {
  for (const body of [
    { query: '{ languagePreference }' },
    { query: 'mutation { setLanguagePreference(language: "es") }' },
  ]) {
    const res = await post(null, body)
    assert.equal(res.status, 401)
    assert.equal(res.body.error.message, 'Missing or malformed Authorization header')
    assert.equal(res.body.data, undefined, 'a 401 must not carry a GraphQL result')
  }
  assert.deepEqual(await stored(), [])
})

test('an unrecognised or malformed token is 401 and writes nothing', async () => {
  for (const header of ['Bearer not-a-real-token', 'Bearer ', 'Basic tok-a', 'tok-a']) {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: header },
      body: JSON.stringify({ query: 'mutation { setLanguagePreference(language: "es") }' }),
    })
    assert.equal(res.status, 401, `header ${JSON.stringify(header)} must be rejected`)
  }
  assert.deepEqual(await stored(), [])
})

test('the 401 happens BEFORE GraphQL parses the document', async () => {
  // A body that graphql-http could never parse. If the gate ran after parsing,
  // this would come back as a 400 syntax error instead of a 401 — so the status
  // is what proves the ordering the criterion asks for.
  const res = await post(null, { query: '{{{ this is not graphql' })
  assert.equal(res.status, 401)
  assert.equal(res.body.error.message, 'Missing or malformed Authorization header')
})

// --- the value is genuinely persisted, not held in the process ---

test('a preference survives a fresh app instance reading through a fresh request', async () => {
  await write('tok-a', 'es')

  // A second app object on its own socket, with its own handler and context —
  // the closest in-suite equivalent of the Cloud Run instance being replaced.
  const second = createApp({ verifyToken })
  const secondServer = second.listen(0)
  await new Promise((resolve) => secondServer.once('listening', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${secondServer.address().port}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a' },
      body: JSON.stringify({ query: '{ languagePreference }' }),
    })
    assert.equal((await res.json()).data.languagePreference, 'es')
  } finally {
    await new Promise((resolve) => secondServer.close(resolve))
  }
})

// A row written directly to the collection — as DAN-97's frontend will find
// rows written by an earlier deploy — reads back through the API unchanged.
test('a row already in the collection is readable by its owner', async () => {
  await rows.insertOne({ _id: 'dan96-tester-user-2', language: 'es' })

  assert.equal((await read('tok-b')).body.data.languagePreference, 'es')
  assert.equal((await read('tok-a')).body.data.languagePreference, null)
})

// --- the wire contract the frontend (DAN-97) will code against ---

test('the schema exposes exactly the two fields the ticket specifies', async () => {
  const res = await post('tok-a', {
    query: `{
      query: __type(name: "Query") { fields { name args { name } type { kind name } } }
      mutation: __type(name: "Mutation") {
        fields { name type { kind ofType { name } } args { name type { kind ofType { name } } } }
      }
    }`,
  })

  const languagePreference = res.body.data.query.fields.find((f) => f.name === 'languagePreference')
  assert.ok(languagePreference, 'Query.languagePreference must exist')
  // Nullable String, and no arguments at all — the absence of an argument is
  // what makes "can only read your own" structural rather than enforced.
  assert.deepEqual(languagePreference.type, { kind: 'SCALAR', name: 'String' })
  assert.deepEqual(languagePreference.args, [])

  const setter = res.body.data.mutation.fields.find((f) => f.name === 'setLanguagePreference')
  assert.ok(setter, 'Mutation.setLanguagePreference must exist')
  assert.equal(setter.type.kind, 'NON_NULL')
  assert.equal(setter.type.ofType.name, 'String')
  assert.deepEqual(
    setter.args.map((a) => [a.name, a.type.kind, a.type.ofType?.name]),
    [['language', 'NON_NULL', 'String']],
  )
})

// The ticket is additive: nothing that already worked may have moved.
test('the pre-existing surface is untouched', async () => {
  const res = await post('tok-a', {
    query: '{ __type(name: "Query") { fields { name } } }',
  })
  const names = res.body.data.__type.fields.map((f) => f.name)
  for (const field of ['records', 'record', 'myAiUsage', 'featureRequests']) {
    assert.ok(names.includes(field), `Query.${field} must still exist`)
  }

  const records = await post('tok-a', { query: '{ records { id } }' })
  assert.equal(records.body.errors, undefined)
  assert.ok(Array.isArray(records.body.data.records))
})
