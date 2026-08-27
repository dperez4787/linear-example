// DAN-88 — independent tester verification.
//
// Bug under test: projectName() truncated the first user message to 80 chars
// and THEN prepended 'paf: ' (85 total), so Linear's projectCreate (hard
// 80-char cap) rejected the name and approve returned INTERNAL for any long
// opening message. The fix must bound the WHOLE name — prefix + base +
// ellipsis — at 80, keep short names byte-identical to the old output, stay
// surrogate-pair safe, and apply the same bound to the _id fallback.
//
// This suite is written from the ticket's acceptance criteria, independently
// of the developer's tests. Unit tests are pure; the approve-path test needs
// Mongo (linear_example_test), same as the sibling integration suites.
// Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import request from 'supertest'

if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // MONGODB_URI must then come from the ambient environment.
  }
}
process.env.MONGODB_DB = 'linear_example_test'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { projectName } = await import('./featureRequests.js')

const PREFIX = 'paf: '
const CAP = 80
const FIT = CAP - PREFIX.length // 75: longest message that needs no truncation

// The exact first message that failed in production (reproduced live on DAN-88).
const PRODUCTION_MESSAGE =
  'Can you make all the buttons you made green before blue now? You can simply revert this PR: https://github.com/dperez4787/linear-example/pull/65'

const msgDoc = (content) => ({
  messages: [
    { role: 'assistant', content: 'ignored — not a user message', createdAt: new Date() },
    { role: 'user', content, createdAt: new Date() },
  ],
  _id: { toString: () => '0123456789abcdef01234567' },
})

// --- property sweep: every length 0..200 obeys the cap ---

test('property sweep: for every message length 0..200 the name is <=80 chars and keeps the prefix', () => {
  for (let n = 0; n <= 200; n++) {
    const name = projectName(msgDoc('x'.repeat(n)))
    assert.ok(
      name.length <= CAP,
      `length-${n} message produced a ${name.length}-char name: ${JSON.stringify(name)}`,
    )
    assert.ok(name.startsWith(PREFIX), `length-${n} message lost the prefix`)
    if (n > FIT) {
      assert.equal(name.length, CAP, `length-${n} truncation should use the full budget`)
      assert.ok(name.endsWith('…'), `length-${n} truncation must be marked`)
    }
  }
})

// --- the live production failure ---

test('the exact production message that broke approve now yields a Linear-valid name', () => {
  const name = projectName(msgDoc(PRODUCTION_MESSAGE))
  assert.ok(name.length <= CAP, `still over the cap: ${name.length}`)
  assert.ok(name.startsWith(PREFIX))
  assert.ok(name.endsWith('…'), 'a 143-char message must be truncated with a marker')
})

// --- regression: short messages are byte-identical to the old algorithm ---

test('every message up to 75 chars produces the identical name the old code produced', () => {
  const samples = ['', 'a', 'fix the login button', 'ünïcödé välüé ok', 'x'.repeat(FIT)]
  for (let n = 0; n <= FIT; n++) samples.push('m'.repeat(n))
  for (const msg of samples) {
    const name = projectName(msgDoc(msg))
    const old = `${PREFIX}${msg}` // old algorithm output for any message <= 80
    assert.equal(name, old, `changed for ${JSON.stringify(msg)}`)
    assert.deepEqual(Buffer.from(name, 'utf8'), Buffer.from(old, 'utf8'), 'byte-identical')
  }
})

// --- boundary: exactly-fits vs one-over ---

test('a 75-char message exactly fits: 80 total, untruncated, no ellipsis', () => {
  const msg = 'b'.repeat(FIT)
  const name = projectName(msgDoc(msg))
  assert.equal(name, `${PREFIX}${msg}`)
  assert.equal(name.length, CAP)
})

test('a 76-char message is cut to exactly 80 total with a trailing ellipsis', () => {
  const name = projectName(msgDoc('b'.repeat(FIT + 1)))
  assert.equal(name.length, CAP)
  assert.equal(name, `${PREFIX}${'b'.repeat(FIT - 1)}…`)
})

// --- emoji / surrogate-pair sweep: the cut lands at every offset near the cap ---

test('emoji sweep: the cut point landing anywhere inside an emoji run never leaves a lone surrogate', () => {
  // Vary the ASCII padding so the raw cut index (74) lands at every possible
  // offset relative to the 2-code-unit emoji that follow: on a pair boundary,
  // mid-pair, and everywhere around the exactly-fits edge.
  for (let pad = 55; pad <= 80; pad++) {
    const msg = 'a'.repeat(pad) + '😀'.repeat(20)
    const name = projectName(msgDoc(msg))
    assert.ok(name.length <= CAP, `pad=${pad}: ${name.length} chars`)
    assert.ok(name.isWellFormed(), `pad=${pad}: lone surrogate in ${JSON.stringify(name)}`)
    assert.ok(name.startsWith(PREFIX), `pad=${pad}: prefix lost`)
    assert.ok(name.endsWith('…'), `pad=${pad}: truncation unmarked`)
  }
  // Pure-emoji message: every character is a surrogate pair.
  const allEmoji = projectName(msgDoc('🚀'.repeat(60)))
  assert.ok(allEmoji.length <= CAP)
  assert.ok(allEmoji.isWellFormed(), 'pure-emoji message left a broken pair')
})

