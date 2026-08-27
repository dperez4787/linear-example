// DAN-65 tester verification: startFeatureRequest accepts the full gateway
// roster. Independent of the developer's tests — own fixtures, own scripted
// fetch, own fake Linear client. Run with: npm test
//
// Criteria under test (from the Linear ticket):
//   1. Each of the four roster models is accepted and persisted; a non-roster
//      model still → BAD_USER_INPUT on field `model`, nothing written.
//   2. A session started with each model sends THAT model on its
//      conversational gateway calls (captured transport), while the
//      entrance-criteria evaluator keeps its own cheap-model constant.
//   3. HARNESS_BY_MODEL maps all four (non-claude → "claude" for now).
//   4. Full backend suite green (verified by the suite run, not this file).
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
// Read lazily by the gateway client; the scripted fetch never dials them.
process.env.AI_GATEWAY_URL = 'https://gateway.tester.invalid'
process.env.AI_GATEWAY_KEY = 'tester-stub-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')
const {
  FEATURE_REQUEST_MODELS,
  HARNESS_BY_MODEL,
  ENTRANCE_CRITERIA_MODEL,
} = await import('./featureRequests.js')
const { ObjectId } = await import('mongodb')

// The roster the ticket names, verbatim and in the ticket's order.
const ROSTER = ['claude-opus-5', 'gpt-5.6-terra', 'gemini-3.6-flash', 'gpt-oss-120b']

// --- scripted transport: replies per metadata.role, captures every request ---

function completion(content) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }
}

const EVAL_ALL_PASS = JSON.stringify({
  notTooBig: { pass: true, reason: 'small' },
  notAmbiguous: { pass: true, reason: 'clear' },
  noBlockedDependencies: { pass: true, reason: 'free' },
})

function capturingFetch() {
  const calls = []
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    const role = body.metadata?.role
    const reply =
      role === 'entrance-criteria'
        ? EVAL_ALL_PASS
        : role === 'planner'
          ? JSON.stringify({ tickets: [] })
          : `[tester fixture] ${role} turn`
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
  fn.calls = calls
  return fn
}

// --- fake Linear client for the approval smoke (records, returns fixtures) ---

function fakeLinearClient() {
  const calls = []
  let issueN = 0
  const client = {
    calls,
    config() {
      return { teamId: 'team-dan65', readyForDevStateId: 'state-dan65-ready' }
    },
    async findOrCreateLabels(names) {
      calls.push({ method: 'findOrCreateLabels', args: { names } })
      return Object.fromEntries(names.map((name) => [name, `label:${name}`]))
    },
    async createProject(args) {
      calls.push({ method: 'createProject', args })
      return { id: 'project-dan65', url: 'https://linear.app/fixture/project/dan65' }
    },
    async createIssue(args) {
      calls.push({ method: 'createIssue', args })
      issueN += 1
      return {
        id: `issue-${issueN}`,
        identifier: `DAN-90${issueN}`,
        url: `https://linear.app/fixture/issue/DAN-90${issueN}`,
      }
    },
    async createRelation(args) {
      calls.push({ method: 'createRelation', args })
      return { id: `rel-${calls.length}` }
    },
  }
  client.callsTo = (method) => calls.filter((c) => c.method === method)
  return client
}

// --- app plumbing ---

const TOKENS = { 'stub-token-alice': { uid: 'uid-alice' } }
const ALICE = 'stub-token-alice'
const stubVerify = async (token) => {
  const decoded = TOKENS[token]
  if (!decoded) throw new Error('invalid token')
  return decoded
}

const makeApp = ({ fetchImpl, linearClient } = {}) =>
  createApp({
    verifyToken: stubVerify,
    ...(fetchImpl ? { aiGateway: createAiGateway({ fetch: fetchImpl }) } : {}),
    ...(linearClient ? { linearClient } : {}),
  })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const START = `mutation ($input: StartFeatureRequestInput!) {
  startFeatureRequest(input: $input) { id status model }
}`
const SEND = `mutation ($id: ID!, $content: String!) {
  sendFeatureRequestMessage(id: $id, content: $content) { id status model }
}`
const APPROVE = `mutation ($id: ID!) {
  approveFeatureRequestPlan(id: $id) { id status }
}`

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

// --- criteria 1 + 2: per-model round trip against the captured transport ---

