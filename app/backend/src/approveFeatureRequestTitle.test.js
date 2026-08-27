// DAN-90: the AI-generated snake_case session title, end to end over HTTP.
//
// Approval asks the titler for one slug, names the Linear project
// `paf: <slug>`, and persists the slug as `title` on the session. The whole
// feature is best-effort: a gateway failure, a quota refusal, or unusable
// model output falls back to DAN-88's truncated project name and STILL
// approves — a title must never cost the user their approval.
//
// Both seams are fakes: the injected linearClient records its calls (as in
// approveFeatureRequestPlan.test.js) and the injected aiGateway is scripted
// per test. No test reaches real Linear or a real gateway. Mongo
// (linear_example_test) is the only external dependency.
// Run with: npm test
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
const { QuotaExhaustedError, GatewayError } = await import('./aiGateway.js')
const { TITLE_MODEL, TITLE_PATTERN, TITLE_MAX_CHARS, MAX_TOKENS_BY_ROLE } = await import(
  './featureRequests.js'
)

// --- fixtures ---

const TEAM_ID = 'team-fixture-id'
const READY_STATE_ID = 'state-ready-fixture-id'
const PROJECT_ID = 'project-fixture-id'
const PROJECT_URL = 'https://linear.app/fixture/project/paf'
const PROJECT_NAME_MAX = 80

const GATES = ['notTooBig', 'notAmbiguous', 'noBlockedDependencies']
const gates = () =>
  Object.fromEntries(GATES.map((g) => [g, { pass: true, reason: `fixture: ${g} ok` }]))

const PLAN = {
  tickets: [
    { key: 'T1', title: 'Backend: revert button color', description: 'Blue again.', dependsOn: [] },
  ],
}

// The real production message from DAN-88 — long enough that the old
// truncated name was unreadable, which is the whole reason this ticket exists.
const LONG_MESSAGE =
  'Can you make all the buttons you made green before blue now? You can simply revert this PR: https://github.com/dperez4787/linear-example/pull/65'

const SHORT_MESSAGE = 'Please make the buttons blue again'

// One shared ordered log across BOTH fakes, so a test can assert that the
// titler call happens before createProject rather than merely that both ran.
function makeFakes({ title }) {
  const calls = []
  let issueN = 0

  const linearClient = {
    config() {
      calls.push({ seam: 'linear', method: 'config', args: {} })
      return { teamId: TEAM_ID, readyForDevStateId: READY_STATE_ID }
    },
    async findOrCreateLabels(names) {
      calls.push({ seam: 'linear', method: 'findOrCreateLabels', args: { names } })
      return Object.fromEntries(names.map((name) => [name, `label-id:${name}`]))
    },
    async createProject(args) {
      calls.push({ seam: 'linear', method: 'createProject', args })
      return { id: PROJECT_ID, url: PROJECT_URL }
    },
    async createIssue(args) {
      calls.push({ seam: 'linear', method: 'createIssue', args })
      issueN += 1
      return {
        id: `issue-id-${issueN}`,
        identifier: `DAN-20${issueN}`,
        url: `https://linear.app/fixture/issue/DAN-20${issueN}`,
      }
    },
    async createRelation(args) {
      calls.push({ seam: 'linear', method: 'createRelation', args })
      return { id: `relation-id-${calls.length}` }
    },
  }

  // `title` scripts the titler: a string is returned as the completion's
  // content, an Error instance is thrown, and a function is invoked to build
  // whatever the test wants.
  const aiGateway = {
    async chat(request) {
      calls.push({ seam: 'gateway', method: 'chat', args: request })
      const outcome = typeof title === 'function' ? title(request) : title
      if (outcome instanceof Error) throw outcome
      return {
        choices: [{ message: { role: 'assistant', content: outcome } }],
        usage: { total_tokens: 12 },
      }
    },
    async usage() {
      calls.push({ seam: 'gateway', method: 'usage', args: {} })
      return { rows: [] }
    },
  }

  return {
    calls,
    linearClient,
    aiGateway,
    named: (method) => calls.filter((c) => c.method === method),
    indexOf: (method) => calls.findIndex((c) => c.method === method),
  }
}

