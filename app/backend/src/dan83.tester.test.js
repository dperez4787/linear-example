// DAN-83 tester suite (independent verification — written from the acceptance
// criteria and the VERIFIED Linear attachment-metadata contract, not from the
// developer's tests).
//
// featureRequestActivity(promptId): the build narrated from the ticket trail —
// Linear comments (author labeled by content heuristics), workflow state
// changes (from→to), and the PR attachment lifecycle, merged chronologically
// across ALL of the session's filed tickets. Exercised through the real
// GraphQL layer (supertest against createApp) with a recording fake
// linearClient; Mongo (linear_example_test) is the only external dependency.
// Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import request from 'supertest'

if (!process.env.MONGODB_URI) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch {
    // No .env — MONGODB_URI must come from the ambient environment.
  }
}
process.env.MONGODB_DB = 'linear_example_test'

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const {
  featureRequestActivity,
  clearFeatureRequestActivityCache,
  ACTIVITY_CACHE_TTL_MS,
  ACTIVITY_COMMENT_BODY_MAX,
} = await import('./featureRequests.js')

// --- recording fake linearClient -------------------------------------------

// Records every issuesActivity call; returns scripted responses in order (the
// last script repeats so cache tests can call freely). No network, ever.
function recordingLinear(...scripts) {
  const calls = []
  return {
    calls,
    async issuesActivity(ids) {
      calls.push(ids)
      if (scripts.length === 0) return []
      return scripts.length > 1 ? scripts.shift() : scripts[0]
    },
  }
}

// A Linear issue node in the raw shape linearClient.issuesActivity returns.
function issueNode({ id, identifier, comments = [], history = [], attachments = [] }) {
  return {
    id,
    identifier,
    url: `https://linear.app/tester/issue/${identifier}`,
    comments: { nodes: comments },
    history: { nodes: history },
    attachments: { nodes: attachments },
  }
}

const c = (createdAt, body, url) => ({ body, createdAt, ...(url && { url }) })
const st = (createdAt, from, to) => ({
  createdAt,
  fromState: from == null ? null : { name: from },
  toState: to == null ? null : { name: to },
})
// A GitHub PR attachment per the VERIFIED metadata contract: boolean
// metadata.draft (the authoritative draft bit — a draft PR's status is NOT
// "draft") plus lowercase metadata.status open/merged/closed with
// mergedAt/closedAt ISO timestamps.
const pr = (createdAt, url, metadata = { draft: false, status: 'open' }) => ({
  url,
  sourceType: 'github',
  createdAt,
  metadata,
})

// --- app + session plumbing -------------------------------------------------

const TOKENS = {
  'tok-alice': { uid: 'uid-alice' },
  'tok-bob': { uid: 'uid-bob' },
}
const stubVerify = async (token) => {
  if (!TOKENS[token]) throw new Error('bad token')
  return TOKENS[token]
}
const appWith = (linearClient) => createApp({ verifyToken: stubVerify, linearClient })

const ACTIVITY_QUERY = `query ($promptId: ID!) {
  featureRequestActivity(promptId: $promptId) { ts ticketIdentifier kind summary body url }
}`
const FEATURE_REQUEST_QUERY = `query ($id: ID!) { featureRequest(id: $id) { id } }`

const gql = (app, token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })

const coll = () => getDb().collection('feature_requests')

async function seedSession({ uid = 'uid-alice', tickets } = {}) {
  const doc = {
    uid,
    status: tickets ? 'building' : 'open',
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Ship it', createdAt: new Date() }],
    createdAt: new Date(),
  }
  if (tickets !== undefined) {
    doc.tickets = tickets
    doc.linearProjectId = 'proj-tester'
  }
  const { insertedId } = await coll().insertOne(doc)
  return insertedId.toString()
}

const ref = (n) => ({
  key: `T${n}`,
  linearIssueId: `issue-${n}`,
  identifier: `DAN-9${n}`,
  url: `https://linear.app/tester/issue/DAN-9${n}`,
})

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set')
  await connect()
})
beforeEach(async () => {
  await coll().deleteMany({})
  clearFeatureRequestActivityCache()
})
after(async () => {
  await coll().deleteMany({})
  await getDb().client.close()
})

