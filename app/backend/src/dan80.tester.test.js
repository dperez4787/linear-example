// DAN-80 tester verification: linearProjectUrl persisted+served from approval,
// and featureRequestCost proxied from the gateway's usage ledger. Written
// independently from the ticket's acceptance criteria and the VERIFIED gateway
// contract (ai-gateway/src/usage.js) — not from the developer's tests.
// Run with: npm test
//
// Seams: stub token verifier, a recording fake Linear client, and the REAL
// createAiGateway over a scripted capturing fetch — so the usage-read
// assertions below pin the exact URL, headers, and response-shape consumption
// production performs. Mongo (linear_example_test) is the only external
// dependency; no test dials a network.
//
// The verified live contract of GET /v1/usage?group_by=prompt_id:
//   { persona, window, group_by,
//     rows: [{ group: <promptId-or-null>, calls, tokensIn, tokensOut, costUsd }],
//     total }
// — the array is `rows`, the key is `group`, the numbers are camelCase. The
// developer's first commit assumed { data: [{ prompt_id, tokens_in, ... }] };
// the wrong-shape probes below prove the shipped code does NOT tolerate that
// shape (it must yield zeros, never a nonzero cost).
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
// Read lazily inside the gateway client; the scripted fetch never dials them.
process.env.AI_GATEWAY_URL = 'https://gateway.dan80.tester.invalid'
process.env.AI_GATEWAY_KEY = 'dan80-tester-virtual-key'
// Off Cloud Run, explicitly: the transport assertions below pin the exact
// header set sent when K_SERVICE is absent.
delete process.env.K_SERVICE

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')
const { ObjectId } = await import('mongodb')

const GATEWAY_URL = process.env.AI_GATEWAY_URL
const GATEWAY_KEY = process.env.AI_GATEWAY_KEY

// --- auth plumbing (stub verifier, two users) ---

const TOKENS = {
  'tester-token-alice': { uid: 'uid-tester-alice' },
  'tester-token-bob': { uid: 'uid-tester-bob' },
}
const ALICE = 'tester-token-alice'
const BOB = 'tester-token-bob'
const stubVerify = async (token) => {
  const decoded = TOKENS[token]
  if (!decoded) throw new Error('invalid token')
  return decoded
}

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const featureRequests = () => getDb().collection('feature_requests')

// --- the capturing gateway transport ---
//
// A REAL createAiGateway instance over a scripted fetch: `calls` records every
// request (url + init) so the tests assert the actual wire request, and the
// scripted response is returned as a Response-alike. recordUsage is a no-op —
// a usage READ must never write the ledger (asserted below).
function capturedGateway({ status = 200, body, reject } = {}) {
  const calls = []
  const recorded = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init })
    if (reject) throw reject
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  const gateway = createAiGateway({
    fetch,
    recordUsage: async (entry) => {
      recorded.push(entry)
    },
  })
  return { gateway, calls, recorded }
}

// The verified live body, parameterized on which promptId owns the target row.
// Decoy and null-group rows are always present so exact-row filtering (not
// first-row, not total, not the unattributed bucket) is what passes.
function liveUsageBody(promptId) {
  return {
    persona: 'linear-example-backend',
    window: '30d',
    group_by: 'prompt_id',
    rows: [
      { group: 'decoy-before', calls: 50, tokensIn: 5000, tokensOut: 4000, costUsd: 7.77 },
      { group: promptId, calls: 6, tokensIn: 321, tokensOut: 654, costUsd: 0.0421 },
      { group: null, calls: 2, tokensIn: 40, tokensOut: 80, costUsd: 0.001 },
      { group: 'decoy-after', calls: 8, tokensIn: 800, tokensOut: 900, costUsd: 1.5 },
    ],
    total: { calls: 66, tokensIn: 6161, tokensOut: 5634, costUsd: 9.3131 },
  }
}

const MATCHED_COST = { calls: 6, tokensIn: 321, tokensOut: 654, costUsd: 0.0421 }
const ZERO_COST = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }

const COST_QUERY = `query ($promptId: ID!) {
  featureRequestCost(promptId: $promptId) { calls tokensIn tokensOut costUsd }
}`

// --- the fake Linear client for the approval path (written from the
// linearClient interface, not copied from the developer's fixture) ---

const T_PROJECT_ID = 'tester-project-id'
const T_PROJECT_URL = 'https://linear.app/tester/project/dan80'

