// DAN-100: unit tests for the test job's auto-merge decision
// (auto-merge-decision.mjs). Zero-dep node:test, mirroring the DAN-98 test
// style. Run with: node --test .github/scripts/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  verdictLine,
  isPassVerdict,
  verdictComments,
  latestVerdict,
  decideAutoMerge,
  parseBool,
  parseSince,
} from './auto-merge-decision.mjs'

const SINCE = '2026-08-27T00:00:00Z'

// ---------- fixture builders (shape mirrors the GitHub issue-comments API) ----------

const comment = (over = {}) => ({
  user: { login: 'github-actions[bot]' },
  body: '## Tester verdict — PASS\n\nAll acceptance criteria verified; see evidence below.',
  created_at: '2026-08-27T00:10:00Z',
  ...over,
})

const failComment = (over = {}) =>
  comment({
    body: '## Tester verdict — FAIL\n\nCriterion 2 expected PASS behavior but the endpoint 500s.',
    ...over,
  })

// ---------- verdict parsing ----------

test('verdictLine: returns the marker-bearing line, null when absent', () => {
  assert.equal(verdictLine('## Tester verdict — PASS\nevidence'), '## Tester verdict — PASS')
  assert.equal(verdictLine('just a normal comment'), null)
  assert.equal(verdictLine(null), null)
})

test('isPassVerdict: PASS on the verdict line → true', () => {
  assert.equal(isPassVerdict(comment().body), true)
})

test('isPassVerdict: FAIL verdict is not a pass, even when the evidence body mentions PASS', () => {
  assert.equal(isPassVerdict(failComment().body), false)
})

test('isPassVerdict: an ambiguous verdict line (both PASS and FAIL) is conservatively not a pass', () => {
  assert.equal(isPassVerdict('## Tester verdict — PASS (was FAIL last run)'), false)
})

test('isPassVerdict: PASS only in the body below the verdict line does not count', () => {
  assert.equal(isPassVerdict('## Tester verdict — FAIL\nPASS PASS PASS'), false)
  assert.equal(isPassVerdict('## Tester verdict\nPASS'), false)
})

test('isPassVerdict: PASS must be a whole word (SURPASSED is not a verdict)', () => {
  assert.equal(isPassVerdict('## Tester verdict — expectations SURPASSED'), false)
})

// ---------- verdict comment filtering (mirrors the labeling step jq) ----------

test('verdictComments: keeps only bot-authored, marker-bearing comments at/after since', () => {
  const kept = comment()
  const out = verdictComments(
    [
      kept,
      comment({ user: { login: 'daniel-perez' } }), // human comment, even with the marker
      comment({ body: 'looks good to me' }), // no marker
      comment({ created_at: '2026-08-26T23:59:59Z' }), // before the run started
      comment({ created_at: null }), // malformed
      { body: null, user: null }, // malformed
    ],
    SINCE,
  )
  assert.deepEqual(out, [kept])
})

test('verdictComments: empty and missing input → empty', () => {
  assert.deepEqual(verdictComments([], SINCE), [])
  assert.deepEqual(verdictComments(null, SINCE), [])
})

test('latestVerdict: with several in-window verdicts, the latest wins', () => {
  const earlier = failComment({ created_at: '2026-08-27T00:05:00Z' })
  const later = comment({ created_at: '2026-08-27T00:20:00Z' })
  assert.equal(latestVerdict([later, earlier], SINCE), later)
  assert.equal(latestVerdict([earlier, later], SINCE), later)
  assert.equal(latestVerdict([], SINCE), null)
})

// ---------- the decision ----------

const promptPass = () => ({
  comments: [comment()],
  since: SINCE,
  isDraft: false,
  promptLabeled: true,
})

test('decide: prompt-labeled + PASS verdict + lifted draft → merge', () => {
  const d = decideAutoMerge(promptPass())
  assert.equal(d.merge, true)
})

test('decide: no prompt:* label → never merge, regardless of a perfect PASS', () => {
  const d = decideAutoMerge({ ...promptPass(), promptLabeled: false })
  assert.equal(d.merge, false)
  assert.match(d.reason, /prompt/)
})

