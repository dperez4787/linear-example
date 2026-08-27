// DAN-90 tester verification: an AI-generated snake_case title per feature
// request — persisted at approval, served on the wire, used as the Linear
// project name, and strictly best-effort. Written independently from the
// ticket's acceptance criteria, NOT from the developer's tests.
// Run with: npm test
//
// Seams: in-process app over the real GraphQL layer, stub token verifier, a
// recording fake Linear client, and the REAL createAiGateway over a scripted
// capturing fetch — so the titler assertions below pin the exact request
// production sends. Mongo (linear_example_test) is the only external
// dependency; no test in this file dials a network.
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
// Read lazily inside the gateway client; every fetch below is scripted, so
// this host is never resolved.
process.env.AI_GATEWAY_URL = 'https://gateway.dan90.tester.invalid'
process.env.AI_GATEWAY_KEY = 'dan90-tester-virtual-key'
delete process.env.K_SERVICE

const { connect, getDb } = await import('./db.js')
const { createApp } = await import('./index.js')
const { createAiGateway } = await import('./aiGateway.js')
const { sanitizeTitle, TITLE_MODEL, MAX_TOKENS_BY_ROLE, projectName } = await import(
  './featureRequests.js'
)
const { ObjectId } = await import('mongodb')

// --- the ticket's own contract, restated here as literals ---
//
// Deliberately NOT imported from the source: the acceptance criteria name this
// shape, and a test that reads the constant it is checking proves nothing.
const SLUG_RE = /^[a-z0-9]+(_[a-z0-9]+)*$/
const MAX_TITLE_CHARS = 50
const PROJECT_PREFIX = 'paf: '
const PROJECT_NAME_CAP = 80 // DAN-88
const TITLER_MODEL_ID = 'claude-haiku-4-5'
const TITLER_MAX_TOKENS = 40

// --- auth plumbing ---

const TOKENS = {
  'dan90-token-alice': { uid: 'uid-dan90-alice' },
  'dan90-token-bob': { uid: 'uid-dan90-bob' },
}
const ALICE = 'dan90-token-alice'
const ALICE_UID = 'uid-dan90-alice'

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

// --- the titler transport ---
//
// A REAL createAiGateway over a scripted fetch. `calls` records the parsed
// request body of every gateway call, so the titler's model / max_tokens /
// attribution are asserted as they actually cross the wire.
function scriptedGateway({ content, status = 200, reject, body } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: JSON.parse(init.body ?? '{}') })
    if (reject) throw reject
    const payload = body ?? {
      choices: [{ message: { role: 'assistant', content } }],
      usage: { total_tokens: 12 },
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
  const gateway = createAiGateway({ fetch, recordUsage: async () => {} })
  return { gateway, calls }
}

// A gateway that must never be reached. Any test whose app is built with this
// and which still approves proves the approval does not depend on the titler.
const refusingGateway = {
  async chat() {
    throw new Error('dan90 tester: no scripted gateway — this test must not reach the network')
  },
  async usage() {
    throw new Error('dan90 tester: no scripted gateway — this test must not reach the network')
  },
}

// --- the fake Linear client (written from the linearClient interface) ---

function fakeLinear() {
  const projects = []
  let n = 0
  return {
    projects,
    config: () => ({ teamId: 'dan90-team', readyForDevStateId: 'dan90-ready' }),
    findOrCreateLabels: async (names) =>
      Object.fromEntries(names.map((name) => [name, `dan90-label:${name}`])),
    createProject: async (args) => {
      projects.push(args)
      return { id: 'dan90-project-id', url: 'https://linear.app/dan90/project/p' }
    },
    createIssue: async () => {
      n += 1
      return {
        id: `dan90-issue-${n}`,
        identifier: `DAN-9${n}`,
        url: `https://linear.app/dan90/issue/DAN-9${n}`,
      }
    },
    createRelation: async () => ({ id: `dan90-rel-${++n}` }),
  }
}

const makeApp = ({ gateway, linearClient } = {}) =>
  createApp({
    verifyToken: stubVerify,
    aiGateway: gateway ?? refusingGateway,
    ...(linearClient ? { linearClient } : {}),
  })

const PASSING_GATES = Object.fromEntries(
  ['notTooBig', 'notAmbiguous', 'noBlockedDependencies'].map((g) => [
    g,
    { pass: true, reason: `dan90 tester: ${g} ok` },
  ]),
)

const SHORT_FIRST_MESSAGE = 'add a CSV export button'

