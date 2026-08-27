// DAN-94 TESTER · independent verification that a session reaches a terminal
// status when the work ships, exactly once, only for its owner, and never
// comes back.
//
// Written from the acceptance criteria, not from the implementation: the
// suite names the behaviour ("the status the wire serves stops saying
// building"), and reaches for the implementation's vocabulary only where the
// criteria themselves are about vocabulary (the exported SHIPPED_STATUS).
//
// The load-bearing instrument here is a wrapper around the feature_requests
// collection that RECORDS every updateOne the module issues. "Flips exactly
// once" is not observable from the stored document alone — a re-read that
// rewrote the same status would look identical — so the count of writes, the
// filter each write carried, and the number of documents each one actually
// modified are what the "exactly once" and "never backwards" criteria are
// asserted against. The same seam is used to make Mongo throw.
//
// Mongo (linear_example_test) is the only external dependency; Linear is a
// recording fake, same idiom as the DAN-52 suite. Run with:
//   MONGODB_URI=... MONGODB_DB=linear_example_test npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { ObjectId } from 'mongodb'

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
const { featureRequestProgress, clearFeatureRequestProgressCache, SHIPPED_STATUS } = await import(
  './featureRequests.js'
)

// --- Linear fixtures ---------------------------------------------------------

const STATES = {
  done: { name: 'Done', type: 'completed' },
  started: { name: 'In Progress', type: 'started' },
  backlog: { name: 'Todo', type: 'backlog' },
}

function issue(id, identifier, state) {
  return {
    id,
    identifier,
    title: `title of ${identifier}`,
    url: `https://linear.app/fixture/issue/${identifier}`,
    state,
    attachments: { nodes: [] },
    inverseRelations: { nodes: [] },
  }
}

// A fake whose per-issue states are MUTABLE: a ticket can be moved forwards
// (to done) or backwards (reopened) between reads, which is how the
// never-flips-back criterion is exercised against Linear's real behaviour.
function fakeLinear(...issues) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const calls = []
  return {
    byId,
    calls,
    setState(id, state) {
      byId.get(id).state = state
    },
    async issuesProgress(issueIds) {
      calls.push(issueIds)
      return issueIds.map((id) => byId.get(id)).filter(Boolean)
    },
  }
}

// --- app plumbing ------------------------------------------------------------

const TOKENS = {
  'dan94-alice': { uid: 'uid-dan94-alice' },
  'dan94-mallory': { uid: 'uid-dan94-mallory' },
}
const ALICE = 'dan94-alice'
const ALICE_UID = 'uid-dan94-alice'
const MALLORY = 'dan94-mallory'
const MALLORY_UID = 'uid-dan94-mallory'

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

const PROGRESS = `query ($promptId: ID!) {
  featureRequestProgress(promptId: $promptId) { issueId identifier state }
}`
const ONE = 'query ($id: ID!) { featureRequest(id: $id) { id status } }'
const LIST = '{ featureRequests { id status } }'

const featureRequests = () => getDb().collection('feature_requests')

async function seedSession({ uid = ALICE_UID, status = 'building', tickets = [] } = {}) {
  const doc = {
    uid,
    status,
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Please add CSV export', createdAt: new Date() }],
    createdAt: new Date(),
  }
  if (tickets.length > 0) {
    doc.tickets = tickets
    doc.linearProjectId = 'project-dan94'
  }
  const { insertedId } = await featureRequests().insertOne(doc)
  return insertedId.toString()
}

const ticketRef = (issueId, identifier) => ({
  key: identifier,
  linearIssueId: issueId,
  identifier,
  url: `https://linear.app/fixture/issue/${identifier}`,
})

const storedDoc = (id) =>
  featureRequests().findOne({ _id: ObjectId.createFromHexString(id) })

const storedStatus = async (id) => (await storedDoc(id))?.status

// --- the write recorder ------------------------------------------------------