// --- app plumbing ---

const TOKENS = { 'stub-token-alice': { uid: 'uid-alice' } }
const ALICE = 'stub-token-alice'
const UID_ALICE = 'uid-alice'

const stubVerify = async (token) => {
  const decoded = TOKENS[token]
  if (!decoded) throw new Error('invalid token')
  return decoded
}

const makeApp = ({ linearClient, aiGateway }) =>
  createApp({ verifyToken: stubVerify, linearClient, aiGateway })

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const FR_FIELDS = 'id status title linearProjectId linearProjectUrl tickets { key identifier }'
const APPROVE = `mutation ($id: ID!) { approveFeatureRequestPlan(id: $id) { ${FR_FIELDS} } }`
const READ = `query ($id: ID!) { featureRequest(id: $id) { ${FR_FIELDS} } }`

const featureRequests = () => getDb().collection('feature_requests')

async function seedSession({
  uid = UID_ALICE,
  status = 'gathering',
  firstMessage = SHORT_MESSAGE,
  plan = PLAN,
  entranceCriteria = gates(),
  title,
} = {}) {
  const doc = {
    uid,
    status,
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: firstMessage, createdAt: new Date() },
      { role: 'product-owner', content: 'Refined scope.', createdAt: new Date() },
      { role: 'architect', content: 'Feasible.', createdAt: new Date() },
    ],
    createdAt: new Date(),
  }
  if (plan !== null) doc.plan = plan
  if (entranceCriteria !== null) doc.entranceCriteria = entranceCriteria
  if (title !== undefined) doc.title = title
  const { insertedId } = await featureRequests().insertOne(doc)
  return insertedId.toString()
}

const storedDoc = (id) => featureRequests().findOne({ _id: new ObjectId(id) })
const projectNameOf = (fakes) => fakes.named('createProject')[0].args.name

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

// --- criterion 1: a newly approved session gets a title and a `paf: <title>` project ---

test('approval persists the sanitized title and names the Linear project `paf: <title>`', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  const id = await seedSession({ firstMessage: LONG_MESSAGE })

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)

  const approved = res.body.data.approveFeatureRequestPlan
  assert.equal(approved.status, 'building')
  assert.equal(approved.title, 'change_buttons_to_blue')
  assert.match(approved.title, TITLE_PATTERN)
  assert.ok(approved.title.length <= TITLE_MAX_CHARS)

  assert.equal(projectNameOf(fakes), 'paf: change_buttons_to_blue')

  const doc = await storedDoc(id)
  assert.equal(doc.title, 'change_buttons_to_blue', 'the title is persisted, not just returned')
})

test('a messy model reply is sanitized before it reaches Linear or the database', async () => {
  const fakes = makeFakes({ title: '```\nTitle: Change Buttons To Blue!\n```' })
  const app = makeApp(fakes)
  const id = await seedSession()

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.body.errors, undefined)

  assert.equal(res.body.data.approveFeatureRequestPlan.title, 'change_buttons_to_blue')
  assert.equal(projectNameOf(fakes), 'paf: change_buttons_to_blue')
  assert.equal((await storedDoc(id)).title, 'change_buttons_to_blue')
})

test("DAN-88's 80-char project-name cap holds for the longest possible title", async () => {
  // 5 words at the 50-char ceiling, from a long opening message.
  const fakes = makeFakes({ title: 'abcdefghij_abcdefghij_abcdefghij_abcdefghij_abcde' })
  const app = makeApp(fakes)
  const id = await seedSession({ firstMessage: LONG_MESSAGE.repeat(4) })

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.body.errors, undefined)

  const name = projectNameOf(fakes)
  assert.ok(name.startsWith('paf: '), 'prefix survives')
  assert.ok(
    name.length <= PROJECT_NAME_MAX,
    `project name must be <= ${PROJECT_NAME_MAX} chars, got ${name.length}: ${name}`,
  )
  const title = res.body.data.approveFeatureRequestPlan.title
  assert.ok(title.length <= TITLE_MAX_CHARS)
  assert.match(title, TITLE_PATTERN)
})

