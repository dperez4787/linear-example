// featureRequestProgress (DAN-52): live per-ticket build status for the
// watch-it-build view, read from Linear on demand through the injected
// client. Tested over HTTP via supertest against the in-process app.
// Run with: npm test
//
// The injected linearClient is a FAKE that records every issuesProgress call
// and returns scripted Linear issue nodes — no test reaches real Linear
// (criterion 5). Sessions are seeded directly into the scratch collection so
// each test controls the filed tickets exactly; Mongo (linear_example_test)
// is the only external dependency, same as the sibling suites.
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
const {
  featureRequestProgress,
  clearFeatureRequestProgressCache,
  PROGRESS_CACHE_TTL_MS,
} = await import('./featureRequests.js')

// --- fixtures ---

// A Linear issue node exactly as linearClient.issuesProgress returns it —
// the fixture shape the ticket pins down: attachments as
// { nodes: [{ url, sourceType }] }, blocked-by as
// { inverseRelations: { nodes: [{ type: "blocks", issue: { id } }] } }.
function linearIssue({
  id,
  identifier,
  title = `title of ${identifier}`,
  state,
  attachments = [],
  inverseRelations = [],
}) {
  return {
    id,
    identifier,
    title,
    url: `https://linear.app/fixture/issue/${identifier}`,
    state,
    attachments: { nodes: attachments },
    inverseRelations: { nodes: inverseRelations },
  }
}

const PR_ATTACHMENT = {
  url: 'https://github.com/dperez4787/linear-example/pull/99',
  sourceType: 'github',
}

// The recording fake (criterion 5): issuesProgress pushes its argument onto
// `calls` and returns the scripted node arrays in order (the last script
// repeats, so cache tests can call freely).
function fakeLinearClient(...scriptedNodes) {
  const calls = []
  return {
    calls,
    async issuesProgress(issueIds) {
      calls.push(issueIds)
      return scriptedNodes.length > 1 ? scriptedNodes.shift() : (scriptedNodes[0] ?? [])
    },
  }
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

// Exactly the criterion-1 field names — the DAN-55 frontend contract.
const PROGRESS = `query ($promptId: ID!) {
  featureRequestProgress(promptId: $promptId) {
    issueId identifier title state issueUrl prUrl blockedBy
  }
}`

const featureRequests = () => getDb().collection('feature_requests')

// Seed a session document directly — the DAN-49/50/51 pipeline is not under
// test here, reading the progress of its stored outcome is. `tickets` is the
// DAN-51 stored shape: { key, linearIssueId, identifier, url }.
async function seedSession({ uid = 'uid-alice', status = 'building', tickets } = {}) {
  const doc = {
    uid,
    status,
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Please add CSV export', createdAt: new Date() }],
    createdAt: new Date(),
  }
  if (tickets !== undefined) {
    doc.tickets = tickets
    doc.linearProjectId = 'project-fixture-id'
  }
  const { insertedId } = await featureRequests().insertOne(doc)
  return insertedId.toString()
}

const ticketRef = (key, issueId, identifier) => ({
  key,
  linearIssueId: issueId,
  identifier,
  url: `https://linear.app/fixture/issue/${identifier}`,
})

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  await featureRequests().deleteMany({})
  clearFeatureRequestProgressCache()
})

after(async () => {
  await featureRequests().deleteMany({})
  await getDb().client.close()
})

// --- criterion 1: one node per filed ticket, exact field names, filed order ---

