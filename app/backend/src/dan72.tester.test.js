// DAN-72 tester verification: per-role max_tokens retuned so an opus round
// fits Hosting's 60s rewrite timeout, and the planner moved to a dedicated
// cheap model with a RAISED 2500 budget (scope updated after a live truncation
// at the old 1500 cap silently blocked plan approval). Independent of the
// developer's edits to the existing suites; written from the updated ticket's
// acceptance criteria. Run with: npm test
//
// Seams: stub token verifier + REAL createAiGateway over a scripted, capturing
// fetch, so every asserted request body is exactly what production sends over
// the wire. Mongo (linear_example_test) is the only external dependency; no
// test dials a network.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
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
process.env.AI_GATEWAY_URL = 'https://gateway.dan72.tester.invalid'
process.env.AI_GATEWAY_KEY = 'dan72-tester-gateway-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')
const { MAX_TOKENS_BY_ROLE, PLANNER_MODEL, ENTRANCE_CRITERIA_MODEL } = await import(
  './featureRequests.js'
)
const { ObjectId } = await import('mongodb')

// --- the updated ticket's numbers and ids, as literals ---
// Asserted as literals FIRST so a drifted constant cannot silently re-anchor
// every wire assertion below.

const TICKET_BUDGETS = {
  'product-owner': 1500,
  architect: 1500,
  planner: 2500,
  'entrance-criteria': 500,
}
const CHEAP_MODEL_ID = 'claude-haiku-4-5'

// --- fixtures ---

const GATES = ['notTooBig', 'notAmbiguous', 'noBlockedDependencies']
const ALL_PASS = Object.fromEntries(
  GATES.map((g) => [g, { pass: true, reason: `dan72 fixture: ${g}` }]),
)

function completion(content) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }
}

// Capturing scripted fetch answering per metadata.role.
function scriptedFetch({ planContent = JSON.stringify({ tickets: [] }) } = {}) {
  const calls = []
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    const role = body.metadata.role
    const reply =
      role === 'product-owner'
        ? 'Refined: one bounded change.'
        : role === 'architect'
          ? 'Feasible; no schema change.'
          : role === 'entrance-criteria'
            ? JSON.stringify(ALL_PASS)
            : planContent
    return { ok: true, status: 200, json: async () => completion(reply) }
  }
  fn.calls = calls
  return fn
}

// --- app plumbing (stub verifier, injected gateway) ---

const TOKENS = { 'stub-token-tomas': { uid: 'uid-tomas-dan72' } }
const TOMAS = 'stub-token-tomas'

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

const SEND = `mutation ($id: ID!, $content: String!) {
  sendFeatureRequestMessage(id: $id, content: $content) {
    id model messages { role }
    plan { tickets { key title description dependsOn } }
    approvable
  }
}`

async function startSession(app, model) {
  const res = await gql(
    app,
    TOMAS,
    'mutation ($input: StartFeatureRequestInput!) { startFeatureRequest(input: $input) { id } }',
    { input: { model } },
  )
  assert.equal(res.body.errors, undefined)
  return res.body.data.startFeatureRequest.id
}

