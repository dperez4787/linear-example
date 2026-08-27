// DAN-50 tester verification: entrance-criteria evaluation — three hard gates.
// Independent of the developer's entranceCriteria.test.js; written from the
// ticket's acceptance criteria. Run with: npm test
//
// Seams: stub token verifier + REAL createAiGateway over a scripted, capturing
// fetch — so "exactly one additional gateway call" is asserted by counting ALL
// captured calls per exchange, not by trusting a role filter. Mongo
// (linear_example_test) is the only external dependency.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import request from 'supertest'

if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // No .env — MONGODB_URI must then come from the ambient environment.
  }
}
process.env.MONGODB_DB = 'linear_example_test'
// Read lazily inside aiGateway.chat(); the scripted fetch never dials them.
process.env.AI_GATEWAY_URL = 'https://gateway.tester.invalid'
process.env.AI_GATEWAY_KEY = 'tester-gateway-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')
const { ENTRANCE_CRITERIA_MODEL } = await import('./featureRequests.js')
const { ObjectId } = await import('mongodb')

// --- fixtures ---

const SESSION_MODEL = 'claude-opus-5'
const PO_REPLY = 'Refined: one CSV export button over the filtered rows.'
const ARCHITECT_REPLY = 'Feasible: one query, no schema change.'
const PLAN_REPLY = JSON.stringify({ tickets: [] }) // planner: not converged

const GATES = ['notTooBig', 'notAmbiguous', 'noBlockedDependencies']

// Build an evaluation verdict from three booleans, in GATES order.
function verdict(big, amb, dep) {
  const passes = { notTooBig: big, notAmbiguous: amb, noBlockedDependencies: dep }
  return Object.fromEntries(
    GATES.map((g) => [g, { pass: passes[g], reason: `tester fixture: ${g} ${passes[g]}` }]),
  )
}

const ALL_PASS = verdict(true, true, true)

function uniformFailure(reason) {
  return Object.fromEntries(GATES.map((g) => [g, { pass: false, reason }]))
}

function completion(content, totalTokens = 7) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: totalTokens },
  }
}

// Distinct primes so a usage delta of the sum proves all four distinct calls landed.
const TOKENS_BY_ROLE = { 'product-owner': 23, architect: 29, planner: 31, 'entrance-criteria': 37 }

// Capturing scripted fetch. Answers per metadata.role. `evalContent` scripts the
// evaluator's reply; `failRole`+`failStatus` makes exactly that role's call fail.
function scriptedFetch({ evalContent = JSON.stringify(ALL_PASS), failRole, failStatus = 429 } = {}) {
  const calls = []
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    const role = body.metadata.role
    if (role === failRole) {
      return { ok: false, status: failStatus, json: async () => ({ error: { message: 'nope' } }) }
    }
    const reply =
      role === 'product-owner'
        ? PO_REPLY
        : role === 'architect'
          ? ARCHITECT_REPLY
          : role === 'entrance-criteria'
            ? evalContent
            : PLAN_REPLY
    return { ok: true, status: 200, json: async () => completion(reply, TOKENS_BY_ROLE[role]) }
  }
  fn.calls = calls
  return fn
}

// --- app plumbing (stub verifier, injected gateway) ---

const TOKENS = { 'stub-token-dana': { uid: 'uid-dana' } }
const DANA = 'stub-token-dana'

const stubVerify = async (token) => {
  const decoded = TOKENS[token]
  if (!decoded) throw new Error('invalid token')
  return decoded
}

const makeApp = (fetchImpl) =>
  createApp({ verifyToken: stubVerify, aiGateway: createAiGateway({ fetch: fetchImpl }) })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const FR_FIELDS = `id status model
  messages { role content }
  plan { tickets { title description } }
  entranceCriteria {
    notTooBig { pass reason }
    notAmbiguous { pass reason }
    noBlockedDependencies { pass reason }
  }
  approvable`
const SEND = `mutation ($id: ID!, $content: String!) {
  sendFeatureRequestMessage(id: $id, content: $content) { ${FR_FIELDS} }
}`
const GET = `query ($id: ID!) { featureRequest(id: $id) { ${FR_FIELDS} } }`
const USAGE = '{ myAiUsage { requests totalTokens } }'

async function startSession(app, token = DANA) {
  const res = await gql(
    app,
    token,
    'mutation ($input: StartFeatureRequestInput!) { startFeatureRequest(input: $input) { id } }',
    { input: { model: SESSION_MODEL } },
  )
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest.id
}

const featureRequests = () => getDb().collection('feature_requests')

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await featureRequests().deleteMany({})
  await getDb().collection('ai_usage').deleteMany({})
})

after(async () => {
  await featureRequests().deleteMany({})
  await getDb().collection('ai_usage').deleteMany({})
  await getDb().client.close()
})

// --- criterion 1: exactly one additional call, cheap model, single constant ---