test('an approved session returns one node per filed ticket with the exact criterion-1 shape, in filed-ticket order', async () => {
  // Linear returns the issues OUT of stored order — the query must re-order
  // by the session's filed tickets, not trust Linear's response order.
  const linear = fakeLinearClient([
    linearIssue({
      id: 'issue-2',
      identifier: 'DAN-102',
      title: 'Frontend: export button',
      state: { name: 'In Progress', type: 'started' },
      inverseRelations: [{ type: 'blocks', issue: { id: 'issue-1' } }],
    }),
    linearIssue({
      id: 'issue-1',
      identifier: 'DAN-101',
      title: 'Backend: export query',
      state: { name: 'Done', type: 'completed' },
      attachments: [PR_ATTACHMENT],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [ticketRef('T1', 'issue-1', 'DAN-101'), ticketRef('T2', 'issue-2', 'DAN-102')],
  })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, JSON.stringify(res.body.errors))
  assert.deepEqual(res.body.data.featureRequestProgress, [
    {
      issueId: 'issue-1',
      identifier: 'DAN-101',
      title: 'Backend: export query',
      state: 'DONE',
      issueUrl: 'https://linear.app/fixture/issue/DAN-101',
      prUrl: PR_ATTACHMENT.url,
      blockedBy: [],
    },
    {
      issueId: 'issue-2',
      identifier: 'DAN-102',
      title: 'Frontend: export button',
      state: 'IN_PROGRESS',
      issueUrl: 'https://linear.app/fixture/issue/DAN-102',
      prUrl: null,
      blockedBy: ['issue-1'],
    },
  ])
  assert.equal(linear.calls.length, 1, 'ONE Linear query for the whole session')
  assert.deepEqual(linear.calls[0], ['issue-1', 'issue-2'], 'queried by the stored linearIssueIds')
})

// --- criterion 2: state mapping, asserted with Linear fixtures ---

test('state mapping: started→IN_PROGRESS, In Review→IN_REVIEW, completed→DONE, backlog/unstarted without PR→BACKLOG, with PR→BOUNCED', async () => {
  const linear = fakeLinearClient([
    linearIssue({ id: 'i-1', identifier: 'DAN-1', state: { name: 'In Progress', type: 'started' } }),
    linearIssue({ id: 'i-2', identifier: 'DAN-2', state: { name: 'In Review', type: 'started' } }),
    linearIssue({ id: 'i-3', identifier: 'DAN-3', state: { name: 'Done', type: 'completed' } }),
    linearIssue({ id: 'i-4', identifier: 'DAN-4', state: { name: 'Backlog', type: 'backlog' } }),
    linearIssue({ id: 'i-5', identifier: 'DAN-5', state: { name: 'Todo', type: 'unstarted' } }),
    linearIssue({
      id: 'i-6',
      identifier: 'DAN-6',
      state: { name: 'Backlog', type: 'backlog' },
      attachments: [PR_ATTACHMENT],
    }),
    linearIssue({
      id: 'i-7',
      identifier: 'DAN-7',
      state: { name: 'Todo', type: 'unstarted' },
      attachments: [PR_ATTACHMENT],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [1, 2, 3, 4, 5, 6, 7].map((n) => ticketRef(`T${n}`, `i-${n}`, `DAN-${n}`)),
  })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })

  assert.deepEqual(
    res.body.data.featureRequestProgress.map((t) => t.state),
    ['IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BACKLOG', 'BACKLOG', 'BOUNCED', 'BOUNCED'],
  )
})

test('the In Review name is matched case-insensitively, and started-with-a-PR is still IN_PROGRESS (a PR only bounces backlog-family states)', async () => {
  const linear = fakeLinearClient([
    linearIssue({ id: 'i-1', identifier: 'DAN-1', state: { name: 'IN REVIEW', type: 'started' } }),
    linearIssue({
      id: 'i-2',
      identifier: 'DAN-2',
      state: { name: 'In Progress', type: 'started' },
      attachments: [PR_ATTACHMENT],
    }),
    // triage is a backlog-family type; a completed ticket keeps DONE even
    // with its PR still attached.
    linearIssue({ id: 'i-3', identifier: 'DAN-3', state: { name: 'Triage', type: 'triage' } }),
    linearIssue({
      id: 'i-4',
      identifier: 'DAN-4',
      state: { name: 'Done', type: 'completed' },
      attachments: [PR_ATTACHMENT],
    }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [1, 2, 3, 4].map((n) => ticketRef(`T${n}`, `i-${n}`, `DAN-${n}`)),
  })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })

  assert.deepEqual(
    res.body.data.featureRequestProgress.map((t) => t.state),
    ['IN_REVIEW', 'IN_PROGRESS', 'BACKLOG', 'DONE'],
  )
})

