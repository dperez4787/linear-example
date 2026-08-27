// DAN-68 tester verification: an empty assistant turn is never persisted, and
// a legacy empty-content message no longer wedges the session.
//
// Independent of the developer's suite (sendFeatureRequestMessage.emptyTurn
// .test.js) in two deliberate ways:
//
//   1. The gateway stub here REJECTS blank outbound content with a 400, the
//      way the production gateway did. "The session is not wedged" is then a
//      real observation — a healed send survives a strict gateway — instead of
//      an assertion over a stub that would have accepted the bad history.
//   2. Empty-body injections are ONE-SHOT (a transient production hiccup), so
//      every failed round is followed by a retry send that must succeed:
//      the criterion is not just "nothing persisted" but "the session still
//      works afterwards".
//
// Over HTTP via supertest against the in-process app, real createAiGateway
// over the scripted fetch, test database only. Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { ObjectId } from 'mongodb'
import request from 'supertest'

if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // No .env — MONGODB_URI must then come from the ambient environment.
  }
}
process.env.MONGODB_DB = 'linear_example_test'
// Read lazily inside chat(); the scripted fetch never dials them.
process.env.AI_GATEWAY_URL = 'https://gateway.test'
process.env.AI_GATEWAY_KEY = 'stub-gateway-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')

const PO_REPLY = 'Refined: export the visible rows as CSV.'
const ARCHITECT_REPLY = 'One new GraphQL query; fits the existing surface.'

const EVALUATION = {
  notTooBig: { pass: true, reason: 'One export feature.' },
  notAmbiguous: { pass: true, reason: 'Concrete scope.' },
  noBlockedDependencies: { pass: true, reason: 'Nothing blocking.' },
}

function completion(content) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

// Scripted gateway transport.
//
//   - Like the production gateway, it 400s any request whose non-system
//     history carries blank content — the rejection that wedged sessions.
//   - `failRole`/`failStatus`: every call for that role fails at HTTP level.
//   - `emptyRoleOnce`/`emptyBody`: the FIRST call for that role returns a 2xx
//     with the given body; later calls succeed normally (one-shot hiccup).
//   - Records every request body in `calls`.
function gatewayStub({ failRole, failStatus = 500, emptyRoleOnce, emptyBody } = {}) {
  const calls = []
  let emptyArmed = Boolean(emptyRoleOnce)
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const blank = body.messages.some(
      (m) => m.role !== 'system' && (typeof m.content !== 'string' || m.content.trim() === ''),
    )
    if (blank) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'empty content' } }) }
    }
    const role = body.metadata.role
    if (role === failRole) {
      return { ok: false, status: failStatus, json: async () => ({ error: { message: 'nope' } }) }
    }
    if (role === emptyRoleOnce && emptyArmed) {
      emptyArmed = false
      return { ok: true, status: 200, json: async () => emptyBody }
    }
    const reply =
      role === 'product-owner'
        ? PO_REPLY
        : role === 'architect'
          ? ARCHITECT_REPLY
          : role === 'entrance-criteria'
            ? JSON.stringify(EVALUATION)
            : JSON.stringify({ tickets: [] })
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
  fn.calls = calls
  return fn
}

const ALICE = 'stub-token-alice'
const stubVerify = async (token) => {
  if (token !== ALICE) throw new Error('invalid token')
  return { uid: 'uid-alice' }
}

function makeApp(fetchImpl) {
  return createApp({
    verifyToken: stubVerify,
    aiGateway: createAiGateway({ fetch: fetchImpl }),
  })
}