test('criterion 1: one exchange makes exactly four gateway calls — PO, architect, planner, then one entrance-criteria call on the cheap model', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app)

  const res = await gql(app, DANA, SEND, { id, content: 'export my table as CSV' })
  assert.equal(res.body.errors, undefined)

  // Count ALL captured calls, not a filtered subset: exactly one call was
  // added to DAN-49's three, and it is the last one.
  assert.equal(fetch.calls.length, 4, 'exactly four gateway calls per exchange')
  assert.deepEqual(
    fetch.calls.map((c) => c.body.metadata.role),
    ['product-owner', 'architect', 'planner', 'entrance-criteria'],
  )

  const evaluator = fetch.calls[3]
  assert.equal(evaluator.body.model, 'claude-haiku-4-5', 'the evaluator runs on the cheap model')
  assert.equal(evaluator.body.model, ENTRANCE_CRITERIA_MODEL, 'the id is the exported constant')
  for (const call of fetch.calls.slice(0, 3)) {
    assert.equal(call.body.model, SESSION_MODEL, `${call.body.metadata.role} uses the session model`)
    assert.notEqual(call.body.model, evaluator.body.model, 'evaluator model is distinct')
  }

  // A second exchange adds exactly four more — the evaluator is per-exchange,
  // not cumulative.
  await gql(app, DANA, SEND, { id, content: 'filtered rows only' })
  assert.equal(fetch.calls.length, 8)
  assert.equal(
    fetch.calls.filter((c) => c.body.metadata.role === 'entrance-criteria').length,
    2,
    'one evaluator call per exchange',
  )
})

test('criterion 1: the cheap model id lives in exactly one non-test source file — the exported constant', () => {
  const srcDir = fileURLToPath(new URL('.', import.meta.url))
  const hits = readdirSync(srcDir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .filter((f) => readFileSync(`${srcDir}/${f}`, 'utf8').includes('claude-haiku-4-5'))
  assert.deepEqual(hits, ['featureRequests.js'], 'the id is a single constant, not scattered')
  const source = readFileSync(`${srcDir}/featureRequests.js`, 'utf8')
  assert.equal(
    source.split('claude-haiku-4-5').length - 1,
    1,
    'the id appears exactly once in that file',
  )
})

// --- criterion 2: structured JSON requested; result persists on the session ---

test('criterion 2: the evaluator call requests structured JSON and the verdict persists as FeatureRequest.entranceCriteria with the exact gate shape', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app)
  const res = await gql(app, DANA, SEND, { id, content: 'export my table as CSV' })

  const evaluator = fetch.calls.find((c) => c.body.metadata.role === 'entrance-criteria')
  assert.deepEqual(evaluator.body.response_format, { type: 'json_object' })

  // Wire shape: three gates, each { pass, reason }.
  assert.deepEqual(res.body.data.sendFeatureRequestMessage.entranceCriteria, ALL_PASS)

  // Raw persistence: the stored document carries exactly the three gates, each
  // exactly { pass: boolean, reason: string } — nothing else.
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.entranceCriteria, ALL_PASS)
  assert.deepEqual(Object.keys(doc.entranceCriteria).sort(), [...GATES].sort())
  for (const gate of GATES) {
    assert.deepEqual(Object.keys(doc.entranceCriteria[gate]).sort(), ['pass', 'reason'])
    assert.equal(typeof doc.entranceCriteria[gate].pass, 'boolean')
    assert.equal(typeof doc.entranceCriteria[gate].reason, 'string')
  }

  // And a fresh read serves the persisted verdict, not an echo.
  const reread = await gql(app, DANA, GET, { id })
  assert.deepEqual(reread.body.data.featureRequest.entranceCriteria, ALL_PASS)
})

// --- criterion 3: approvable iff all three gates pass — all 8 combinations ---

for (const big of [true, false]) {
  for (const amb of [true, false]) {
    for (const dep of [true, false]) {
      const expected = big && amb && dep
      test(`criterion 3: gates (notTooBig=${big}, notAmbiguous=${amb}, noBlockedDependencies=${dep}) → approvable=${expected}`, async () => {
        const fixture = verdict(big, amb, dep)
        const app = makeApp(scriptedFetch({ evalContent: JSON.stringify(fixture) }))
        const id = await startSession(app)

        const res = await gql(app, DANA, SEND, { id, content: 'export my table as CSV' })
        assert.equal(res.body.errors, undefined)
        const fr = res.body.data.sendFeatureRequestMessage
        assert.equal(fr.approvable, expected)
        assert.deepEqual(fr.entranceCriteria, fixture)

        const reread = await gql(app, DANA, GET, { id })
        assert.equal(reread.body.data.featureRequest.approvable, expected)
      })
    }
  }
}

// --- criterion 3/derivation: approvable is derived live, never stored ---

