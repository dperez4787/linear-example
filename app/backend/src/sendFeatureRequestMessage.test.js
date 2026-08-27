// sendFeatureRequestMessage (DAN-49): role orchestration + plan extraction,
// tested over HTTP via supertest against the in-process app. Run with: npm test
//
// The injected AI gateway is a REAL createAiGateway with a scripted fetch, so
// the captured requests are exactly what production would send (system message,
// metadata, bearer key) and usage recording flows through the real DAN-48
// ledger — myAiUsage deltas are asserted, never a second recorder. No test
// performs a real network call; Mongo (linear_example_test) is the only
// external dependency, same as the sibling suites.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
// The gateway client reads these lazily inside chat(); the scripted fetch never
// dials them, but they must be set for chat() to proceed.
process.env.AI_GATEWAY_URL = 'https://gateway.test'
process.env.AI_GATEWAY_KEY = 'stub-gateway-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')

// --- canned turns + structured plan (criterion 7) ---

const PO_REPLY = 'Refined: a CSV export of the visible rows. Scope question: filtered set or all records?'
const ARCHITECT_REPLY = 'Fits the existing GraphQL surface; needs one new query, no schema migration.'

const PLAN_FIXTURE = {
  tickets: [
    { key: 'T1', title: 'Backend: exportRecords query', description: 'CSV of all records.', dependsOn: [] },
    { key: 'T2', title: 'Frontend: export button', description: 'Download via api.js.', dependsOn: ['T1'] },
  ],
}

// DAN-50: the entrance-criteria evaluator runs as a fourth call after the
// planner; this fixture keeps it green so the DAN-49 assertions stay focused.
const EVALUATION_FIXTURE = {
  notTooBig: { pass: true, reason: 'One export, one button.' },
  notAmbiguous: { pass: true, reason: 'Scope question answered.' },
  noBlockedDependencies: { pass: true, reason: 'Nothing blocking.' },
}

function completion(content, totalTokens) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: totalTokens },
  }
}

// Fixture token counts are distinct primes so the usage delta proves all four
// calls were recorded, not four of one kind.
const TOKENS_BY_ROLE = { 'product-owner': 11, architect: 13, planner: 17, 'entrance-criteria': 19 }

// A scripted fetch: replies per metadata.role, records every request, and can
// be told to fail a given role's call. `planContent` is what the planner says;
// `evalContent` is what the entrance-criteria evaluator (DAN-50) says.
function scriptedFetch({
  planContent = JSON.stringify(PLAN_FIXTURE),
  evalContent = JSON.stringify(EVALUATION_FIXTURE),
  failRole,
  failStatus = 429,
} = {}) {
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
            : planContent
    return { ok: true, status: 200, json: async () => completion(reply, TOKENS_BY_ROLE[role]) }
  }
  fn.calls = calls
  return fn
}

// --- app with stub verifier + injected gateway ---

const TOKENS = {
  'stub-token-alice': { uid: 'uid-alice' },
  'stub-token-bob': { uid: 'uid-bob' },
}
const ALICE = 'stub-token-alice'
const BOB = 'stub-token-bob'

const stubVerify = async (token) => {
  const decoded = TOKENS[token]
  if (!decoded) throw new Error('invalid token')
  return decoded
}

function makeApp(fetchImpl) {
  return createApp({
    verifyToken: stubVerify,
    aiGateway: createAiGateway({ fetch: fetchImpl }),
  })
}

function gql(app, token, query, variables) {
  return request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })
}

const FR_FIELDS = `id status model createdAt
  messages { role content createdAt }
  plan { tickets { key title description dependsOn } }`

const START = `mutation ($input: StartFeatureRequestInput!) {
  startFeatureRequest(input: $input) { id }
}`
const SEND = `mutation ($id: ID!, $content: String!) {
  sendFeatureRequestMessage(id: $id, content: $content) { ${FR_FIELDS} }
}`
const GET = `query ($id: ID!) { featureRequest(id: $id) { ${FR_FIELDS} } }`
const USAGE = '{ myAiUsage { requests totalTokens } }'

async function startSession(app, token, model = 'claude-opus-5') {
  const res = await gql(app, token, START, { input: { model } })
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest.id
}

function featureRequests() {
  return getDb().collection('feature_requests')
}

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

// --- criterion 2: one PO turn, one architect turn, all three persisted ---

test('sendFeatureRequestMessage appends user, product-owner, and architect turns in order and returns them', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app, ALICE)

  const res = await gql(app, ALICE, SEND, { id, content: 'I want to export the table as CSV' })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)

  const fr = res.body.data.sendFeatureRequestMessage
  assert.equal(fr.id, id, 'the updated FeatureRequest comes back — the DAN-53 contract')
  assert.deepEqual(
    fr.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'I want to export the table as CSV'],
      ['product-owner', PO_REPLY],
      ['architect', ARCHITECT_REPLY],
    ],
    'transcript order: user, then PO, then architect',
  )
  for (const m of fr.messages) {
    assert.equal(new Date(m.createdAt).toISOString(), m.createdAt, `${m.role} message has an ISO createdAt`)
  }

  // Persisted, not just returned: a fresh read shows the same transcript, and
  // the raw documents carry role + Date timestamp.
  const reread = await gql(app, ALICE, GET, { id })
  assert.deepEqual(reread.body.data.featureRequest.messages, fr.messages)
  const { ObjectId } = await import('mongodb')
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.messages.length, 3)
  for (const m of doc.messages) {
    assert.ok(m.createdAt instanceof Date, 'persisted timestamps are Dates')
  }
})

