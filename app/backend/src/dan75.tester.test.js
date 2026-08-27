// DAN-75 tester suite (independent verification): `approvable` is true ONLY
// when all three entrance gates pass AND a plan is stored on the session.
// Sessions whose gates pass but whose planner has not converged serve
// approvable: false, while approveFeatureRequestPlan keeps its existing
// no-plan refusal ("feature request has no plan to approve", BAD_USER_INPUT)
// as a backstop — and the two must never disagree: for every session,
// approvable:true implies the mutation succeeds and approvable:false implies
// it refuses. A session becoming approvable after the planner converges flips
// on the next read.
//
// Written by the tester from the acceptance criteria, not from the developer's
// tests. Same seams as the sibling suites: HTTP via supertest against the
// in-process app, stub token verifier, a REAL createAiGateway over a scripted
// fetch for the pipeline tests, a recording fake Linear client for approvals,
// and direct Mongo seeding for the state-matrix tests. Run with: npm test
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
const { ObjectId } = await import('mongodb')

// --- fixtures ---

const GATE_NAMES = ['notTooBig', 'notAmbiguous', 'noBlockedDependencies']

function gates(overrides = {}) {
  return Object.fromEntries(
    GATE_NAMES.map((g) => [g, overrides[g] ?? { pass: true, reason: `tester fixture: ${g} ok` }]),
  )
}

const ALL_PASS_GATES = gates()
const ONE_FAIL_GATES = gates({ notAmbiguous: { pass: false, reason: 'format undecided' } })
const ALL_FAIL_GATES = gates(
  Object.fromEntries(GATE_NAMES.map((g) => [g, { pass: false, reason: `${g} fails` }])),
)

const STORED_PLAN = {
  tickets: [
    { key: 'T1', title: 'Backend export endpoint', description: 'Streams CSV.', dependsOn: [] },
    { key: 'T2', title: 'Frontend export button', description: 'Calls T1.', dependsOn: ['T1'] },
  ],
}
const EMPTY_PLAN = { tickets: [] }

const NO_PLAN_MESSAGE = 'feature request has no plan to approve'

// Scripted planner replies for the pipeline (flip) tests.
const PO_REPLY = 'Refined: export the filtered records as CSV.'
const ARCHITECT_REPLY = 'One streaming endpoint, no schema change.'
const CONVERGED_REPLY = JSON.stringify({
  tickets: [{ key: 'T1', title: 'Export endpoint', description: 'CSV stream.', dependsOn: [] }],
})
const NOT_CONVERGED_REPLY = JSON.stringify({ tickets: [] })
const ALL_PASS_EVAL = JSON.stringify({
  notTooBig: { pass: true, reason: 'One endpoint and a button.' },
  notAmbiguous: { pass: true, reason: 'Format is settled: CSV.' },
  noBlockedDependencies: { pass: true, reason: 'Nothing upstream.' },
})

function completion(content) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 5 },
  }
}

