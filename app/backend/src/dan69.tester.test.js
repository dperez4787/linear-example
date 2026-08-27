// DAN-69 tester verification: lenient JSON extraction for the internal roles +
// explicit max_tokens per turn. Independent of the developer's
// lenientJsonExtraction.test.js; written from the ticket's acceptance criteria.
// Run with: npm test
//
// Seams: stub token verifier + REAL createAiGateway over a scripted, capturing
// fetch, so every asserted request body is exactly what production would send
// and every reply travels the full parse-and-persist path. Mongo
// (linear_example_test) is the only external dependency; no test dials a
// network.
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
process.env.AI_GATEWAY_URL = 'https://gateway.dan69.tester.invalid'
process.env.AI_GATEWAY_KEY = 'dan69-tester-gateway-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')
const { MAX_TOKENS_BY_ROLE } = await import('./featureRequests.js')
const { ObjectId } = await import('mongodb')

// --- fixtures ---

const SESSION_MODEL = 'claude-opus-5'
const PO_REPLY = 'Refined: export the currently filtered rows as one CSV file.'
const ARCHITECT_REPLY = 'Feasible with one streaming query; no schema change.'

const GATES = ['notTooBig', 'notAmbiguous', 'noBlockedDependencies']

function verdict(pass, tag) {
  return Object.fromEntries(
    GATES.map((g) => [g, { pass, reason: `dan69 fixture ${tag}: ${g}` }]),
  )
}
const ALL_PASS = verdict(true, 'pass')
const ALL_FAIL = verdict(false, 'fail')

const UNAVAILABLE = Object.fromEntries(
  GATES.map((g) => [g, { pass: false, reason: 'evaluation unavailable' }]),
)

const PLAN = {
  tickets: [
    { key: 'T1', title: 'Export endpoint', description: 'Add GET /api/records/export', dependsOn: [] },
    { key: 'T2', title: 'Export button', description: 'Wire the button to the endpoint', dependsOn: ['T1'] },
  ],
}

// A reply mimicking what claude-haiku actually produced in the live dry-run:
// a ```json fence around a pretty-printed three-gate object.
const HAIKU_STYLE_REPLY = [
  '```json',
  '{',
  '  "notTooBig": {"pass": true, "reason": "One export query and one button is a small, bounded change."},',
  '  "notAmbiguous": {"pass": true, "reason": "The file format and row scope were both confirmed."},',
  '  "noBlockedDependencies": {"pass": true, "reason": "The transcript names no unresolved prerequisite."}',
  '}',
  '```',
].join('\n')

const HAIKU_STYLE_GATES = {
  notTooBig: { pass: true, reason: 'One export query and one button is a small, bounded change.' },
  notAmbiguous: { pass: true, reason: 'The file format and row scope were both confirmed.' },
  noBlockedDependencies: { pass: true, reason: 'The transcript names no unresolved prerequisite.' },
}

function completion(content) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }
}

