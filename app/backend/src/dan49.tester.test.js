// Tester verification for DAN-49 (sendFeatureRequestMessage — role
// orchestration + plan extraction). Independent of the developer's suite in
// sendFeatureRequestMessage.test.js: same seams (stub verifier, real
// createAiGateway over a scripted fetch — no real gateway), but its own
// fixtures and its own assertions, with extra weight on:
//
//   - byte-for-byte system prompts against the checked-in roles/*.md files,
//     strict call ordering (PO before architect), prompt_id attribution
//   - persistence under a 429 on the SECOND (architect) call, and that the
//     session is not wedged afterward — a follow-up send completes
//   - planner robustness: malformed shapes store nothing and surface no
//     client error; a later valid plan replaces the stored one wholesale;
//     extra keys from the model never reach Mongo (exact stored field check)
//   - the approved-session guard against a status flipped directly in Mongo
//   - the DAN-53 return contract: the mutation returns the full updated
//     FeatureRequest, messages in chronological order, each with createdAt
//
// Run with: npm test (MONGODB_DB is forced to linear_example_test).
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
// Read lazily inside aiGateway.chat(); the scripted fetch never dials them.
process.env.AI_GATEWAY_URL = 'https://tester-gateway.invalid'
process.env.AI_GATEWAY_KEY = 'tester-stub-key'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')
const { ObjectId } = await import('mongodb')

// --- scripted gateway (criterion 7: canned turns, no real gateway) ---

const PO_TURN = 'tester-po: split it into an export query and a download button.'
const ARCH_TURN = 'tester-architect: one resolver, no migration, fits api.js.'

const VALID_PLAN = {
  tickets: [
    { key: 'A1', title: 'Backend export', description: 'Add the export query.', dependsOn: [] },
    { key: 'A2', title: 'Frontend button', description: 'Wire the button.', dependsOn: ['A1'] },
  ],
}
const REPLACEMENT_PLAN = {
  tickets: [
    { key: 'B1', title: 'Single combined ticket', description: 'Do it all at once.', dependsOn: [] },
  ],
}
// What a sloppy model might emit: right fields plus extras, at both levels.
const NOISY_PLAN = {
  confidence: 0.9,
  tickets: [
    {
      key: 'N1',
      title: 'Noisy ticket',
      description: 'Has extra keys.',
      dependsOn: [],
      estimate: '3d',
      priority: 'high',
      assignee: 'nobody',
    },
  ],
}

function completion(content, totalTokens) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: totalTokens },
  }
}

const TOKENS_BY_ROLE = { 'product-owner': 101, architect: 103, planner: 107, 'entrance-criteria': 109 }

// DAN-50 added a fourth per-round call: the entrance-criteria evaluator. It is
// answered with a fixed passing evaluation so this suite's DAN-49 assertions
// stay focused; the evaluator's own behavior is tested in entranceCriteria.test.js.
const PASSING_EVALUATION = JSON.stringify({
  notTooBig: { pass: true, reason: 'tester: small.' },
  notAmbiguous: { pass: true, reason: 'tester: clear.' },
  noBlockedDependencies: { pass: true, reason: 'tester: unblocked.' },
})

// A scripted fetch. `plans` is a queue of planner reply strings (last one
// repeats); `failCall` (1-based, across ALL calls) returns `failStatus` once.
function scriptedFetch({ plans = [JSON.stringify(VALID_PLAN)], failCall, failStatus = 429 } = {}) {
  const calls = []
  let planIndex = 0
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    if (calls.length === failCall) {
      return { ok: false, status: failStatus, json: async () => ({ error: { message: 'rate limited' } }) }
    }
    const role = body.metadata.role
    let reply
    if (role === 'product-owner') reply = PO_TURN
    else if (role === 'architect') reply = ARCH_TURN
    else if (role === 'entrance-criteria') reply = PASSING_EVALUATION
    else {
      reply = plans[Math.min(planIndex, plans.length - 1)]
      planIndex += 1
    }
    return { ok: true, status: 200, json: async () => completion(reply, TOKENS_BY_ROLE[role] ?? 1) }
  }
  fn.calls = calls
  return fn
}