// --- criterion 1: role prompts from checked-in files; gateway attribution ---

test('the PO and architect calls carry each roles/<role>.md file as system message, with metadata.role and prompt_id = session id', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app, ALICE)
  await gql(app, ALICE, SEND, { id, content: 'CSV export please' })

  assert.equal(fetch.calls.length, 4, 'PO turn, architect turn, planner call, evaluator call (DAN-50)')
  assert.deepEqual(
    fetch.calls.map((c) => c.body.metadata.role),
    ['product-owner', 'architect', 'planner', 'entrance-criteria'],
  )

  for (const role of ['product-owner', 'architect']) {
    const call = fetch.calls.find((c) => c.body.metadata.role === role)
    const file = await readFile(new URL(`../roles/${role}.md`, import.meta.url), 'utf8')
    assert.equal(call.body.messages[0].role, 'system')
    assert.equal(call.body.messages[0].content, file, `${role} system message is exactly the checked-in file`)
    assert.deepEqual(call.body.metadata, {
      on_behalf_of: 'uid-alice',
      feature: 'prompt-a-feature',
      prompt_id: id,
      role,
    })
    assert.equal(call.body.model, 'claude-opus-5', 'the session model is the request model')
  }

  // The architect's request already contains the PO's fresh turn.
  const architectCall = fetch.calls.find((c) => c.body.metadata.role === 'architect')
  const contents = architectCall.body.messages.map((m) => m.content)
  assert.ok(
    contents.some((c) => c.includes(PO_REPLY)),
    'the architect sees the product-owner turn from this round',
  )

  // The planner call requests strict JSON.
  const plannerCall = fetch.calls.find((c) => c.body.metadata.role === 'planner')
  assert.deepEqual(plannerCall.body.response_format, { type: 'json_object' })
  assert.equal(plannerCall.body.metadata.prompt_id, id)
})

// --- DAN-65: every roster model threads through to the conversational calls ---

// A session started with each roster model sends THAT model on its
// conversational gateway calls (PO, architect, planner — all doc.model), while
// the entrance-criteria evaluator keeps its own cheap-model constant
// regardless of the session's choice.
for (const model of ['claude-opus-5', 'gpt-5.6-terra', 'gemini-3.6-flash', 'gpt-oss-120b']) {
  test(`a ${model} session sends ${model} on conversational calls; the evaluator keeps its cheap model`, async () => {
    const { ENTRANCE_CRITERIA_MODEL } = await import('./featureRequests.js')
    const fetch = scriptedFetch()
    const app = makeApp(fetch)
    const id = await startSession(app, ALICE, model)

    const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
    assert.equal(res.body.errors, undefined)

    assert.equal(fetch.calls.length, 4, 'PO, architect, planner, evaluator')
    for (const role of ['product-owner', 'architect', 'planner']) {
      const call = fetch.calls.find((c) => c.body.metadata.role === role)
      assert.equal(call.body.model, model, `the ${role} call carries the session model`)
    }
    const evaluatorCall = fetch.calls.find((c) => c.body.metadata.role === 'entrance-criteria')
    assert.equal(
      evaluatorCall.body.model,
      ENTRANCE_CRITERIA_MODEL,
      'the evaluator uses its own cheap-model constant, not the session model',
    )
  })
}

// --- criterion 3: a structured-JSON plan persists and is exposed ---

test('when the planner fixture returns a plan, FeatureRequest.plan.tickets persists on the session', async () => {
  const app = makeApp(scriptedFetch())
  const id = await startSession(app, ALICE)

  const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
  assert.deepEqual(res.body.data.sendFeatureRequestMessage.plan, PLAN_FIXTURE)

  const reread = await gql(app, ALICE, GET, { id })
  assert.deepEqual(reread.body.data.featureRequest.plan, PLAN_FIXTURE, 'the plan is persisted, not ephemeral')
})

for (const [label, planContent] of [
  ['an empty tickets array (not converged)', JSON.stringify({ tickets: [] })],
  ['non-JSON prose', 'I think we need more discussion before planning.'],
]) {
  test(`a planner reply with ${label} stores no plan and is not an error`, async () => {
    const app = makeApp(scriptedFetch({ planContent }))
    const id = await startSession(app, ALICE)
    const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
    assert.equal(res.body.errors, undefined, 'no-plan-yet is a normal outcome')
    assert.equal(res.body.data.sendFeatureRequestMessage.plan, null)
    assert.equal(res.body.data.sendFeatureRequestMessage.messages.length, 3, 'the turns still landed')
  })
}