async function seedApprovable({ uid = ALICE_UID, firstMessage = SHORT_FIRST_MESSAGE } = {}) {
  const { insertedId } = await featureRequests().insertOne({
    uid,
    status: 'gathering',
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: firstMessage, createdAt: new Date() },
      { role: 'product-owner', content: 'Understood — a CSV export.', createdAt: new Date() },
    ],
    createdAt: new Date(),
    plan: {
      tickets: [
        { key: 'T1', title: 'One', description: 'First.', dependsOn: [] },
        { key: 'T2', title: 'Two', description: 'Second.', dependsOn: ['T1'] },
      ],
    },
    entranceCriteria: PASSING_GATES,
  })
  return insertedId.toString()
}

const APPROVE = `mutation ($id: ID!) {
  approveFeatureRequestPlan(id: $id) { id status title linearProjectId }
}`

const READ = `query ($id: ID!) {
  featureRequest(id: $id) { id status title }
}`

// Approve `id` through the real GraphQL layer and return everything the
// assertions need: the wire payload, the persisted doc, the Linear project
// args, and the captured gateway calls.
async function approve({ id, gateway, calls, linearClient, token = ALICE }) {
  const app = makeApp({ gateway, linearClient })
  const res = await gql(app, token, APPROVE, { id })
  const doc = await featureRequests().findOne({ _id: new ObjectId(id) })
  const read = await gql(app, token, READ, { id })
  return { res, doc, read, project: linearClient.projects.at(-1), calls }
}

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

// =====================================================================
// criterion 1: happy path — title persisted, served, and used as the
// project name, end to end through the real GraphQL layer
// =====================================================================

test('criterion 1: a newly approved session persists its slug, serves it on the wire, and names the Linear project `paf: <slug>` inside 80 chars', async () => {
  const id = await seedApprovable()
  const { gateway, calls } = scriptedGateway({ content: 'add_csv_export_button' })
  const linearClient = fakeLinear()
  const { res, doc, read, project } = await approve({ id, gateway, calls, linearClient })

  assert.equal(res.status, 200)
  assert.equal(res.body.errors, undefined, 'a clean titler reply must not disturb approval')

  const fr = res.body.data.approveFeatureRequestPlan
  assert.equal(fr.status, 'building', 'the approval itself still succeeds')
  assert.equal(fr.title, 'add_csv_export_button', 'the slug is served on the approval payload')
  assert.match(fr.title, SLUG_RE, 'the served title matches the ticket regex')
  assert.ok(fr.title.length <= MAX_TITLE_CHARS)

  // Persisted, not merely computed for this response.
  assert.equal(doc.title, 'add_csv_export_button', 'the slug is persisted in Mongo')

  // And served identically on a fresh read of the same session.
  assert.equal(read.body.errors, undefined)
  assert.equal(read.body.data.featureRequest.title, 'add_csv_export_button')

  // The Linear project carries `paf: <slug>` — the slug, NOT the DAN-88
  // truncated first message.
  assert.equal(project.name, 'paf: add_csv_export_button')
  assert.ok(project.name.length <= PROJECT_NAME_CAP, 'DAN-88 cap holds')
  assert.notEqual(project.name, projectName(doc), 'the fallback name was not used')
})

test('criterion 1: the persisted title is generated once — a second read never re-calls the titler', async () => {
  const id = await seedApprovable()
  const { gateway, calls } = scriptedGateway({ content: 'add_csv_export_button' })
  const linearClient = fakeLinear()
  const app = makeApp({ gateway, linearClient })

  assert.equal((await gql(app, ALICE, APPROVE, { id })).body.errors, undefined)
  const afterApproval = calls.length
  assert.equal(afterApproval, 1, 'exactly one titler call at approval')

  const read = await gql(app, ALICE, READ, { id })
  assert.equal(read.body.data.featureRequest.title, 'add_csv_export_button')
  assert.equal(calls.length, afterApproval, 'reading a session makes no gateway call')
})

test('criterion 1: the longest legal slug still leaves the project name inside Linear’s 80-char cap', async () => {
  const id = await seedApprovable()
  // Five words, exactly 50 characters.
  const longest = 'aaaaaaaaaa_bbbbbbbbbb_cccccccccc_dddddddddd_eeeeee'
  assert.equal(longest.length, MAX_TITLE_CHARS)
  const { gateway, calls } = scriptedGateway({ content: longest })
  const linearClient = fakeLinear()
  const { res, project } = await approve({ id, gateway, calls, linearClient })

  assert.equal(res.body.errors, undefined)
  assert.equal(res.body.data.approveFeatureRequestPlan.title, longest)
  assert.equal(project.name, `${PROJECT_PREFIX}${longest}`)
  assert.ok(project.name.length <= PROJECT_NAME_CAP, `project name ${project.name.length} > 80`)
})