// --- _id fallback ---

test('with no user message the _id string is used and respects the same bound', () => {
  const short = projectName({ messages: [], _id: { toString: () => 'abc123' } })
  assert.equal(short, `${PREFIX}abc123`)

  const long = projectName({ messages: [], _id: { toString: () => '9'.repeat(300) } })
  assert.equal(long.length, CAP)
  assert.ok(long.startsWith(PREFIX))
  assert.ok(long.endsWith('…'))
})

// --- approve path end-to-end: long first message no longer breaks approval ---

const sessions = () => getDb().collection('feature_requests')

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

// My own recording fake — returns fixture identities, remembers every call.
function recordingLinear() {
  const calls = []
  const rec = (method, args, ret) => {
    calls.push({ method, args })
    return ret
  }
  return {
    calls,
    named: (m) => calls.filter((c) => c.method === m),
    config: () => rec('config', {}, { teamId: 'team-t', readyForDevStateId: 'state-r' }),
    findOrCreateLabels: async (names) =>
      rec('findOrCreateLabels', { names }, Object.fromEntries(names.map((n) => [n, `lbl-${n}`]))),
    createProject: async (args) =>
      rec('createProject', args, { id: 'proj-tester-1', url: 'https://linear.app/t/project/p1' }),
    createIssue: async (args) =>
      rec('createIssue', args, {
        id: `iss-${calls.length}`,
        identifier: `DAN-9${calls.length}`,
        url: `https://linear.app/t/issue/DAN-9${calls.length}`,
      }),
    createRelation: async (args) => rec('createRelation', args, { id: `rel-${calls.length}` }),
  }
}

const USER = { token: 'tester-token', uid: 'uid-tester' }
const verify = async (token) => {
  if (token !== USER.token) throw new Error('bad token')
  return { uid: USER.uid }
}

const APPROVE = `mutation ($id: ID!) {
  approveFeatureRequestPlan(id: $id) { id status linearProjectId tickets { key identifier } }
}`

test('approve with a long first message: createProject gets a <=80-char name, approval succeeds, session builds', async () => {
  const longFirst =
    'Rework the entire records dashboard: add column pinning, saved filter presets shared per team, ' +
    'inline editing with optimistic updates, and a nightly reconciliation job emailing a diff report'
  assert.ok(longFirst.length > 150, 'fixture must exercise the truncation path')

  const gates = Object.fromEntries(
    ['notTooBig', 'notAmbiguous', 'noBlockedDependencies'].map((g) => [
      g,
      { pass: true, reason: 'tester fixture' },
    ]),
  )
  const { insertedId } = await sessions().insertOne({
    uid: USER.uid,
    status: 'gathering',
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: longFirst, createdAt: new Date() }],
    plan: {
      tickets: [
        { key: 'A1', title: 'Backend work', description: 'Do the backend.', dependsOn: [] },
        { key: 'A2', title: 'Frontend work', description: 'Do the frontend.', dependsOn: ['A1'] },
      ],
    },
    entranceCriteria: gates,
    createdAt: new Date(),
  })

  const linear = recordingLinear()
  const app = createApp({ verifyToken: verify, linearClient: linear })
  const res = await request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${USER.token}`)
    .send({ query: APPROVE, variables: { id: insertedId.toString() } })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, `approve failed: ${JSON.stringify(res.body.errors)}`)

  // The name Linear actually received is valid.
  const projects = linear.named('createProject')
  assert.equal(projects.length, 1, 'exactly one project filed')
  const sent = projects[0].args.name
  assert.ok(sent.length <= CAP, `Linear received a ${sent.length}-char name`)
  assert.ok(sent.startsWith(PREFIX))
  assert.ok(sent.endsWith('…'))

  // Approval completed: issues filed, session flipped to building.
  assert.equal(linear.named('createIssue').length, 2, 'one issue per plan ticket')
  assert.equal(res.body.data.approveFeatureRequestPlan.status, 'building')
  assert.equal(res.body.data.approveFeatureRequestPlan.linearProjectId, 'proj-tester-1')
  const stored = await sessions().findOne({ _id: insertedId })
  assert.equal(stored.status, 'building')
})
