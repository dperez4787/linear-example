// approveFeatureRequestPlan (DAN-51): approving a session that passes all
// gates files one Linear project plus its tickets — labels, blocked-by
// relations, Ready for Dev for unblocked tickets — and moves the session to
// "building". Tested over HTTP via supertest against the in-process app.
// Run with: npm test
//
// The injected linearClient is a FAKE that records every call and returns
// fixture ids/urls (criterion 7) — no test reaches real Linear. Sessions are
// seeded directly into the scratch collection so each test controls the gates
// and the plan exactly; Mongo (linear_example_test) is the only external
// dependency, same as the sibling suites.
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
const { ObjectId } = await import('mongodb')

// --- fixtures ---

const TEAM_ID = 'team-fixture-id'
const READY_STATE_ID = 'state-ready-fixture-id'
const PROJECT_ID = 'project-fixture-id'
const PROJECT_URL = 'https://linear.app/fixture/project/paf'

const GATES = ['notTooBig', 'notAmbiguous', 'noBlockedDependencies']

function gates(overrides = {}) {
  return Object.fromEntries(
    GATES.map((g) => [g, overrides[g] ?? { pass: true, reason: `fixture: ${g} ok` }]),
  )
}

// T1 has no blockers; T2 depends on T1; T3 depends on both — so the fixture
// exercises Ready-for-Dev-at-create, Backlog-by-omission, and a multi-edge
// dependency fan-in.
const PLAN = {
  tickets: [
    { key: 'T1', title: 'Backend: export query', description: 'CSV of all records.', dependsOn: [] },
    { key: 'T2', title: 'Frontend: export button', description: 'Download via api.js.', dependsOn: ['T1'] },
    { key: 'T3', title: 'Docs: export section', description: 'Document the export.', dependsOn: ['T1', 'T2'] },
  ],
}

// The recording fake (criterion 7): every method pushes { method, args } onto
// `calls` and returns fixture ids/urls. `failOn`/`failAt` script a Linear
// failure at the Nth call of one method, for the mid-creation-failure test.
function fakeLinearClient({ failOn, failAt = 1 } = {}) {
  const calls = []
  const counts = {}
  let issueN = 0

  function record(method, args) {
    calls.push({ method, args })
    counts[method] = (counts[method] ?? 0) + 1
    if (method === failOn && counts[method] === failAt) {
      throw new Error(`fixture Linear failure on ${method} #${failAt}`)
    }
  }

  const client = {
    calls,
    config() {
      record('config', {})
      return { teamId: TEAM_ID, readyForDevStateId: READY_STATE_ID }
    },
    async findOrCreateLabels(names) {
      record('findOrCreateLabels', { names })
      return Object.fromEntries(names.map((name) => [name, `label-id:${name}`]))
    },
    async createProject(args) {
      record('createProject', args)
      return { id: PROJECT_ID, url: PROJECT_URL }
    },
    async createIssue(args) {
      record('createIssue', args)
      issueN += 1
      return {
        id: `issue-id-${issueN}`,
        identifier: `DAN-10${issueN}`,
        url: `https://linear.app/fixture/issue/DAN-10${issueN}`,
      }
    },
    async createRelation(args) {
      record('createRelation', args)
      return { id: `relation-id-${calls.length}` }
    },
  }
  client.callsTo = (method) => calls.filter((c) => c.method === method)
  return client
}

// --- app plumbing (stub verifier, injected fake linearClient) ---

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

const makeApp = (linearClient) => createApp({ verifyToken: stubVerify, linearClient })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const FR_FIELDS = `id status model linearProjectId linearProjectUrl
  tickets { key identifier url }
  plan { tickets { key } }
  approvable`
const APPROVE = `mutation ($id: ID!) {
  approveFeatureRequestPlan(id: $id) { ${FR_FIELDS} }
}`

const featureRequests = () => getDb().collection('feature_requests')