function gql(app, query, variables) {
  return request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${ALICE}`)
    .send({ query, variables })
}

const START = `mutation ($input: StartFeatureRequestInput!) {
  startFeatureRequest(input: $input) { id }
}`
const SEND = `mutation ($id: ID!, $content: String!) {
  sendFeatureRequestMessage(id: $id, content: $content) {
    id messages { role content }
  }
}`

async function startSession(app) {
  const res = await gql(app, START, { input: { model: 'claude-opus-5' } })
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest.id
}

function featureRequests() {
  return getDb().collection('feature_requests')
}

// The persisted transcript, read straight from Mongo — persistence claims are
// verified at the database, not through the API's view of it.
async function storedMessages(id) {
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  return doc.messages.map((m) => [m.role, m.content])
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

// --- Criterion 1: a THROWN gateway turn persists no message, per position ---

const THROW_POSITIONS = [
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

for (const [failRole, expected] of THROW_POSITIONS) {
  test(`AC1: gateway 500 on the ${failRole} call → INTERNAL, nothing persisted for that turn`, async () => {
    const app = makeApp(gatewayStub({ failRole }))
    const id = await startSession(app)

    const res = await gql(app, SEND, { id, content: 'CSV export please' })
    assert.equal(res.status, 200)
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')

    assert.deepEqual(await storedMessages(id), expected)
  })
}

// --- Criterion 2 + empty-shape matrix, all at the ARCHITECT position ---
//
// Every 2xx body shape that pre-DAN-68 coalesced to '' and persisted. The
// whitespace-only shape documents the fix's blankness rule: content is judged
// by trim(), so '   \t\n' is as empty as ''.
const EMPTY_SHAPES = [
  ['content is the empty string', completion('')],
  ['content is whitespace-only', completion('   \t\n')],
  ['content is null', completion(null)],
  ['message object missing', { choices: [{ index: 0 }] }],
  ['choices is an empty array', { choices: [] }],
  ['choices missing entirely', { id: 'cmpl-x', object: 'chat.completion' }],
]

for (const [label, emptyBody] of EMPTY_SHAPES) {
  test(`AC2: 2xx architect reply where ${label} → INTERNAL, nothing persisted, next send succeeds`, async () => {
    const app = makeApp(gatewayStub({ emptyRoleOnce: 'architect', emptyBody }))
    const id = await startSession(app)

    const res = await gql(app, SEND, { id, content: 'CSV export please' })
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
    // Nothing leaks about the gateway in the client-facing message.
    assert.ok(!/gateway|completion|architect/i.test(res.body.errors[0].message))

    // Transcript intact at the last good message — no empty turn, per Mongo.
    assert.deepEqual(await storedMessages(id), [
      ['user', 'CSV export please'],
      ['product-owner', PO_REPLY],
    ])

    // The session is NOT wedged: the empty body was a one-shot hiccup, and the
    // stub 400s blank history — so this retry succeeding proves the failed
    // round left no poison behind.
    const retry = await gql(app, SEND, { id, content: 'Trying again' })
    assert.equal(retry.body.errors, undefined, `session wedged after: ${label}`)
    assert.deepEqual(await storedMessages(id), [
      ['user', 'CSV export please'],
      ['product-owner', PO_REPLY],
      ['user', 'Trying again'],
      ['product-owner', PO_REPLY],
      ['architect', ARCHITECT_REPLY],
    ])
  })
}

// --- Criterion 3: legacy empty message — outbound skip, round completes ---

test('AC3: session seeded with a legacy empty architect message sends again; outbound history excludes it', async () => {
  const stub = gatewayStub()
  const app = makeApp(stub)
  const id = await startSession(app)

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

  const res = await gql(app, SEND, { id, content: 'Any update?' })
  // The stub 400s blank outbound content, so this passing means the empty
  // message never left the building — the wedge is healed against a strict
  // gateway, not a permissive stub.
  assert.equal(res.body.errors, undefined)

  assert.equal(stub.calls.length, 4, 'PO, architect, planner, evaluator all ran')
  for (const call of stub.calls) {
    for (const m of call.messages) {
      assert.equal(typeof m.content, 'string')
      assert.notEqual(m.content.trim(), '')
    }
  }
  // The flattened analyst view carries no dangling "architect:" line either.
  const planner = stub.calls.find((c) => c.metadata.role === 'planner')
  assert.ok(!/^architect:\s*$/m.test(planner.messages[1].content))

  // Outbound-skip only, no migration: the legacy '' is still stored verbatim,
  // with the new round appended after it.
  assert.deepEqual(await storedMessages(id), [
    ['user', 'I want CSV export'],
    ['product-owner', 'Refined: CSV export.'],
    ['architect', ''],
    ['user', 'Any update?'],
    ['product-owner', PO_REPLY],
    ['architect', ARCHITECT_REPLY],
  ])
})

// --- DAN-49 regression: a 429 keeps QUOTA_EXHAUSTED + partial transcript ---

test('a 429 on the architect call still surfaces QUOTA_EXHAUSTED with the partial transcript persisted', async () => {
  const app = makeApp(gatewayStub({ failRole: 'architect', failStatus: 429 }))
  const id = await startSession(app)

  const res = await gql(app, SEND, { id, content: 'CSV export please' })
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'QUOTA_EXHAUSTED')
  assert.deepEqual(await storedMessages(id), [
    ['user', 'CSV export please'],
    ['product-owner', PO_REPLY],
  ])
})