// --- global chronological merge across multiple tickets ---------------------

test('tester: events from three tickets interleave into ONE globally time-ordered feed (not per-ticket concatenation), via one Linear query', async () => {
  // Timestamps deliberately zig-zag across tickets: sorted output must
  // alternate ticket identifiers, which per-ticket concatenation cannot.
  const linear = recordingLinear([
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      history: [st('2026-08-26T10:00:00.000Z', 'Backlog', 'In Progress')],
      comments: [c('2026-08-26T10:20:00.000Z', 'Starting the build now.')],
    }),
    issueNode({
      id: 'issue-2',
      identifier: 'DAN-92',
      history: [st('2026-08-26T10:10:00.000Z', 'Backlog', 'In Progress')],
      comments: [c('2026-08-26T10:30:00.000Z', 'Queued behind the first one.')],
    }),
    issueNode({
      id: 'issue-3',
      identifier: 'DAN-93',
      comments: [c('2026-08-26T10:05:00.000Z', 'Filing follow-up notes.')],
      attachments: [pr('2026-08-26T10:25:00.000Z', 'https://github.com/o/r/pull/3')],
    }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ tickets: [ref(1), ref(2), ref(3)] })

  const res = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, JSON.stringify(res.body.errors))

  const feed = res.body.data.featureRequestActivity
  assert.deepEqual(
    feed.map((e) => [e.ts, e.ticketIdentifier, e.kind]),
    [
      ['2026-08-26T10:00:00.000Z', 'DAN-91', 'state'],
      ['2026-08-26T10:05:00.000Z', 'DAN-93', 'comment'],
      ['2026-08-26T10:10:00.000Z', 'DAN-92', 'state'],
      ['2026-08-26T10:20:00.000Z', 'DAN-91', 'comment'],
      ['2026-08-26T10:25:00.000Z', 'DAN-93', 'pr'],
      ['2026-08-26T10:30:00.000Z', 'DAN-92', 'comment'],
    ],
    'global chronological order across tickets',
  )
  // Exact wire shape of one event of each kind.
  assert.deepEqual(feed[0], {
    ts: '2026-08-26T10:00:00.000Z',
    ticketIdentifier: 'DAN-91',
    kind: 'state',
    summary: 'DAN-91: Backlog → In Progress',
    body: null,
    url: 'https://linear.app/tester/issue/DAN-91',
  })
  assert.deepEqual(feed[4], {
    ts: '2026-08-26T10:25:00.000Z',
    ticketIdentifier: 'DAN-93',
    kind: 'pr',
    summary: 'PR opened for DAN-93',
    body: null,
    url: 'https://github.com/o/r/pull/3',
  })
  assert.equal(linear.calls.length, 1, 'exactly one issuesActivity call for the whole session')
  assert.deepEqual(linear.calls[0], ['issue-1', 'issue-2', 'issue-3'])
})

// --- comments: bodies, truncation, author heuristics -------------------------

test('tester: comment body over the cap truncates to exactly ACTIVITY_COMMENT_BODY_MAX chars ending in an ellipsis; short bodies pass through', async () => {
  const oversized = 'A'.repeat(ACTIVITY_COMMENT_BODY_MAX + 137)
  const linear = recordingLinear([
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      comments: [
        c('2026-08-26T09:00:00.000Z', oversized),
        c('2026-08-26T09:01:00.000Z', 'Small note.'),
      ],
    }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ tickets: [ref(1)] })

  const res = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  const [longEvent, shortEvent] = res.body.data.featureRequestActivity

  assert.equal(longEvent.body.length, ACTIVITY_COMMENT_BODY_MAX, 'truncated to the ~500 cap')
  assert.ok(longEvent.body.endsWith('…'), 'ellipsis marks the cut')
  assert.equal(longEvent.body.slice(0, -1), 'A'.repeat(ACTIVITY_COMMENT_BODY_MAX - 1))
  assert.equal(shortEvent.body, 'Small note.')
})

