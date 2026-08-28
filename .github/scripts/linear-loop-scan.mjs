#!/usr/bin/env node
// DAN-98: the two loop-closing passes the 5-minute scan runs BEFORE it looks
// for tickets to hand to agents (.github/workflows/linear-agents.yml):
//
//   1. Reconciliation — a prompt-labeled ticket sitting In Progress WITH a
//      GitHub PR attachment and WITHOUT `agent-tested` is a completed dev leg
//      whose In Review handoff was missed (crashed run, or work predating the
//      in-workflow handoff — e.g. DAN-95). Move it to In Review so the tester
//      picks it up. Why PR-present is a safe claim-race guard: the dev leg
//      opens/attaches the draft PR as its LAST act, so a PR attachment on an
//      In Progress ticket means dev work is already finished — an ACTIVE
//      develop run's ticket has no PR yet and is left alone. Tickets that
//      failed testing are In Progress WITH a PR but also WITH `agent-tested`,
//      so the label check leaves those alone too.
//
//   2. Dependent promotion — a prompt-labeled ticket born blocked (filed in a
//      backlog/unstarted-family state by approveFeatureRequestPlan) whose
//      "blocked by" relations are now ALL resolved is unblocked: move it to
//      Ready for Dev so the relay/scan dispatches it. "Resolved" means the
//      blocker's state TYPE is `completed` OR `canceled` — a canceled blocker
//      will never finish, and counting it as still-blocking would strand the
//      dependent chain forever. State TYPES (not names) are used throughout so
//      workspace renames cannot break the check. A ticket with ANY
//      still-blocking (non-completed, non-canceled) blocker is untouched. A
//      ticket with NO blockers at
//      all is untouched: unblocked tickets are filed straight into Ready for
//      Dev at approval time, so a blocker-less ticket in Todo got there some
//      other deliberate way (e.g. the dev agent bouncing an unimplementable
//      ticket back to Todo) and must not be re-queued in a loop.
//
//   Reconciliation (completions-processing) runs before promotion in the same
//   pass. Tickets without a prompt:* label are NEVER touched by either pass,
//   and the DAN-44 project partition applies: tickets in the excluded project
//   (ai-gateway) belong to that repo's own scan and are left alone, as is any
//   ticket whose project cannot be determined.
//
// Zero dependencies (node >= 20: built-in fetch, node:util parseArgs).
// Usage: node linear-loop-scan.mjs [--check]
//   --check  dry run: print the moves that WOULD be made, mutate nothing.
// Env (same names/values as the workflow's env block; ids are hardcoded there
// by existing convention): LINEAR_API_KEY, LINEAR_TEAM_KEY,
// EXCLUDED_LINEAR_PROJECT, STATE_IN_PROGRESS, STATE_IN_REVIEW,
// STATE_READY_FOR_DEV.
// Logs only ticket identifiers and state NAMES — never the API key.

const GITHUB_PR_URL = /\bgithub\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/

export const SCAN_QUERY = `query($inProgress: ID, $teamKey: String) {
  reconcile: issues(filter: { state: { id: { eq: $inProgress } } }, first: 50) {
    nodes {
      id identifier
      project { name }
      labels { nodes { name } }
      attachments { nodes { url } }
    }
  }
  promote: issues(
    filter: { team: { key: { eq: $teamKey } }, state: { type: { in: ["backlog", "unstarted"] } } }
    first: 50
  ) {
    nodes {
      id identifier
      state { id type }
      project { name }
      labels { nodes { name } }
      inverseRelations { nodes { type issue { identifier state { type } } } }
    }
  }
}`

// DAN-44 partition rule, same as the workflow's IN_SCOPE jq filter: only work
// tickets whose project is known and is not the excluded one — better
// untouched than agents acting from the wrong repo.
export function inScope(issue, excludedProject) {
  const name = issue?.project?.name
  return typeof name === 'string' && name !== excludedProject
}

export function hasPromptLabel(issue) {
  return (issue?.labels?.nodes ?? []).some(
    (l) => typeof l?.name === 'string' && l.name.startsWith('prompt:'),
  )
}

export function hasLabel(issue, name) {
  return (issue?.labels?.nodes ?? []).some((l) => l?.name === name)
}

export function hasPrAttachment(issue) {
  return (issue?.attachments?.nodes ?? []).some(
    (a) => typeof a?.url === 'string' && GITHUB_PR_URL.test(a.url),
  )
}

