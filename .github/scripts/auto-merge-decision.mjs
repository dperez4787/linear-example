#!/usr/bin/env node
// DAN-100: decides whether the test job may auto-merge a PR after the tester
// leg (.github/workflows/linear-agents.yml). The prompt-a-feature flow runs
// end to end with no human after the in-app Approve — the human gate moved
// from per-PR to per-feature — but ONLY for tickets carrying a `prompt:*`
// label. Every other ticket keeps the old contract: tester lifts the draft,
// a human merges.
//
// The decision (decideAutoMerge) is a pure function over data the workflow
// already holds — no network calls here:
//
//   1. Ticket has no `prompt:*` label      → merge=no. Non-prompt tickets keep
//      today's behavior exactly (lifted draft, In Review, unmerged).
//   2. No tester verdict comment since the run started → merge=no. (The
//      evidence-gated labeling step already fails the job in this case; this
//      re-check is defense in depth, not the primary gate.)
//   3. Latest verdict since run start is not a PASS → merge=no. The verdict
//      line — the line of the comment containing "Tester verdict", the same
//      marker the labeling step greps for — must be an UNHEDGED TERMINAL
//      PASS: "Tester verdict", a separator (em/en dash, hyphen, or colon),
//      then PASS as the last thing on the line. Nothing may follow PASS, and
//      nothing but the separator may precede it after the marker, so negation
//      or hedging is impossible by construction: "NOT PASS", "did not PASS",
//      "PASS?", "PASS (with caveats)", "PASSED"/"PASSABLE", lowercase
//      "pass", and every FAIL variant are all conservatively not a PASS. A
//      FAIL verdict whose evidence body happens to mention "PASS" does not
//      count either — only the verdict line is inspected.
//   4. The PR is still a draft → merge=no. The tester only lifts the draft
//      (`gh pr ready`) on a full pass, so PASS-comment AND lifted-draft
//      together are the reliable signal; either alone is not.
//   5. All of the above hold → merge=yes. The workflow then merges with a
//      merge commit (matching the repo's merge history), deletes the branch,
//      and moves the ticket to Done — each of those steps failing loudly so
//      a conflict/protection failure parks the ticket In Review for the next
//      scan or a human (the correct degraded state).
//
// Verdict comments are matched the same way the evidence-gated labeling step
// matches them: author github-actions[bot], body containing "Tester verdict",
// created_at >= the run's start timestamp. With several verdicts in-window,
// the LATEST wins.
//
// Zero dependencies (node >= 20: node:util parseArgs). Usage:
//   node auto-merge-decision.mjs --comments <file.json> --since <ISO-8601 UTC> \
//     --draft <true|false> --prompt-labeled <true|false>
// <file.json> is the GitHub issue-comments API response (a JSON array) the
// labeling step saved; --draft is the PR's current isDraft bit; --since is the
// guard step's `started` output. Prints exactly two GITHUB_OUTPUT-ready lines:
//   merge=yes|no
//   reason=<single-line explanation>
// Invalid input fails loudly (exit 1) rather than defaulting to a merge.
// Logs never contain tokens or comment bodies.

const VERDICT_MARKER = 'Tester verdict'
const BOT_LOGIN = 'github-actions[bot]'
// Unhedged terminal PASS only (see rule 3 above): the marker, a separator
// (em dash, colon, en dash, or hyphen), then PASS ending the line (trailing
// whitespace ok — also tolerates CRLF bodies). Because nothing but the
// separator may sit between the marker and PASS, and nothing at all after
// it, negated/hedged/fragment lookalikes cannot match. Case-sensitive.
const PASS_VERDICT = /Tester verdict\s*[—:–-]+\s*PASS\s*$/
// A permissive `--since` would be dangerous: string-comparing created_at
// against '' (or garbage) makes every historical PASS count. Require the
// exact shape the guard step emits (date -u +%Y-%m-%dT%H:%M:%SZ).
const SINCE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

// First line of the comment containing the verdict marker (e.g.
// "## Tester verdict — PASS"), or null if the marker is absent.
export function verdictLine(body) {
  if (typeof body !== 'string') return null
  return body.split('\n').find((line) => line.includes(VERDICT_MARKER)) ?? null
}

// PASS iff the verdict line itself is an unhedged terminal PASS. Only the
// verdict line is inspected — evidence text below it can say anything.
export function isPassVerdict(body) {
  const line = verdictLine(body)
  return line !== null && PASS_VERDICT.test(line)
}

// Same filter as the labeling step's jq: bot-authored, marker-bearing,
// posted at/after the run's start.
export function verdictComments(comments, since) {
  return (comments ?? []).filter(
    (c) =>
      c?.user?.login === BOT_LOGIN &&
      typeof c?.body === 'string' &&
      c.body.includes(VERDICT_MARKER) &&
      typeof c?.created_at === 'string' &&
      c.created_at >= since,
  )
}

export function latestVerdict(comments, since) {
  const inWindow = verdictComments(comments, since)
  if (inWindow.length === 0) return null
  return inWindow.reduce((latest, c) => (c.created_at >= latest.created_at ? c : latest))
}

export function decideAutoMerge({ comments, since, isDraft, promptLabeled }) {
  if (!promptLabeled) {
    return { merge: false, reason: 'ticket has no prompt:* label - human merge gate applies (behavior unchanged)' }
  }
  const verdict = latestVerdict(comments, since)
  if (!verdict) {
    return { merge: false, reason: `no tester verdict comment since ${since}` }
  }
  if (!isPassVerdict(verdict.body)) {
    return { merge: false, reason: 'latest tester verdict is not a PASS - leaving the PR alone' }
  }
  if (isDraft) {
    return { merge: false, reason: 'PR is still a draft - the tester did not lift it, not merging' }
  }
  return { merge: true, reason: 'prompt-labeled ticket, tester PASS verdict, draft lifted' }
}

export function parseBool(name, value) {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`--${name} must be exactly "true" or "false", got "${value ?? ''}"`)
}

export function parseSince(value) {
  if (typeof value !== 'string' || !SINCE_SHAPE.test(value)) {
    throw new Error(`--since must be a UTC timestamp like 2026-08-27T00:00:00Z, got "${value ?? ''}"`)
  }
  return value
}

const { pathToFileURL } = await import('node:url')
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    const { parseArgs } = await import('node:util')
    const { readFile } = await import('node:fs/promises')
    const { values } = parseArgs({
      options: {
        comments: { type: 'string' },
        since: { type: 'string' },
        draft: { type: 'string' },
        'prompt-labeled': { type: 'string' },
      },
    })
    if (!values.comments) throw new Error('--comments <file.json> is required')
    const comments = JSON.parse(await readFile(values.comments, 'utf8'))
    if (!Array.isArray(comments)) throw new Error('--comments file must contain a JSON array of comments')
    const decision = decideAutoMerge({
      comments,
      since: parseSince(values.since),
      isDraft: parseBool('draft', values.draft),
      promptLabeled: parseBool('prompt-labeled', values['prompt-labeled']),
    })
    console.log(`merge=${decision.merge ? 'yes' : 'no'}`)
    console.log(`reason=${decision.reason}`)
  } catch (err) {
    console.error(`::error::auto-merge-decision: ${err.message}`)
    process.exit(1)
  }
}
