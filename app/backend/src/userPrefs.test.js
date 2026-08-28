// Language-preference tests (DAN-96): the userPrefs.js data layer against the
// scratch test database, and the languagePreference / setLanguagePreference
// GraphQL fields over real HTTP through the real auth gate.
//
// Same environment contract as graphql.test.js and aiUsage.test.js: any
// reachable mongod via MONGODB_URI (.env or ambient), MONGODB_DB forced to
// linear_example_test.
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
    // No .env — MONGODB_URI must then come from the ambient environment.
  }
}
process.env.MONGODB_DB = 'linear_example_test'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { LANGUAGES, getLanguagePreference, setLanguagePreference } = await import('./userPrefs.js')
const { ValidationError } = await import('./schema.js')

// Stub verifier mapping distinct tokens to distinct uids, so uid isolation is
// assertable over HTTP. Same seam as every other HTTP-level suite.
const TOKENS = { 'token-alice': 'uid-alice', 'token-bob': 'uid-bob' }
const stubVerify = async (token) => {
  const uid = TOKENS[token]
  if (!uid) throw new Error('invalid token')
  return { uid }
}

function gql(app, token, body) {
  const req = request(app).post('/api/graphql')
  if (token) req.set('Authorization', `Bearer ${token}`)
  return req.send(body)
}

const readQuery = '{ languagePreference }'

function writeMutation(app, token, language) {
  return gql(app, token, {
    query: 'mutation($language: String!) { setLanguagePreference(language: $language) }',
    variables: { language },
  })
}

function prefs() {
  return getDb().collection('user_prefs')
}

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await prefs().deleteMany({})
})

after(async () => {
  await prefs().deleteMany({})
  await getDb().client.close()
})

// --- data layer ---

test('LANGUAGES is exactly en and es', () => {
  assert.deepEqual(LANGUAGES, ['en', 'es'])
})

test('getLanguagePreference returns null for a user with no document', async () => {
  assert.equal(await getLanguagePreference('uid-nobody'), null)
})

test('setLanguagePreference upserts { _id: uid, language } and echoes the stored value', async () => {
  assert.equal(await setLanguagePreference('uid-alice', 'es'), 'es')

  // The stored document is keyed by the uid itself — that is what makes the
  // scoping structural rather than a filter that can be forgotten.
  assert.deepEqual(await prefs().findOne({ _id: 'uid-alice' }), {
    _id: 'uid-alice',
    language: 'es',
  })
  assert.equal(await getLanguagePreference('uid-alice'), 'es')
})

test('a second setLanguagePreference overwrites rather than adding a row', async () => {
  await setLanguagePreference('uid-alice', 'es')
  assert.equal(await setLanguagePreference('uid-alice', 'en'), 'en')

  assert.equal(await getLanguagePreference('uid-alice'), 'en')
  assert.equal(await prefs().countDocuments({ _id: 'uid-alice' }), 1)
})

// Every value that cannot reach the collection, including the ones GraphQL's
// String! would also stop: the data layer refuses them on its own, so a future
// non-GraphQL caller gets the same answer.
for (const bad of ['fr', '', 'EN', 'es ', null, undefined, 5, ['es']]) {
  test(`setLanguagePreference rejects ${JSON.stringify(bad)} and writes nothing`, async () => {
    await assert.rejects(
      () => setLanguagePreference('uid-alice', bad),
      (err) => {
        assert.ok(err instanceof ValidationError)
        assert.equal(err.field, 'language')
        assert.equal(err.status, 400)
        // The message names the allowed values, so the client never has to
        // guess what would have been accepted.
        assert.match(err.message, /en, es/)
        return true
      },
    )
    assert.equal(await prefs().countDocuments({}), 0)
  })
}

test('preferences are per-user: one caller\'s row never bleeds into another\'s', async () => {
  await setLanguagePreference('uid-alice', 'es')
  await setLanguagePreference('uid-bob', 'en')

  assert.equal(await getLanguagePreference('uid-alice'), 'es')
  assert.equal(await getLanguagePreference('uid-bob'), 'en')
})

// --- GraphQL over HTTP ---

test('languagePreference returns null over HTTP when the caller has no document', async () => {
  const app = createApp({ verifyToken: stubVerify })
  const res = await gql(app, 'token-alice', { query: readQuery })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.languagePreference, null)
})

test('setLanguagePreference("es") stores it and languagePreference reads it back', async () => {
  const app = createApp({ verifyToken: stubVerify })

  const write = await writeMutation(app, 'token-alice', 'es')
  assert.equal(write.status, 200)
  assert.equal(write.body.errors, undefined)
  assert.equal(write.body.data.setLanguagePreference, 'es')

  const read = await gql(app, 'token-alice', { query: readQuery })
  assert.equal(read.body.data.languagePreference, 'es')
})