// =====================================================================
// criterion 2: `title: String` on the wire, null for legacy/unapproved
// =====================================================================

test('criterion 2: an unapproved session serves title null, and a legacy approved session (field absent) serves null rather than erroring', async () => {
  const unapproved = await seedApprovable()
  const app = makeApp({ linearClient: fakeLinear() })

  const a = await gql(app, ALICE, READ, { id: unapproved })
  assert.equal(a.body.errors, undefined)
  assert.equal(a.body.data.featureRequest.title, null, 'unapproved => null, not an error')

  // A session approved before DAN-90 existed: status building, no `title` key.
  const { insertedId } = await featureRequests().insertOne({
    uid: ALICE_UID,
    status: 'building',
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'legacy session', createdAt: new Date() }],
    createdAt: new Date(),
    plan: { tickets: [{ key: 'T1', title: 'One', description: 'First.', dependsOn: [] }] },
    entranceCriteria: PASSING_GATES,
    linearProjectId: 'legacy-project',
    tickets: [],
  })
  const legacy = await gql(app, ALICE, READ, { id: insertedId.toString() })
  assert.equal(legacy.body.errors, undefined)
  assert.equal(legacy.body.data.featureRequest.title, null, 'legacy => null, never undefined')
  assert.ok(
    'title' in legacy.body.data.featureRequest,
    'the field is present on the wire, explicitly null',
  )
})

test('criterion 2: title is a nullable String on the published schema (a non-null String! would break legacy sessions)', async () => {
  const app = makeApp({ linearClient: fakeLinear() })
  const res = await gql(
    app,
    ALICE,
    `{ __type(name: "FeatureRequest") { fields { name type { kind name } } } }`,
  )
  assert.equal(res.body.errors, undefined)
  const field = res.body.data.__type.fields.find((f) => f.name === 'title')
  assert.ok(field, 'FeatureRequest.title must exist on the schema')
  assert.deepEqual(field.type, { kind: 'SCALAR', name: 'String' }, 'nullable String')
})

// =====================================================================
// criterion 3: the sanitizer, swept over adversarial model output
// =====================================================================

// Every string a model might plausibly emit instead of a bare slug. The
// PROPERTY asserted over all of them is the wire contract itself: the result
// is null, or a string matching the regex and no longer than 50 chars. There
// is deliberately no third possibility.
const ADVERSARIAL = [
  ['already a valid slug', 'add_csv_export_button'],
  ['markdown fence', '```\nadd_csv_export_button\n```'],
  ['fenced with a language tag', '```text\nadd_csv_export\n```'],
  ['double-quoted', '"add_csv_export"'],
  ['single-quoted', "'add_csv_export'"],
  ['backticked', '`add_csv_export`'],
  ['Title: preamble', 'Title: add_csv_export'],
  ['bolded label preamble', '**Name:** add_csv_export'],
  ['slug - preamble', 'slug - add_csv_export'],
  ['Title Case with spaces', 'Add CSV Export Button'],
  ['hyphenated', 'add-csv-export-button'],
  ['em-dash separated', 'add—csv—export'],
  ['emoji only', '\u{1F389}\u{1F389}\u{1F389}'],
  ['CJK only', '追加する'],
  ['emoji mixed with words', '\u{1F389} add csv export \u{1F389}'],
  ['200-char ramble', `Sure! Here is a good title for this feature request: ${'the user would like to export their table data as a comma separated values file so they can open it in a spreadsheet '.repeat(2)}`],
  ['leading/trailing punctuation', '...add_csv_export!!!'],
  ['wrapped in brackets', '[add_csv_export]'],
  ['empty string', ''],
  ['whitespace only', '   \n\t  '],
  ['punctuation only', '!!!???...'],
  ['underscores only', '____'],
  ['multi-line with explanation', 'add_csv_export\n\nThis names the change the user asked for.'],
  ['multi-line, slug on a later line', 'Here is the slug:\nadd_csv_export'],
  ['doubled underscores', 'add__csv___export'],
  ['leading and trailing underscores', '__add_csv_export__'],
  ['upper snake case', 'ADD_CSV_EXPORT'],
  ['more than five words', 'add a csv export button to the reports page please'],
  ['one enormous word', 'a'.repeat(200)],
  ['a very long five-word slug', ['x'.repeat(30), 'y'.repeat(30), 'z'.repeat(30), 'w'.repeat(30), 'v'.repeat(30)].join('_')],
  ['numbers only', '12345'],
  ['leading digits', '2fa_login_support'],
  ['tab separated', 'add\tcsv\texport'],
  ['JSON wrapper', '{"title": "add_csv_export"}'],
  ['trailing period', 'add_csv_export.'],
  ['newline only', '\n'],
]