test('decide: FAIL verdict → no merge', () => {
  const d = decideAutoMerge({ ...promptPass(), comments: [failComment()] })
  assert.equal(d.merge, false)
  assert.match(d.reason, /not a PASS/)
})

test('decide: PASS comment but the PR is still a draft → no merge (both signals required)', () => {
  const d = decideAutoMerge({ ...promptPass(), isDraft: true })
  assert.equal(d.merge, false)
  assert.match(d.reason, /draft/)
})

test('decide: no verdict since the run started → no merge (stale PASS from an old run does not count)', () => {
  const stale = comment({ created_at: '2026-08-20T00:00:00Z' })
  const d = decideAutoMerge({ ...promptPass(), comments: [stale] })
  assert.equal(d.merge, false)
  assert.match(d.reason, /no tester verdict/)
})

test('decide: FAIL posted after an earlier in-window PASS → latest wins, no merge', () => {
  const d = decideAutoMerge({
    ...promptPass(),
    comments: [
      comment({ created_at: '2026-08-27T00:05:00Z' }),
      failComment({ created_at: '2026-08-27T00:15:00Z' }),
    ],
  })
  assert.equal(d.merge, false)
})

test('decide: reasons are single-line (GITHUB_OUTPUT-safe)', () => {
  for (const args of [
    promptPass(),
    { ...promptPass(), promptLabeled: false },
    { ...promptPass(), comments: [failComment()] },
    { ...promptPass(), isDraft: true },
    { ...promptPass(), comments: [] },
  ]) {
    const { reason } = decideAutoMerge(args)
    assert.equal(typeof reason, 'string')
    assert.ok(!reason.includes('\n'))
  }
})

// ---------- input validation (never default toward a merge) ----------

test('parseBool: only exact "true"/"false" accepted', () => {
  assert.equal(parseBool('draft', 'true'), true)
  assert.equal(parseBool('draft', 'false'), false)
  for (const bad of ['TRUE', 'yes', '1', '', undefined]) {
    assert.throws(() => parseBool('draft', bad), /--draft/)
  }
})

test('parseSince: requires the guard step timestamp shape', () => {
  assert.equal(parseSince(SINCE), SINCE)
  for (const bad of ['', 'now', '2026-08-27', '2026-08-27T00:00:00+02:00', undefined]) {
    assert.throws(() => parseSince(bad), /--since/)
  }
})

// ---------- CLI (invoked exactly as the workflow invokes it) ----------

const SCRIPT = fileURLToPath(new URL('./auto-merge-decision.mjs', import.meta.url))

function runCli(commentsJson, extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'dan100-'))
  const file = join(dir, 'comments.json')
  writeFileSync(file, JSON.stringify(commentsJson))
  return execFileSync(process.execPath, [SCRIPT, '--comments', file, ...extraArgs], {
    encoding: 'utf8',
  })
}

test('CLI: merge case prints exactly the two GITHUB_OUTPUT lines', () => {
  const out = runCli([comment()], ['--since', SINCE, '--draft', 'false', '--prompt-labeled', 'true'])
  const lines = out.trim().split('\n')
  assert.equal(lines[0], 'merge=yes')
  assert.match(lines[1], /^reason=/)
  assert.equal(lines.length, 2)
})

test('CLI: non-prompt ticket → merge=no', () => {
  const out = runCli([comment()], ['--since', SINCE, '--draft', 'false', '--prompt-labeled', 'false'])
  assert.equal(out.trim().split('\n')[0], 'merge=no')
})

test('CLI: invalid --draft fails loudly with exit 1 (never merges by default)', () => {
  assert.throws(
    () => runCli([comment()], ['--since', SINCE, '--draft', 'maybe', '--prompt-labeled', 'true']),
    (err) => err.status === 1 && /--draft/.test(String(err.stderr)),
  )
})

test('CLI: comments file that is not a JSON array fails loudly', () => {
  assert.throws(
    () => runCli({ not: 'an array' }, ['--since', SINCE, '--draft', 'false', '--prompt-labeled', 'true']),
    (err) => err.status === 1 && /JSON array/.test(String(err.stderr)),
  )
})
