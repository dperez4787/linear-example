// DAN-51 tester verification. Independent of the developer's
// approveFeatureRequestPlan.test.js and linearClient.test.js.
//
// What this suite locks that the developer's suites do not exercise:
//
//   1. Dependency-graph fidelity on a DIAMOND plan (A; B<-A; C<-A; D<-B,C):
//      exactly 4 issues, exactly 4 relations, each relation's issueId is the
//      BLOCKER and relatedIssueId the DEPENDENT, A alone files Ready for Dev.
//   2. A plan whose dependsOn names a nonexistent key: the mutation must fail
//      deterministically (INTERNAL) and corrupt nothing in Mongo.
//   3. The exact mid-creation failure script from the ticket: project created,
//      SECOND issue create fails -> INTERNAL over the wire, session stays
//      "gathering", no linearProjectId and no tickets persisted.
//   4. The default client's 30s timeout WIRING — the literal milliseconds
//      passed to AbortSignal.timeout — plus lazy-env construction and the
//      bare (non-Bearer) Authorization header, via an injected fetch.
//   5. A REAL boot: src/index.js spawned with an empty environment (no
//      MONGODB_URI, no LINEAR_*), /health answering 200 over actual HTTP.
//   6. The DAN-54 wire contract: the approve mutation DOCUMENT the merged
//      frontend actually sends (FEATURE_REQUEST_FIELDS read out of
//      app/frontend/src/api.js at test time) executes against this schema
//      in-process with zero errors.
//
// The injected linearClient is this suite's own recording fake returning
// fixture ids/urls — no test reaches real Linear. Needs a reachable mongod via
// MONGODB_URI (ambient or app/backend/.env); MONGODB_DB is forced to the
// scratch database. Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { graphql } from 'graphql'

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
const { createLinearClient, LinearError } = await import('./linearClient.js')
const { schema, rootValue } = await import('./graphql.js')
const { ObjectId } = await import('mongodb')

// --- this suite's own recording fake (criterion 7) ---

const TEAM_ID = 't51-team'
const READY_STATE_ID = 't51-ready-for-dev'

function recordingLinearClient({ failOnCall } = {}) {
  const calls = []
  let issueN = 0
  // failOnCall counts LINEAR MUTATION/QUERY calls (not config()) so "fail on
  // the Nth call" reads the way the ticket's scrutiny note means it.
  let n = 0
  const record = (method, args) => {
    calls.push({ method, args })
    n += 1
    if (failOnCall && n === failOnCall) {
      throw new LinearError(`tester fixture: scripted failure on call #${n} (${method})`)
    }
  }
  const client = {
    calls,
    config() {
      return { teamId: TEAM_ID, readyForDevStateId: READY_STATE_ID }
    },
    async findOrCreateLabels(names) {
      record('findOrCreateLabels', { names })
      return Object.fromEntries(names.map((name) => [name, `lbl(${name})`]))
    },
    async createProject(args) {
      record('createProject', args)
      return { id: 'prj-51', url: 'https://linear.app/t51/project/prj-51' }
    },
    async createIssue(args) {
      record('createIssue', args)
      issueN += 1
      return {
        id: `iss-${issueN}`,
        identifier: `T51-${issueN}`,
        url: `https://linear.app/t51/issue/T51-${issueN}`,
      }
    },
    async createRelation(args) {
      record('createRelation', args)
      return { id: `rel-${calls.length}` }
    },
  }
  client.callsTo = (m) => calls.filter((c) => c.method === m).map((c) => c.args)
  return client
}

// --- app + session plumbing ---

const TOKENS = {
  'tester-token-owner': { uid: 'uid-t51-owner' },
  'tester-token-other': { uid: 'uid-t51-other' },
}
const OWNER = 'tester-token-owner'
const OTHER = 'tester-token-other'
const stubVerify = async (token) => {
  if (!TOKENS[token]) throw new Error('invalid token')
  return TOKENS[token]
}
const makeApp = (linearClient) => createApp({ verifyToken: stubVerify, linearClient })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const APPROVE = `mutation ($id: ID!) {
  approveFeatureRequestPlan(id: $id) {
    id status linearProjectId tickets { key identifier url }
  }
}`