// Shadows Db#collection with a wrapper that records every updateOne against
// feature_requests (filter, update document, and the driver's result), and
// can be told to make the next writes throw. Everything else passes straight
// through, and every other collection is untouched.
function recordWrites() {
  const db = getDb()
  const original = db.collection.bind(db)
  const updates = []
  let failure = null

  db.collection = (name, ...rest) => {
    const col = original(name, ...rest)
    if (name !== 'feature_requests') return col
    return new Proxy(col, {
      get(target, prop, receiver) {
        if (prop === 'updateOne') {
          return async (filter, update, options) => {
            const record = { filter, update }
            updates.push(record)
            if (failure) throw failure
            const result = await target.updateOne(filter, update, options)
            record.modified = result.modifiedCount
            return result
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  return {
    updates,
    failNextWith(err) {
      failure = err
    },
    stopFailing() {
      failure = null
    },
    restore() {
      delete db.collection
    },
  }
}

let writes = null

before(async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be set for these tests')
  await connect()
})

beforeEach(async () => {
  if (writes) writes.restore()
  await featureRequests().deleteMany({})
  clearFeatureRequestProgressCache()
  writes = recordWrites()
})

after(async () => {
  if (writes) writes.restore()
  await featureRequests().deleteMany({})
  await getDb().client.close()
})

// --- 1. the terminal status exists and is its own word -----------------------

test('the terminal status is a single exported constant, distinct from "building" and "gathering"', () => {
  assert.equal(typeof SHIPPED_STATUS, 'string')
  assert.ok(SHIPPED_STATUS.length > 0, 'the terminal status is a non-empty string')
  assert.notEqual(SHIPPED_STATUS, 'building')
  assert.notEqual(SHIPPED_STATUS, 'gathering')
  assert.equal(SHIPPED_STATUS, 'shipped', 'the ticket asks for the word the ticket uses')
})

// --- 2. all-DONE flips exactly once, persisted -------------------------------

test('a session whose filed tickets are all DONE flips to the terminal status on a progress read, and the flip is persisted', async () => {
  const linear = fakeLinear(
    issue('i1', 'DAN-201', STATES.done),
    issue('i2', 'DAN-202', STATES.done),
  )
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-201'), ticketRef('i2', 'DAN-202')] })

  assert.equal(await storedStatus(id), 'building', 'precondition: stored as building')

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, JSON.stringify(res.body.errors))
  assert.deepEqual(
    res.body.data.featureRequestProgress.map((n) => n.state),
    ['DONE', 'DONE'],
    'the nodes the caller asked for are still served',
  )

  // Persisted, not just computed.
  const doc = await storedDoc(id)
  assert.equal(doc.status, SHIPPED_STATUS)
  assert.ok(doc.shippedAt instanceof Date, 'the moment it shipped is stamped alongside')

  // Exactly one write, and it was uid-scoped and guarded on "building".
  assert.equal(writes.updates.length, 1, 'the flip is ONE write')
  assert.equal(writes.updates[0].filter.uid, ALICE_UID, 'the write is scoped to the caller')
  assert.equal(writes.updates[0].filter.status, 'building', 'guarded on the precondition')
  assert.equal(writes.updates[0].modified, 1, 'it modified the caller\'s document')
})

test('a second progress read of a shipped session issues NO write at all — the flip happens exactly once', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-203', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-203')] })

  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(writes.updates.length, 1)
  const firstShippedAt = (await storedDoc(id)).shippedAt

  // Past the cache, so the second read is a full cold read that re-derives
  // "finished" — the strongest form of the re-read: nothing is short-circuited
  // by the cache, and the write STILL must not happen.
  clearFeatureRequestProgressCache()
  const again = await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(again.body.errors, undefined)
  assert.equal(again.body.data.featureRequestProgress[0].state, 'DONE')

  assert.equal(writes.updates.length, 1, 'the re-read issued no second write')
  const doc = await storedDoc(id)
  assert.equal(doc.status, SHIPPED_STATUS)
  assert.deepEqual(
    doc.shippedAt,
    firstShippedAt,
    'shippedAt is the moment it FIRST shipped, not the moment it was last read',
  )

  // And a third, for good measure — the count must stay put forever.
  clearFeatureRequestProgressCache()
  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(writes.updates.length, 1, 'still exactly one write after three reads')
})

test('two concurrent progress reads of the same finished session produce one effective flip', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-204', STATES.done))
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-204')] })

  // Data layer with the cache disabled (a clock that always looks stale), so
  // both reads genuinely race into the flip rather than one being served the
  // other's cached nodes.
  const staleClock = () => Date.now() + 10 * 60 * 1000
  await Promise.all([
    featureRequestProgress(ALICE_UID, id, linear, staleClock),
    featureRequestProgress(ALICE_UID, id, linear, staleClock),
  ])

  const modified = writes.updates.reduce((sum, u) => sum + (u.modified ?? 0), 0)
  assert.equal(modified, 1, 'however many updates raced, exactly one document was modified')
  assert.equal(await storedStatus(id), SHIPPED_STATUS)
})

// --- 3. not finished stays building ------------------------------------------

