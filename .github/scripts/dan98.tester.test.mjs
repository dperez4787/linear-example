// DAN-98 independent tester suite (written against the acceptance criteria,
// not against the developer's tests). Exercises the importable logic of
// linear-loop-scan.mjs: reconciliation predicate, promotion predicate,
// project partition, mutation ordering, --check dry-run, fail-loud paths,
// and secret hygiene in log output.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SCAN_QUERY,
  reconcileCandidates,
  promoteCandidates,
  run,
} from './linear-loop-scan.mjs'

const ENV = {
  LINEAR_API_KEY: 'lin_api_TESTERSECRET_zz9',
  LINEAR_TEAM_KEY: 'DAN',
  EXCLUDED_LINEAR_PROJECT: 'ai-gateway',
  STATE_IN_PROGRESS: 'id-in-progress',
  STATE_IN_REVIEW: 'id-in-review',
  STATE_READY_FOR_DEV: 'id-ready-for-dev',
}

// ---------- fixtures ----------

const PR_ATTACHMENT = { url: 'https://github.com/dperez4787/linear-example/pull/82' }
const FIGMA_ATTACHMENT = { url: 'https://www.figma.com/file/abc/mockup' }

function reconIssue(overrides = {}) {
  return {
    id: 'uuid-r1',
    identifier: 'DAN-90',
    project: { name: 'prompt-a-feature' },
    labels: { nodes: [{ name: 'prompt:feature' }] },
    attachments: { nodes: [PR_ATTACHMENT] },
    ...overrides,
  }
}

function blocker(stateType, identifier = 'DAN-1') {
  return { type: 'blocks', issue: { identifier, state: { type: stateType } } }
}

function promoIssue(overrides = {}) {
  return {
    id: 'uuid-p1',
    identifier: 'DAN-91',
    state: { id: 'id-todo', type: 'unstarted' },
    project: { name: 'prompt-a-feature' },
    labels: { nodes: [{ name: 'prompt:feature' }] },
    inverseRelations: { nodes: [blocker('completed')] },
    ...overrides,
  }
}

// ---------- reconciliation predicate ----------

test('reconciliation: prompt-labeled In Progress ticket with PR attachment and no agent-tested is moved', () => {
  assert.deepEqual(
    reconcileCandidates([reconIssue()], ENV).map((i) => i.identifier),
    ['DAN-90'],
  )
})

test('reconciliation: unlabeled ticket is NOT moved', () => {
  const issue = reconIssue({ labels: { nodes: [{ name: 'bug' }] } })
  assert.equal(reconcileCandidates([issue], ENV).length, 0)
})

test('reconciliation: ticket with no attachments is NOT moved (active dev run guard)', () => {
  const issue = reconIssue({ attachments: { nodes: [] } })
  assert.equal(reconcileCandidates([issue], ENV).length, 0)
})

test('reconciliation: non-PR attachment (Figma) does NOT count as a PR', () => {
  const issue = reconIssue({ attachments: { nodes: [FIGMA_ATTACHMENT] } })
  assert.equal(reconcileCandidates([issue], ENV).length, 0)
})

test('reconciliation: a github.com issue link is not a pull request attachment', () => {
  const issue = reconIssue({
    attachments: { nodes: [{ url: 'https://github.com/dperez4787/linear-example/issues/12' }] },
  })
  assert.equal(reconcileCandidates([issue], ENV).length, 0)
})

test('reconciliation: agent-tested ticket (failed-test parking state) is NOT moved', () => {
  const issue = reconIssue({
    labels: { nodes: [{ name: 'prompt:feature' }, { name: 'agent-tested' }] },
  })
  assert.equal(reconcileCandidates([issue], ENV).length, 0)
})

test('reconciliation: ai-gateway project ticket is NEVER touched (DAN-44 partition)', () => {
  const issue = reconIssue({ project: { name: 'ai-gateway' } })
  assert.equal(reconcileCandidates([issue], ENV).length, 0)
})

test('reconciliation: ticket with unknown project is NOT touched', () => {
  assert.equal(reconcileCandidates([reconIssue({ project: null })], ENV).length, 0)
  assert.equal(reconcileCandidates([reconIssue({ project: {} })], ENV).length, 0)
})