test('tester: author heuristics — tester vocabulary labels tester, developer vocabulary labels developer, neutral text labels agent', async () => {
  const linear = recordingLinear([
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      comments: [
        c('2026-08-26T09:00:00.000Z', 'Verdict: PASS. Every acceptance criterion holds under the suite.'),
        c('2026-08-26T09:01:00.000Z', 'Pushed the implementation to the ticket branch and opened a draft PR.'),
        c('2026-08-26T09:02:00.000Z', 'Kicking off the run for this session now.'),
      ],
    }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ tickets: [ref(1)] })

  const res = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.deepEqual(
    res.body.data.featureRequestActivity.map((e) => e.summary),
    [
      'tester commented on DAN-91',
      'developer commented on DAN-91',
      'agent commented on DAN-91',
    ],
  )
})

// --- state changes -----------------------------------------------------------

test('tester: state events summarize from→to; history rows lacking either state are not events', async () => {
  const linear = recordingLinear([
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      history: [
        st('2026-08-26T08:00:00.000Z', null, 'Ready for Dev'), // creation row
        st('2026-08-26T09:00:00.000Z', 'Ready for Dev', 'In Progress'),
        st('2026-08-26T09:30:00.000Z', null, null), // assignment/label row
        st('2026-08-26T10:00:00.000Z', 'In Progress', 'Done'),
      ],
    }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ tickets: [ref(1)] })

  const res = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.deepEqual(
    res.body.data.featureRequestActivity.map((e) => [e.kind, e.summary]),
    [
      ['state', 'DAN-91: Ready for Dev → In Progress'],
      ['state', 'DAN-91: In Progress → Done'],
    ],
  )
})

// --- pr lifecycle matrix (VERIFIED metadata contract) -----------------------

test('tester: PR lifecycle matrix — draft boolean → draft opened @createdAt; merged → @mergedAt; closed → @closedAt; open/missing metadata → opened; one pr event per issue', async () => {
  const linear = recordingLinear([
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      // Verified contract: draft PR has draft:true and status "open" (NOT "draft").
      attachments: [pr('2026-08-26T10:00:00.000Z', 'https://github.com/o/r/pull/1', { draft: true, status: 'open' })],
    }),
    issueNode({
      id: 'issue-2',
      identifier: 'DAN-92',
      attachments: [
        pr('2026-08-26T10:01:00.000Z', 'https://github.com/o/r/pull/2', {
          draft: false,
          status: 'merged',
          mergedAt: '2026-08-26T14:00:00.000Z',
        }),
      ],
    }),
    issueNode({
      id: 'issue-3',
      identifier: 'DAN-93',
      attachments: [
        pr('2026-08-26T10:02:00.000Z', 'https://github.com/o/r/pull/3', {
          draft: false,
          status: 'closed',
          closedAt: '2026-08-26T15:00:00.000Z',
        }),
      ],
    }),
    issueNode({
      id: 'issue-4',
      identifier: 'DAN-94',
      attachments: [pr('2026-08-26T10:03:00.000Z', 'https://github.com/o/r/pull/4', { draft: false, status: 'open' })],
    }),
    issueNode({
      id: 'issue-5',
      identifier: 'DAN-95',
      // No metadata at all — must still narrate as an opened PR, never crash.
      attachments: [{ url: 'https://github.com/o/r/pull/5', sourceType: 'github', createdAt: '2026-08-26T10:04:00.000Z' }],
    }),
    issueNode({
      id: 'issue-6',
      identifier: 'DAN-96',
      // Two github attachments on one issue: exactly ONE pr event.
      attachments: [
        pr('2026-08-26T10:05:00.000Z', 'https://github.com/o/r/pull/6', { draft: false, status: 'open' }),
        pr('2026-08-26T10:06:00.000Z', 'https://github.com/o/r/pull/66', { draft: false, status: 'open' }),
      ],
    }),
    issueNode({
      id: 'issue-7',
      identifier: 'DAN-97',
      // A non-GitHub attachment must not produce a pr event.
      attachments: [{ url: 'https://www.figma.com/file/xyz', sourceType: 'figma', createdAt: '2026-08-26T10:07:00.000Z' }],
    }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ tickets: [1, 2, 3, 4, 5, 6, 7].map(ref) })

  const res = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.equal(res.body.errors, undefined, JSON.stringify(res.body.errors))
  const prEvents = res.body.data.featureRequestActivity.filter((e) => e.kind === 'pr')

  assert.deepEqual(
    prEvents.map((e) => [e.ticketIdentifier, e.summary, e.ts, e.url]),
    [
      ['DAN-91', 'draft PR opened for DAN-91', '2026-08-26T10:00:00.000Z', 'https://github.com/o/r/pull/1'],
      ['DAN-94', 'PR opened for DAN-94', '2026-08-26T10:03:00.000Z', 'https://github.com/o/r/pull/4'],
      ['DAN-95', 'PR opened for DAN-95', '2026-08-26T10:04:00.000Z', 'https://github.com/o/r/pull/5'],
      ['DAN-96', 'PR opened for DAN-96', '2026-08-26T10:05:00.000Z', 'https://github.com/o/r/pull/6'],
      ['DAN-92', 'PR merged for DAN-92', '2026-08-26T14:00:00.000Z', 'https://github.com/o/r/pull/2'],
      ['DAN-93', 'PR closed for DAN-93', '2026-08-26T15:00:00.000Z', 'https://github.com/o/r/pull/3'],
    ],
    'lifecycle verbs, per-state timestamps, one pr event per issue, no event for DAN-97',
  )
})