function fakeLinear({ omitProjectUrl = false } = {}) {
  let n = 0
  return {
    config: () => ({ teamId: 'tester-team', readyForDevStateId: 'tester-ready' }),
    findOrCreateLabels: async (names) =>
      Object.fromEntries(names.map((name) => [name, `tester-label:${name}`])),
    createProject: async () => {
      const project = { id: T_PROJECT_ID }
      if (!omitProjectUrl) project.url = T_PROJECT_URL
      return project
    },
    createIssue: async () => {
      n += 1
      return {
        id: `tester-issue-${n}`,
        identifier: `DAN-90${n}`,
        url: `https://linear.app/tester/issue/DAN-90${n}`,
      }
    },
    createRelation: async () => ({ id: `tester-relation-${++n}` }),
  }
}

const APPROVABLE_GATES = Object.fromEntries(
  ['notTooBig', 'notAmbiguous', 'noBlockedDependencies'].map((g) => [
    g,
    { pass: true, reason: `tester: ${g} ok` },
  ]),
)

async function seedApprovable({ uid = 'uid-tester-alice' } = {}) {
  const { insertedId } = await featureRequests().insertOne({
    uid,
    status: 'gathering',
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'tester seed', createdAt: new Date() }],
    createdAt: new Date(),
    plan: {
      tickets: [
        { key: 'T1', title: 'One', description: 'First.', dependsOn: [] },
        { key: 'T2', title: 'Two', description: 'Second.', dependsOn: ['T1'] },
      ],
    },
    entranceCriteria: APPROVABLE_GATES,
  })
  return insertedId.toString()
}

// A bare gathering session — enough for the uid-scoped cost read.
async function seedSession({ uid = 'uid-tester-alice' } = {}) {
  const { insertedId } = await featureRequests().insertOne({
    uid,
    status: 'gathering',
    model: 'claude-opus-5',
    messages: [],
    createdAt: new Date(),
  })
  return insertedId.toString()
}

const makeApp = ({ gateway, linearClient } = {}) =>
  createApp({
    verifyToken: stubVerify,
    ...(gateway ? { aiGateway: gateway } : {}),
    ...(linearClient ? { linearClient } : {}),
  })

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await featureRequests().deleteMany({})
})

after(async () => {
  await featureRequests().deleteMany({})
  await getDb().client.close()
})

// =========================================================================
// Criterion 1 — linearProjectUrl: persisted at approval, served on the wire
// =========================================================================

test('approval persists projectCreate url and every later read serves it: mutation result, single read, list', async () => {
  const app = makeApp({ linearClient: fakeLinear() })
  const id = await seedApprovable()

  const approved = await gql(app, ALICE, `mutation ($id: ID!) {
    approveFeatureRequestPlan(id: $id) { id status linearProjectId linearProjectUrl }
  }`, { id })
  assert.equal(approved.body.errors, undefined)
  assert.equal(approved.body.data.approveFeatureRequestPlan.status, 'building')
  assert.equal(approved.body.data.approveFeatureRequestPlan.linearProjectUrl, T_PROJECT_URL)

  // Persisted, not merely echoed from the in-flight mutation.
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.linearProjectUrl, T_PROJECT_URL, 'the url is stored on the document')

  // A FRESH app (new gateway/linear instances) serves it from Mongo alone.
  const freshApp = makeApp({ linearClient: fakeLinear() })
  const single = await gql(freshApp, ALICE, `query ($id: ID!) {
    featureRequest(id: $id) { linearProjectUrl }
  }`, { id })
  assert.equal(single.body.errors, undefined)
  assert.equal(single.body.data.featureRequest.linearProjectUrl, T_PROJECT_URL)

  const list = await gql(freshApp, ALICE, `query { featureRequests { id linearProjectUrl } }`)
  assert.equal(list.body.errors, undefined)
  assert.deepEqual(list.body.data.featureRequests, [{ id, linearProjectUrl: T_PROJECT_URL }])
})

test('a legacy approved session (document predates the field) serves linearProjectUrl null on single read, without erroring', async () => {
  const app = makeApp({})
  // Exactly what DAN-51 wrote: project id + tickets, NO linearProjectUrl key.
  const { insertedId } = await featureRequests().insertOne({
    uid: 'uid-tester-alice',
    status: 'building',
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'legacy', createdAt: new Date() }],
    createdAt: new Date(),
    linearProjectId: 'legacy-project-id',
    tickets: [
      {
        key: 'T1',
        linearIssueId: 'legacy-issue-1',
        identifier: 'DAN-1',
        url: 'https://linear.app/tester/issue/DAN-1',
      },
    ],
  })
  const id = insertedId.toString()

  const res = await gql(app, ALICE, `query ($id: ID!) {
    featureRequest(id: $id) { status linearProjectId linearProjectUrl tickets { identifier } }
  }`, { id })

  assert.equal(res.body.errors, undefined, 'legacy documents must not error')
  assert.equal(res.body.data.featureRequest.linearProjectId, 'legacy-project-id')
  assert.equal(res.body.data.featureRequest.linearProjectUrl, null)
  assert.deepEqual(res.body.data.featureRequest.tickets, [{ identifier: 'DAN-1' }])
})

