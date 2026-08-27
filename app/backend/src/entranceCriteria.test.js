// Entrance-criteria evaluation (DAN-50): after every sendFeatureRequestMessage
// exchange, one cheap-model structured-JSON call scores the three hard gates
// (notTooBig, notAmbiguous, noBlockedDependencies); the result persists as
// FeatureRequest.entranceCriteria and controls FeatureRequest.approvable.
// Tested over HTTP via supertest against the in-process app. Run with: npm test
//
// Same seams as the DAN-49 suites: stub token verifier, and a REAL
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
const { ENTRANCE_CRITERIA_MODEL } = await import('./featureRequests.js')
const { ObjectId } = await import('mongodb')

// --- fixtures ---

const PO_REPLY = 'Refined: one CSV export of the visible rows.'
const ARCHITECT_REPLY = 'One new query, no migration.'
// Planner: converged by default. DAN-75 made the stored plan load-bearing for
// approvable, so the default fixture stores one; NOT_CONVERGED opts out.
const PLAN_REPLY = JSON.stringify({
  tickets: [{ key: 'T1', title: 'Export query', description: 'GET /api/records/export', dependsOn: [] }],
})
const NOT_CONVERGED = JSON.stringify({ tickets: [] })

const ALL_PASS = {
  notTooBig: { pass: true, reason: 'One export query and one button.' },
  notAmbiguous: { pass: true, reason: 'The scope question was answered.' },
  noBlockedDependencies: { pass: true, reason: 'No prerequisite is unresolved.' },
}

const ONE_FAILING = {
  notTooBig: { pass: true, reason: 'Small.' },
  notAmbiguous: { pass: false, reason: 'The export format is still undecided.' },
  noBlockedDependencies: { pass: true, reason: 'Nothing blocking.' },
}

function completion(content, totalTokens = 5) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: totalTokens },
  }
}

const TOKENS_BY_ROLE = { 'product-owner': 11, architect: 13, planner: 17, 'entrance-criteria': 19 }

// A scripted fetch answering per metadata.role. `evalContent` is what the
// evaluator says; `evalStatus` makes the evaluator call itself fail with that
// HTTP status while every other role keeps succeeding; `planContent` scripts
// the planner (default: converged — see PLAN_REPLY).
function scriptedFetch({ evalContent = JSON.stringify(ALL_PASS), evalStatus, planContent = PLAN_REPLY } = {}) {
  const calls = []
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    const role = body.metadata.role
    if (role === 'entrance-criteria' && evalStatus) {
      return { ok: false, status: evalStatus, json: async () => ({ error: { message: 'nope' } }) }
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

const UNEVALUATED = Object.fromEntries(
  ['notTooBig', 'notAmbiguous', 'noBlockedDependencies'].map((gate) => [
    gate,
    { pass: false, reason: 'not yet evaluated' },
  ]),
)

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

// --- criterion 1: exactly one extra call, cheap model, single constant ---

test('each exchange makes exactly one additional call with metadata.role entrance-criteria, on the cheap model constant, distinct from the conversation model', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })
  assert.equal(res.body.errors, undefined)

  const evaluatorCalls = fetch.calls.filter((c) => c.body.metadata.role === 'entrance-criteria')
  assert.equal(evaluatorCalls.length, 1, 'exactly one evaluator call per exchange')
  const [call] = evaluatorCalls

  // The cheap model id comes from the single exported constant, and it is not
  // the session's conversation model.
  assert.equal(call.body.model, ENTRANCE_CRITERIA_MODEL)
  assert.equal(call.body.model, 'claude-haiku-4-5')
  const conversationCall = fetch.calls.find((c) => c.body.metadata.role === 'product-owner')
  assert.notEqual(call.body.model, conversationCall.body.model, 'evaluator model is distinct from the conversation model')

  // Attribution rides the gateway client like every call.
  assert.deepEqual(call.body.metadata, {
    on_behalf_of: 'uid-alice',
    feature: 'prompt-a-feature',
    prompt_id: id,
    role: 'entrance-criteria',
  })
})

// --- criterion 2: structured JSON requested; result persists on the session ---

test('the evaluator call requests structured JSON and its verdicts persist as FeatureRequest.entranceCriteria', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

  const call = fetch.calls.find((c) => c.body.metadata.role === 'entrance-criteria')
  assert.deepEqual(call.body.response_format, { type: 'json_object' }, 'structured JSON is requested')
  assert.equal(call.body.messages[0].role, 'system')
  assert.ok(call.body.messages[0].content.length > 0, 'the evaluator carries a system prompt')

  assert.deepEqual(res.body.data.sendFeatureRequestMessage.entranceCriteria, ALL_PASS)

  // Persisted, not just echoed: a fresh read and the raw document agree.
  const reread = await gql(app, ALICE, GET, { id })
  assert.deepEqual(reread.body.data.featureRequest.entranceCriteria, ALL_PASS)
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.entranceCriteria, ALL_PASS)
})

