// featureRequestCost (DAN-80): what one feature-request session has cost,
// proxied live from the AI gateway's usage ledger and filtered to the
// session's promptId. Tested over HTTP via supertest against the in-process
// app.
// Run with: npm test
//
// The injected aiGateway is a FAKE that records every usage() call and
// returns fixture rows — no test reaches a real gateway. Sessions are seeded
// directly into the scratch collection; Mongo (linear_example_test) is the
// only external dependency, same as the sibling suites.
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

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { GatewayError, createAiGateway } = await import('./aiGateway.js')

// --- fixtures ---

// The live response shape of GET /v1/usage?group_by=prompt_id, verified
// against the gateway's source (ai-gateway/src/usage.js): rows keyed by
// `group` (the promptId, or null for unattributed calls), camelCase number
// fields, costUsd rounded server-side, plus a `total` rollup. `usageBody`
// builds the fixture around the session id under test, alongside a decoy row
// and a null-group row that must never bleed into the answer.
function usageBody(promptId) {
  return {
    persona: 'linear-example-backend',
    window: '30d',
    group_by: 'prompt_id',
    rows: [
      { group: 'prompt-decoy', calls: 99, tokensIn: 9999, tokensOut: 8888, costUsd: 12.34 },
      { group: promptId, calls: 4, tokensIn: 120, tokensOut: 260, costUsd: 0.0134 },
      { group: null, calls: 3, tokensIn: 50, tokensOut: 60, costUsd: 0.002 },
    ],
    total: { calls: 106, tokensIn: 10169, tokensOut: 9208, costUsd: 12.3554 },
  }
}

const EXPECTED_COST = { calls: 4, tokensIn: 120, tokensOut: 260, costUsd: 0.0134 }
const ZERO_COST = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }

// The recording fake: usage() pushes its args and returns the canned body
// (or throws the scripted error). chat is present but must never be called.
function fakeAiGateway({ body = usageBody('prompt-nobody-asked-about'), error } = {}) {
  const calls = []
  return {
    calls,
    async chat() {
      throw new Error('featureRequestCost must never call chat()')
    },
    async usage(args) {
      calls.push(args)
      if (error) throw error
      return body
    },
  }
}

// --- app plumbing (stub verifier, injected fake aiGateway) ---

const TOKENS = {
  'stub-token-alice': { uid: 'uid-alice' },
  'stub-token-bob': { uid: 'uid-bob' },
}
const ALICE = 'stub-token-alice'
const BOB = 'stub-token-bob'

const stubVerify = async (token) => {
  const decoded = TOKENS[token]
  if (!decoded) throw new Error('invalid token')
  return decoded
}

const makeApp = (aiGateway) => createApp({ verifyToken: stubVerify, aiGateway })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const COST = `query ($promptId: ID!) {
  featureRequestCost(promptId: $promptId) { calls tokensIn tokensOut costUsd }
}`

const featureRequests = () => getDb().collection('feature_requests')

async function seedSession({ uid = 'uid-alice' } = {}) {
  const { insertedId } = await featureRequests().insertOne({
    uid,
    status: 'gathering',
    model: 'claude-opus-5',
    messages: [],
    createdAt: new Date(),
  })
  return insertedId.toString()
}

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

// --- criterion 2: the row for exactly that promptId ---

test('featureRequestCost returns the gateway row for exactly the session promptId, requested with group_by prompt_id', async () => {
  const id = await seedSession()
  const gateway = fakeAiGateway({ body: usageBody(id) })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, EXPECTED_COST)
  assert.deepEqual(
    gateway.calls,
    [{ groupBy: 'prompt_id', window: 'all' }],
    'one usage read, grouped by prompt_id, over the LIFETIME window (DAN-107)',
  )
})

test('a session the gateway has no row for costs zeros — never null, never an error', async () => {
  const id = await seedSession()
  // Decoy, foreign, and null-group rows only: nothing matches this session's
  // promptId, and the null-group (unattributed) row must not be picked up.
  const gateway = fakeAiGateway({ body: usageBody('prompt-someone-else') })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, ZERO_COST)
})