test('a session with any ticket not DONE stays "building" and issues no write', async () => {
  for (const notDone of [STATES.started, STATES.backlog]) {
    await featureRequests().deleteMany({})
    clearFeatureRequestProgressCache()
    writes.updates.length = 0

    const linear = fakeLinear(issue('i1', 'DAN-205', STATES.done), issue('i2', 'DAN-206', notDone))
    const app = makeApp(linear)
    const id = await seedSession({
      tickets: [ticketRef('i1', 'DAN-205'), ticketRef('i2', 'DAN-206')],
    })

    const res = await gql(app, ALICE, PROGRESS, { promptId: id })
    assert.equal(res.body.errors, undefined)
    assert.equal(await storedStatus(id), 'building', `stays building with a ${notDone.name} ticket`)
    assert.equal(writes.updates.length, 0, 'no write is attempted for an unfinished build')
  }
})

test('a session with zero filed tickets stays "building" — an empty DAG is not a finished one', async () => {
  const linear = fakeLinear()
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [] })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestProgress, [])
  assert.equal(await storedStatus(id), 'building')
  assert.equal(writes.updates.length, 0)
  assert.equal(linear.calls.length, 0, 'and Linear was never asked')
})

test('a session every one of whose filed tickets vanished from Linear stays "building" — zero nodes is not finished', async () => {
  // Every filed ticket deleted by hand in Linear: the read serves [] (nothing
  // is fabricated), and an empty node list must not read as "all done".
  const linear = fakeLinear()
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('gone-1', 'DAN-207')] })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(res.body.data.featureRequestProgress, [])
  assert.equal(await storedStatus(id), 'building')
  assert.equal(writes.updates.length, 0)
})

test('a ticket deleted by hand in Linear does not hold the session open — "finished" is the nodes actually served', async () => {
  // The tester's ruling on the developer's judgement call, pinned as a test so
  // it cannot be changed by accident. Two tickets filed, one deleted by hand
  // in Linear; the read serves one node (nothing is fabricated), the DAG
  // already calls that "Build complete — every ticket is done." and stops
  // polling, so the STATUS agrees with the screen instead of contradicting it.
  // The alternative — comparing the node count to the stored ticket list —
  // would strand such a session in "building" forever with no way out, which
  // is the very bug this ticket was filed against.
  const linear = fakeLinear(issue('i1', 'DAN-222', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({
    tickets: [ticketRef('i1', 'DAN-222'), ticketRef('deleted-in-linear', 'DAN-223')],
  })

  const res = await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(res.body.data.featureRequestProgress.length, 1, 'the missing ticket is skipped')
  assert.equal(await storedStatus(id), SHIPPED_STATUS)

  // The boundary that keeps this safe: if the surviving node is NOT done, the
  // deletion buys nothing — the session stays building.
  await featureRequests().deleteMany({})
  clearFeatureRequestProgressCache()
  writes.updates.length = 0
  const linear2 = fakeLinear(issue('i9', 'DAN-224', STATES.started))
  const app2 = makeApp(linear2)
  const id2 = await seedSession({
    tickets: [ticketRef('i9', 'DAN-224'), ticketRef('deleted-in-linear', 'DAN-225')],
  })
  await gql(app2, ALICE, PROGRESS, { promptId: id2 })
  assert.equal(await storedStatus(id2), 'building')
})

test('a "gathering" session is never flipped by a progress read', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-208', STATES.done))
  const app = makeApp(linear)
  // Pathological but the point: tickets present, all done, status still
  // gathering. Only "building" is a valid precondition for the terminal flip.
  const id = await seedSession({ status: 'gathering', tickets: [ticketRef('i1', 'DAN-208')] })

  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(await storedStatus(id), 'gathering')
  assert.equal(writes.updates.length, 0)
})

// --- 4. terminal means terminal ----------------------------------------------

test('a shipped session never reverts when a ticket is reopened in Linear', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-209', STATES.done), issue('i2', 'DAN-210', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-209'), ticketRef('i2', 'DAN-210')] })

  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(await storedStatus(id), SHIPPED_STATUS)
  const shippedAt = (await storedDoc(id)).shippedAt

  // Someone reopens a ticket in Linear. The DAG is allowed to show it — the
  // session's status is not allowed to walk backwards.
  linear.setState('i2', STATES.started)
  clearFeatureRequestProgressCache()
  const res = await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(res.body.errors, undefined)
  assert.deepEqual(
    res.body.data.featureRequestProgress.map((n) => n.state),
    ['DONE', 'IN_PROGRESS'],
    'the DAG tells the truth about the reopened ticket',
  )

  assert.equal(await storedStatus(id), SHIPPED_STATUS, 'the session stays shipped')
  assert.equal(writes.updates.length, 1, 'and no write was even attempted to move it back')

  // Re-closed: still one write, still the original shippedAt.
  linear.setState('i2', STATES.done)
  clearFeatureRequestProgressCache()
  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(writes.updates.length, 1)
  assert.deepEqual((await storedDoc(id)).shippedAt, shippedAt)
})