test('legacy and new sessions coexist in the list: null and the url, side by side, no errors', async () => {
  const app = makeApp({ linearClient: fakeLinear() })
  // Legacy doc first.
  await featureRequests().insertOne({
    uid: 'uid-tester-alice',
    status: 'building',
    model: 'claude-opus-5',
    messages: [],
    createdAt: new Date(Date.now() - 1000),
    linearProjectId: 'legacy-project-id',
    tickets: [],
  })
  // Then a session approved through the real mutation.
  const id = await seedApprovable()
  const approved = await gql(app, ALICE, `mutation ($id: ID!) {
    approveFeatureRequestPlan(id: $id) { id }
  }`, { id })
  assert.equal(approved.body.errors, undefined)

  const res = await gql(app, ALICE, `query { featureRequests { linearProjectUrl } }`)
  assert.equal(res.body.errors, undefined, 'a mixed list must not error')
  const urls = res.body.data.featureRequests.map((fr) => fr.linearProjectUrl).sort()
  assert.deepEqual(urls, [T_PROJECT_URL, null].sort(), 'one null (legacy), one real url (new)')
})

test('projectCreate returning no url: approval still succeeds and serves null, never an error', async () => {
  const app = makeApp({ linearClient: fakeLinear({ omitProjectUrl: true }) })
  const id = await seedApprovable()

  const res = await gql(app, ALICE, `mutation ($id: ID!) {
    approveFeatureRequestPlan(id: $id) { status linearProjectId linearProjectUrl }
  }`, { id })

  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.approveFeatureRequestPlan.status, 'building')
  assert.equal(res.body.data.approveFeatureRequestPlan.linearProjectId, T_PROJECT_ID)
  assert.equal(res.body.data.approveFeatureRequestPlan.linearProjectUrl, null)
})

// =========================================================================
// Criterion 2 — featureRequestCost: exact-row filtering over the REAL client
// =========================================================================

test('featureRequestCost serves exactly the matching row — decoys and the null-group bucket never bleed in', async () => {
  const id = await seedSession()
  const { gateway, calls, recorded } = capturedGateway({ body: liveUsageBody(id) })

  const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, MATCHED_COST)
  assert.equal(calls.length, 1, 'exactly one gateway request')
  assert.equal(recorded.length, 0, 'a usage READ records nothing to the ledger')
})

test('captured transport: GET ${AI_GATEWAY_URL}/v1/usage?group_by=prompt_id, headers exactly x-gateway-key off Cloud Run', async () => {
  const id = await seedSession()
  const { gateway, calls } = capturedGateway({ body: liveUsageBody(id) })

  await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, `${GATEWAY_URL}/v1/usage?group_by=prompt_id`)
  assert.ok(url.endsWith('/v1/usage?group_by=prompt_id'))
  assert.equal(init.method, undefined, 'a plain GET: no method override')
  assert.equal(init.body, undefined, 'no body on the usage read')
  assert.deepEqual(
    Object.keys(init.headers),
    ['x-gateway-key'],
    'off Cloud Run the ONLY header is the virtual key — no Authorization, no Content-Type',
  )
  assert.equal(init.headers['x-gateway-key'], GATEWAY_KEY)
})

test('rows: [] serves zeros — never null, never an error', async () => {
  const id = await seedSession()
  const { gateway } = capturedGateway({
    body: {
      persona: 'linear-example-backend',
      window: '30d',
      group_by: 'prompt_id',
      rows: [],
      total: ZERO_COST,
    },
  })

  const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, ZERO_COST)
})

test('no row for this promptId serves zeros — the null-group and total rollup are not fallbacks', async () => {
  const id = await seedSession()
  const { gateway } = capturedGateway({ body: liveUsageBody('some-other-session') })

  const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, ZERO_COST)
})

// --- the wrong-shape probes: the mapping must pin the REAL contract ---

test("the dev's originally-assumed shape { data: [{ prompt_id, tokens_in, ... }] } yields ZEROS — the mapping must not tolerate it", async () => {
  const id = await seedSession()
  const { gateway } = capturedGateway({
    body: {
      data: [
        { prompt_id: id, calls: 7, tokens_in: 700, tokens_out: 800, cost_usd: 9.99 },
      ],
    },
  })

  const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(res.body.errors, undefined, 'an unrecognized body is zeros, not a crash')
  assert.deepEqual(
    res.body.data.featureRequestCost,
    ZERO_COST,
    'a body in the old wrong shape must NOT produce a nonzero cost',
  )
})