test('an empty gateway ledger costs zeros', async () => {
  const id = await seedSession()
  const gateway = fakeAiGateway({
    body: {
      persona: 'linear-example-backend',
      window: '30d',
      group_by: 'prompt_id',
      rows: [],
      total: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
    },
  })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, ZERO_COST)
})

// --- criterion 2: uid scoping and id hygiene — same rules as featureRequest ---

test("another user's session → NOT_FOUND, and the gateway is never called", async () => {
  const id = await seedSession({ uid: 'uid-alice' })
  const gateway = fakeAiGateway({ body: usageBody(id) })

  const res = await gql(makeApp(gateway), BOB, COST, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.data, null, 'non-null return type nulls data overall')
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(res.body.errors[0].message, 'feature request not found')
  assert.equal(gateway.calls.length, 0, 'no usage read for a session the caller cannot see')
})

for (const [label, badId] of [
  ['nonexistent', '0123456789abcdef01234567'],
  ['malformed', 'not-an-object-id'],
]) {
  test(`a ${label} promptId → NOT_FOUND, zero gateway calls (never 5xx)`, async () => {
    const gateway = fakeAiGateway()
    const res = await gql(makeApp(gateway), ALICE, COST, { promptId: badId })
    assert.equal(res.status, 200)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
    assert.equal(gateway.calls.length, 0)
  })
}

// --- criterion 2: gateway failure → INTERNAL, nothing leaked ---

test('a gateway failure maps to INTERNAL without leaking gateway details', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  const id = await seedSession()
  const gateway = fakeAiGateway({
    error: new GatewayError('AI gateway responded 503 to the usage read'),
  })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.status, 200, 'a gateway failure is a domain error, not a 5xx')
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')
  const wire = JSON.stringify(res.body)
  assert.ok(!wire.includes('503'), 'the gateway status must not leak')
  assert.ok(!/gateway/i.test(wire), 'gateway details must not leak')
  assert.ok(errors.mock.callCount() >= 1, 'the real error is logged server-side')
})

// --- the auth gate, same as every session operation ---

test('featureRequestCost without a token → HTTP 401 from the gate, zero gateway calls', async () => {
  const gateway = fakeAiGateway()
  const id = await seedSession()
  const res = await request(makeApp(gateway))
    .post('/api/graphql')
    .send({ query: COST, variables: { promptId: id } })
  assert.equal(res.status, 401)
  assert.equal(gateway.calls.length, 0)
})

// =========================================================================
// DAN-107 — the lifetime window
//
// The production bug: a feature planned YESTERDAY showed "$0.0000 · 0 calls".
// The read asked for no window, the gateway defaulted to `day`, and every
// ledger row older than today's UTC midnight fell outside it. Cost-per-feature
// is a lifetime question, so the read now asks for `window=all` (gateway
// DAN-106: the entire ledger, no lower bound).
//
// Everything below is proved against ONE fixture — a simulated gateway that
// actually honours the window it is asked for — so the same ledger can be
// shown returning zeros under the old request and the real cost under the new
// one. A fake that ignored the window could not tell those two apart.
// =========================================================================

// Midnight today, UTC — the lower bound the gateway's `day` default applies.
function startOfUtcToday() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

const HOUR = 60 * 60 * 1000
const yesterday = () => new Date(startOfUtcToday() - 5 * HOUR)
const earlierToday = () => new Date(startOfUtcToday() + 1 * HOUR)

// A gateway fake that AGGREGATES a ledger of individual calls the way the real
// /v1/usage does, and — the load-bearing part — respects the window it is
// asked for: `all` is the whole ledger with no lower bound, anything else
// (including an omitted window, i.e. the gateway's `day` default) sees only
// calls at or after today's UTC midnight. Rows are shaped exactly like the
// live contract: keyed by `group`, camelCase numbers, costUsd round6.
function ledgerGateway(entries) {
  const calls = []
  const aggregate = (window) => {
    const floor = window === 'all' ? -Infinity : startOfUtcToday()
    const byPrompt = new Map()
    const total = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }
    for (const entry of entries) {
      if (entry.at.getTime() < floor) continue
      const row = byPrompt.get(entry.promptId) ?? {
        group: entry.promptId,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }
      for (const [key, value] of [
        ['calls', 1],
        ['tokensIn', entry.tokensIn],
        ['tokensOut', entry.tokensOut],
        ['costUsd', entry.costUsd],
      ]) {
        row[key] = Number((row[key] + value).toFixed(6))
        total[key] = Number((total[key] + value).toFixed(6))
      }
      byPrompt.set(entry.promptId, row)
    }
    return {
      persona: 'linear-example-backend',
      window: window ?? 'day',
      group_by: 'prompt_id',
      rows: [...byPrompt.values()],
      total,
    }
  }
  return {
    calls,
    aggregate,
    async chat() {
      throw new Error('featureRequestCost must never call chat()')
    },
    async usage(args) {
      calls.push(args)
      return aggregate(args.window)
    },
  }
}