for (const model of ROSTER) {
  test(`DAN-65 round trip [${model}]: start persists the model; conversational calls carry it; the evaluator keeps ${ENTRANCE_CRITERIA_MODEL}`, async () => {
    const fetchImpl = capturingFetch()
    const app = makeApp({ fetchImpl })

    // Start: accepted, echoed back, persisted.
    const startRes = await gql(app, ALICE, START, { input: { model } })
    assert.equal(startRes.status, 200)
    assert.equal(startRes.body.errors, undefined, `${model} must be accepted`)
    const session = startRes.body.data.startFeatureRequest
    assert.equal(session.status, 'gathering')
    assert.equal(session.model, model, 'the mutation echoes the chosen model')

    const doc = await featureRequests().findOne({ _id: new ObjectId(session.id) })
    assert.ok(doc, 'a session document was written')
    assert.equal(doc.model, model, 'the chosen model is persisted verbatim')

    // One exchange: PO, architect, planner all carry the session's model on
    // the wire; the evaluator carries the cheap constant instead.
    const sendRes = await gql(app, ALICE, SEND, { id: session.id, content: 'Add CSV export' })
    assert.equal(sendRes.status, 200)
    assert.equal(sendRes.body.errors, undefined)

    const byRole = new Map(fetchImpl.calls.map((c) => [c.body.metadata.role, c]))
    assert.deepEqual(
      [...byRole.keys()].sort(),
      ['architect', 'entrance-criteria', 'planner', 'product-owner'],
      'exactly the four orchestration roles were called',
    )
    for (const role of ['product-owner', 'architect', 'planner']) {
      assert.equal(
        byRole.get(role).body.model,
        model,
        `the ${role} call sends the session model on the wire`,
      )
    }
    assert.equal(
      byRole.get('entrance-criteria').body.model,
      ENTRANCE_CRITERIA_MODEL,
      'the evaluator sends its own cheap-model constant, not the session model',
    )
    // No roster model is the cheap model, so this holds for all four:
    assert.notEqual(
      byRole.get('entrance-criteria').body.model,
      model,
      'the evaluator model is independent of the session model',
    )
  })
}

// --- criterion 1 (rejection half): non-roster models write nothing ---

for (const [label, badModel] of [
  ['plausible non-roster model', 'claude-sonnet-5'],
  ['case-mismatched roster model', 'Claude-Opus-5'],
  ['case-mismatched roster model (gpt)', 'GPT-5.6-TERRA'],
  ['empty string', ''],
]) {
  test(`DAN-65 rejects ${label} (${JSON.stringify(badModel)}): BAD_USER_INPUT on field model, zero writes`, async () => {
    const app = makeApp()
    const res = await gql(app, ALICE, START, { input: { model: badModel } })

    assert.equal(res.status, 200, 'a domain validation failure is never an HTTP 4xx/5xx')
    assert.equal(res.body.data, null)
    assert.deepEqual(res.body.errors[0].extensions, { code: 'BAD_USER_INPUT', field: 'model' })
    assert.equal(await featureRequests().countDocuments(), 0, 'nothing written')
  })
}

// --- criterion 3: the harness map, asserted directly ---

test('DAN-65 HARNESS_BY_MODEL maps every roster model, non-claude models to "claude" for now', () => {
  assert.deepEqual(FEATURE_REQUEST_MODELS, ROSTER, 'the allow-list is exactly the four-model roster')
  assert.deepEqual(Object.keys(HARNESS_BY_MODEL).sort(), [...ROSTER].sort(), 'the map covers exactly the roster')
  for (const model of ROSTER) {
    assert.equal(HARNESS_BY_MODEL[model], 'claude', `${model} maps to the claude harness`)
  }
})

// --- criterion 3 (behavioral smoke): a non-claude session still files agent:claude ---

test('DAN-65 approval smoke: a gpt-oss-120b session files its issue with the agent:claude label via the mapping', async () => {
  const linear = fakeLinearClient()
  const app = makeApp({ linearClient: linear })

  const allPass = Object.fromEntries(
    ['notTooBig', 'notAmbiguous', 'noBlockedDependencies'].map((g) => [
      g,
      { pass: true, reason: 'tester fixture' },
    ]),
  )
  const { insertedId } = await featureRequests().insertOne({
    uid: 'uid-alice',
    status: 'gathering',
    model: 'gpt-oss-120b',
    messages: [{ role: 'user', content: 'Ship the roster', createdAt: new Date() }],
    createdAt: new Date(),
    plan: { tickets: [{ key: 'T1', title: 'Do it', description: 'Small.', dependsOn: [] }] },
    entranceCriteria: allPass,
  })
  const id = insertedId.toString()

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.approveFeatureRequestPlan.status, 'building')

  const labelCalls = linear.callsTo('findOrCreateLabels')
  assert.equal(labelCalls.length, 1)
  assert.deepEqual(
    labelCalls[0].args.names,
    ['agent:claude', `prompt:${id}`],
    'the non-claude model rides the claude harness label, per the documented mapping',
  )
  const issues = linear.callsTo('createIssue')
  assert.equal(issues.length, 1)
  assert.deepEqual(issues[0].args.labelIds, ['label:agent:claude', `label:prompt:${id}`])
})