// Scripted fetch answering per metadata.role; `plannerReplies` is consumed one
// reply per planner call (the last one repeats), so a session can converge on
// a chosen exchange.
function scriptedFetch({ plannerReplies = [CONVERGED_REPLY] } = {}) {
  let plannerCall = 0
  return async (url, init) => {
    const role = JSON.parse(init.body).metadata.role
    let reply
    if (role === 'product-owner') reply = PO_REPLY
    else if (role === 'architect') reply = ARCHITECT_REPLY
    else if (role === 'entrance-criteria') reply = ALL_PASS_EVAL
    else {
      reply = plannerReplies[Math.min(plannerCall, plannerReplies.length - 1)]
      plannerCall += 1
    }
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
}

// Recording fake Linear client: every method records and returns fixture ids.
// No test reaches real Linear.
function fakeLinearClient() {
  const calls = []
  let issueN = 0
  const record = (method, args) => calls.push({ method, args })
  return {
    calls,
    config() {
      record('config', {})
      return { teamId: 'tester-team', readyForDevStateId: 'tester-ready-state' }
    },
    async findOrCreateLabels(names) {
      record('findOrCreateLabels', { names })
      return Object.fromEntries(names.map((n) => [n, `tester-label:${n}`]))
    },
    async createProject(args) {
      record('createProject', args)
      return { id: 'tester-project-id', url: 'https://linear.app/tester/project/dan75' }
    },
    async createIssue(args) {
      record('createIssue', args)
      issueN += 1
      return {
        id: `tester-issue-${issueN}`,
        identifier: `DAN-75${issueN}`,
        url: `https://linear.app/tester/issue/DAN-75${issueN}`,
      }
    },
    async createRelation(args) {
      record('createRelation', args)
      return { id: `tester-relation-${calls.length}` }
    },
  }
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

const FR_FIELDS = `id status approvable
  plan { tickets { key } }
  entranceCriteria {
    notTooBig { pass }
    notAmbiguous { pass }
    noBlockedDependencies { pass }
  }`
const GET = `query ($id: ID!) { featureRequest(id: $id) { ${FR_FIELDS} } }`
const SEND = `mutation ($id: ID!, $content: String!) {
  sendFeatureRequestMessage(id: $id, content: $content) { ${FR_FIELDS} }
}`
const APPROVE = `mutation ($id: ID!) { approveFeatureRequestPlan(id: $id) { id status } }`

const featureRequests = () => getDb().collection('feature_requests')

// Seed a session document directly so each test controls gates and plan
// exactly. `plan: undefined` / `entranceCriteria: undefined` omit the field.
async function seedSession({ plan, entranceCriteria } = {}) {
  const doc = {
    uid: 'uid-alice',
    status: 'gathering',
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'tester: CSV export please', createdAt: new Date() }],
    createdAt: new Date(),
  }
  if (plan !== undefined) doc.plan = plan
  if (entranceCriteria !== undefined) doc.entranceCriteria = entranceCriteria
  const { insertedId } = await featureRequests().insertOne(doc)
  return insertedId.toString()
}

async function readApprovable(app, id) {
  const res = await gql(app, ALICE, GET, { id })
  assert.equal(res.body.errors, undefined, 'reading a session never errors')
  return res.body.data.featureRequest.approvable
}

async function startSession(app) {
  const res = await gql(
    app,
    ALICE,
    'mutation ($input: StartFeatureRequestInput!) { startFeatureRequest(input: $input) { id } }',
    { input: { model: 'claude-opus-5' } },
  )
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest.id
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

// --- criterion 1: approvable = gates AND stored plan ---

test('gates pass + stored plan → approvable: true, on both the single read and the list', async () => {
  const app = makeApp()
  const id = await seedSession({ plan: STORED_PLAN, entranceCriteria: ALL_PASS_GATES })

  assert.equal(await readApprovable(app, id), true)

  const list = await gql(app, ALICE, '{ featureRequests { id approvable } }')
  assert.equal(list.body.errors, undefined)
  assert.deepEqual(list.body.data.featureRequests, [{ id, approvable: true }])
})

test('gates pass + NO plan → approvable: false, and the mutation still refuses with the exact backstop message and BAD_USER_INPUT', async () => {
  const linear = fakeLinearClient()
  const app = makeApp({ linearClient: linear })
  const id = await seedSession({ entranceCriteria: ALL_PASS_GATES }) // no plan field at all

  assert.equal(await readApprovable(app, id), false, 'passing gates alone must not be approvable')

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.status, 200)
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors.length, 1)
  assert.equal(res.body.errors[0].message, NO_PLAN_MESSAGE, 'the backstop message is unchanged')
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT', 'the error shape is unchanged')
  assert.equal(linear.calls.length, 0, 'the refusal reaches Linear zero times')

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'gathering', 'the refused session is untouched')
})

test('gates fail + stored plan → approvable: false', async () => {
  const app = makeApp()
  const id = await seedSession({ plan: STORED_PLAN, entranceCriteria: ONE_FAIL_GATES })
  assert.equal(await readApprovable(app, id), false)
})

test('gates pass + stored plan with ZERO tickets → approvable: false, and the mutation refuses with the no-plan backstop', async () => {
  const linear = fakeLinearClient()
  const app = makeApp({ linearClient: linear })
  const id = await seedSession({ plan: EMPTY_PLAN, entranceCriteria: ALL_PASS_GATES })

  assert.equal(await readApprovable(app, id), false, 'an empty-tickets plan is no plan')

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.body.errors[0].message, NO_PLAN_MESSAGE)
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(linear.calls.length, 0)
})