// One full exchange against a fresh session on `model`.
async function exchange(model, opts) {
  const fetch = scriptedFetch(opts)
  const app = makeApp(fetch)
  const id = await startSession(app, model)
  const res = await gql(app, TOMAS, SEND, { id, content: 'export my table as CSV' })
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

// --- criterion 1: the four per-role budgets, asserted on the wire ---

test('criterion 1: one exchange makes exactly four calls carrying max_tokens 1500/1500/2500/500 on the wire, and the exported constant matches the ticket', async () => {
  const { fetch } = await exchange('claude-opus-5')

  assert.equal(fetch.calls.length, 4, 'PO, architect, planner, evaluator — exactly four')
  assert.deepEqual(
    fetch.calls.map((c) => c.body.metadata.role),
    ['product-owner', 'architect', 'planner', 'entrance-criteria'],
    'the four roles, in orchestration order',
  )
  for (const call of fetch.calls) {
    const role = call.body.metadata.role
    assert.equal(typeof call.body.max_tokens, 'number', `${role} max_tokens is a number`)
    assert.equal(
      call.body.max_tokens,
      TICKET_BUDGETS[role],
      `${role} carries the updated ticket's budget on the wire`,
    )
  }

  // The single exported constant agrees with the ticket, so the suites that
  // anchor on the constant cannot drift from what production sends.
  //
  // DAN-90 added a FIFTH role, the titler (40 tokens), which runs at APPROVAL
  // time rather than in an exchange — this criterion's subject, the four calls
  // one exchange sends, is unchanged and the wire assertions above still bound
  // it exactly. The new role is added to the EXPECTED OBJECT rather than
  // relaxing the assertion into a per-entry loop: whole-object equality is what
  // catches an unreviewed budget change to ANY role, extra keys included.
  assert.deepEqual(MAX_TOKENS_BY_ROLE, { ...TICKET_BUDGETS, titler: 40 })
})

// --- criterion 2: the planner's dedicated cheap model ---

test('criterion 2: the planner call carries claude-haiku-4-5 (= exported PLANNER_MODEL); PO and architect keep the session model; the evaluator keeps its own constant', async () => {
  const SESSION_MODEL = 'claude-opus-5'
  const { fetch } = await exchange(SESSION_MODEL)
  const byRole = new Map(fetch.calls.map((c) => [c.body.metadata.role, c.body]))

  assert.equal(byRole.get('planner').model, CHEAP_MODEL_ID, 'planner model, as a literal')
  assert.equal(byRole.get('planner').model, PLANNER_MODEL, 'and it is the exported constant')
  assert.equal(byRole.get('product-owner').model, SESSION_MODEL)
  assert.equal(byRole.get('architect').model, SESSION_MODEL)
  assert.equal(
    byRole.get('entrance-criteria').model,
    ENTRANCE_CRITERIA_MODEL,
    'the evaluator still carries its own constant',
  )
})

// --- model independence: a NON-claude session model does not leak into the
// internal roles, and the cheap roles do not leak into the conversation ---

test('independence: a gpt-oss-120b session sends gpt-oss-120b@1500 for PO and architect, claude-haiku-4-5@2500 for the planner, claude-haiku-4-5@500 for the evaluator', async () => {
  const { fetch } = await exchange('gpt-oss-120b')

  assert.equal(fetch.calls.length, 4)
  const got = fetch.calls.map((c) => ({
    role: c.body.metadata.role,
    model: c.body.model,
    max_tokens: c.body.max_tokens,
  }))
  assert.deepEqual(got, [
    { role: 'product-owner', model: 'gpt-oss-120b', max_tokens: 1500 },
    { role: 'architect', model: 'gpt-oss-120b', max_tokens: 1500 },
    { role: 'planner', model: 'claude-haiku-4-5', max_tokens: 2500 },
    { role: 'entrance-criteria', model: 'claude-haiku-4-5', max_tokens: 500 },
  ])
})

// --- the production failure shape: a large converged plan now fits ---

// ~2000 tokens of tickets JSON (the truncation that blocked live approval hit
// the old 1500 planner cap). 40 tickets with long descriptions pretty-printed
// inside a ```json fence lands around 8-9k characters ≈ 2k+ tokens; it must
// parse and persist FULLY — every ticket, every dependsOn edge, no tail loss.
function largePlan() {
  const tickets = []
  for (let i = 1; i <= 40; i += 1) {
    tickets.push({
      key: `T${i}`,
      title: `Step ${i}: incremental slice of the CSV export epic with filters`,
      description:
        `Implement stage ${i} of the export pipeline: stream the filtered rows ` +
        `through the cursor in batches, escape embedded quotes and delimiters per ` +
        `RFC 4180, and surface progress to the client without buffering the whole ` +
        `result set in memory on the M0 tier.`,
      dependsOn: i === 1 ? [] : [`T${i - 1}`],
    })
  }
  return { tickets }
}

test('regression (the live truncation): a ~2000-token fenced converged plan parses and persists fully', async () => {
  const plan = largePlan()
  const fenced = '```json\n' + JSON.stringify(plan, null, 2) + '\n```'
  assert.ok(fenced.length > 8000, `fixture is large enough to exceed the old cap (${fenced.length} chars)`)

  const { fr, doc } = await exchange('claude-opus-5', { planContent: fenced })

  assert.ok(fr.plan, 'a plan came back')
  assert.equal(fr.plan.tickets.length, 40, 'every ticket survived')
  assert.deepEqual(fr.plan, plan, 'the plan round-trips byte-for-byte through GraphQL')
  assert.deepEqual(doc.plan, plan, 'and persists fully in Mongo, not just echoed')
  assert.deepEqual(doc.plan.tickets[39], plan.tickets[39], 'the tail ticket is intact')
})

// --- source hygiene: the cheap-model id stays a pair of named constants ---

// Sharper than a bare occurrence count: EVERY line of non-test source that
// mentions the id must be an `export const` definition, so a hardcoded id at
// any call site — even one that keeps the total count at two by deleting a
// constant — fails here.
test('hygiene: every non-test source occurrence of claude-haiku-4-5 is an export-const definition line in featureRequests.js', async () => {
  const srcDir = fileURLToPath(new URL('.', import.meta.url))
  const offenders = []
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    const lines = readFileSync(`${srcDir}/${f}`, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!line.includes(CHEAP_MODEL_ID)) return
      if (f === 'featureRequests.js' && /^export const \w+ = 'claude-haiku-4-5'$/.test(line.trim())) return
      offenders.push(`${f}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'no scattered cheap-model id outside the two named constants')
  const source = readFileSync(`${srcDir}/featureRequests.js`, 'utf8')
  assert.match(source, /export const ENTRANCE_CRITERIA_MODEL = 'claude-haiku-4-5'/)
  assert.match(source, /export const PLANNER_MODEL = 'claude-haiku-4-5'/)
})
