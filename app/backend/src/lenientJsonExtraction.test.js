// Lenient JSON extraction for the internal roles + explicit max_tokens per
// turn (DAN-69). The live dry-run proved two production failures: claude-haiku
// wraps its (valid) evaluator JSON in markdown fences, which the strict
// JSON.parse rejected — gates stuck at "evaluation unavailable", Approve never
// unlocked — and no call sent max_tokens, so the gateway's anthropic default
// (1024) truncated architect replies mid-sentence. Run with: npm test
//
// Same seams as the DAN-49/50 suites: stub token verifier, and a REAL
// createAiGateway over a scripted fetch, so the captured requests are exactly
// what production would send. No test performs a real network call; Mongo
// (linear_example_test) is the only external dependency.
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
// Read lazily inside aiGateway.chat(); the scripted fetch never dials them.
process.env.AI_GATEWAY_URL = 'https://gateway.test'
process.env.AI_GATEWAY_KEY = 'stub-gateway-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')
const { MAX_TOKENS_BY_ROLE } = await import('./featureRequests.js')
const { ObjectId } = await import('mongodb')

// --- fixtures ---

const PO_REPLY = 'Refined: one CSV export of the visible rows.'
const ARCHITECT_REPLY = 'One new query, no migration.'

const ALL_PASS = {
  notTooBig: { pass: true, reason: 'One export query and one button.' },
  notAmbiguous: { pass: true, reason: 'The scope question was answered.' },
  noBlockedDependencies: { pass: true, reason: 'No prerequisite is unresolved.' },
}

const PLAN_FIXTURE = {
  tickets: [
    { key: 'T1', title: 'Add export query', description: 'GET /api/records/export', dependsOn: [] },
    { key: 'T2', title: 'Add export button', description: 'Button calls the query', dependsOn: ['T1'] },
  ],
}

// The production failure verbatim: valid JSON wrapped in a markdown fence.
const fenced = (json) => '```json\n' + json + '\n```'
// A one-line prose preamble before bare JSON — the other observed lenient shape.
const preambled = (json) => 'Here is my verdict as requested:\n' + json

function completion(content, totalTokens = 5) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: totalTokens },
  }
}

// A scripted fetch answering per metadata.role, with per-role reply overrides.
function scriptedFetch({
  // Converged by default: DAN-75 made approvable require a stored plan, and
  // the lenient-evaluator tests assert "parsing unlocks Approve" with the
  // plan requirement satisfied.
  planContent = JSON.stringify(PLAN_FIXTURE),
  evalContent = JSON.stringify(ALL_PASS),
} = {}) {
  const calls = []
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    const role = body.metadata.role
    const reply =
      role === 'product-owner'
        ? PO_REPLY
        : role === 'architect'
          ? ARCHITECT_REPLY
          : role === 'entrance-criteria'
            ? evalContent
            : planContent
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
  fn.calls = calls
  return fn
}

// --- app plumbing (stub verifier, injected gateway) ---