test('no write this module issues on the progress path can ever set the status back to "building"', async () => {
  // A structural check over every update the flip path issues across the
  // reopened-ticket lifecycle: none of them writes "building" into status.
  const linear = fakeLinear(issue('i1', 'DAN-211', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-211')] })

  await gql(app, ALICE, PROGRESS, { promptId: id })
  linear.setState('i1', STATES.backlog)
  clearFeatureRequestProgressCache()
  await gql(app, ALICE, PROGRESS, { promptId: id })

  for (const { update } of writes.updates) {
    const written = update?.$set?.status ?? update?.status
    assert.notEqual(written, 'building', 'no progress-path write ever sets status back to building')
  }
  assert.equal(await storedStatus(id), SHIPPED_STATUS)
})

// --- 5. the wire -------------------------------------------------------------

test('the terminal status is served on the wire by both the single read and the list', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-212', STATES.done))
  const app = makeApp(linear)
  const shippedId = await seedSession({ tickets: [ticketRef('i1', 'DAN-212')] })
  const buildingId = await seedSession({ status: 'building' })
  const gatheringId = await seedSession({ status: 'gathering' })

  const before = await gql(app, ALICE, ONE, { id: shippedId })
  assert.equal(before.body.data.featureRequest.status, 'building', 'before the read: still building')

  await gql(app, ALICE, PROGRESS, { promptId: shippedId })

  const one = await gql(app, ALICE, ONE, { id: shippedId })
  assert.equal(one.body.errors, undefined)
  assert.equal(one.body.data.featureRequest.status, SHIPPED_STATUS)

  const list = await gql(app, ALICE, LIST)
  assert.equal(list.body.errors, undefined)
  const byId = Object.fromEntries(list.body.data.featureRequests.map((r) => [r.id, r.status]))
  assert.equal(byId[shippedId], SHIPPED_STATUS)
  assert.equal(byId[buildingId], 'building', 'the other sessions are untouched')
  assert.equal(byId[gatheringId], 'gathering')
})

test('the list query is a pure read — it never flips a stale "building" session by itself (the migration story)', async () => {
  // The documented migration: no backfill. A session that shipped before
  // DAN-94 stays "building" until someone opens its build view. That is only
  // an honest story if the list itself does not write.
  const linear = fakeLinear(issue('i1', 'DAN-213', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-213')] })

  await gql(app, ALICE, LIST)
  await gql(app, ALICE, ONE, { id })
  assert.equal(await storedStatus(id), 'building', 'no backfill on the list path')
  assert.equal(writes.updates.length, 0)
  assert.equal(linear.calls.length, 0, 'and the list costs no Linear round trip')

  // …and the first build-view poll heals it, which is the migration.
  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(await storedStatus(id), SHIPPED_STATUS)
})

test('shippedAt is stored but not on the wire', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-214', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-214')] })
  await gql(app, ALICE, PROGRESS, { promptId: id })

  assert.ok((await storedDoc(id)).shippedAt instanceof Date, 'stored')

  const res = await gql(app, ALICE, 'query ($id: ID!) { featureRequest(id: $id) { shippedAt } }', {
    id,
  })
  assert.ok(res.body.errors, 'shippedAt is deliberately not a schema field')
})

// --- 6. scoping (DAN-52 proof pattern) ---------------------------------------

test('a foreign uid cannot flip another user\'s session — cold cache', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-215', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({ uid: ALICE_UID, tickets: [ticketRef('i1', 'DAN-215')] })

  const res = await gql(app, MALLORY, PROGRESS, { promptId: id })
  assert.equal(res.status, 200)
  assert.equal(res.body.data, null)
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND')

  assert.equal(await storedStatus(id), 'building', "the owner's session is untouched")
  assert.equal(writes.updates.length, 0, 'the intruder issued no write')
  assert.equal(linear.calls.length, 0, 'and never reached Linear')
})