// --- app plumbing (stub verifier, injected gateway) ---

const TOKENS = {
  'tester-token-owner': { uid: 'tester-uid-owner' },
  'tester-token-intruder': { uid: 'tester-uid-intruder' },
}
const OWNER = 'tester-token-owner'
const INTRUDER = 'tester-token-intruder'

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

const FR_FIELDS = `id status model createdAt
  messages { role content createdAt }
  plan { tickets { key title description dependsOn } }`
const SEND = `mutation ($id: ID!, $content: String!) {
  sendFeatureRequestMessage(id: $id, content: $content) { ${FR_FIELDS} }
}`
const GET = `query ($id: ID!) { featureRequest(id: $id) { ${FR_FIELDS} } }`
const USAGE = '{ myAiUsage { requests totalTokens } }'

async function startSession(app, token = OWNER) {
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

// --- criterion 1: checked-in prompts, byte-for-byte, attribution, ordering ---

test('criterion 1: each role call carries its roles/<role>.md content byte-for-byte as the system message, prompt_id = session id, PO strictly before architect', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app)
  const res = await gql(app, OWNER, SEND, { id, content: 'export my table' })
  assert.equal(res.body.errors, undefined)

  // Strict ordering by call index, not by lookup: PO is call 1, architect call 2.
  const roleOrder = fetch.calls.map((c) => c.body.metadata.role)
  assert.equal(roleOrder[0], 'product-owner', 'the product owner takes the first turn')
  assert.equal(roleOrder[1], 'architect', 'the architect takes the second turn')
  assert.ok(
    roleOrder.indexOf('product-owner') < roleOrder.indexOf('architect'),
    'PO call strictly precedes the architect call',
  )

  for (const [index, role] of [[0, 'product-owner'], [1, 'architect']]) {
    const call = fetch.calls[index]
    const fileContent = await readFile(new URL(`../roles/${role}.md`, import.meta.url), 'utf8')
    assert.ok(fileContent.length > 0, `roles/${role}.md is a real, non-empty checked-in file`)
    const system = call.body.messages[0]
    assert.equal(system.role, 'system')
    assert.ok(
      Buffer.from(system.content, 'utf8').equals(Buffer.from(fileContent, 'utf8')),
      `${role} system message equals roles/${role}.md byte-for-byte`,
    )
    assert.equal(call.body.metadata.role, role)
    assert.equal(call.body.metadata.prompt_id, id, 'prompt_id is the session id')
    assert.equal(call.body.metadata.on_behalf_of, 'tester-uid-owner')
  }
})

// --- criterion 2 + DAN-53 contract: full updated FeatureRequest, in order ---

test('criterion 2: the mutation returns the full updated FeatureRequest — user, PO, architect messages in chronological order, each with createdAt', async () => {
  const app = makeApp(scriptedFetch())
  const id = await startSession(app)
  const res = await gql(app, OWNER, SEND, { id, content: 'export my table' })
  assert.equal(res.body.errors, undefined)

  const fr = res.body.data.sendFeatureRequestMessage
  // DAN-53 consumes the whole object, not just messages.
  assert.equal(fr.id, id)
  assert.equal(fr.status, 'gathering')
  assert.equal(fr.model, 'claude-opus-5')
  assert.deepEqual(
    fr.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'export my table'],
      ['product-owner', PO_TURN],
      ['architect', ARCH_TURN],
    ],
  )
  // Chronological: every createdAt is valid ISO-8601 and non-decreasing.
  const times = fr.messages.map((m) => {
    assert.equal(new Date(m.createdAt).toISOString(), m.createdAt, `${m.role} createdAt is ISO-8601`)
    return Date.parse(m.createdAt)
  })
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] >= times[i - 1], 'messages are in chronological order')
  }

  // Persisted with role + Date timestamp, not just echoed.
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.messages.map((m) => m.role), ['user', 'product-owner', 'architect'])
  for (const m of doc.messages) {
    assert.ok(m.createdAt instanceof Date, 'persisted createdAt is a BSON Date')
  }
})