// "blocked by" = inverseRelations of type "blocks"; the blocking issue is
// relation.issue. Promotion requires at least one blocker (see header) and
// every blocker's state TYPE to be resolved: `completed` or `canceled` — a
// canceled blocker will never finish, so treating it as still-blocking would
// strand the dependent chain forever.
const RESOLVED_STATE_TYPES = new Set(['completed', 'canceled'])

export function blockers(issue) {
  return (issue?.inverseRelations?.nodes ?? []).filter((r) => r?.type === 'blocks')
}

export function allBlockersResolved(issue) {
  const blockedBy = blockers(issue)
  return (
    blockedBy.length > 0 &&
    blockedBy.every((r) => RESOLVED_STATE_TYPES.has(r?.issue?.state?.type))
  )
}

export function reconcileCandidates(nodes, env) {
  return (nodes ?? []).filter(
    (issue) =>
      inScope(issue, env.EXCLUDED_LINEAR_PROJECT) &&
      hasPromptLabel(issue) &&
      hasPrAttachment(issue) &&
      !hasLabel(issue, 'agent-tested'),
  )
}

export function promoteCandidates(nodes, env) {
  return (nodes ?? []).filter(
    (issue) =>
      inScope(issue, env.EXCLUDED_LINEAR_PROJECT) &&
      hasPromptLabel(issue) &&
      // already Ready for Dev (itself an unstarted-family state) → nothing to do
      issue?.state?.id !== env.STATE_READY_FOR_DEV &&
      allBlockersResolved(issue),
  )
}

async function gql(fetchImpl, apiKey, query, variables) {
  const res = await fetchImpl('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Linear GraphQL HTTP ${res.status}`)
  const body = await res.json()
  // fail loudly on GraphQL errors, same as the workflow's `jq -e '.data'` gate
  if (!body || body.errors || !body.data) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(body?.errors ?? body)}`)
  }
  return body.data
}

const MOVE_MUTATION =
  'mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }'

async function moveIssue(fetchImpl, apiKey, issue, stateId, stateName, check, log) {
  if (check) {
    log(`[check] would move ${issue.identifier} → ${stateName}`)
    return
  }
  const data = await gql(fetchImpl, apiKey, MOVE_MUTATION, { id: issue.id, state: stateId })
  if (data?.issueUpdate?.success !== true) {
    throw new Error(`issueUpdate failed moving ${issue.identifier} → ${stateName}`)
  }
  log(`${issue.identifier} → ${stateName}`)
}

export async function run({ env = process.env, fetchImpl = fetch, check = false, log = console.log } = {}) {
  for (const name of [
    'LINEAR_API_KEY',
    'LINEAR_TEAM_KEY',
    'EXCLUDED_LINEAR_PROJECT',
    'STATE_IN_PROGRESS',
    'STATE_IN_REVIEW',
    'STATE_READY_FOR_DEV',
  ]) {
    if (!env[name]) throw new Error(`missing required env var ${name}`)
  }

  const data = await gql(fetchImpl, env.LINEAR_API_KEY, SCAN_QUERY, {
    inProgress: env.STATE_IN_PROGRESS,
    teamKey: env.LINEAR_TEAM_KEY,
  })

  const toReview = reconcileCandidates(data.reconcile?.nodes, env)
  const toReady = promoteCandidates(data.promote?.nodes, env)

  // completions-processing (reconciliation) before promotion, same pass
  for (const issue of toReview) {
    await moveIssue(fetchImpl, env.LINEAR_API_KEY, issue, env.STATE_IN_REVIEW, 'In Review', check, log)
  }
  for (const issue of toReady) {
    await moveIssue(fetchImpl, env.LINEAR_API_KEY, issue, env.STATE_READY_FOR_DEV, 'Ready for Dev', check, log)
  }

  log(
    `Reconciled to In Review: ${toReview.length ? toReview.map((i) => i.identifier).join(', ') : 'none'}`,
  )
  log(
    `Promoted to Ready for Dev: ${toReady.length ? toReady.map((i) => i.identifier).join(', ') : 'none'}`,
  )
  return { toReview, toReady }
}

const { pathToFileURL } = await import('node:url')
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  run({ check: process.argv.includes('--check') }).catch((err) => {
    console.error(`::error::linear-loop-scan: ${err.message}`)
    process.exit(1)
  })
}