const allPass = () =>
  Object.fromEntries(
    ['notTooBig', 'notAmbiguous', 'noBlockedDependencies'].map((g) => [
      g,
      { pass: true, reason: 'tester fixture' },
    ]),
  )

// The diamond: A unblocked; B and C depend on A; D depends on B and C.
const DIAMOND = {
  tickets: [
    { key: 'A', title: 'A: root', description: 'root work', dependsOn: [] },
    { key: 'B', title: 'B: left', description: 'left leg', dependsOn: ['A'] },
    { key: 'C', title: 'C: right', description: 'right leg', dependsOn: ['A'] },
    { key: 'D', title: 'D: join', description: 'joins B and C', dependsOn: ['B', 'C'] },
  ],
}

const sessions = () => getDb().collection('feature_requests')

async function seed({ uid = 'uid-t51-owner', plan = DIAMOND, entranceCriteria = allPass(), status = 'gathering' } = {}) {
  const doc = {
    uid,
    status,
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Build the diamond feature', createdAt: new Date() }],
    createdAt: new Date(),
    plan,
    entranceCriteria,
  }
  const { insertedId } = await sessions().insertOne(doc)
  return insertedId.toString()
}

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await sessions().deleteMany({})
})

after(async () => {
  await sessions().deleteMany({})
  await getDb().client.close()
})

// --- 1. diamond-graph fidelity (criterion 3) ---

test('diamond plan: 4 issues, 4 relations with blocker->dependent direction, A alone Ready for Dev', async () => {
  const linear = recordingLinearClient()
  const app = makeApp(linear)
  const id = await seed()

  const res = await gql(app, OWNER, APPROVE, { id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)

  // Exactly one project, exactly 4 issues, in plan order.
  assert.equal(linear.callsTo('createProject').length, 1)
  const issues = linear.callsTo('createIssue')
  assert.equal(issues.length, 4, 'exactly one issue per plan ticket')
  assert.deepEqual(
    issues.map((i) => i.title),
    ['A: root', 'B: left', 'C: right', 'D: join'],
  )
  assert.deepEqual(
    issues.map((i) => i.description),
    ['root work', 'left leg', 'right leg', 'joins B and C'],
  )

  // Both labels on EVERY issue: agent:claude (claude-opus-5 -> claude) and
  // prompt:<promptId>.
  for (const issue of issues) {
    assert.deepEqual(issue.labelIds, ['lbl(agent:claude)', `lbl(prompt:${id})`])
  }
  assert.deepEqual(linear.callsTo('findOrCreateLabels'), [
    { names: ['agent:claude', `prompt:${id}`] },
  ])

  // State: A (no blockers) files Ready for Dev; B, C, D carry NO stateId at
  // all, so they land in the team default (Backlog).
  assert.equal(issues[0].stateId, READY_STATE_ID, 'A -> Ready for Dev at create time')
  for (const [i, key] of [[1, 'B'], [2, 'C'], [3, 'D']]) {
    assert.ok(!('stateId' in issues[i]) || issues[i].stateId === undefined,
      `${key} is blocked -> no stateId (Backlog)`)
  }

  // Exactly 4 relations — one per dependsOn edge, no extras — and the
  // direction is blocker `blocks` dependent: issueId is the BLOCKER's id,
  // relatedIssueId the DEPENDENT's. Fixture ids: A=iss-1 B=iss-2 C=iss-3 D=iss-4.
  const relations = linear.callsTo('createRelation')
  assert.equal(relations.length, 4, 'exactly one relation per dependsOn edge')
  const asSet = new Set(relations.map((r) => `${r.type}:${r.issueId}->${r.relatedIssueId}`))
  assert.deepEqual(
    asSet,
    new Set([
      'blocks:iss-1->iss-2', // A blocks B
      'blocks:iss-1->iss-3', // A blocks C
      'blocks:iss-2->iss-4', // B blocks D
      'blocks:iss-3->iss-4', // C blocks D
    ]),
  )

  // Criterion 4, on the diamond: persisted + returned identities line up.
  const fr = res.body.data.approveFeatureRequestPlan
  assert.equal(fr.status, 'building')
  assert.equal(fr.linearProjectId, 'prj-51')
  assert.deepEqual(fr.tickets.map((t) => [t.key, t.identifier, t.url]), [
    ['A', 'T51-1', 'https://linear.app/t51/issue/T51-1'],
    ['B', 'T51-2', 'https://linear.app/t51/issue/T51-2'],
    ['C', 'T51-3', 'https://linear.app/t51/issue/T51-3'],
    ['D', 'T51-4', 'https://linear.app/t51/issue/T51-4'],
  ])
  const doc = await sessions().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'building')
  assert.deepEqual(doc.tickets.map((t) => t.linearIssueId), ['iss-1', 'iss-2', 'iss-3', 'iss-4'])
})