// Three calls, all made yesterday — the shape of the session the user found.
const yesterdayLedger = (promptId) => [
  { promptId, at: yesterday(), tokensIn: 100, tokensOut: 200, costUsd: 0.004 },
  { promptId, at: yesterday(), tokensIn: 50, tokensOut: 60, costUsd: 0.0015 },
  { promptId, at: yesterday(), tokensIn: 30, tokensOut: 40, costUsd: 0.0005 },
  // A decoy prompt, also yesterday: it must never bleed into the answer.
  { promptId: 'prompt-decoy', at: yesterday(), tokensIn: 999, tokensOut: 999, costUsd: 9.9 },
]
const YESTERDAY_TOTAL = { calls: 3, tokensIn: 180, tokensOut: 300, costUsd: 0.006 }

test('DAN-107: a session whose ledger rows ALL predate today reports its real cost', async () => {
  const id = await seedSession()
  const gateway = ledgerGateway(yesterdayLedger(id))

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, YESTERDAY_TOTAL)
  assert.deepEqual(
    gateway.calls,
    [{ groupBy: 'prompt_id', window: 'all' }],
    'the lifetime window is what made this visible',
  )
})

test('DAN-107 regression: the OLD day-window request returned zeros for that very ledger', async () => {
  const id = await seedSession()
  const gateway = ledgerGateway(yesterdayLedger(id))

  // Exactly the arguments the pre-DAN-107 code sent: group_by and nothing
  // else, so the gateway's `day` default applied.
  const oldBody = await gateway.usage({ groupBy: 'prompt_id' })
  assert.equal(oldBody.window, 'day')
  assert.deepEqual(oldBody.rows, [], "the day window cannot see yesterday's calls — this WAS the bug")

  // And end to end: served that old-shape body, the resolver reports zeros —
  // the "$0.0000 · 0 calls" the user saw in production.
  const res = await gql(makeApp(fakeAiGateway({ body: oldBody })), ALICE, COST, { promptId: id })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, ZERO_COST)

  // Same ledger, new request: a real number. The fixture is the control.
  const fixed = await gql(makeApp(ledgerGateway(yesterdayLedger(id))), ALICE, COST, { promptId: id })
  assert.deepEqual(fixed.body.data.featureRequestCost, YESTERDAY_TOTAL)
  assert.notDeepEqual(fixed.body.data.featureRequestCost, ZERO_COST)
})

test('DAN-107: a session spanning yesterday AND today reports the full total, not just today', async () => {
  const id = await seedSession()
  const entries = [
    { promptId: id, at: yesterday(), tokensIn: 100, tokensOut: 200, costUsd: 0.004 },
    { promptId: id, at: earlierToday(), tokensIn: 10, tokensOut: 20, costUsd: 0.0006 },
  ]
  const gateway = ledgerGateway(entries)

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.deepEqual(res.body.data.featureRequestCost, {
    calls: 2,
    tokensIn: 110,
    tokensOut: 220,
    costUsd: 0.0046,
  })
  // The day window would have undercounted rather than zeroed: a partial
  // answer is the same bug wearing a plausible number.
  assert.deepEqual(gateway.aggregate(undefined).rows, [
    { group: id, calls: 1, tokensIn: 10, tokensOut: 20, costUsd: 0.0006 },
  ])
})

// --- criterion 1: the exact URL, over the REAL client and a captured fetch ---