test('reconciliation: wrong-state tickets are excluded server-side — query filters by the In Progress state id', async () => {
  // The predicate never sees non-In-Progress tickets because the GraphQL filter
  // pins state.id to $inProgress; verify the query AND that run() binds the
  // variable to STATE_IN_PROGRESS.
  assert.match(SCAN_QUERY, /reconcile:\s*issues\(filter:\s*\{\s*state:\s*\{\s*id:\s*\{\s*eq:\s*\$inProgress/)
  let vars
  const fetchImpl = async (url, opts) => {
    vars = JSON.parse(opts.body).variables
    return { ok: true, json: async () => ({ data: { reconcile: { nodes: [] }, promote: { nodes: [] } } }) }
  }
  await run({ env: ENV, fetchImpl, log: () => {} })
  assert.equal(vars.inProgress, ENV.STATE_IN_PROGRESS)
})

// ---------- promotion predicate ----------

test('promotion: all blockers completed -> promoted', () => {
  const issue = promoIssue({
    inverseRelations: { nodes: [blocker('completed'), blocker('completed', 'DAN-2')] },
  })
  assert.equal(promoteCandidates([issue], ENV).length, 1)
})

test('promotion: all blockers canceled -> promoted (canceled must not strand chains)', () => {
  const issue = promoIssue({
    inverseRelations: { nodes: [blocker('canceled'), blocker('canceled', 'DAN-2')] },
  })
  assert.equal(promoteCandidates([issue], ENV).length, 1)
})

test('promotion: completed + canceled mix -> promoted', () => {
  const issue = promoIssue({
    inverseRelations: { nodes: [blocker('completed'), blocker('canceled', 'DAN-2')] },
  })
  assert.equal(promoteCandidates([issue], ENV).length, 1)
})

test('promotion: one open blocker among resolved -> NOT promoted', () => {
  for (const openType of ['started', 'unstarted', 'backlog', 'triage']) {
    const issue = promoIssue({
      inverseRelations: {
        nodes: [blocker('completed'), blocker(openType, 'DAN-2'), blocker('canceled', 'DAN-3')],
      },
    })
    assert.equal(promoteCandidates([issue], ENV).length, 0, `open type ${openType} must block`)
  }
})

test('promotion: zero blockers -> NOT promoted (dev-bounce loop prevention)', () => {
  const issue = promoIssue({ inverseRelations: { nodes: [] } })
  assert.equal(promoteCandidates([issue], ENV).length, 0)
})

test('promotion: non-"blocks" relations are not blockers — a lone resolved "related" relation is still zero blockers', () => {
  const issue = promoIssue({
    inverseRelations: { nodes: [{ type: 'related', issue: { state: { type: 'completed' } } }] },
  })
  assert.equal(promoteCandidates([issue], ENV).length, 0)
})

test('promotion: unlabeled ticket -> NOT promoted', () => {
  const issue = promoIssue({ labels: { nodes: [] } })
  assert.equal(promoteCandidates([issue], ENV).length, 0)
})

test('promotion: ai-gateway project ticket is NEVER touched (DAN-44 partition)', () => {
  const issue = promoIssue({ project: { name: 'ai-gateway' } })
  assert.equal(promoteCandidates([issue], ENV).length, 0)
})

test('promotion: ticket already in Ready for Dev is left alone', () => {
  const issue = promoIssue({ state: { id: ENV.STATE_READY_FOR_DEV, type: 'unstarted' } })
  assert.equal(promoteCandidates([issue], ENV).length, 0)
})

test('promotion: blocker with missing state data counts as still blocking (fail safe)', () => {
  const issue = promoIssue({
    inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'DAN-2' } }] },
  })
  assert.equal(promoteCandidates([issue], ENV).length, 0)
})

// ---------- run(): ordering, dry-run, fail-loud, secret hygiene ----------

function successFetch(calls) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body)
    calls.push(body)
    if (body.query.startsWith('mutation')) {
      return { ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }) }
    }
    return {
      ok: true,
      json: async () => ({
        data: {
          reconcile: { nodes: [reconIssue()] },
          promote: { nodes: [promoIssue()] },
        },
      }),
    }
  }
}