test('rows keyed prompt_id instead of group yield ZEROS — the row key is `group`', async () => {
  const id = await seedSession()
  const { gateway } = capturedGateway({
    body: {
      rows: [{ prompt_id: id, calls: 5, tokensIn: 100, tokensOut: 200, costUsd: 1.23 }],
    },
  })

  const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, ZERO_COST)
})

test('a matched row with snake_case number fields yields zeros for those fields — the numbers are read camelCase', async () => {
  const id = await seedSession()
  const { gateway } = capturedGateway({
    body: {
      rows: [{ group: id, calls: 3, tokens_in: 111, tokens_out: 222, cost_usd: 9.9 }],
    },
  })

  const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(res.body.errors, undefined)
  // `calls` collides between the shapes, so it reads through; the three
  // snake_case-only fields must NOT.
  assert.deepEqual(res.body.data.featureRequestCost, {
    calls: 3,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  })
})

// --- uid scoping: NOT_FOUND identical to featureRequest, zero gateway calls ---

test("a foreign session (bob reading alice's) → NOT_FOUND with the SAME error shape as featureRequest, and ZERO gateway calls", async () => {
  const id = await seedSession({ uid: 'uid-tester-alice' })
  const { gateway, calls } = capturedGateway({ body: liveUsageBody(id) })
  const app = makeApp({ gateway })

  const costRes = await gql(app, BOB, COST_QUERY, { promptId: id })
  const frRes = await gql(app, BOB, `query ($id: ID!) {
    featureRequest(id: $id) { id }
  }`, { id })

  assert.equal(costRes.status, 200)
  assert.equal(costRes.body.data, null, 'non-null return type nulls data overall')
  assert.equal(costRes.body.errors.length, 1)
  assert.equal(costRes.body.errors[0].message, frRes.body.errors[0].message, 'identical message')
  assert.deepEqual(
    costRes.body.errors[0].extensions,
    frRes.body.errors[0].extensions,
    'identical extensions (code NOT_FOUND)',
  )
  assert.equal(costRes.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(calls.length, 0, 'the gateway must never be consulted for an invisible session')
})

for (const [label, badId] of [
  ['unknown', new ObjectId().toString()],
  ['malformed', 'definitely-not-an-object-id'],
]) {
  test(`a ${label} promptId → NOT_FOUND (HTTP 200, never a 5xx), zero gateway calls`, async () => {
    const { gateway, calls } = capturedGateway({ body: liveUsageBody(badId) })

    const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: badId })

    assert.equal(res.status, 200)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
    assert.equal(res.body.errors[0].message, 'feature request not found')
    assert.equal(calls.length, 0)
  })
}

// --- gateway failure → INTERNAL, nothing leaked ---

test('a non-2xx gateway response → INTERNAL: generic message, no status/url/gateway detail on the wire, real error logged', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const id = await seedSession()
  const { gateway } = capturedGateway({ status: 503, body: { error: 'upstream exploded' } })

  const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(res.status, 200, 'a gateway failure is a GraphQL domain error, not an HTTP 5xx')
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')
  const wire = JSON.stringify(res.body)
  assert.ok(!wire.includes('503'), 'the upstream status must not leak')
  assert.ok(!/gateway/i.test(wire), 'the word "gateway" must not leak')
  assert.ok(!wire.includes('usage'), 'the endpoint must not leak')
  assert.ok(!wire.includes(GATEWAY_URL), 'the gateway url must not leak')
  assert.ok(!wire.includes(GATEWAY_KEY), 'the virtual key must not leak')
  assert.ok(logged.mock.callCount() >= 1, 'the real error IS logged server-side')
})

test('a network-level gateway failure → INTERNAL with the same generic message', async (t) => {
  t.mock.method(console, 'error', () => {})
  const id = await seedSession()
  const { gateway } = capturedGateway({ reject: new Error('ECONNREFUSED 10.0.0.7:443') })

  const res = await gql(makeApp({ gateway }), ALICE, COST_QUERY, { promptId: id })

  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')
  assert.ok(!JSON.stringify(res.body).includes('ECONNREFUSED'), 'transport errors must not leak')
})

// --- the auth gate holds for the new query ---

test('featureRequestCost without a token → HTTP 401 before GraphQL, zero gateway calls', async () => {
  const id = await seedSession()
  const { gateway, calls } = capturedGateway({ body: liveUsageBody(id) })

  const res = await request(makeApp({ gateway }))
    .post('/api/graphql')
    .send({ query: COST_QUERY, variables: { promptId: id } })

  assert.equal(res.status, 401)
  assert.equal(calls.length, 0)
})