// --- 2. dependsOn naming a nonexistent key ---

test('a dependsOn edge to a nonexistent key -> INTERNAL, session stays "gathering", nothing persisted', async () => {
  const linear = recordingLinearClient()
  const app = makeApp(linear)
  const id = await seed({
    plan: {
      tickets: [
        { key: 'A', title: 'A', description: 'a', dependsOn: [] },
        { key: 'B', title: 'B', description: 'b', dependsOn: ['NOPE'] },
      ],
    },
  })

  const res = await gql(app, OWNER, APPROVE, { id })

  assert.equal(res.status, 200)
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL', 'fails loudly, not silently dropped')
  assert.equal(res.body.errors[0].message, 'Internal Server Error', 'no plan detail leaks')

  // Deterministic and non-corrupting: Mongo untouched, no relation was filed
  // for the dangling edge.
  const doc = await sessions().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'gathering')
  assert.equal(doc.linearProjectId, undefined)
  assert.equal(doc.tickets, undefined)
  assert.equal(linear.callsTo('createRelation').length, 0, 'no relation for the dangling key')
})

// --- 3. ownership: another uid -> NOT_FOUND, existence not leaked, zero Linear calls ---

test('another user approving the session -> NOT_FOUND indistinguishable from nonexistent, zero Linear calls', async () => {
  const linear = recordingLinearClient()
  const app = makeApp(linear)
  const id = await seed({ uid: 'uid-t51-owner' })

  const otherUsers = await gql(app, OTHER, APPROVE, { id })
  const nonexistent = await gql(app, OTHER, APPROVE, { id: '0123456789abcdef01234567' })

  assert.equal(otherUsers.body.errors[0].extensions.code, 'NOT_FOUND')
  // Existence must not leak: same code AND same message as a genuinely
  // nonexistent id.
  assert.equal(otherUsers.body.errors[0].message, nonexistent.body.errors[0].message)
  assert.equal(linear.calls.length, 0, 'zero Linear calls for either')

  const doc = await sessions().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'gathering', 'the owner session is untouched')
})

// --- 4. criterion 6, exact script: project ok, SECOND issue create fails ---

test('Linear fails on the second issue create -> INTERNAL over the wire, session stays "gathering", no partial Mongo writes; retry works', async () => {
  const id = await seed()
  // Call order is findOrCreateLabels(1), createProject(2), createIssue(3),
  // createIssue(4)... so failOnCall=4 is exactly "project ok, second issue fails".
  const failing = recordingLinearClient({ failOnCall: 4 })
  const res = await gql(makeApp(failing), OWNER, APPROVE, { id })

  assert.equal(failing.callsTo('createProject').length, 1, 'the project WAS created before the failure')
  assert.equal(failing.callsTo('createIssue').length, 2, 'the failure hit the second issue create')
  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
  assert.equal(res.body.errors[0].message, 'Internal Server Error')

  const doc = await sessions().findOne({ _id: new ObjectId(id) })
  assert.equal(doc.status, 'gathering', 'session stays gathering')
  assert.equal(doc.linearProjectId, undefined, 'no linearProjectId persisted')
  assert.equal(doc.tickets, undefined, 'no tickets persisted')

  // Retry remains possible (partial Linear cleanup explicitly out of scope).
  const retry = await gql(makeApp(recordingLinearClient()), OWNER, APPROVE, { id })
  assert.equal(retry.body.errors, undefined)
  assert.equal(retry.body.data.approveFeatureRequestPlan.status, 'building')
})