// --- criterion 3 + planner robustness ---

test('criterion 3: a structured-JSON planner reply persists as plan.tickets with key/title/description/dependsOn', async () => {
  const app = makeApp(scriptedFetch())
  const id = await startSession(app)
  const res = await gql(app, OWNER, SEND, { id, content: 'export my table' })
  assert.deepEqual(res.body.data.sendFeatureRequestMessage.plan, VALID_PLAN)
  const reread = await gql(app, OWNER, GET, { id })
  assert.deepEqual(reread.body.data.featureRequest.plan, VALID_PLAN, 'plan survives a fresh read')
})

for (const [label, planContent] of [
  ['truncated JSON', '{"tickets": [{"key": "T1", "title": "cut off'],
  ['valid JSON, tickets not an array', JSON.stringify({ tickets: 'soon' })],
  ['a ticket missing description', JSON.stringify({ tickets: [{ key: 'T1', title: 'x' }] })],
  ['a ticket with non-string key', JSON.stringify({ tickets: [{ key: 1, title: 'x', description: 'y', dependsOn: [] }] })],
  ['dependsOn holding non-strings', JSON.stringify({ tickets: [{ key: 'T1', title: 'x', description: 'y', dependsOn: [2] }] })],
]) {
  test(`planner robustness: ${label} → no plan stored, no client error`, async () => {
    const app = makeApp(scriptedFetch({ plans: [planContent] }))
    const id = await startSession(app)
    const res = await gql(app, OWNER, SEND, { id, content: 'export my table' })
    assert.equal(res.body.errors, undefined, 'a malformed planner reply is never a client error')
    assert.equal(res.body.data.sendFeatureRequestMessage.plan, null)
    const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
    assert.ok(!('plan' in doc), 'no plan field is written for a malformed reply')
    assert.equal(doc.messages.length, 3, 'the conversational turns still landed')
  })
}

test('planner robustness: a later valid plan replaces the stored plan wholesale', async () => {
  const app = makeApp(
    scriptedFetch({ plans: [JSON.stringify(VALID_PLAN), JSON.stringify(REPLACEMENT_PLAN)] }),
  )
  const id = await startSession(app)

  await gql(app, OWNER, SEND, { id, content: 'export my table' })
  let doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.plan, VALID_PLAN)

  const res = await gql(app, OWNER, SEND, { id, content: 'actually make it one ticket' })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.sendFeatureRequestMessage.plan, REPLACEMENT_PLAN)
  doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.plan, REPLACEMENT_PLAN, 'no trace of the earlier plan remains')
  assert.equal(doc.plan.tickets.length, 1, 'replacement is wholesale, not a merge')
})

test('planner robustness: extra keys from the model never reach Mongo — stored tickets carry exactly key, title, description, dependsOn', async () => {
  const app = makeApp(scriptedFetch({ plans: [JSON.stringify(NOISY_PLAN)] }))
  const id = await startSession(app)
  const res = await gql(app, OWNER, SEND, { id, content: 'export my table' })
  assert.equal(res.body.errors, undefined)

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(Object.keys(doc.plan), ['tickets'], 'top-level extras (confidence) are dropped')
  assert.equal(doc.plan.tickets.length, 1)
  assert.deepEqual(
    Object.keys(doc.plan.tickets[0]).sort(),
    ['dependsOn', 'description', 'key', 'title'],
    'stored ticket fields are exactly the four schema fields',
  )
  assert.deepEqual(doc.plan.tickets[0], {
    key: 'N1',
    title: 'Noisy ticket',
    description: 'Has extra keys.',
    dependsOn: [],
  })
})

// --- criterion 4: ownership + lifecycle ---