// The tests above pin the ARGUMENTS featureRequestCost passes; this one pins
// what those arguments become on the wire, by driving the resolver through the
// real createAiGateway over a stub transport. No network: the stub answers.
function stubFetch({ status = 200, body } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  fn.calls = calls
  return fn
}

const REAL_GATEWAY_URL = 'https://gateway.dan107.invalid'
const REAL_GATEWAY_KEY = 'dan107-virtual-key'

// Set AI_GATEWAY_* for one test and restore them; K_SERVICE is forced off so
// the header assertions describe the local (non-Cloud-Run) path.
function withGatewayEnv(t) {
  const saved = {
    AI_GATEWAY_URL: process.env.AI_GATEWAY_URL,
    AI_GATEWAY_KEY: process.env.AI_GATEWAY_KEY,
    K_SERVICE: process.env.K_SERVICE,
  }
  process.env.AI_GATEWAY_URL = REAL_GATEWAY_URL
  process.env.AI_GATEWAY_KEY = REAL_GATEWAY_KEY
  delete process.env.K_SERVICE
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

test('captured transport: the cost read GETs /v1/usage?group_by=prompt_id&window=all', async (t) => {
  withGatewayEnv(t)
  const id = await seedSession()
  const fetch = stubFetch({ body: usageBody(id) })
  const gateway = createAiGateway({ fetch, recordUsage: async () => {} })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestCost, EXPECTED_COST)

  assert.equal(fetch.calls.length, 1, 'exactly one gateway request')
  const { url, init } = fetch.calls[0]
  assert.equal(url, `${REAL_GATEWAY_URL}/v1/usage?group_by=prompt_id&window=all`)
  // Both parameters, spelled out: the grouping AND the window.
  const sent = new URL(url)
  assert.equal(sent.searchParams.get('group_by'), 'prompt_id')
  assert.equal(sent.searchParams.get('window'), 'all')
  assert.equal(init.method, undefined, 'still a plain GET')
  assert.equal(init.body, undefined)
  assert.deepEqual(Object.keys(init.headers), ['x-gateway-key'], 'auth unchanged by DAN-107')
  assert.equal(init.headers['x-gateway-key'], REAL_GATEWAY_KEY)
})

// --- criterion 3: the rollout failure mode ---

// Until the gateway's DAN-106 finishes deploying, `window=all` is an unknown
// parameter and the gateway answers 400. This asserts that a 400 takes the
// SAME path a 503 has always taken — GatewayError → INTERNAL, generic message,
// real error logged server-side, nothing about the gateway on the wire. No new
// error class reaches the request view.
test('rollout: a gateway 400 on window=all degrades exactly like any other gateway failure', async (t) => {
  withGatewayEnv(t)
  const errors = t.mock.method(console, 'error', () => {})
  const id = await seedSession()
  const fetch = stubFetch({
    status: 400,
    body: { error: { message: "unknown window 'all'" } },
  })
  const gateway = createAiGateway({ fetch, recordUsage: async () => {} })

  const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

  assert.equal(res.status, 200, 'a rejected usage read is a domain error, not a 5xx')
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors.length, 1)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL', 'the established mapping, not a new code')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')
  const wire = JSON.stringify(res.body)
  assert.ok(!wire.includes('400'), 'the gateway status must not leak')
  assert.ok(!/gateway/i.test(wire), 'gateway details must not leak')
  assert.ok(!/window/i.test(wire), 'the rejected parameter must not leak either')
  assert.ok(errors.mock.callCount() >= 1, 'the real error is logged server-side')
})

// The 400 is not a special case anywhere: every non-2xx the usage read can
// receive lands on the same INTERNAL, with the same generic message.
for (const status of [400, 429, 500, 503]) {
  test(`rollout: a gateway ${status} on the cost read is INTERNAL with the same generic message`, async (t) => {
    withGatewayEnv(t)
    t.mock.method(console, 'error', () => {})
    const id = await seedSession()
    const gateway = createAiGateway({
      fetch: stubFetch({ status, body: { error: { message: 'nope' } } }),
      recordUsage: async () => {},
    })

    const res = await gql(makeApp(gateway), ALICE, COST, { promptId: id })

    assert.equal(res.status, 200)
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
    assert.equal(res.body.errors[0].message, 'Internal Server Error')
  })
}