test('extra keys from the model never reach Mongo — stored gates carry exactly pass and reason', async () => {
  const noisy = {
    verdict: 'looks good',
    notTooBig: { pass: true, reason: 'Small.', confidence: 0.9 },
    notAmbiguous: { pass: true, reason: 'Clear.', severity: 'low' },
    noBlockedDependencies: { pass: true, reason: 'Unblocked.', blockers: [] },
  }
  const app = makeApp(scriptedFetch({ evalContent: JSON.stringify(noisy) }))
  const id = await startSession(app)
  await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(
    Object.keys(doc.entranceCriteria).sort(),
    ['noBlockedDependencies', 'notAmbiguous', 'notTooBig'],
    'top-level extras are dropped',
  )
  for (const gate of Object.values(doc.entranceCriteria)) {
    assert.deepEqual(Object.keys(gate).sort(), ['pass', 'reason'], 'each gate is rebuilt field-by-field')
  }
})

// --- criterion 3: approvable iff all three gates pass AND a plan is stored
// (the plan requirement is DAN-75) ---

test('approvable is true when all three gates pass and a plan is stored', async () => {
  const app = makeApp(scriptedFetch({ evalContent: JSON.stringify(ALL_PASS) }))
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })
  assert.equal(res.body.data.sendFeatureRequestMessage.approvable, true)
  const reread = await gql(app, ALICE, GET, { id })
  assert.equal(reread.body.data.featureRequest.approvable, true)
})

test('DAN-75: passing gates with NO stored plan (planner not converged) serve approvable: false', async () => {
  const app = makeApp(
    scriptedFetch({ evalContent: JSON.stringify(ALL_PASS), planContent: NOT_CONVERGED }),
  )
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

  const fr = res.body.data.sendFeatureRequestMessage
  assert.deepEqual(fr.entranceCriteria, ALL_PASS, 'every gate passes')
  assert.equal(fr.approvable, false, 'no stored plan — the mutation would refuse, so approvable must too')

  const reread = await gql(app, ALICE, GET, { id })
  assert.equal(reread.body.data.featureRequest.approvable, false)
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.ok(!('plan' in doc), 'nothing stored while the planner has not converged')
})

test('DAN-75: failing gates with a stored plan still serve approvable: false', async () => {
  const app = makeApp(scriptedFetch({ evalContent: JSON.stringify(ONE_FAILING) }))
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.ok(doc.plan?.tickets?.length > 0, 'the plan converged and is stored')
  assert.equal(res.body.data.sendFeatureRequestMessage.approvable, false)
  const reread = await gql(app, ALICE, GET, { id })
  assert.equal(reread.body.data.featureRequest.approvable, false)
})

test('DAN-75: a session with passing gates flips approvable on the next read once the planner converges', async () => {
  // First exchange: gates pass, planner not converged. Second: planner converges.
  let plannerRound = 0
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const role = body.metadata.role
    let reply
    if (role === 'product-owner') reply = PO_REPLY
    else if (role === 'architect') reply = ARCHITECT_REPLY
    else if (role === 'entrance-criteria') reply = JSON.stringify(ALL_PASS)
    else {
      plannerRound += 1
      reply = plannerRound === 1 ? NOT_CONVERGED : PLAN_REPLY
    }
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
  const app = makeApp(fetchImpl)
  const id = await startSession(app)

  const first = await gql(app, ALICE, SEND, { id, content: 'export my table' })
  assert.equal(first.body.data.sendFeatureRequestMessage.approvable, false, 'gates pass but no plan yet')

  const second = await gql(app, ALICE, SEND, { id, content: 'CSV, filtered rows only' })
  assert.equal(second.body.data.sendFeatureRequestMessage.approvable, true, 'plan stored — approvable flips')

  // And a fresh read (what the frontend polls) serves the flipped bit.
  const reread = await gql(app, ALICE, GET, { id })
  assert.equal(reread.body.data.featureRequest.approvable, true)
})

test('approvable is false when any single gate fails, and the failing gate keeps its own reason', async () => {
  const app = makeApp(scriptedFetch({ evalContent: JSON.stringify(ONE_FAILING) }))
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

  const fr = res.body.data.sendFeatureRequestMessage
  assert.equal(fr.approvable, false)
  assert.deepEqual(fr.entranceCriteria, ONE_FAILING)
  assert.equal(fr.entranceCriteria.notAmbiguous.pass, false)
  assert.equal(fr.entranceCriteria.notAmbiguous.reason, 'The export format is still undecided.')
})

// --- criterion 4: a virgin session synthesizes "not yet evaluated" ---