test('a WARM cache cannot cause a cross-user write (DAN-52 pattern)', async () => {
  // The cache is keyed by promptId, not by uid. The DAN-52 rule is that the
  // uid-scoped session read runs on every call, cached or not; DAN-94 extends
  // it to the write. Warmed here with an UNFINISHED build so the owner's own
  // read leaves the document in "building" — that is what makes "unchanged"
  // an observable claim afterwards.
  const linear = fakeLinear(issue('i1', 'DAN-216', STATES.started))
  const app = makeApp(linear)
  const id = await seedSession({ uid: ALICE_UID, tickets: [ticketRef('i1', 'DAN-216')] })

  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(linear.calls.length, 1, 'the cache is now warm for this promptId')
  assert.equal(await storedStatus(id), 'building')
  assert.equal(writes.updates.length, 0)

  // Linear now says the work is done — but the entry is warm, so nothing here
  // re-derives it. The intruder polls the warm id.
  linear.setState('i1', STATES.done)
  const intruder = await gql(app, MALLORY, PROGRESS, { promptId: id })
  assert.equal(intruder.body.data, null)
  assert.equal(intruder.body.errors[0].extensions.code, 'NOT_FOUND')
  assert.equal(intruder.body.errors[0].message, 'feature request not found')

  assert.equal(await storedStatus(id), 'building', 'the warm entry did not let the intruder write')
  assert.equal(writes.updates.length, 0, 'no write was issued on the intruder\'s behalf')
  assert.equal(linear.calls.length, 1, 'the intruder never reached Linear either')

  // The owner's own warm re-read writes nothing either — there is no
  // cached-path write for anything to bypass.
  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(writes.updates.length, 0, 'the cached path issues no write at all')
  assert.equal(linear.calls.length, 1)

  // And once the cache goes cold, the OWNER's read is the one that flips it.
  clearFeatureRequestProgressCache()
  await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(await storedStatus(id), SHIPPED_STATUS)
  assert.equal(writes.updates.length, 1)
  assert.equal(writes.updates[0].filter.uid, ALICE_UID)
})

test('two users\' finished sessions flip independently — the write never crosses documents', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-217', STATES.done), issue('i2', 'DAN-218', STATES.done))
  const app = makeApp(linear)
  const aliceId = await seedSession({ uid: ALICE_UID, tickets: [ticketRef('i1', 'DAN-217')] })
  const malloryId = await seedSession({ uid: MALLORY_UID, tickets: [ticketRef('i2', 'DAN-218')] })

  await gql(app, ALICE, PROGRESS, { promptId: aliceId })

  assert.equal(await storedStatus(aliceId), SHIPPED_STATUS)
  assert.equal(await storedStatus(malloryId), 'building', "the other user's session is untouched")
  assert.equal(
    await featureRequests().countDocuments({ status: SHIPPED_STATUS }),
    1,
    'exactly one document in the whole collection moved',
  )
})

// --- 7. the heal is best-effort ----------------------------------------------

test('a throwing Mongo update does not break the progress response, and the next read retries', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-219', STATES.done), issue('i2', 'DAN-220', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-219'), ticketRef('i2', 'DAN-220')] })

  writes.failNextWith(new Error('dan94-tester: simulated Mongo failure'))
  const res = await gql(app, ALICE, PROGRESS, { promptId: id })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, 'the caller gets no error from a failed cosmetic heal')
  assert.deepEqual(
    res.body.data.featureRequestProgress.map((n) => n.identifier),
    ['DAN-219', 'DAN-220'],
    'the nodes the caller asked for are served in full',
  )
  assert.equal(writes.updates.length, 1, 'the write was attempted')
  assert.equal(await storedStatus(id), 'building', 'and it did not take effect')

  // The next poll simply tries again.
  writes.stopFailing()
  clearFeatureRequestProgressCache()
  const retry = await gql(app, ALICE, PROGRESS, { promptId: id })
  assert.equal(retry.body.errors, undefined)
  assert.equal(writes.updates.length, 2, 'the next poll retried the heal')
  assert.equal(await storedStatus(id), SHIPPED_STATUS, 'and it healed')
})

test('the build view keeps working while Mongo refuses the heal — the DAG never goes down with it', async () => {
  const linear = fakeLinear(issue('i1', 'DAN-221', STATES.done))
  const app = makeApp(linear)
  const id = await seedSession({ tickets: [ticketRef('i1', 'DAN-221')] })

  writes.failNextWith(new Error('dan94-tester: Mongo down'))
  for (let poll = 0; poll < 3; poll += 1) {
    clearFeatureRequestProgressCache()
    const res = await gql(app, ALICE, PROGRESS, { promptId: id })
    assert.equal(res.body.errors, undefined, `poll ${poll} still served`)
    assert.equal(res.body.data.featureRequestProgress[0].state, 'DONE')
  }
  assert.equal(writes.updates.length, 3, 'every poll retried, none of them threw at the caller')
  assert.equal(await storedStatus(id), 'building')
})