test('criterion 3: PROPERTY — over every adversarial model output, sanitizeTitle returns null or a slug matching ^[a-z0-9]+(_[a-z0-9]+)*$ of at most 50 chars, and nothing else', () => {
  for (const [label, raw] of ADVERSARIAL) {
    const out = sanitizeTitle(raw)
    if (out === null) continue
    assert.equal(typeof out, 'string', `${label}: returned a non-string`)
    assert.match(out, SLUG_RE, `${label}: "${out}" is not a legal slug`)
    assert.ok(
      out.length <= MAX_TITLE_CHARS,
      `${label}: "${out}" is ${out.length} chars, over the ${MAX_TITLE_CHARS} cap`,
    )
    assert.ok(!out.startsWith('_') && !out.endsWith('_'), `${label}: dangling underscore`)
    assert.ok(!out.includes('__'), `${label}: doubled underscore`)
    assert.equal(out, out.toLowerCase(), `${label}: not lowercased`)
  }
})

test('criterion 3: PROPERTY — non-strings and nullish model content sanitize to null, never a throw', () => {
  for (const raw of [null, undefined, 42, {}, [], true, Symbol('x')]) {
    assert.equal(sanitizeTitle(raw), null, `${String(raw)} must sanitize to null`)
  }
})

test('criterion 3: the adversarial cases that DO carry a recoverable name recover it (a sanitizer that always returned null would satisfy the property alone)', () => {
  const recoverable = [
    ['```\nadd_csv_export_button\n```', 'add_csv_export_button'],
    ['"add_csv_export"', 'add_csv_export'],
    ['Title: add_csv_export', 'add_csv_export'],
    ['Add CSV Export Button', 'add_csv_export_button'],
    ['add-csv-export-button', 'add_csv_export_button'],
    ['...add_csv_export!!!', 'add_csv_export'],
    ['__add_csv_export__', 'add_csv_export'],
    ['add__csv___export', 'add_csv_export'],
    ['ADD_CSV_EXPORT', 'add_csv_export'],
    ['add_csv_export\n\nThis names the change.', 'add_csv_export'],
    ['add_csv_export.', 'add_csv_export'],
    ['2fa_login_support', '2fa_login_support'],
  ]
  for (const [raw, expected] of recoverable) {
    assert.equal(sanitizeTitle(raw), expected, `sanitizing ${JSON.stringify(raw)}`)
  }
})

test('criterion 3: unusable output sanitizes to null rather than to a degenerate slug', () => {
  for (const raw of ['', '   \n\t  ', '!!!???...', '____', '\u{1F389}\u{1F389}', '追加する']) {
    assert.equal(sanitizeTitle(raw), null, `${JSON.stringify(raw)} must be null`)
  }
})

test('criterion 3: a 200-char ramble is bounded, not merely trimmed of its tail punctuation', () => {
  const ramble = `Sure! Here is a good title: ${'the user would like to export their table data as a comma separated values file '.repeat(3)}`
  assert.ok(ramble.length > 200)
  const out = sanitizeTitle(ramble)
  if (out !== null) {
    assert.match(out, SLUG_RE)
    assert.ok(out.length <= MAX_TITLE_CHARS, `${out.length} chars`)
    assert.ok(out.split('_').length <= 5, 'at most five words')
  }
})

// =====================================================================
// criterion 4: every failure mode still approves, on the DAN-88 name
// =====================================================================

// A first message long enough that DAN-88's truncation is observable, so a
// fallback name can be told apart from an untruncated one.
const LONG_FIRST_MESSAGE =
  'I would like the reports page to export every visible row of the current table as a CSV file, including the hidden columns, so finance can reconcile it in a spreadsheet'