// --- criterion 5: the titler call, asserted on the wire ---

test('the titler call goes through the injected gateway on the cheap model, with its budget and this session promptId', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  const id = await seedSession()

  await gql(app, ALICE, APPROVE, { id })

  const chats = fakes.named('chat')
  assert.equal(chats.length, 1, 'exactly one titler call per approval')
  const { args } = chats[0]

  assert.equal(args.model, TITLE_MODEL, 'the dedicated cheap model')
  assert.equal(args.model, 'claude-haiku-4-5')
  assert.equal(args.max_tokens, MAX_TOKENS_BY_ROLE.titler)
  assert.equal(args.max_tokens, 40)

  // Attribution: the same promptId/uid/role metadata every other role carries,
  // so the call is metered on this session's ledger — no bypass.
  assert.equal(args.promptId, id, 'metered under this session promptId')
  assert.equal(args.uid, UID_ALICE)
  assert.equal(args.role, 'titler')

  // The system prompt must demand a bare slug and nothing else.
  const system = args.messages[0]
  assert.equal(system.role, 'system')
  assert.match(system.content, /snake_case/i)
  assert.match(system.content, /NOTHING else/i)
  assert.match(system.content, /5 words/)
  assert.match(system.content, /50 characters/)

  // The transcript is the user turn, as for the other internal analyst roles.
  assert.equal(args.messages[1].role, 'user')
  assert.match(args.messages[1].content, /Please make the buttons blue again/)
})

test('the titler runs BEFORE createProject, and exactly once', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  const id = await seedSession()

  await gql(app, ALICE, APPROVE, { id })

  const titlerAt = fakes.indexOf('chat')
  const projectAt = fakes.indexOf('createProject')
  assert.ok(titlerAt !== -1 && projectAt !== -1)
  assert.ok(titlerAt < projectAt, 'the name must exist before the project is filed')
  assert.equal(fakes.named('chat').length, 1)
})

test('a session that is not approvable spends nothing: no titler call at all', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  const id = await seedSession({ plan: null })

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(fakes.named('chat').length, 0, 'a refused approval never pays for a title')
  assert.equal(fakes.calls.length, 0, 'and touches neither seam')
})

// --- criterion 4: every failure mode falls back and STILL approves ---

async function assertFallbackApproval(fakes, id, why) {
  const app = makeApp(fakes)
  const res = await gql(app, ALICE, APPROVE, { id })

  assert.equal(res.status, 200, `${why}: still HTTP 200`)
  assert.equal(res.body.errors, undefined, `${why}: no error reaches the client`)

  const approved = res.body.data.approveFeatureRequestPlan
  assert.equal(approved.status, 'building', `${why}: the approval succeeded`)
  assert.equal(approved.linearProjectId, PROJECT_ID, `${why}: the project was filed`)
  assert.equal(approved.title, null, `${why}: no title is invented`)

  const name = projectNameOf(fakes)
  assert.equal(name, `paf: ${SHORT_MESSAGE}`, `${why}: DAN-88's truncated name is used`)
  assert.ok(name.length <= PROJECT_NAME_MAX)

  const doc = await storedDoc(id)
  assert.equal(doc.status, 'building')
  assert.equal(doc.title, undefined, `${why}: nothing unusable is persisted as a title`)
  return res
}

test('a gateway failure falls back to the truncated name and still approves', async () => {
  const fakes = makeFakes({ title: new GatewayError('AI gateway responded 500') })
  const id = await seedSession()
  await assertFallbackApproval(fakes, id, 'gateway failure')
  assert.equal(fakes.named('chat').length, 1, 'the call was attempted')
})