// Capturing scripted fetch answering per metadata.role. `failRole` makes that
// one role's call fail with `failStatus`.
function scriptedFetch({
  // Converged by default: DAN-75 made approvable require a stored plan, and
  // the criterion-1 tests here assert the gates axis with that satisfied.
  planContent = JSON.stringify(PLAN),
  evalContent = JSON.stringify(ALL_PASS),
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
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
  fn.calls = calls
  return fn
}

// --- app plumbing (stub verifier, injected gateway) ---

const TOKENS = { 'stub-token-tessa': { uid: 'uid-tessa-dan69' } }
const TESSA = 'stub-token-tessa'

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

async function startSession(app, token = TESSA) {
  const res = await gql(
    app,
    token,
    'mutation ($input: StartFeatureRequestInput!) { startFeatureRequest(input: $input) { id } }',
    { input: { model: SESSION_MODEL } },
  )
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest.id
}

// One full exchange against a fresh session; returns { fr, doc, fetch }.
async function exchange(opts) {
  const fetch = scriptedFetch(opts)
  const app = makeApp(fetch)
  const id = await startSession(app)
  const res = await gql(app, TESSA, SEND, { id, content: 'export my table as CSV' })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, 'the exchange must succeed')
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  return { fr: res.body.data.sendFeatureRequestMessage, doc, fetch, app, id }
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

// --- criterion 1: lenient evaluator parsing, malformed still safe ---

test('criterion 1: a fenced evaluator reply (```json) parses and the three gates persist', async () => {
  const { fr, doc } = await exchange({
    evalContent: '```json\n' + JSON.stringify(ALL_PASS) + '\n```',
  })
  assert.deepEqual(fr.entranceCriteria, ALL_PASS)
  assert.equal(fr.approvable, true)
  assert.deepEqual(doc.entranceCriteria, ALL_PASS, 'persisted, not just echoed')
})

test('criterion 1: a one-line preamble before the JSON parses too', async () => {
  const { fr, doc } = await exchange({
    evalContent: 'Here is my evaluation of the three gates.\n' + JSON.stringify(ALL_PASS),
  })
  assert.deepEqual(fr.entranceCriteria, ALL_PASS)
  assert.deepEqual(doc.entranceCriteria, ALL_PASS)
})

test('criterion 1 (realistic): the verbatim haiku-style reply — pretty-printed JSON in a ```json fence — flips all gates and approvable on the wire', async () => {
  const { fr, doc } = await exchange({ evalContent: HAIKU_STYLE_REPLY })
  assert.deepEqual(fr.entranceCriteria, HAIKU_STYLE_GATES)
  assert.equal(fr.approvable, true, 'this is exactly what unblocks plan approval')
  assert.deepEqual(doc.entranceCriteria, HAIKU_STYLE_GATES)
})

test('criterion 1 (adversarial): a ```json fence followed by trailing prose still parses', async () => {
  const { fr } = await exchange({
    evalContent:
      '```json\n' + JSON.stringify(ALL_PASS) + '\n```\n\nLet me know if you need more detail on any gate.',
  })
  assert.deepEqual(fr.entranceCriteria, ALL_PASS)
  assert.equal(fr.approvable, true)
})

test('criterion 1 (adversarial): braces and escaped quotes inside string values do not derail extraction after a preamble', async () => {
  const gates = {
    notTooBig: { pass: true, reason: 'Use {curly} braces in the UI copy is one small change.' },
    notAmbiguous: { pass: true, reason: 'The spec says "{start" is fine as a literal.' },
    noBlockedDependencies: { pass: true, reason: 'Nothing { unresolved } remains.' },
  }
  const { fr, doc } = await exchange({
    evalContent: 'My verdict follows.\n' + JSON.stringify(gates),
  })
  assert.deepEqual(fr.entranceCriteria, gates)
  assert.deepEqual(doc.entranceCriteria, gates)
  assert.equal(doc.entranceCriteria.notTooBig.reason.includes('{curly}'), true)
})

for (const [label, evalContent] of [
  ['prose with no JSON at all', 'All three gates look fine to me, ship it.'],
  ['a fence around truncated JSON', '```json\n{"notTooBig": {"pass": true, "reason": "cut\n```'],
  ['a whitespace-only reply', '   \n\t  \n'],
  ['an empty reply', ''],
  ['an unterminated bare object', 'verdict: {"notTooBig": {"pass": true'],
]) {
  test(`criterion 1: genuinely malformed evaluator output (${label}) yields "evaluation unavailable" and the exchange succeeds`, async () => {
    const { fr, doc } = await exchange({ evalContent })
    assert.deepEqual(
      fr.messages.map((m) => m.role),
      ['user', 'product-owner', 'architect'],
      'the chat exchange itself succeeded',
    )
    assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
    assert.equal(fr.approvable, false)
    assert.deepEqual(doc.entranceCriteria, UNAVAILABLE, 'the safe verdict is persisted')
  })
}

// --- extraction contract probes: multiple objects, arrays ---
// These pin the observed behavior of the shared helper on contract-violating
// replies. Neither shape may ever crash the exchange or persist a partial
// verdict: the outcome must be either a fully valid gates object or the
// uniform "evaluation unavailable".

test('extraction probe: two JSON objects with trailing prose — the FIRST balanced object wins', async () => {
  const { fr, doc } = await exchange({
    evalContent:
      'Initial verdict: ' + JSON.stringify(ALL_PASS) + ' though one could argue ' + JSON.stringify(ALL_FAIL) + ' instead.',
  })
  assert.deepEqual(fr.entranceCriteria, ALL_PASS, 'first object wins, second is ignored')
  assert.deepEqual(doc.entranceCriteria, ALL_PASS)
})

test('extraction probe: two bare concatenated JSON objects (no prose) — treated malformed, evaluation unavailable', async () => {
  // The trimmed text starts with { and ends with }, so the helper attempts a
  // whole-string parse, which fails; no fallback re-scan happens. Documented
  // observed behavior: the safe malformed path, not first-wins.
  const { fr, doc } = await exchange({
    evalContent: JSON.stringify(ALL_PASS) + '\n' + JSON.stringify(ALL_FAIL),
  })
  assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
  assert.equal(fr.approvable, false)
  assert.deepEqual(doc.entranceCriteria, UNAVAILABLE)
})

test('extraction probe: a JSON ARRAY wrapping a valid gates object — the element object is extracted and validated, never a crash', async () => {
  // Observed behavior: the helper takes the first balanced {...} inside the
  // array, which here is the (fully valid) gates object, so the strict
  // field-by-field validation still gates what persists.
  const { fr, doc } = await exchange({ evalContent: JSON.stringify([ALL_PASS]) })
  assert.deepEqual(fr.entranceCriteria, ALL_PASS)
  assert.deepEqual(doc.entranceCriteria, ALL_PASS)
})

test('extraction probe: a JSON ARRAY of gate fragments (no valid gates object) — evaluation unavailable', async () => {
  const { fr, doc } = await exchange({
    evalContent: JSON.stringify([
      { pass: true, reason: 'fragment' },
      { pass: false, reason: 'fragment' },
    ]),
  })
  assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
  assert.deepEqual(doc.entranceCriteria, UNAVAILABLE)
})

test('extraction probe: an array of scalars (no object anywhere) — evaluation unavailable', async () => {
  const { fr } = await exchange({ evalContent: '["notTooBig", "notAmbiguous"]' })
  assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
})

// --- criterion 2: the planner shares the same lenient shapes ---

test('criterion 2: a fenced planner reply parses and the plan persists', async () => {
  const { fr, doc } = await exchange({
    planContent: '```json\n' + JSON.stringify(PLAN) + '\n```',
  })
  assert.deepEqual(fr.plan, PLAN)
  assert.deepEqual(doc.plan, PLAN, 'persisted, not just echoed')
})

test('criterion 2: a preambled planner reply parses and the plan persists', async () => {
  const { fr, doc } = await exchange({
    planContent: 'The conversation has converged; here is the plan.\n' + JSON.stringify(PLAN),
  })
  assert.deepEqual(fr.plan, PLAN)
  assert.deepEqual(doc.plan, PLAN)
})

test('criterion 2 (nested): fenced plan with nested dependsOn arrays and brace-bearing descriptions survives intact', async () => {
  const plan = {
    tickets: [
      { key: 'T1', title: 'Schema', description: 'Add {exportedAt} to the record shape', dependsOn: [] },
      { key: 'T2', title: 'Endpoint', description: 'Stream rows as CSV', dependsOn: ['T1'] },
      { key: 'T3', title: 'Button', description: 'Call the endpoint', dependsOn: ['T1', 'T2'] },
    ],
  }
  const { fr, doc } = await exchange({
    planContent: 'Plan follows.\n```json\n' + JSON.stringify(plan, null, 2) + '\n```\nEnd of plan.',
  })
  assert.deepEqual(fr.plan, plan)
  assert.deepEqual(doc.plan, plan)
})

test('criterion 2 regression (DAN-49): a malformed planner reply still stores no plan and is not an error', async () => {
  const { fr, doc } = await exchange({ planContent: 'We should keep discussing scope.' })
  assert.equal(fr.plan, null)
  assert.ok(!('plan' in doc), 'nothing stored for a malformed plan')
})

test('criterion 2: a planner reply that is a JSON array (not the tickets object) stores no plan', async () => {
  const { fr, doc } = await exchange({ planContent: JSON.stringify(PLAN.tickets) })
  // The first balanced object inside the array is a bare ticket (no "tickets"
  // key), which parsePlan rejects — so no plan persists. Safe outcome.
  assert.equal(fr.plan, null)
  assert.ok(!('plan' in doc))
})

// --- criterion 3: explicit max_tokens on the captured transport, all four call sites ---

test('criterion 3: one exchange sends four calls whose bodies carry max_tokens 1500/1500/2500/500, matching the exported constant', async () => {
  const { fetch } = await exchange()

  assert.equal(fetch.calls.length, 4, 'PO, architect, planner, evaluator')
  assert.deepEqual(
    fetch.calls.map((c) => c.body.metadata.role),
    ['product-owner', 'architect', 'planner', 'entrance-criteria'],
  )

  // The ticket's numbers, asserted as literals on the wire — independent of
  // whatever the constant says. Literals updated by DAN-72 (budgets retuned
  // so an opus round fits Hosting's 60s timeout; the planner budget rose to
  // 2500 alongside its move to the cheap model).
  const expected = {
    'product-owner': 1500,
    architect: 1500,
    planner: 2500,
    'entrance-criteria': 500,
  }
  for (const call of fetch.calls) {
    const role = call.body.metadata.role
    assert.equal(call.body.max_tokens, expected[role], `${role} max_tokens on the wire`)
    assert.equal(typeof call.body.max_tokens, 'number')
  }

  // And the exported constant matches the ticket, so tests and code cannot
  // drift apart silently.
  assert.deepEqual(MAX_TOKENS_BY_ROLE, expected)
})

test('criterion 3: a second exchange on the same session sends the same per-role budgets (not a first-call artifact)', async () => {
  const { fetch, app, id } = await exchange()
  const res = await gql(app, TESSA, SEND, { id, content: 'only the filtered rows' })
  assert.equal(res.body.errors, undefined)
  assert.equal(fetch.calls.length, 8)
  for (const call of fetch.calls.slice(4)) {
    assert.equal(call.body.max_tokens, MAX_TOKENS_BY_ROLE[call.body.metadata.role])
  }
})

// --- regression: evaluator failure still never fails the exchange (DAN-50) ---

for (const failStatus of [429, 500]) {
  test(`regression (DAN-50): an evaluator HTTP ${failStatus} still never fails the exchange — gates read "evaluation unavailable"`, async () => {
    const { fr, doc } = await exchange({ failRole: 'entrance-criteria', failStatus })
    assert.deepEqual(
      fr.messages.map((m) => m.role),
      ['user', 'product-owner', 'architect'],
    )
    assert.deepEqual(fr.entranceCriteria, UNAVAILABLE)
    assert.deepEqual(doc.entranceCriteria, UNAVAILABLE)
  })
}
