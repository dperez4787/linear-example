// DAN-68: an empty assistant turn must never be persisted, and a legacy
// empty-content message already in a session must not wedge it. Tested over
// HTTP via supertest against the in-process app, with a REAL createAiGateway
// over a scripted fetch — same pattern as sendFeatureRequestMessage.test.js
// (DAN-49). Run with: npm test
//
// Two failure families are covered, because they reach the code differently:
//   - the gateway THROWS (non-2xx / network): chat() throws before append, so
//     no message can persist for that turn — asserted at all three positions;
//   - the gateway returns 2xx with EMPTY/ABSENT content: this was the bug —
//     `?? ''` used to persist an empty message; now it is a GatewayError
//     (→ INTERNAL) and nothing persists for the turn.
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
// The gateway client reads these lazily inside chat(); the scripted fetch never
// dials them, but they must be set for chat() to proceed.
process.env.AI_GATEWAY_URL = 'https://gateway.test'
process.env.AI_GATEWAY_KEY = 'stub-gateway-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')

// --- canned turns (mirroring the DAN-49 suite) ---

const PO_REPLY = 'Refined: a CSV export of the visible rows.'
const ARCHITECT_REPLY = 'Fits the existing GraphQL surface; one new query.'

const PLAN_FIXTURE = {
  tickets: [
    { key: 'T1', title: 'Backend: exportRecords query', description: 'CSV of all records.', dependsOn: [] },
  ],
}

const EVALUATION_FIXTURE = {
  notTooBig: { pass: true, reason: 'One export.' },
  notAmbiguous: { pass: true, reason: 'Concrete.' },
  noBlockedDependencies: { pass: true, reason: 'Nothing blocking.' },
}

function completion(content) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
  }
}

// A scripted fetch: replies per metadata.role, records every request. Per role
// it can be told to fail the HTTP call (`failRole`/`failStatus`) or to return
// a 2xx whose body is `emptyBody` (`emptyRole`) — the DAN-68 shapes.
function scriptedFetch({ failRole, failStatus = 500, emptyRole, emptyBody } = {}) {
  const calls = []
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    const role = body.metadata.role
    if (role === failRole) {
      return { ok: false, status: failStatus, json: async () => ({ error: { message: 'nope' } }) }
    }
    if (role === emptyRole) {
      return { ok: true, status: 200, json: async () => emptyBody }
    }
    const reply =
      role === 'product-owner'
        ? PO_REPLY
        : role === 'architect'
          ? ARCHITECT_REPLY
          : role === 'entrance-criteria'
            ? JSON.stringify(EVALUATION_FIXTURE)
            : JSON.stringify(PLAN_FIXTURE)
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
  fn.calls = calls
  return fn
}

// --- app with stub verifier + injected gateway ---

const TOKENS = { 'stub-token-alice': { uid: 'uid-alice' } }
const ALICE = 'stub-token-alice'

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

async function startSession(app, token, model = 'claude-opus-5') {
  const res = await gql(app, token, START, { input: { model } })
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest.id
}

function featureRequests() {
  return getDb().collection('feature_requests')
}