const TOKENS = { 'stub-token-alice': { uid: 'uid-alice' } }
const ALICE = 'stub-token-alice'

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
  plan { tickets { key title description dependsOn } }
  entranceCriteria {
    notTooBig { pass reason }
    notAmbiguous { pass reason }
    noBlockedDependencies { pass reason }
  }
  approvable`
const SEND = `mutation ($id: ID!, $content: String!) {
  sendFeatureRequestMessage(id: $id, content: $content) { ${FR_FIELDS} }
}`

async function startSession(app, token = ALICE) {
  const res = await gql(
    app,
    token,
    'mutation ($input: StartFeatureRequestInput!) { startFeatureRequest(input: $input) { id } }',
    { input: { model: 'claude-opus-5' } },
  )
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest.id
}

const featureRequests = () => getDb().collection('feature_requests')

const UNAVAILABLE = Object.fromEntries(
  ['notTooBig', 'notAmbiguous', 'noBlockedDependencies'].map((gate) => [
    gate,
    { pass: false, reason: 'evaluation unavailable' },
  ]),
)

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

// --- criterion 1: lenient evaluator parsing ---

for (const [label, evalContent] of [
  ['a ```json fence (the live haiku failure)', fenced(JSON.stringify(ALL_PASS))],
  ['a bare ``` fence', '```\n' + JSON.stringify(ALL_PASS) + '\n```'],
  ['a one-line preamble before bare JSON', preambled(JSON.stringify(ALL_PASS))],
  ['a preamble before a fenced block', 'Sure, evaluating now.\n' + fenced(JSON.stringify(ALL_PASS))],
]) {
  test(`an evaluator reply with ${label} parses and the three gates persist`, async () => {
    const app = makeApp(scriptedFetch({ evalContent }))
    const id = await startSession(app)
    const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

    assert.equal(res.body.errors, undefined)
    const fr = res.body.data.sendFeatureRequestMessage
    assert.deepEqual(fr.entranceCriteria, ALL_PASS)
    assert.equal(fr.approvable, true, 'lenient parsing is what unlocks Approve')

    const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
    assert.deepEqual(doc.entranceCriteria, ALL_PASS, 'persisted, not just echoed')
  })
}

test('a genuinely malformed evaluator reply still yields "evaluation unavailable" and the exchange succeeds', async () => {
  for (const evalContent of [
    'All three gates look fine to me.',
    fenced('{"notTooBig": {"pass": true, "reason": "cut'),
    'preamble then {"notTooBig": broken',
  ]) {
    const app = makeApp(scriptedFetch({ evalContent }))
    const id = await startSession(app)
    const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

    assert.equal(res.status, 200)
    assert.equal(res.body.errors, undefined, 'never a thrown error for a bad evaluation')
    const fr = res.body.data.sendFeatureRequestMessage
    assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
    assert.equal(fr.approvable, false)
    assert.equal(fr.messages.length, 3, 'the chat exchange itself succeeded')
  }
})

// --- criterion 2: the same lenient shapes work for the planner (shared helper) ---

for (const [label, planContent] of [
  ['a ```json fence', fenced(JSON.stringify(PLAN_FIXTURE))],
  ['a one-line preamble before bare JSON', preambled(JSON.stringify(PLAN_FIXTURE))],
]) {
  test(`a planner reply with ${label} parses and the plan persists`, async () => {
    const app = makeApp(scriptedFetch({ planContent }))
    const id = await startSession(app)
    const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

    assert.equal(res.body.errors, undefined)
    assert.deepEqual(res.body.data.sendFeatureRequestMessage.plan, PLAN_FIXTURE)

    const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
    assert.deepEqual(doc.plan, PLAN_FIXTURE, 'persisted, not just echoed')
  })
}

test('a genuinely malformed planner reply still stores no plan and is not an error', async () => {
  const app = makeApp(scriptedFetch({ planContent: 'I think we need more discussion.' }))
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })
  assert.equal(res.body.errors, undefined, 'no-plan-yet is a normal outcome')
  assert.equal(res.body.data.sendFeatureRequestMessage.plan, null)
})

// --- criterion 3: explicit max_tokens per role on the captured transport ---

test('every gateway call carries the explicit per-role max_tokens: PO and architect 1500, planner 2500, evaluator 500', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })
  assert.equal(res.body.errors, undefined)

  assert.equal(fetch.calls.length, 4, 'PO, architect, planner, evaluator')
  const byRole = Object.fromEntries(fetch.calls.map((c) => [c.body.metadata.role, c.body]))

  assert.equal(byRole['product-owner'].max_tokens, 1500)
  assert.equal(byRole.architect.max_tokens, 1500)
  assert.equal(byRole.planner.max_tokens, 2500)
  assert.equal(byRole['entrance-criteria'].max_tokens, 500)

  // The numbers come from the single exported constant, not four hardcodes.
  for (const [role, body] of Object.entries(byRole)) {
    assert.equal(body.max_tokens, MAX_TOKENS_BY_ROLE[role])
  }
})