const FALLBACK_CASES = [
  [
    'the gateway throws (network-level failure)',
    () => scriptedGateway({ reject: new Error('socket hang up') }),
  ],
  [
    'the gateway refuses on quota (HTTP 429 => QuotaExhaustedError)',
    () => scriptedGateway({ status: 429, body: { error: 'quota exhausted' } }),
  ],
  [
    'the gateway responds 500',
    () => scriptedGateway({ status: 500, body: { error: 'boom' } }),
  ],
  [
    'the model emits unusable content (emoji only)',
    () => scriptedGateway({ content: '\u{1F389}\u{1F389}\u{1F389}' }),
  ],
  [
    'the model emits an empty completion',
    () => scriptedGateway({ content: '' }),
  ],
  [
    'the completion is oddly shaped (no choices)',
    () => scriptedGateway({ body: { usage: { total_tokens: 3 } } }),
  ],
  [
    'no gateway is wired into the app at all',
    () => ({ gateway: refusingGateway, calls: [] }),
  ],
]

for (const [label, build] of FALLBACK_CASES) {
  test(`criterion 4: when ${label}, approval STILL succeeds on the DAN-88 truncated name, title serves null, and no error reaches the client`, async () => {
    const id = await seedApprovable({ firstMessage: LONG_FIRST_MESSAGE })
    const { gateway, calls } = build()
    const linearClient = fakeLinear()
    const { res, doc, read, project } = await approve({ id, gateway, calls, linearClient })

    // No error reaches the client — not in `errors`, not as a non-200.
    assert.equal(res.status, 200, `${label}: HTTP status`)
    assert.equal(res.body.errors, undefined, `${label}: a titler failure must never surface`)

    const fr = res.body.data.approveFeatureRequestPlan
    assert.equal(fr.status, 'building', `${label}: the approval still completes`)
    assert.equal(fr.linearProjectId, 'dan90-project-id', `${label}: the project was still filed`)

    // title is null on the wire — never a non-slug string.
    assert.equal(fr.title, null, `${label}: title must be null, not a salvaged sentence`)
    assert.equal(read.body.data.featureRequest.title, null, `${label}: null on a fresh read too`)

    // Nothing non-slug was persisted: the field is absent, or null.
    assert.ok(
      doc.title === undefined || doc.title === null,
      `${label}: persisted title was ${JSON.stringify(doc.title)}`,
    )
    assert.equal(doc.status, 'building')

    // The project fell back to DAN-88's truncated first-message name.
    assert.equal(project.name, projectName(doc), `${label}: DAN-88 fallback name`)
    assert.ok(project.name.startsWith(PROJECT_PREFIX))
    assert.ok(
      project.name.length <= PROJECT_NAME_CAP,
      `${label}: fallback name ${project.name.length} > 80`,
    )
    assert.ok(project.name.endsWith('…'), `${label}: the long message was truncated`)
    assert.ok(
      !SLUG_RE.test(project.name.slice(PROJECT_PREFIX.length)),
      `${label}: the fallback is the truncated message, not a slug`,
    )
  })
}

test('criterion 4: a fallback approval leaves `title` null rather than storing the truncated project name', async () => {
  const id = await seedApprovable({ firstMessage: LONG_FIRST_MESSAGE })
  const { gateway, calls } = scriptedGateway({ reject: new Error('socket hang up') })
  const linearClient = fakeLinear()
  const { doc, project } = await approve({ id, gateway, calls, linearClient })

  assert.notEqual(doc.title, project.name, 'the project name must not leak into title')
  assert.notEqual(doc.title, project.name.slice(PROJECT_PREFIX.length))
  assert.ok(doc.title === undefined || doc.title === null)
})

test('criterion 4: a quota refusal at approval does NOT surface the QUOTA_EXHAUSTED code the conversational turns raise', async () => {
  const id = await seedApprovable()
  const { gateway, calls } = scriptedGateway({ status: 429, body: { error: 'quota exhausted' } })
  const linearClient = fakeLinear()
  const { res } = await approve({ id, gateway, calls, linearClient })

  assert.equal(res.body.errors, undefined)
  const serialized = JSON.stringify(res.body)
  assert.ok(!serialized.includes('QUOTA_EXHAUSTED'), 'no quota code on the approval response')
  assert.ok(!/quota/i.test(serialized), 'no quota wording reaches the client')
  assert.equal(res.body.data.approveFeatureRequestPlan.status, 'building')
})

// =====================================================================
// criterion 5: the titler call, asserted on the wire
// =====================================================================