test('calling setLanguagePreference again with "en" overwrites the stored value', async () => {
  const app = createApp({ verifyToken: stubVerify })

  await writeMutation(app, 'token-alice', 'es')
  const second = await writeMutation(app, 'token-alice', 'en')
  assert.equal(second.body.data.setLanguagePreference, 'en')

  const read = await gql(app, 'token-alice', { query: readQuery })
  assert.equal(read.body.data.languagePreference, 'en')
  assert.equal(await prefs().countDocuments({}), 1)
})

// "fr", "" and "EN" all reach the resolver (they are valid Strings), so these
// are the values that exercise the BAD_USER_INPUT mapping end to end.
for (const bad of ['fr', '', 'EN']) {
  test(`setLanguagePreference(${JSON.stringify(bad)}) is BAD_USER_INPUT over HTTP and writes nothing`, async () => {
    const app = createApp({ verifyToken: stubVerify })
    const res = await writeMutation(app, 'token-alice', bad)

    // A well-formed GraphQL request reports failures in `errors`, not a status.
    assert.equal(res.status, 200)
    assert.equal(res.body.errors.length, 1)
    assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
    assert.equal(res.body.errors[0].extensions.field, 'language')
    assert.match(res.body.errors[0].message, /en, es/)

    assert.equal(await prefs().countDocuments({}), 0)
  })
}

// A literal/variable null is stopped EARLIER than the resolver: `language` is
// String!, so graphql rejects it during variable coercion, before execution.
// That is a different error code than BAD_USER_INPUT by construction — the
// acceptance criterion's guarantee that survives is the one that matters, that
// null is rejected and nothing is written. The data-layer loop above also
// proves userPrefs.js refuses null on its own if it is ever called directly.
test('a null language is rejected before execution and writes nothing', async () => {
  const app = createApp({ verifyToken: stubVerify })
  const res = await writeMutation(app, 'token-alice', null)

  assert.ok(res.body.errors?.length >= 1, 'null must be rejected')
  assert.equal(res.body.data, undefined)
  assert.equal(await prefs().countDocuments({}), 0)
})

test('a rejected write leaves an ALREADY stored preference untouched', async () => {
  const app = createApp({ verifyToken: stubVerify })
  await writeMutation(app, 'token-alice', 'es')

  await writeMutation(app, 'token-alice', 'fr')

  const read = await gql(app, 'token-alice', { query: readQuery })
  assert.equal(read.body.data.languagePreference, 'es')
})

test('caller A can neither read nor affect caller B\'s preference', async () => {
  const app = createApp({ verifyToken: stubVerify })

  await writeMutation(app, 'token-alice', 'es')

  // Bob sees his own (absent) preference, not Alice's.
  const bobBefore = await gql(app, 'token-bob', { query: readQuery })
  assert.equal(bobBefore.body.data.languagePreference, null)

  // Bob writing his own does not disturb Alice's.
  await writeMutation(app, 'token-bob', 'en')
  const aliceAfter = await gql(app, 'token-alice', { query: readQuery })
  assert.equal(aliceAfter.body.data.languagePreference, 'es')
  const bobAfter = await gql(app, 'token-bob', { query: readQuery })
  assert.equal(bobAfter.body.data.languagePreference, 'en')

  // Two rows, each keyed by its own uid.
  assert.equal(await prefs().countDocuments({}), 2)
})

// The uid is not an argument anywhere in the schema, so there is no query a
// caller can even write that names another user. Asserting that keeps a future
// "just add a uid argument" change from passing review quietly.
test('neither field accepts a uid argument', async () => {
  const app = createApp({ verifyToken: stubVerify })

  const read = await gql(app, 'token-bob', { query: '{ languagePreference(uid: "uid-alice") }' })
  assert.ok(read.body.errors?.length >= 1)

  const write = await gql(app, 'token-bob', {
    query: 'mutation { setLanguagePreference(uid: "uid-alice", language: "es") }',
  })
  assert.ok(write.body.errors?.length >= 1)
  assert.equal(await prefs().countDocuments({}), 0)
})

// --- criterion 3: the existing auth gate, unchanged ---

test('unauthenticated requests are rejected with 401 before GraphQL runs', async () => {
  const app = createApp({ verifyToken: stubVerify })

  for (const body of [{ query: readQuery }, {
    query: 'mutation { setLanguagePreference(language: "es") }',
  }]) {
    const noHeader = await gql(app, null, body)
    assert.equal(noHeader.status, 401)
    assert.equal(noHeader.body.error.message, 'Missing or malformed Authorization header')

    const badToken = await gql(app, 'token-nope', body)
    assert.equal(badToken.status, 401)
    assert.equal(badToken.body.error.message, 'Invalid or expired token')
  }

  // Nothing was written by any of those attempts.
  assert.equal(await prefs().countDocuments({}), 0)
})