// --- criterion 2: the flip — planner convergence turns the bit on the next read ---

test('a session with passing gates reads approvable: false until the planner converges, then true on the very next read', async () => {
  const fetchImpl = scriptedFetch({ plannerReplies: [NOT_CONVERGED_REPLY, CONVERGED_REPLY] })
  const app = makeApp({ fetchImpl })
  const id = await startSession(app)

  // Exchange 1: every gate passes but the planner has not converged.
  const first = await gql(app, ALICE, SEND, { id, content: 'export my records as CSV' })
  assert.equal(first.body.errors, undefined)
  const fr1 = first.body.data.sendFeatureRequestMessage
  for (const gate of GATE_NAMES) {
    assert.equal(fr1.entranceCriteria[gate].pass, true, `${gate} passes on exchange 1`)
  }
  assert.equal(fr1.plan, null, 'no plan stored yet')
  assert.equal(fr1.approvable, false, 'passing gates without a plan must read false')
  assert.equal(await readApprovable(app, id), false, 'a fresh read agrees')

  // Exchange 2: the planner converges.
  const second = await gql(app, ALICE, SEND, { id, content: 'yes, filtered rows only' })
  assert.equal(second.body.errors, undefined)
  assert.equal(second.body.data.sendFeatureRequestMessage.approvable, true, 'the flip is visible immediately')

  // The NEXT READ — what the frontend polls — serves true, backed by the doc.
  assert.equal(await readApprovable(app, id), true)
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.ok(doc.plan?.tickets?.length > 0, 'the flip is backed by a stored plan')
  assert.ok(!('approvable' in doc), 'approvable stays derived, never persisted')
})

// --- criterion 3: end-to-end approval when approvable is true ---

test('when approvable reads true, the approve mutation succeeds end-to-end and files the project', async () => {
  const linear = fakeLinearClient()
  const app = makeApp({ linearClient: linear })
  const id = await seedSession({ plan: STORED_PLAN, entranceCriteria: ALL_PASS_GATES })

  assert.equal(await readApprovable(app, id), true)

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.body.errors, undefined, 'approvable: true promised a mutation that succeeds')
  assert.equal(res.body.data.approveFeatureRequestPlan.status, 'building')
  assert.equal(linear.calls.filter((c) => c.method === 'createProject').length, 1)
  assert.equal(
    linear.calls.filter((c) => c.method === 'createIssue').length,
    STORED_PLAN.tickets.length,
    'one issue per plan ticket',
  )
})

// --- criterion 4: the bit and the mutation can NEVER disagree ---

const MATRIX = [
  ['all gates pass, full plan', { plan: STORED_PLAN, entranceCriteria: ALL_PASS_GATES }],
  ['all gates pass, no plan field', { entranceCriteria: ALL_PASS_GATES }],
  ['all gates pass, empty-tickets plan', { plan: EMPTY_PLAN, entranceCriteria: ALL_PASS_GATES }],
  ['one gate fails, full plan', { plan: STORED_PLAN, entranceCriteria: ONE_FAIL_GATES }],
  ['all gates fail, full plan', { plan: STORED_PLAN, entranceCriteria: ALL_FAIL_GATES }],
  ['one gate fails, no plan', { entranceCriteria: ONE_FAIL_GATES }],
  ['never evaluated, full plan', { plan: STORED_PLAN }],
  ['never evaluated, no plan', {}],
]

for (const [label, seed] of MATRIX) {
  test(`consistency: ${label} — approvable and the approve mutation agree`, async () => {
    const linear = fakeLinearClient()
    const app = makeApp({ linearClient: linear })
    const id = await seedSession(seed)

    const approvable = await readApprovable(app, id)
    const res = await gql(app, ALICE, APPROVE, { id })

    if (approvable) {
      assert.equal(res.body.errors, undefined, `${label}: approvable:true must mean the mutation succeeds`)
      assert.equal(res.body.data.approveFeatureRequestPlan.status, 'building')
    } else {
      assert.ok(res.body.errors?.length, `${label}: approvable:false must mean the mutation refuses`)
      assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
      assert.equal(linear.calls.length, 0, `${label}: a refused approval files nothing`)
    }
  })
}