test('tester: a merged PR sorts into the feed at mergedAt — after comments that came between attachment and merge', async () => {
  const linear = recordingLinear([
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      comments: [c('2026-08-26T12:00:00.000Z', 'Midway status note for the record.')],
      attachments: [
        pr('2026-08-26T10:00:00.000Z', 'https://github.com/o/r/pull/1', {
          draft: false,
          status: 'merged',
          mergedAt: '2026-08-26T14:00:00.000Z',
        }),
      ],
    }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ tickets: [ref(1)] })

  const res = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.deepEqual(
    res.body.data.featureRequestActivity.map((e) => [e.kind, e.ts]),
    [
      ['comment', '2026-08-26T12:00:00.000Z'],
      ['pr', '2026-08-26T14:00:00.000Z'],
    ],
    'the merge narrates where it happened, not where the PR was attached',
  )
  assert.equal(res.body.data.featureRequestActivity[1].summary, 'PR merged for DAN-91')
})

test('tester: merged/closed metadata WITHOUT its timestamp falls back to the attachment createdAt', async () => {
  const linear = recordingLinear([
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      attachments: [
        pr('2026-08-26T10:00:00.000Z', 'https://github.com/o/r/pull/1', { draft: false, status: 'merged' }),
      ],
    }),
    issueNode({
      id: 'issue-2',
      identifier: 'DAN-92',
      attachments: [
        pr('2026-08-26T11:00:00.000Z', 'https://github.com/o/r/pull/2', { draft: false, status: 'closed' }),
      ],
    }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ tickets: [ref(1), ref(2)] })

  const res = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.deepEqual(
    res.body.data.featureRequestActivity.map((e) => [e.summary, e.ts]),
    [
      ['PR merged for DAN-91', '2026-08-26T10:00:00.000Z'],
      ['PR closed for DAN-92', '2026-08-26T11:00:00.000Z'],
    ],
  )
})

// --- scoping: unapproved, foreign, unknown, malformed ------------------------

test('tester: an unapproved session (no filed tickets) returns [] and makes ZERO Linear calls', async () => {
  const linear = recordingLinear()
  const app = appWith(linear)
  const id = await seedSession({}) // no tickets

  const res = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestActivity, [])
  assert.equal(linear.calls.length, 0, 'activity is approved-only data — Linear untouched')
})