test('a new session with no exchanges exposes all three gates as pass: false with a "not yet evaluated" reason and approvable: false', async () => {
  const app = makeApp(scriptedFetch())
  const id = await startSession(app)

  const res = await gql(app, ALICE, GET, { id })
  assert.equal(res.body.errors, undefined)
  const fr = res.body.data.featureRequest
  assert.deepEqual(fr.entranceCriteria, UNEVALUATED)
  assert.equal(fr.approvable, false)

  // Synthesized at the presentation layer, never stored: the raw document has
  // no entranceCriteria field until an evaluation has actually run.
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.ok(!('entranceCriteria' in doc), 'nothing is stored for a virgin session')

  // The list query synthesizes identically.
  const list = await gql(app, ALICE, `{ featureRequests { ${FR_FIELDS} } }`)
  assert.deepEqual(list.body.data.featureRequests[0].entranceCriteria, UNEVALUATED)
  assert.equal(list.body.data.featureRequests[0].approvable, false)
})

// --- criterion 5: unparseable output / evaluator failure never breaks the exchange ---

for (const [label, evalContent] of [
  ['non-JSON prose', 'All three gates look fine to me.'],
  ['truncated JSON', '{"notTooBig": {"pass": true, "reason": "cut'],
  ['a missing gate', JSON.stringify({ notTooBig: { pass: true, reason: 'x' }, notAmbiguous: { pass: true, reason: 'y' } })],
  ['a non-boolean pass', JSON.stringify({ ...ALL_PASS, notTooBig: { pass: 'yes', reason: 'x' } })],
  ['a missing reason', JSON.stringify({ ...ALL_PASS, noBlockedDependencies: { pass: true } })],
]) {
  test(`unparseable evaluator output (${label}) → all gates fail with "evaluation unavailable"; the exchange still succeeds`, async () => {
    const app = makeApp(scriptedFetch({ evalContent }))
    const id = await startSession(app)
    const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

    assert.equal(res.status, 200)
    assert.equal(res.body.errors, undefined, 'never a thrown error for a bad evaluation')
    const fr = res.body.data.sendFeatureRequestMessage
    assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
    assert.equal(fr.approvable, false)
    assert.equal(fr.messages.length, 3, 'the chat exchange itself succeeded')

    const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
    assert.deepEqual(doc.entranceCriteria, UNAVAILABLE, 'the unavailable verdict is persisted')
  })
}

test('an evaluator 429 is handled like unparseable output: gates fail with "evaluation unavailable", the exchange succeeds, no QUOTA_EXHAUSTED surfaces', async () => {
  const fetch = scriptedFetch({ evalStatus: 429 })
  const app = makeApp(fetch)
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, 'the evaluator 429 must not fail the exchange')
  const fr = res.body.data.sendFeatureRequestMessage
  assert.deepEqual(fr.messages.map((m) => m.role), ['user', 'product-owner', 'architect'])
  assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
  assert.equal(fr.approvable, false)
})

test('an evaluator 500 is handled the same way — no INTERNAL error ever leaks from the evaluation', async () => {
  const app = makeApp(scriptedFetch({ evalStatus: 500 }))
  const id = await startSession(app)
  const res = await gql(app, ALICE, SEND, { id, content: 'export my table as CSV' })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.sendFeatureRequestMessage.entranceCriteria, UNAVAILABLE)
})

// --- re-evaluation + usage ---

test('each exchange re-evaluates: a later verdict replaces the stored one wholesale', async () => {
  // First round: one gate fails. Second round: all pass.
  let round = 0
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const role = body.metadata.role
    let reply
    if (role === 'product-owner') reply = PO_REPLY
    else if (role === 'architect') reply = ARCHITECT_REPLY
    else if (role === 'entrance-criteria') {
      round += 1
      reply = JSON.stringify(round === 1 ? ONE_FAILING : ALL_PASS)
    } else reply = PLAN_REPLY
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
  const app = makeApp(fetchImpl)
  const id = await startSession(app)

  const first = await gql(app, ALICE, SEND, { id, content: 'export my table' })
  assert.equal(first.body.data.sendFeatureRequestMessage.approvable, false)

  const second = await gql(app, ALICE, SEND, { id, content: 'CSV, filtered rows only' })
  assert.equal(second.body.data.sendFeatureRequestMessage.approvable, true)
  assert.deepEqual(second.body.data.sendFeatureRequestMessage.entranceCriteria, ALL_PASS)

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.entranceCriteria, ALL_PASS, 'latest evaluation wins, replaced wholesale')
})

test('the evaluator call records usage through the gateway ledger like every call', async () => {
  const app = makeApp(scriptedFetch())
  const id = await startSession(app)

  const beforeUsage = (await gql(app, ALICE, USAGE)).body.data.myAiUsage
  await gql(app, ALICE, SEND, { id, content: 'export my table' })
  const afterUsage = (await gql(app, ALICE, USAGE)).body.data.myAiUsage

  assert.equal(afterUsage.requests - beforeUsage.requests, 4, 'PO + architect + planner + evaluator')
  assert.equal(
    afterUsage.totalTokens - beforeUsage.totalTokens,
    TOKENS_BY_ROLE['product-owner'] +
      TOKENS_BY_ROLE.architect +
      TOKENS_BY_ROLE.planner +
      TOKENS_BY_ROLE['entrance-criteria'],
    'the evaluator tokens land on the ledger',
  )
})