// --- criterion 3: prUrl from the PR attachment when present, else null ---

test('prUrl comes from the PR attachment; non-PR attachments are ignored; sourceType alone also identifies the PR', async () => {
  const linear = fakeLinearClient([
    // A non-PR attachment (a Figma link) plus the PR: the PR's url wins.
    linearIssue({
      id: 'i-1',
      identifier: 'DAN-1',
      state: { name: 'In Review', type: 'started' },
      attachments: [
        { url: 'https://www.figma.com/file/abc', sourceType: 'figma' },
        { url: 'https://github.com/dperez4787/linear-example/pull/7', sourceType: 'github' },
      ],
    }),
    // Only non-PR attachments: prUrl is null, not the Figma link.
    linearIssue({
      id: 'i-2',
      identifier: 'DAN-2',
      state: { name: 'In Progress', type: 'started' },
      attachments: [{ url: 'https://www.figma.com/file/def', sourceType: 'figma' }],
    }),
    // sourceType identifies the PR even when the url shape is unfamiliar
    // (e.g. a GitHub Enterprise host that doesn't contain github.com).
    linearIssue({
      id: 'i-3',
      identifier: 'DAN-3',
      state: { name: 'Backlog', type: 'backlog' },
      attachments: [{ url: 'https://git.example.com/o/r/pull/12', sourceType: 'githubPullRequest' }],
    }),
    // url identifies the PR even without a sourceType.
    linearIssue({
      id: 'i-4',
      identifier: 'DAN-4',
      state: { name: 'Backlog', type: 'backlog' },
      attachments: [{ url: 'https://github.com/o/r/pull/13' }],
    }),
    // No attachments at all.
    linearIssue({ id: 'i-5', identifier: 'DAN-5', state: { name: 'Todo', type: 'unstarted' } }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [1, 2, 3, 4, 5].map((n) => ticketRef(`T${n}`, `i-${n}`, `DAN-${n}`)),
  })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })

  const rows = res.body.data.featureRequestProgress
  assert.equal(rows[0].prUrl, 'https://github.com/dperez4787/linear-example/pull/7')
  assert.equal(rows[1].prUrl, null)
  assert.equal(rows[2].prUrl, 'https://git.example.com/o/r/pull/12')
  assert.equal(rows[2].state, 'BOUNCED', 'the sourceType-detected PR bounces a backlog ticket')
  assert.equal(rows[3].prUrl, 'https://github.com/o/r/pull/13')
  assert.equal(rows[3].state, 'BOUNCED', 'the url-detected PR bounces a backlog ticket')
  assert.equal(rows[4].prUrl, null)
})

// --- blockedBy: blocks relations only, from inverseRelations ---

test('blockedBy lists the blocker issue ids from inverse "blocks" relations; other relation types are ignored', async () => {
  const linear = fakeLinearClient([
    linearIssue({ id: 'i-1', identifier: 'DAN-1', state: { name: 'Done', type: 'completed' } }),
    linearIssue({
      id: 'i-2',
      identifier: 'DAN-2',
      state: { name: 'Backlog', type: 'backlog' },
      inverseRelations: [
        { type: 'blocks', issue: { id: 'i-1' } },
        { type: 'blocks', issue: { id: 'i-3' } },
        { type: 'related', issue: { id: 'i-999' } },
        { type: 'duplicate', issue: { id: 'i-998' } },
      ],
    }),
    linearIssue({ id: 'i-3', identifier: 'DAN-3', state: { name: 'Todo', type: 'unstarted' } }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [1, 2, 3].map((n) => ticketRef(`T${n}`, `i-${n}`, `DAN-${n}`)),
  })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })

  assert.deepEqual(
    res.body.data.featureRequestProgress.map((t) => t.blockedBy),
    [[], ['i-1', 'i-3'], []],
  )
})

// --- criterion 4: unapproved → [], unknown/foreign → NOT_FOUND ---