test('a quota refusal (429) falls back to the truncated name and still approves', async () => {
  const fakes = makeFakes({ title: new QuotaExhaustedError() })
  const id = await seedSession()
  const res = await assertFallbackApproval(fakes, id, 'quota refusal')
  // The QUOTA_EXHAUSTED mapping must NOT surface here — unlike a conversational
  // turn, a refused title is invisible to the client.
  assert.equal(res.body.errors, undefined)
})

test('a network-level throw from the gateway client falls back and still approves', async () => {
  const fakes = makeFakes({ title: new Error('socket hang up') })
  const id = await seedSession()
  await assertFallbackApproval(fakes, id, 'network failure')
})

test('unusable model output (emoji only) falls back to the truncated name and still approves', async () => {
  const fakes = makeFakes({ title: '🚀✨' })
  const id = await seedSession()
  await assertFallbackApproval(fakes, id, 'unusable output')
})

test('an empty completion falls back to the truncated name and still approves', async () => {
  const fakes = makeFakes({ title: '   ' })
  const id = await seedSession()
  await assertFallbackApproval(fakes, id, 'empty output')
})

test('a malformed completion (no choices) falls back to the truncated name and still approves', async () => {
  const fakes = makeFakes({ title: 'ignored' })
  fakes.aiGateway.chat = async (req) => {
    fakes.calls.push({ seam: 'gateway', method: 'chat', args: req })
    return {}
  }
  const id = await seedSession()
  await assertFallbackApproval(fakes, id, 'malformed completion')
})

// --- criterion 2: title on the wire, null for legacy/unapproved ---

test('an unapproved session serves title: null', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  const id = await seedSession()

  const res = await gql(app, ALICE, READ, { id })
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.featureRequest.title, null)
  assert.equal(fakes.named('chat').length, 0, 'reading never generates a title')
})

test('a legacy approved session (approved before this field existed) serves title: null', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  const id = await seedSession({ status: 'building' })
  await featureRequests().updateOne(
    { _id: new ObjectId(id) },
    { $set: { linearProjectId: 'legacy-project', tickets: [] } },
  )

  const res = await gql(app, ALICE, READ, { id })
  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.featureRequest.title, null)
})

test('title is on the list query too, null for a session with none', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  await seedSession()
  await seedSession({ status: 'building', title: 'already_named_session' })

  const res = await gql(app, ALICE, 'query { featureRequests { id title } }')
  assert.equal(res.body.errors, undefined)
  const titles = res.body.data.featureRequests.map((f) => f.title).sort()
  assert.deepEqual(titles, [null, 'already_named_session'].sort())
})

// --- stability: generated once, never regenerated ---

test('the title is generated once at approval and is stable across later reads', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  const id = await seedSession()

  await gql(app, ALICE, APPROVE, { id })
  assert.equal(fakes.named('chat').length, 1)

  for (let i = 0; i < 3; i += 1) {
    const res = await gql(app, ALICE, READ, { id })
    assert.equal(res.body.data.featureRequest.title, 'change_buttons_to_blue')
  }
  assert.equal(fakes.named('chat').length, 1, 'no read ever re-asks the titler')
})

test('re-approving an already-approved session is still refused and costs no title call', async () => {
  const fakes = makeFakes({ title: 'change_buttons_to_blue' })
  const app = makeApp(fakes)
  const id = await seedSession()

  await gql(app, ALICE, APPROVE, { id })
  const before = fakes.named('chat').length

  const again = await gql(app, ALICE, APPROVE, { id })
  assert.equal(again.body.errors[0].extensions.code, 'BAD_USER_INPUT')
  assert.equal(again.body.errors[0].message, 'feature request already approved')
  assert.equal(fakes.named('chat').length, before, 'no second titler call')
  assert.equal((await storedDoc(id)).title, 'change_buttons_to_blue', 'the title is unchanged')
})