// --- criterion 4: ownership and lifecycle ---

test('posting to another user session → NOT_FOUND, no gateway call, nothing appended', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app, ALICE)

  const res = await gql(app, BOB, SEND, { id, content: 'let me in' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(fetch.calls.length, 0, 'the gateway is never called for a session the caller does not own')

  const reread = await gql(app, ALICE, GET, { id })
  assert.deepEqual(reread.body.data.featureRequest.messages, [], 'nothing was appended')
})

for (const [label, id] of [
  ['an unknown', '0123456789abcdef01234567'],
  ['a malformed', 'not-an-object-id'],
]) {
  test(`posting to ${label} promptId → NOT_FOUND, indistinguishable from another user's`, async () => {
    const fetch = scriptedFetch()
    const app = makeApp(fetch)
    const res = await gql(app, ALICE, SEND, { id, content: 'hello' })
    assert.equal(res.status, 200)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
    assert.equal(fetch.calls.length, 0)
  })
}

test('posting to an approved session → BAD_USER_INPUT, no gateway call, nothing appended', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app, ALICE)
  const { ObjectId } = await import('mongodb')
  await featureRequests().updateOne({ _id: new ObjectId(id) }, { $set: { status: 'approved' } })

  const res = await gql(app, ALICE, SEND, { id, content: 'one more thing' })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(fetch.calls.length, 0)

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.messages, [], 'an approved session is immutable')
})

test('empty content → BAD_USER_INPUT on field content, nothing written, no gateway call', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app, ALICE)
  const res = await gql(app, ALICE, SEND, { id, content: '   ' })
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(res.body.errors[0].extensions.field, 'content')
  assert.equal(fetch.calls.length, 0)
})

// --- criterion 5: 429 mid-conversation ---

test('a 429 on the architect turn → QUOTA_EXHAUSTED; the user message and the PO turn remain persisted', async () => {
  const fetch = scriptedFetch({ failRole: 'architect' })
  const app = makeApp(fetch)
  const id = await startSession(app, ALICE)

  const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
  assert.equal(res.status, 200, 'quota exhaustion is a domain error, not an HTTP failure')
  assert.equal(res.body.data, null, 'the mutation return type is non-null, so data nulls overall')
  assert.equal(res.body.errors[0].extensions.code, 'QUOTA_EXHAUSTED')
  assert.match(res.body.errors[0].message, /quota/i)

  // Re-read: the transcript is consistent — everything completed before the
  // failure is there, nothing after it.
  const reread = await gql(app, ALICE, GET, { id })
  assert.deepEqual(
    reread.body.data.featureRequest.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'CSV export please'],
      ['product-owner', PO_REPLY],
    ],
  )
  assert.equal(reread.body.data.featureRequest.plan, null, 'no plan without a planner call')
})

test('a 429 on the FIRST (product-owner) turn still leaves the user message persisted', async () => {
  const fetch = scriptedFetch({ failRole: 'product-owner' })
  const app = makeApp(fetch)
  const id = await startSession(app, ALICE)

  const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
  assert.equal(res.body.errors[0].extensions.code, 'QUOTA_EXHAUSTED')

  const reread = await gql(app, ALICE, GET, { id })
  assert.deepEqual(
    reread.body.data.featureRequest.messages.map((m) => [m.role, m.content]),
    [['user', 'CSV export please']],
  )
})

// --- criterion 6: usage recorded per turn, asserted via myAiUsage delta ---

test('one round records four gateway calls in the ledger: myAiUsage requests +4, totalTokens += the four fixture usages', async () => {
  const app = makeApp(scriptedFetch())
  const id = await startSession(app, ALICE)

  const beforeUsage = (await gql(app, ALICE, USAGE)).body.data.myAiUsage
  await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
  const afterUsage = (await gql(app, ALICE, USAGE)).body.data.myAiUsage

  assert.equal(afterUsage.requests - beforeUsage.requests, 4, 'PO + architect + planner + evaluator (DAN-50)')
  assert.equal(
    afterUsage.totalTokens - beforeUsage.totalTokens,
    TOKENS_BY_ROLE['product-owner'] +
      TOKENS_BY_ROLE.architect +
      TOKENS_BY_ROLE.planner +
      TOKENS_BY_ROLE['entrance-criteria'],
  )
})

test('a failed turn is not counted: a 429 on the architect leaves exactly one recorded request (the PO turn)', async () => {
  const app = makeApp(scriptedFetch({ failRole: 'architect' }))
  const id = await startSession(app, ALICE)

  await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
  const usage = (await gql(app, ALICE, USAGE)).body.data.myAiUsage
  assert.equal(usage.requests, 1, 'only the completed PO turn is on the ledger')
  assert.equal(usage.totalTokens, TOKENS_BY_ROLE['product-owner'])
})