test('ordering: reconciliation mutations execute before promotion mutations in one pass', async () => {
  const calls = []
  const result = await run({ env: ENV, fetchImpl: successFetch(calls), log: () => {} })
  const mutations = calls.filter((c) => c.query.startsWith('mutation'))
  assert.equal(mutations.length, 2)
  assert.deepEqual(
    mutations.map((m) => m.variables.state),
    [ENV.STATE_IN_REVIEW, ENV.STATE_READY_FOR_DEV],
    'In Review handoff must precede Ready for Dev promotion',
  )
  assert.deepEqual(result.toReview.map((i) => i.identifier), ['DAN-90'])
  assert.deepEqual(result.toReady.map((i) => i.identifier), ['DAN-91'])
})

test('--check: zero mutations issued while reporting what it would do', async () => {
  const calls = []
  const lines = []
  await run({ env: ENV, fetchImpl: successFetch(calls), check: true, log: (l) => lines.push(l) })
  const mutations = calls.filter((c) => c.query.startsWith('mutation'))
  assert.equal(mutations.length, 0, 'dry run must not mutate')
  assert.equal(calls.length, 1, 'only the read query is allowed')
  const out = lines.join('\n')
  assert.match(out, /would move DAN-90 → In Review/)
  assert.match(out, /would move DAN-91 → Ready for Dev/)
})

test('fail-loud: non-2xx HTTP response rejects', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
  await assert.rejects(() => run({ env: ENV, fetchImpl, log: () => {} }), /500/)
})

test('fail-loud: GraphQL errors payload rejects even with HTTP 200', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'rate limited' }] }),
  })
  await assert.rejects(() => run({ env: ENV, fetchImpl, log: () => {} }), /GraphQL errors/)
})

test('fail-loud: missing data field rejects', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) })
  await assert.rejects(() => run({ env: ENV, fetchImpl, log: () => {} }))
})

test('fail-loud: issueUpdate success:false rejects and names the ticket', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (body.query.startsWith('mutation')) {
      return { ok: true, json: async () => ({ data: { issueUpdate: { success: false } } }) }
    }
    return {
      ok: true,
      json: async () => ({ data: { reconcile: { nodes: [reconIssue()] }, promote: { nodes: [] } } }),
    }
  }
  await assert.rejects(() => run({ env: ENV, fetchImpl, log: () => {} }), /DAN-90/)
})

test('fail-loud: each missing required env var rejects by name', async () => {
  for (const name of Object.keys(ENV)) {
    const env = { ...ENV }
    delete env[name]
    await assert.rejects(
      () => run({ env, fetchImpl: async () => { throw new Error('must not fetch') }, log: () => {} }),
      new RegExp(name),
      `missing ${name} must fail before any network call`,
    )
  }
})

test('secret hygiene: API key appears in no log line, success or failure', async () => {
  const lines = []
  const calls = []
  await run({ env: ENV, fetchImpl: successFetch(calls), log: (l) => lines.push(String(l)) })
  // and a failing run's error message
  let failureMessage = ''
  try {
    await run({
      env: ENV,
      fetchImpl: async () => ({ ok: true, json: async () => ({ errors: [{ message: 'boom' }] }) }),
      log: (l) => lines.push(String(l)),
    })
  } catch (err) {
    failureMessage = String(err && err.stack)
  }
  const everything = lines.join('\n') + '\n' + failureMessage
  assert.ok(!everything.includes(ENV.LINEAR_API_KEY), 'API key leaked into logs')
})

test('secret hygiene: CLI run with missing env exits 1 without echoing any env secret', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'linear-loop-scan.mjs')
  const env = {
    PATH: process.env.PATH,
    LINEAR_API_KEY: 'lin_api_CLI_SECRET_abc',
    // LINEAR_TEAM_KEY deliberately missing -> must exit 1 before any network use
  }
  let code = 0
  let stdout = ''
  let stderr = ''
  try {
    const res = await promisify(execFile)(process.execPath, [script], { env })
    stdout = res.stdout
    stderr = res.stderr
  } catch (err) {
    code = err.code
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
  }
  assert.equal(code, 1)
  assert.match(stderr, /missing required env var LINEAR_TEAM_KEY/)
  assert.ok(!(stdout + stderr).includes('lin_api_CLI_SECRET_abc'), 'API key leaked to CLI output')
})