test('criterion 5: the titler call carries model claude-haiku-4-5, max_tokens 40, and full promptId/uid/role attribution', async () => {
  const id = await seedApprovable()
  const { gateway, calls } = scriptedGateway({ content: 'add_csv_export_button' })
  const linearClient = fakeLinear()
  const { res } = await approve({ id, gateway, calls, linearClient })
  assert.equal(res.body.errors, undefined)

  assert.equal(calls.length, 1, 'approval makes exactly one gateway call — the titler')
  const call = calls[0]

  assert.equal(call.url, `${process.env.AI_GATEWAY_URL}/v1/chat/completions`)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['x-gateway-key'], process.env.AI_GATEWAY_KEY)

  // The model, as a literal from the ticket — and it is the exported constant.
  assert.equal(call.body.model, TITLER_MODEL_ID, 'titler model on the wire')
  assert.equal(TITLE_MODEL, TITLER_MODEL_ID, 'the exported TITLE_MODEL agrees')

  // The budget, as a literal — and the exported table agrees.
  assert.equal(call.body.max_tokens, TITLER_MAX_TOKENS, 'titler max_tokens on the wire')
  assert.equal(typeof call.body.max_tokens, 'number')
  assert.equal(
    MAX_TOKENS_BY_ROLE[call.body.metadata.role],
    TITLER_MAX_TOKENS,
    'the exported per-role budget agrees with the wire',
  )

  // Attribution: this session's promptId, this caller's uid, a named role.
  assert.equal(call.body.metadata.prompt_id, id, 'promptId is the session id')
  assert.equal(call.body.metadata.on_behalf_of, ALICE_UID, 'attributed to the approving user')
  assert.equal(call.body.metadata.feature, 'prompt-a-feature')
  assert.equal(typeof call.body.metadata.role, 'string')
  assert.ok(call.body.metadata.role.length > 0, 'the titler call carries a role')
  assert.ok(
    !['product-owner', 'architect', 'planner', 'entrance-criteria'].includes(
      call.body.metadata.role,
    ),
    'the titler has its own role, not a conversational one',
  )

  // It asks for a slug, and it is shown the transcript.
  const system = call.body.messages.find((m) => m.role === 'system')
  const user = call.body.messages.find((m) => m.role === 'user')
  assert.ok(/snake_case/i.test(system.content), 'the titler prompt asks for snake_case')
  assert.ok(user.content.includes(SHORT_FIRST_MESSAGE), 'the transcript is the input')
})

test('criterion 5: the titler runs once per approval and is billed on this session, not a side channel', async () => {
  const id = await seedApprovable()
  const { gateway, calls } = scriptedGateway({ content: 'add_csv_export_button' })
  const linearClient = fakeLinear()
  await approve({ id, gateway, calls, linearClient })

  assert.equal(calls.length, 1)
  const promptIds = new Set(calls.map((c) => c.body.metadata.prompt_id))
  assert.deepEqual([...promptIds], [id], 'every approval-time call is attributed to this session')
})

test('criterion 5: the titler is called BEFORE the project is created — the name it produces is the name Linear receives', async () => {
  const id = await seedApprovable()
  const { gateway, calls } = scriptedGateway({ content: 'rename_me_now' })
  const order = []
  const base = fakeLinear()
  const linearClient = {
    ...base,
    createProject: async (args) => {
      order.push(`createProject:${calls.length}`)
      return base.createProject(args)
    },
  }
  linearClient.projects = base.projects
  const { res, project } = await approve({ id, gateway, calls, linearClient })

  assert.equal(res.body.errors, undefined)
  assert.deepEqual(order, ['createProject:1'], 'the titler call preceded createProject')
  assert.equal(project.name, 'paf: rename_me_now')
})

// =====================================================================
// ownership: DAN-90 must not have opened a cross-tenant read
// =====================================================================

test("ownership: another user's session is still not approvable, and no titler call is made for it", async () => {
  const id = await seedApprovable({ uid: 'uid-dan90-bob' })
  const { gateway, calls } = scriptedGateway({ content: 'add_csv_export_button' })
  const linearClient = fakeLinear()
  const app = makeApp({ gateway, linearClient })

  const res = await gql(app, ALICE, APPROVE, { id })
  assert.ok(res.body.errors, 'approving another user’s session must fail')
  assert.equal(calls.length, 0, 'no gateway call for a session the caller does not own')
  assert.equal(linearClient.projects.length, 0, 'no project filed')
})