// Seed a session document directly — the DAN-49/50 pipeline is not under test
// here, the approval of its stored outcome is.
async function seedSession({
  uid = 'uid-alice',
  status = 'gathering',
  model = 'claude-opus-5',
  plan = PLAN,
  entranceCriteria = gates(),
} = {}) {
  const doc = {
    uid,
    status,
    model,
    messages: [
      { role: 'user', content: 'Please add a CSV export of the records table', createdAt: new Date() },
      { role: 'product-owner', content: 'Refined scope.', createdAt: new Date() },
      { role: 'architect', content: 'Feasible.', createdAt: new Date() },
    ],
    createdAt: new Date(),
  }
  if (plan !== null) doc.plan = plan
  if (entranceCriteria !== null) doc.entranceCriteria = entranceCriteria
  const { insertedId } = await featureRequests().insertOne(doc)
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

// --- criterion 2: not approvable → BAD_USER_INPUT naming the gates, zero Linear calls ---

test('approving a session with failing gates → 200, BAD_USER_INPUT naming the failing gate(s), zero Linear calls, session untouched', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession({
    entranceCriteria: gates({
      notTooBig: { pass: false, reason: 'too big' },
      noBlockedDependencies: { pass: false, reason: 'blocked' },
    }),
  })

  const res = await gql(app, ALICE, APPROVE, { id })

  assert.equal(res.status, 200, 'a domain failure is never an HTTP 4xx/5xx')
  assert.equal(res.body.data, null, 'non-null mutation return type nulls data overall')
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.match(res.body.errors[0].message, /notTooBig/, 'names the first failing gate')
  assert.match(res.body.errors[0].message, /noBlockedDependencies/, 'names the second failing gate')
  assert.ok(
    !/notAmbiguous/.test(res.body.errors[0].message),
    'a passing gate is not named as failing',
  )
  assert.equal(linear.calls.length, 0, 'the fake client records zero calls')

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'gathering')
  assert.equal(doc.linearProjectId, undefined)
})

test('approving a never-evaluated session (no stored gates) → BAD_USER_INPUT, zero Linear calls', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession({ entranceCriteria: null })

  const res = await gql(app, ALICE, APPROVE, { id })

  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(linear.calls.length, 0)
})

test('approving an approvable session with NO plan → BAD_USER_INPUT, zero Linear calls', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession({ plan: null })

  const res = await gql(app, ALICE, APPROVE, { id })

  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.match(res.body.errors[0].message, /plan/)
  assert.equal(linear.calls.length, 0)
})

// --- criterion 3: the recorded Linear calls, exactly ---

test('approving an approvable session files one project, one issue per plan ticket with labels, dependsOn relations, and Ready for Dev for unblocked tickets', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession()

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)

  // One project, named from the session, description carrying the promptId.
  const projects = linear.callsTo('createProject')
  assert.equal(projects.length, 1, 'exactly one project created')
  assert.equal(projects[0].args.teamId, TEAM_ID)
  assert.equal(
    projects[0].args.name,
    'paf: Please add a CSV export of the records table',
    'name is the first user message with the paf: prefix',
  )
  assert.match(projects[0].args.description, new RegExp(id), 'description carries the promptId')

  // Labels: agent:<harness> (claude-opus-5 → claude) and prompt:<promptId>.
  const labelCalls = linear.callsTo('findOrCreateLabels')
  assert.equal(labelCalls.length, 1)
  assert.deepEqual(labelCalls[0].args.names, ['agent:claude', `prompt:${id}`])

  // One issue per plan ticket, in order, each carrying title, description,
  // the project, and BOTH labels.
  const issues = linear.callsTo('createIssue')
  assert.equal(issues.length, PLAN.tickets.length)
  for (const [i, ticket] of PLAN.tickets.entries()) {
    assert.equal(issues[i].args.teamId, TEAM_ID)
    assert.equal(issues[i].args.projectId, PROJECT_ID)
    assert.equal(issues[i].args.title, ticket.title)
    assert.equal(issues[i].args.description, ticket.description)
    assert.deepEqual(issues[i].args.labelIds, ['label-id:agent:claude', `label-id:prompt:${id}`])
  }

  // No blockers → Ready for Dev at create time; blocked → no stateId (Backlog).
  assert.equal(issues[0].args.stateId, READY_STATE_ID, 'T1 has no blockers → Ready for Dev')
  assert.equal(issues[1].args.stateId, undefined, 'T2 is blocked → left in Backlog')
  assert.equal(issues[2].args.stateId, undefined, 'T3 is blocked → left in Backlog')

  // Blocked-by relations exactly matching the plan's dependsOn edges:
  // T2←T1, T3←T1, T3←T2, expressed as blocker-blocks-dependent.
  const relations = linear.callsTo('createRelation').map((c) => c.args)
  assert.deepEqual(relations, [
    { issueId: 'issue-id-1', relatedIssueId: 'issue-id-2', type: 'blocks' },
    { issueId: 'issue-id-1', relatedIssueId: 'issue-id-3', type: 'blocks' },
    { issueId: 'issue-id-2', relatedIssueId: 'issue-id-3', type: 'blocks' },
  ])
})