test('criterion 4: another uid posting to the session → NOT_FOUND, same shape as an unknown id (existence not leaked)', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app, OWNER)

  const asIntruder = await gql(app, INTRUDER, SEND, { id, content: 'mine now' })
  const asUnknown = await gql(app, INTRUDER, SEND, {
    id: new ObjectId().toString(),
    content: 'mine now',
  })
  for (const res of [asIntruder, asUnknown]) {
    assert.equal(res.status, 200)
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  }
  // Indistinguishable: identical message and extensions either way.
  assert.equal(asIntruder.body.errors[0].message, asUnknown.body.errors[0].message)
  assert.deepEqual(asIntruder.body.errors[0].extensions, asUnknown.body.errors[0].extensions)
  assert.equal(fetch.calls.length, 0, 'no gateway call for either')

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.messages, [], 'the intruder wrote nothing')
})

test('criterion 4: session flipped to approved directly in Mongo → BAD_USER_INPUT, nothing appended', async () => {
  const fetch = scriptedFetch()
  const app = makeApp(fetch)
  const id = await startSession(app)
  await featureRequests().updateOne({ _id: new ObjectId(id) }, { $set: { status: 'approved' } })

  const res = await gql(app, OWNER, SEND, { id, content: 'one more' })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(fetch.calls.length, 0, 'no gateway call against an approved session')
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.deepEqual(doc.messages, [])
})

// --- criterion 5: 429 on the SECOND call; the session is not wedged ---

test('criterion 5: gateway 429 on the architect (second) call → QUOTA_EXHAUSTED on the wire; user message + PO turn persisted; a follow-up send completes', async () => {
  // failCall: 2 → the architect call 429s; PO and (later) everything else succeed.
  const fetch = scriptedFetch({ failCall: 2 })
  const app = makeApp(fetch)
  const id = await startSession(app)

  const failed = await gql(app, OWNER, SEND, { id, content: 'export my table' })
  assert.equal(failed.status, 200)
  assert.equal(failed.body.data, null)
  assert.equal(failed.body.errors[0].extensions.code, 'QUOTA_EXHAUSTED')

  // Re-read shows a consistent partial transcript: user + PO, nothing else.
  const reread = await gql(app, OWNER, GET, { id })
  assert.deepEqual(
    reread.body.data.featureRequest.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'export my table'],
      ['product-owner', PO_TURN],
    ],
  )
  assert.equal(reread.body.data.featureRequest.plan, null)

  // The session is not wedged: the next send runs a full round on top of the
  // partial transcript.
  const retry = await gql(app, OWNER, SEND, { id, content: 'still want the export' })
  assert.equal(retry.body.errors, undefined, 'a follow-up send after quota recovery succeeds')
  assert.deepEqual(
    retry.body.data.sendFeatureRequestMessage.messages.map((m) => m.role),
    ['user', 'product-owner', 'user', 'product-owner', 'architect'],
    'the retry appends on top of the persisted partial transcript',
  )
  assert.deepEqual(retry.body.data.sendFeatureRequestMessage.plan, VALID_PLAN)
})

// --- criterion 6: per-turn usage via myAiUsage delta ---

test('criterion 6: each turn records usage — myAiUsage delta is +4 requests (DAN-50 adds the evaluator) and the sum of the four distinct fixture token counts', async () => {
  const app = makeApp(scriptedFetch())
  const id = await startSession(app)

  const beforeUsage = (await gql(app, OWNER, USAGE)).body.data.myAiUsage
  await gql(app, OWNER, SEND, { id, content: 'export my table' })
  const afterUsage = (await gql(app, OWNER, USAGE)).body.data.myAiUsage

  assert.equal(afterUsage.requests - beforeUsage.requests, 4)
  assert.equal(
    afterUsage.totalTokens - beforeUsage.totalTokens,
    TOKENS_BY_ROLE['product-owner'] +
      TOKENS_BY_ROLE.architect +
      TOKENS_BY_ROLE.planner +
      TOKENS_BY_ROLE['entrance-criteria'],
    'distinct per-role token counts prove all four calls hit the ledger',
  )
})