test('approvable is never stored: flipping the stored gates directly in Mongo flips the derived approvable on the next read', async () => {
  const app = makeApp(scriptedFetch({ evalContent: JSON.stringify(ALL_PASS) }))
  const id = await startSession(app)
  await gql(app, DANA, SEND, { id, content: 'export my table as CSV' })

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.ok(!('approvable' in doc), 'no approvable field is ever persisted')
  const first = await gql(app, DANA, GET, { id })
  assert.equal(first.body.data.featureRequest.approvable, true)

  // Flip one stored gate behind the app's back; approvable must follow.
  await featureRequests().updateOne(
    { _id: new ObjectId(id) },
    { $set: { 'entranceCriteria.notAmbiguous.pass': false } },
  )
  const flipped = await gql(app, DANA, GET, { id })
  assert.equal(flipped.body.data.featureRequest.approvable, false, 'derived from the stored gates, live')

  // And back.
  await featureRequests().updateOne(
    { _id: new ObjectId(id) },
    { $set: { 'entranceCriteria.notAmbiguous.pass': true } },
  )
  const restored = await gql(app, DANA, GET, { id })
  assert.equal(restored.body.data.featureRequest.approvable, true)
})

// --- criterion 4: virgin session — synthesized, never stored ---

test('criterion 4: a new session with no exchanges exposes three failed "not yet evaluated" gates and approvable: false, with nothing stored in Mongo', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app)

  const res = await gql(app, DANA, GET, { id })
  assert.equal(res.body.errors, undefined)
  const fr = res.body.data.featureRequest
  for (const gate of GATES) {
    assert.equal(fr.entranceCriteria[gate].pass, false, `${gate} fails before any evaluation`)
    assert.match(fr.entranceCriteria[gate].reason, /not yet evaluated/i)
  }
  assert.equal(fr.approvable, false)
  assert.equal(fetch.calls.length, 0, 'reading a virgin session makes no gateway call')

  // Presentation-layer synthesis, as designed: the raw document stores neither
  // entranceCriteria nor approvable.
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.ok(!('entranceCriteria' in doc), 'no entranceCriteria stored for a virgin session')
  assert.ok(!('approvable' in doc), 'no approvable stored for a virgin session')
})

// --- criterion 5: evaluator failures never break the exchange ---

const UNAVAILABLE = uniformFailure('evaluation unavailable')

for (const [label, opts] of [
  ['unparseable model output (prose, not JSON)', { evalContent: 'Looks fine to me, ship it.' }],
  ['an evaluator HTTP 429', { failRole: 'entrance-criteria', failStatus: 429 }],
  ['an evaluator HTTP 500', { failRole: 'entrance-criteria', failStatus: 500 }],
]) {
  test(`criterion 5: ${label} → exchange still succeeds (200, no errors), all gates fail with "evaluation unavailable"`, async () => {
    const app = makeApp(scriptedFetch(opts))
    const id = await startSession(app)

    const res = await gql(app, DANA, SEND, { id, content: 'export my table as CSV' })
    assert.equal(res.status, 200)
    assert.equal(res.body.errors, undefined, 'never a thrown error from the evaluation')

    const fr = res.body.data.sendFeatureRequestMessage
    assert.deepEqual(
      fr.messages.map((m) => m.role),
      ['user', 'product-owner', 'architect'],
      'the chat exchange itself succeeded',
    )
    assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
    assert.equal(fr.approvable, false)

    // The uniform failure verdict is persisted — the next read agrees.
    const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
    assert.deepEqual(doc.entranceCriteria, UNAVAILABLE)
  })
}

test('criterion 5 regression (DAN-49): a 429 on a conversational turn still fails the exchange with QUOTA_EXHAUSTED — only the evaluator is exempt', async () => {
  const fetch = scriptedFetch({ failRole: 'architect', failStatus: 429 })
  const app = makeApp(fetch)
  const id = await startSession(app)

  const res = await gql(app, DANA, SEND, { id, content: 'export my table as CSV' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'QUOTA_EXHAUSTED')

  // The round stopped at the architect: no planner call, no evaluator call,
  // and no evaluation stored.
  assert.deepEqual(
    fetch.calls.map((c) => c.body.metadata.role),
    ['product-owner', 'architect'],
  )
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.ok(!('entranceCriteria' in doc), 'a failed round stores no evaluation')
})

// --- criterion 6/usage: the evaluator call rides the same ledger ---

test('the four calls of one exchange land on the usage ledger: +4 requests, tokens are the sum of the four distinct fixture counts', async () => {
  const app = makeApp(scriptedFetch())
  const id = await startSession(app)

  const beforeUsage = (await gql(app, DANA, USAGE)).body.data.myAiUsage
  await gql(app, DANA, SEND, { id, content: 'export my table as CSV' })
  const afterUsage = (await gql(app, DANA, USAGE)).body.data.myAiUsage

  assert.equal(afterUsage.requests - beforeUsage.requests, 4)
  assert.equal(
    afterUsage.totalTokens - beforeUsage.totalTokens,
    TOKENS_BY_ROLE['product-owner'] +
      TOKENS_BY_ROLE.architect +
      TOKENS_BY_ROLE.planner +
      TOKENS_BY_ROLE['entrance-criteria'],
  )
})