// --- criterion 4: persistence + the returned FeatureRequest ---

test('approval persists status "building", linearProjectId, linearProjectUrl, and per-ticket identities, and the returned FeatureRequest reflects all of it', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession()

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.body.errors, undefined)

  const fr = res.body.data.approveFeatureRequestPlan
  assert.equal(fr.id, id)
  assert.equal(fr.status, 'building')
  assert.equal(fr.linearProjectId, PROJECT_ID)
  // DAN-80: the projectCreate url is persisted and served at approval time.
  assert.equal(fr.linearProjectUrl, PROJECT_URL)
  assert.deepEqual(fr.tickets, [
    { key: 'T1', identifier: 'DAN-101', url: 'https://linear.app/fixture/issue/DAN-101' },
    { key: 'T2', identifier: 'DAN-102', url: 'https://linear.app/fixture/issue/DAN-102' },
    { key: 'T3', identifier: 'DAN-103', url: 'https://linear.app/fixture/issue/DAN-103' },
  ])

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'building')
  assert.equal(doc.linearProjectId, PROJECT_ID)
  assert.equal(doc.linearProjectUrl, PROJECT_URL, 'the url is persisted, not just echoed')
  assert.deepEqual(doc.tickets, [
    { key: 'T1', linearIssueId: 'issue-id-1', identifier: 'DAN-101', url: 'https://linear.app/fixture/issue/DAN-101' },
    { key: 'T2', linearIssueId: 'issue-id-2', identifier: 'DAN-102', url: 'https://linear.app/fixture/issue/DAN-102' },
    { key: 'T3', linearIssueId: 'issue-id-3', identifier: 'DAN-103', url: 'https://linear.app/fixture/issue/DAN-103' },
  ])
})

// --- criterion 5: a second approval is refused and files nothing ---

test('a second approval → BAD_USER_INPUT "already approved"; no second project in the recorded calls', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession()

  const first = await gql(app, ALICE, APPROVE, { id })
  assert.equal(first.body.errors, undefined)

  const second = await gql(app, ALICE, APPROVE, { id })
  assert.equal(second.status, 200)
  assert.equal(second.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.match(second.body.errors[0].message, /already approved/)
  assert.equal(linear.callsTo('createProject').length, 1, 'still exactly one project')
})

// --- criterion 6: Linear failure mid-creation → INTERNAL, session stays gathering ---

test('a Linear failure mid-creation → 200 with INTERNAL, session stays "gathering" with nothing persisted, retry remains possible', async () => {
  // Fail on the SECOND issue create: the project and one issue already exist
  // in Linear when the failure hits — the honest mid-creation case.
  const failing = fakeLinearClient({ failOn: 'createIssue', failAt: 2 })
  const app = makeApp(failing)
  const id = await seedSession()

  const res = await gql(app, ALICE, APPROVE, { id })

  assert.equal(res.status, 200)
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(
    res.body.errors[0].message,
    'Internal Server Error',
    'the Linear failure detail never leaks to the client',
  )

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'gathering', 'the session stays gathering')
  assert.equal(doc.linearProjectId, undefined, 'no project id persisted')
  assert.equal(doc.linearProjectUrl, undefined, 'no project url persisted')
  assert.equal(doc.tickets, undefined, 'no tickets persisted')

  // Retry with a healthy client succeeds (partial cleanup is out of scope —
  // the retry files a fresh project; DAN-51 accepts that trade-off).
  const healthy = fakeLinearClient()
  const retryRes = await gql(makeApp(healthy), ALICE, APPROVE, { id })
  assert.equal(retryRes.body.errors, undefined)
  assert.equal(retryRes.body.data.approveFeatureRequestPlan.status, 'building')
})