test('tester: foreign, unknown, and malformed promptIds are NOT_FOUND, identical in shape to featureRequest\'s, with zero Linear calls', async () => {
  const linear = recordingLinear()
  const app = appWith(linear)
  const aliceId = await seedSession({ uid: 'uid-alice', tickets: [ref(1)] })

  const cases = [
    ['tok-bob', aliceId], // foreign: Bob asking for Alice's session
    ['tok-alice', '64b000000000000000000000'], // unknown but valid ObjectId
    ['tok-alice', 'definitely-not-an-objectid'], // malformed
  ]
  for (const [token, promptId] of cases) {
    const res = await gql(app, token, ACTIVITY_QUERY, { promptId })
    assert.equal(res.status, 200, `${promptId}: GraphQL errors ride a 200`)
    assert.equal(res.body.data, null)
    assert.equal(res.body.errors.length, 1)
    const err = res.body.errors[0]
    // Reference shape: what featureRequest(id) itself returns for the same miss.
    const refRes = await gql(app, token, FEATURE_REQUEST_QUERY, { id: promptId })
    const refErr = refRes.body.errors[0]
    assert.equal(err.message, refErr.message, `${promptId}: same message as featureRequest`)
    assert.deepEqual(err.extensions, refErr.extensions, `${promptId}: same extensions as featureRequest`)
    assert.equal(err.extensions.code, 'NOT_FOUND')
    assert.equal(err.message, 'feature request not found')
  }
  assert.equal(linear.calls.length, 0, 'no miss ever reaches Linear')
})

// --- cache -------------------------------------------------------------------

test('tester: two calls inside the TTL fetch Linear once; the second serves the cached feed', async () => {
  const linear = recordingLinear([
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      comments: [c('2026-08-26T09:00:00.000Z', 'Only fetched once.')],
    }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ tickets: [ref(1)] })

  const first = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  const second = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })

  assert.equal(linear.calls.length, 1, 'one Linear fetch for two in-TTL calls')
  assert.deepEqual(second.body.data, first.body.data)
})

test('tester: with an injectable clock, the cache expires after ACTIVITY_CACHE_TTL_MS and Linear is re-read', async () => {
  const stale = [issueNode({ id: 'issue-1', identifier: 'DAN-91', comments: [c('2026-08-26T09:00:00.000Z', 'First read of the trail.')] })]
  const fresh = [
    issueNode({
      id: 'issue-1',
      identifier: 'DAN-91',
      comments: [c('2026-08-26T09:00:00.000Z', 'First read of the trail.')],
      history: [st('2026-08-26T09:30:00.000Z', 'In Review', 'Done')],
    }),
  ]
  const linear = recordingLinear(stale, fresh)
  const id = await seedSession({ tickets: [ref(1)] })

  let clock = 1_000_000
  const now = () => clock

  const a = await featureRequestActivity('uid-alice', id, linear, now)
  assert.equal(a.length, 1)

  clock += ACTIVITY_CACHE_TTL_MS - 1 // still inside the window
  const b = await featureRequestActivity('uid-alice', id, linear, now)
  assert.equal(linear.calls.length, 1, 'one ms before expiry the cache still serves')
  assert.deepEqual(b, a)

  clock += 2 // now past the TTL
  const cEvents = await featureRequestActivity('uid-alice', id, linear, now)
  assert.equal(linear.calls.length, 2, 'past the TTL Linear is re-read')
  assert.equal(cEvents.length, 2)
  assert.equal(cEvents[1].summary, 'DAN-91: In Review → Done')
})

test('tester: DAN-52 proof — Alice warming the cache does not bypass scoping: Bob still gets NOT_FOUND and his request never reaches Linear', async () => {
  const linear = recordingLinear([
    issueNode({ id: 'issue-1', identifier: 'DAN-91', comments: [c('2026-08-26T09:00:00.000Z', 'Warm feed.')] }),
  ])
  const app = appWith(linear)
  const id = await seedSession({ uid: 'uid-alice', tickets: [ref(1)] })

  // Alice warms the cache for this promptId.
  const warm = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.equal(warm.body.errors, undefined)
  assert.equal(warm.body.data.featureRequestActivity.length, 1)
  assert.equal(linear.calls.length, 1)

  // Bob asks for the SAME promptId while the cache is hot.
  const bob = await gql(app, 'tok-bob', ACTIVITY_QUERY, { promptId: id })
  assert.equal(bob.body.data, null)
  assert.equal(bob.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(bob.body.errors[0].message, 'feature request not found')
  assert.equal(linear.calls.length, 1, 'Bob\'s denied request recorded NO Linear call')

  // And the cache is still intact for Alice — served without a refetch.
  const again = await gql(app, 'tok-alice', ACTIVITY_QUERY, { promptId: id })
  assert.equal(again.body.data.featureRequestActivity.length, 1)
  assert.equal(linear.calls.length, 1)
})