async function readMessages(app, id) {
  const res = await gql(app, ALICE, GET, { id })
  return res.body.data.featureRequest.messages.map((m) => [m.role, m.content])
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

// --- criterion 1: a THROWN turn persists no message, at every position ---

// Expected transcript after the failure, per failing position: everything
// before the failed call, nothing for (or after) it.
const THROW_CASES = [
  ['product-owner', [['user', 'CSV export please']]],
  ['architect', [['user', 'CSV export please'], ['product-owner', PO_REPLY]]],
  [
    'planner',
    [
      ['user', 'CSV export please'],
      ['product-owner', PO_REPLY],
      ['architect', ARCHITECT_REPLY],
    ],
  ],
]

for (const [failRole, expected] of THROW_CASES) {
  test(`a gateway 500 on the ${failRole} call → INTERNAL; no message persists for that turn`, async () => {
    const app = makeApp(scriptedFetch({ failRole, failStatus: 500 }))
    const id = await startSession(app, ALICE)

    const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
    assert.equal(res.status, 200, 'a gateway failure is a domain error, not an HTTP failure')
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')

    assert.deepEqual(await readMessages(app, id), expected)
    const doc = await featureRequests().findOne({})
    assert.ok(
      doc.messages.every((m) => m.content.trim() !== ''),
      'no empty message anywhere in the persisted transcript',
    )
    if (failRole === 'planner') {
      const reread = await gql(app, ALICE, GET, { id })
      assert.equal(reread.body.data.featureRequest.plan, null, 'no plan from a failed planner call')
    }
  })
}

// A 429 keeps its QUOTA_EXHAUSTED semantics — the DAN-68 guard sits after
// chat(), which throws QuotaExhaustedError first.
test('a 429 on the architect call still surfaces QUOTA_EXHAUSTED, no message for that turn', async () => {
  const app = makeApp(scriptedFetch({ failRole: 'architect', failStatus: 429 }))
  const id = await startSession(app, ALICE)

  const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
  assert.equal(res.body.errors[0].extensions.code, 'QUOTA_EXHAUSTED')
  assert.deepEqual(await readMessages(app, id), [
    ['user', 'CSV export please'],
    ['product-owner', PO_REPLY],
  ])
})

// --- criterion 2: a 2xx with EMPTY/ABSENT content persists nothing (the bug) ---

// Every shape that used to coalesce to '' and persist: empty string content,
// content missing from the message, message missing, choices empty or absent.
const EMPTY_BODIES = [
  ['empty string content', completion('')],
  ['whitespace-only content', completion('   \n')],
  ['message without a content field', { choices: [{ index: 0, message: { role: 'assistant' } }] }],
  ['choice without a message', { choices: [{ index: 0 }] }],
  ['empty choices array', { choices: [] }],
  ['body without choices', { id: 'cmpl-1', object: 'chat.completion' }],
]

for (const [label, emptyBody] of EMPTY_BODIES) {
  test(`a 2xx architect reply with ${label} → INTERNAL; nothing persists for the turn, transcript intact at the PO turn`, async () => {
    const app = makeApp(scriptedFetch({ emptyRole: 'architect', emptyBody }))
    const id = await startSession(app, ALICE)

    const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors[0].extensions.code, 'INTERNAL', 'an empty completion is a failed exchange')

    assert.deepEqual(
      await readMessages(app, id),
      [
        ['user', 'CSV export please'],
        ['product-owner', PO_REPLY],
      ],
      'transcript intact at the last good message — no empty architect turn',
    )
  })
}

test('a 2xx product-owner reply with empty content → INTERNAL; only the user message persists', async () => {
  const app = makeApp(scriptedFetch({ emptyRole: 'product-owner', emptyBody: completion('') }))
  const id = await startSession(app, ALICE)

  const res = await gql(app, ALICE, SEND, { id, content: 'CSV export please' })
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.deepEqual(await readMessages(app, id), [['user', 'CSV export please']])
})

// --- criterion 3: a legacy empty-content message no longer wedges the session ---

test('a session seeded with a legacy empty architect message can still send: outbound history skips it and the round completes', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app, ALICE)

  // Seed the pre-DAN-68 corruption directly: a persisted empty assistant turn.
  const { ObjectId } = await import('mongodb')
  await featureRequests().updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        messages: [
          { role: 'user', content: 'I want CSV export', createdAt: new Date() },
          { role: 'product-owner', content: 'Refined: CSV export.', createdAt: new Date() },
          { role: 'architect', content: '', createdAt: new Date() },
        ],
      },
    },
  )

  const res = await gql(app, ALICE, SEND, { id, content: 'Any update?' })
  assert.equal(res.body.errors, undefined, 'the wedged session sends again')

  // Every outbound gateway call excludes the empty message entirely.
  assert.equal(fetch.calls.length, 4, 'PO, architect, planner, evaluator all ran')
  for (const call of fetch.calls) {
    for (const message of call.body.messages) {
      assert.notEqual(message.content.trim(), '', `no empty message sent to the gateway (${call.body.metadata.role})`)
    }
  }
  // The analyst calls flatten the transcript into one user message; the empty
  // architect line must not appear there either.
  const plannerCall = fetch.calls.find((c) => c.body.metadata.role === 'planner')
  assert.ok(!/architect:\s*$/m.test(plannerCall.body.messages[1].content), 'no dangling empty architect line')

  // The round completed on top of the corrupted history: the stored legacy
  // message is untouched (self-healing is outbound-only, not a data migration),
  // and the new turns landed after it.
  assert.deepEqual(await readMessages(app, id), [
    ['user', 'I want CSV export'],
    ['product-owner', 'Refined: CSV export.'],
    ['architect', ''],
    ['user', 'Any update?'],
    ['product-owner', PO_REPLY],
    ['architect', ARCHITECT_REPLY],
  ])
})