// --- 5. criterion 2 (independent of the developer's): all-fail gates name all three ---

test('no gate passes -> BAD_USER_INPUT naming all three gates, zero Linear calls', async () => {
  const linear = recordingLinearClient()
  const id = await seed({
    entranceCriteria: Object.fromEntries(
      ['notTooBig', 'notAmbiguous', 'noBlockedDependencies'].map((g) => [
        g,
        { pass: false, reason: 'nope' },
      ]),
    ),
  })
  const res = await gql(makeApp(linear), OWNER, APPROVE, { id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  for (const gate of ['notTooBig', 'notAmbiguous', 'noBlockedDependencies']) {
    assert.match(res.body.errors[0].message, new RegExp(gate))
  }
  assert.equal(linear.calls.length, 0)
})

// --- 6. criterion 5 (independent): a "building" session cannot be approved again ---

test('approving a session already in "building" -> BAD_USER_INPUT "already approved", zero Linear calls', async () => {
  const linear = recordingLinearClient()
  const id = await seed({ status: 'building' })
  const res = await gql(makeApp(linear), OWNER, APPROVE, { id })
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.match(res.body.errors[0].message, /already approved/)
  assert.equal(linear.calls.length, 0)
})

// --- 7. default client (criterion 1): lazy env, bare header, 30s timeout wiring ---

test('createLinearClient constructs with no LINEAR_* env and throws nothing until a call', async () => {
  const saved = { ...process.env }
  delete process.env.LINEAR_API_KEY
  delete process.env.LINEAR_TEAM_ID
  delete process.env.LINEAR_STATE_READY_FOR_DEV
  try {
    let fetches = 0
    const client = createLinearClient({ fetch: async () => { fetches += 1 } }) // must not throw
    await assert.rejects(
      () => client.createIssue({ teamId: 'x', projectId: 'y', title: 't', description: 'd', labelIds: [] }),
      (err) => err instanceof LinearError && /LINEAR_API_KEY/.test(err.message),
    )
    assert.equal(fetches, 0, 'missing env at call time -> no fetch attempted')
    assert.throws(() => client.config(), LinearError, 'config() also lazy and required')
  } finally {
    process.env = saved
  }
})

test('the default client sends a bare Authorization header (no Bearer) and wires a 30s AbortSignal.timeout', async () => {
  const saved = { ...process.env }
  process.env.LINEAR_API_KEY = 'lin_api_t51_fixture'
  const timeoutArgs = []
  const realTimeout = AbortSignal.timeout
  AbortSignal.timeout = (ms) => {
    timeoutArgs.push(ms)
    return realTimeout.call(AbortSignal, ms)
  }
  try {
    const seen = []
    const client = createLinearClient({
      fetch: async (url, init) => {
        seen.push({ url, init })
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { issueRelationCreate: { issueRelation: { id: 'r' } } } }),
        }
      },
    })
    await client.createRelation({ issueId: 'a', relatedIssueId: 'b', type: 'blocks' })

    assert.equal(seen[0].url, 'https://api.linear.app/graphql')
    assert.equal(seen[0].init.headers.Authorization, 'lin_api_t51_fixture', 'bare key, no Bearer prefix')
    assert.ok(!/^Bearer /.test(seen[0].init.headers.Authorization))
    assert.ok(seen[0].init.signal instanceof AbortSignal)
    assert.deepEqual(timeoutArgs, [30000], 'exactly one 30s timeout per request')
  } finally {
    AbortSignal.timeout = realTimeout
    process.env = saved
  }
})