test('a session that has not been approved yet (no filed tickets) returns [] and never calls Linear', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const id = await seedSession({ status: 'gathering', tickets: undefined })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestProgress, [])
  assert.equal(linear.calls.length, 0, 'progress is approved-only data — no Linear read')
})

test('unknown, malformed, and another user\'s promptId all yield the NOT_FOUND shape, with zero Linear calls', async () => {
  const linear = fakeLinearClient()
  const app = makeApp(linear)
  const aliceSession = await seedSession({
    tickets: [ticketRef('T1', 'issue-1', 'DAN-101')],
  })

  const cases = [
    ['unknown promptId', ALICE, '0123456789abcdef01234567'],
    ['malformed promptId', ALICE, 'not-an-object-id'],
    ["another user's session", BOB, aliceSession],
  ]
  for (const [label, token, promptId] of cases) {
    const res = await gql(app, token, PROGRESS, { promptId })
    assert.equal(res.status, 200, `${label}: domain errors are never HTTP 4xx`)
    assert.equal(res.body.data, null, `${label}: non-null list type nulls data overall`)
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND', label)
    assert.equal(res.body.errors[0].message, 'feature request not found', label)
  }
  assert.equal(linear.calls.length, 0, 'a NOT_FOUND never reaches Linear')
})

// --- a filed ticket deleted in Linear is skipped, not fabricated ---

test('a filed ticket Linear no longer returns is skipped rather than invented', async () => {
  const linear = fakeLinearClient([
    linearIssue({ id: 'issue-2', identifier: 'DAN-102', state: { name: 'Todo', type: 'unstarted' } }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [ticketRef('T1', 'issue-1', 'DAN-101'), ticketRef('T2', 'issue-2', 'DAN-102')],
  })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(
    res.body.data.featureRequestProgress.map((t) => t.issueId),
    ['issue-2'],
  )
})

// --- the ~10s cache: per promptId, Linear read only; clearable; expiring ---

test('two reads within the TTL hit Linear once; clearing the cache forces a refetch; the session read (and its auth) is never cached', async () => {
  const linear = fakeLinearClient([
    linearIssue({ id: 'issue-1', identifier: 'DAN-101', state: { name: 'In Progress', type: 'started' } }),
  ])
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('T1', 'issue-1', 'DAN-101')] })

  const first = await gql(app, ALICE, PROGRESS, { promptId: id })
  const second = await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(first.body.errors, undefined)
  assert.deepEqual(second.body.data, first.body.data, 'the cached nodes are what the second read serves')
  assert.equal(linear.calls.length, 1, 'the second read within ~10s is served from the cache')

  // The cache never bypasses the per-user session read: Bob still gets
  // NOT_FOUND on Alice's (cached) session.
  const bob = await gql(app, BOB, PROGRESS, { promptId: id })
  assert.equal(bob.body.errors[0].extensions.code, 'NOT_FOUND')

  clearFeatureRequestProgressCache()
  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(linear.calls.length, 2, 'a cleared cache refetches from Linear')
})

test('the cache expires after PROGRESS_CACHE_TTL_MS (injectable clock, data layer)', async () => {
  const linear = fakeLinearClient([
    linearIssue({ id: 'issue-1', identifier: 'DAN-101', state: { name: 'Done', type: 'completed' } }),
  ])
  const id = await seedSession({ tickets: [ticketRef('T1', 'issue-1', 'DAN-101')] })

  let clock = 1_000_000
  const now = () => clock

  await featureRequestProgress('uid-alice', id, linear, now)
  clock += PROGRESS_CACHE_TTL_MS - 1
  await featureRequestProgress('uid-alice', id, linear, now)
  assert.equal(linear.calls.length, 1, 'one tick inside the TTL still serves the cache')

  clock += 2
  const rows = await featureRequestProgress('uid-alice', id, linear, now)
  assert.equal(linear.calls.length, 2, 'past the TTL the cache entry is stale and Linear is re-read')
  assert.equal(rows[0].state, 'DONE')
})