// --- ownership + id hygiene (same rules as every other session operation) ---

test('approving another user\'s session → NOT_FOUND, zero Linear calls', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession({ uid: 'uid-alice' })

  const res = await gql(app, BOB, APPROVE, { id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(linear.calls.length, 0)

  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'gathering')
})

for (const [label, badId] of [
  ['nonexistent', '0123456789abcdef01234567'],
  ['malformed', 'not-an-object-id'],
]) {
  test(`approving a ${label} id → NOT_FOUND, zero Linear calls (never 5xx)`, async () => {
    const linear = fakeLinearClient()
    const res = await gql(makeApp(linear), ALICE, APPROVE, { id: badId })
    assert.equal(res.status, 200)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')
    assert.equal(linear.calls.length, 0)
  })
}

test('approval without a token → HTTP 401 from the gate, zero Linear calls', async () => {
  const linear = fakeLinearClient()
  const id = await seedSession()
  const res = await request(makeApp(linear))
    .post('/api/graphql')
    .send({ query: APPROVE, variables: { id } })
  assert.equal(res.status, 401)
  assert.equal(linear.calls.length, 0)
})

// --- the pre-approval read path: new fields are null before approval ---

test('linearProjectId, linearProjectUrl, and tickets are null on a session that has not been approved', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession()

  const res = await gql(app, ALICE, `query ($id: ID!) {
    featureRequest(id: $id) { linearProjectId linearProjectUrl tickets { key } }
  }`, { id })

  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.featureRequest.linearProjectId, null)
  assert.equal(res.body.data.featureRequest.linearProjectUrl, null)
  assert.equal(res.body.data.featureRequest.tickets, null)
})

// --- DAN-80: legacy sessions — approved before linearProjectUrl existed ---

test('a legacy building session with no stored linearProjectUrl serves null without erroring', async () => {
  const app = makeApp(fakeLinearClient())
  // Seeded exactly as DAN-51 persisted it: project id and tickets, no url.
  const { insertedId } = await featureRequests().insertOne({
    uid: 'uid-alice',
    status: 'building',
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: 'legacy session', createdAt: new Date() },
    ],
    createdAt: new Date(),
    plan: PLAN,
    entranceCriteria: gates(),
    linearProjectId: PROJECT_ID,
    tickets: [
      { key: 'T1', linearIssueId: 'issue-id-1', identifier: 'DAN-101', url: 'https://linear.app/fixture/issue/DAN-101' },
    ],
  })
  const id = insertedId.toString()

  const res = await gql(app, ALICE, `query ($id: ID!) {
    featureRequest(id: $id) { status linearProjectId linearProjectUrl tickets { key } }
  }`, { id })

  assert.equal(res.body.errors, undefined, 'a legacy session must not error')
  assert.equal(res.body.data.featureRequest.status, 'building')
  assert.equal(res.body.data.featureRequest.linearProjectId, PROJECT_ID)
  assert.equal(res.body.data.featureRequest.linearProjectUrl, null, 'no stored url serves null')
  assert.deepEqual(res.body.data.featureRequest.tickets, [{ key: 'T1' }])
})

test('legacy sessions in the list view also serve linearProjectUrl null without erroring', async () => {
  const app = makeApp(fakeLinearClient())
  await featureRequests().insertOne({
    uid: 'uid-alice',
    status: 'building',
    model: 'claude-opus-5',
    messages: [],
    createdAt: new Date(),
    linearProjectId: PROJECT_ID,
    tickets: [],
  })

  const res = await gql(app, ALICE, `query {
    featureRequests { status linearProjectUrl }
  }`)

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequests, [{ status: 'building', linearProjectUrl: null }])
})