test('a LinearError from the default client surfaces as INTERNAL over the wire, detail unleaked', async () => {
  // The mutation path with the DEFAULT client and no LINEAR_* env: config()
  // throws LinearError, the mapper has no branch for it -> INTERNAL.
  const saved = { ...process.env }
  delete process.env.LINEAR_API_KEY
  delete process.env.LINEAR_TEAM_ID
  delete process.env.LINEAR_STATE_READY_FOR_DEV
  try {
    const id = await seed()
    const app = createApp({ verifyToken: stubVerify, linearClient: createLinearClient({ fetch: async () => assert.fail('must not fetch') }) })
    const res = await gql(app, OWNER, APPROVE, { id })
    assert.equal(res.status, 200)
    assert.equal(res.body.errors[0].extensions.code, 'INTERNAL')
    assert.equal(res.body.errors[0].message, 'Internal Server Error')
    const doc = await sessions().findOne({ _id: new ObjectId(id) })
    assert.equal(doc.status, 'gathering')
  } finally {
    process.env = saved
  }
})

// --- 8. real boot: /health with a genuinely empty environment ---

test('src/index.js spawned with zero env (no MONGODB_URI, no LINEAR_*) serves GET /health 200 over real HTTP', async () => {
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
  const indexPath = fileURLToPath(new URL('./index.js', import.meta.url))
  // Minimal env: PATH so node's children resolve, PORT. No MONGODB_URI, no
  // LINEAR_*, no .env in this checkout — the true Cloud-Run-cold-boot shape.
  const child = spawn(process.execPath, [indexPath], {
    env: { PATH: process.env.PATH, PORT: String(port) },
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server never listened')), 10000)
      child.stdout.on('data', (d) => {
        if (d.toString().includes('backend listening on')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`exited before listening (code ${code})`))
      })
    })
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
  } finally {
    child.kill('SIGKILL')
  }
})

// --- 9. DAN-54 wire contract: execute the merged frontend's own document ---

test("the approve document DAN-54's api.js sends (verbatim FEATURE_REQUEST_FIELDS) executes with zero errors and status building", async () => {
  const apiSrc = readFileSync(
    fileURLToPath(new URL('../../frontend/src/api.js', import.meta.url)),
    'utf8',
  )
  const fieldsMatch = apiSrc.match(/const FEATURE_REQUEST_FIELDS = `([^`]+)`/)
  assert.ok(fieldsMatch, 'api.js still defines FEATURE_REQUEST_FIELDS')
  const docMatch = apiSrc.match(
    /`(mutation \(\$id: ID!\) \{ approveFeatureRequestPlan\(id: \$id\) \{ \$\{FEATURE_REQUEST_FIELDS\} \} \})`/,
  )
  assert.ok(docMatch, 'api.js still sends the agreed approve mutation')
  const source = docMatch[1].replace('${FEATURE_REQUEST_FIELDS}', fieldsMatch[1])

  const linear = recordingLinearClient()
  const id = await seed()
  const result = await graphql({
    schema,
    source,
    rootValue,
    contextValue: { uid: 'uid-t51-owner', linearClient: linear },
    variableValues: { id },
  })

  assert.equal(result.errors, undefined, `frontend document must resolve: ${result.errors?.[0]?.message}`)
  const fr = result.data.approveFeatureRequestPlan
  assert.equal(fr.status, 'building', 'the frontend sees the post-approval status')
  assert.equal(fr.approvable, true)
  assert.ok(Array.isArray(fr.messages))
  assert.equal(fr.entranceCriteria.notTooBig.pass, true)
  // Note for the record: the merged FEATURE_REQUEST_FIELDS selects neither
  // `tickets` nor `linearProjectId`; identifier+url availability is asserted
  // against the schema by the HTTP tests above. This test proves the merged
  // document itself is schema-compatible.
})
