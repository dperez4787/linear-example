// DAN-100: independent TESTER suite for auto-merge-decision.mjs — written
// against the ticket's acceptance criteria, not the developer's tests. This
// script is the safety boundary of the only step that merges to main with no
// human, so every test here attacks a way a merge could happen that shouldn't.
// Run with: node --test '.github/scripts/*.test.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decideAutoMerge, isPassVerdict } from './auto-merge-decision.mjs'

const SINCE = '2026-08-27T10:00:00Z'
const BOT = 'github-actions[bot]'

// Comment builders — shape mirrors the GitHub issue-comments API the workflow
// saves to $RUNNER_TEMP/pr-verdict-comments.json.
const bot = (body, created_at = '2026-08-27T10:15:00Z') => ({
  user: { login: BOT },
  body,
  created_at,
})
const human = (body, created_at = '2026-08-27T10:16:00Z') => ({
  user: { login: 'evil-drive-by-account' },
  body,
  created_at,
})

const PASS_BODY = '## Tester verdict — PASS\n\nAll criteria verified. Evidence attached.'
const FAIL_BODY = '## Tester verdict — FAIL\n\nCriterion 3 broken; see logs.'

const base = (over = {}) => ({
  comments: [bot(PASS_BODY)],
  since: SINCE,
  isDraft: false,
  promptLabeled: true,
  ...over,
})

const decide = (over) => decideAutoMerge(base(over))

// ---------------- happy path, then each leg knocked out individually ----------------

test('T01 happy path: prompt label + clean bot PASS in-window + draft lifted -> yes', () => {
  const d = decide()
  assert.equal(d.merge, true)
})

test('T02 prompt label removed, everything else perfect -> no', () => {
  assert.equal(decide({ promptLabeled: false }).merge, false)
})

test('T03 no verdict comment at all -> no', () => {
  assert.equal(decide({ comments: [] }).merge, false)
})

test('T04 PASS verdict but draft still true -> no (both signals required)', () => {
  assert.equal(decide({ isDraft: true }).merge, false)
})

test('T05 FAIL verdict -> no', () => {
  assert.equal(decide({ comments: [bot(FAIL_BODY)] }).merge, false)
})

// ---------------- verdict LINE vs comment body ----------------

test('T06 verdict line FAIL, body repeatedly mentions PASS -> no', () => {
  const body = '## Tester verdict — FAIL\n\nExpected PASS on step 2. PASS was seen locally. PASS PASS.'
  assert.equal(decide({ comments: [bot(body)] }).merge, false)
})

test('T07 verdict line PASS, body discusses failures -> yes (only the verdict line rules)', () => {
  const body = '## Tester verdict — PASS\n\nEarlier run said FAIL; the FAIL was env flake. All criteria now pass.'
  assert.equal(decide({ comments: [bot(body)] }).merge, true)
})

test('T08 verdict line containing both PASS and FAIL is ambiguous -> conservative no', () => {
  assert.equal(isPassVerdict('## Tester verdict — PASS (was FAIL before)'), false)
  assert.equal(decide({ comments: [bot('## Tester verdict — PASS (was FAIL before)')] }).merge, false)
})

test('T09 marker present but neither word on the verdict line -> no', () => {
  assert.equal(decide({ comments: [bot('## Tester verdict —\n\nPASS')] }).merge, false)
})

// ---------------- ordering: the LATEST in-window verdict wins ----------------

test('T10 PASS then later FAIL in the same run -> latest wins, no', () => {
  const d = decide({
    comments: [
      bot(PASS_BODY, '2026-08-27T10:05:00Z'),
      bot(FAIL_BODY, '2026-08-27T10:25:00Z'),
    ],
  })
  assert.equal(d.merge, false)
})

test('T11 PASS then later FAIL, array delivered in reverse order -> still no', () => {
  const d = decide({
    comments: [
      bot(FAIL_BODY, '2026-08-27T10:25:00Z'),
      bot(PASS_BODY, '2026-08-27T10:05:00Z'),
    ],
  })
  assert.equal(d.merge, false)
})

test('T12 FAIL then a later corrected PASS -> latest wins, yes', () => {
  const d = decide({
    comments: [
      bot(FAIL_BODY, '2026-08-27T10:05:00Z'),
      bot(PASS_BODY, '2026-08-27T10:25:00Z'),
    ],
  })
  assert.equal(d.merge, true)
})

// ---------------- staleness: verdicts from before the run must not merge ----------------

test('T13 only verdict is a PASS from BEFORE run start -> no (stale verdict cannot merge)', () => {
  const d = decide({ comments: [bot(PASS_BODY, '2026-08-27T09:59:59Z')] })
  assert.equal(d.merge, false)
})

test('T14 stale PASS plus in-window FAIL -> no on both grounds', () => {
  const d = decide({
    comments: [
      bot(PASS_BODY, '2026-08-20T00:00:00Z'),
      bot(FAIL_BODY, '2026-08-27T10:10:00Z'),
    ],
  })
  assert.equal(d.merge, false)
})

test('T15 verdict created exactly AT run start counts (boundary is inclusive, matching the jq)', () => {
  const d = decide({ comments: [bot(PASS_BODY, SINCE)] })
  assert.equal(d.merge, true)
})

// ---------------- authorship: only github-actions[bot] verdicts count ----------------

test('T16 non-bot author posting a fake "Tester verdict — PASS" -> ignored, no', () => {
  const d = decide({ comments: [human(PASS_BODY)] })
  assert.equal(d.merge, false)
})

test('T17 attacker fake PASS posted AFTER a genuine bot FAIL -> still no', () => {
  const d = decide({
    comments: [
      bot(FAIL_BODY, '2026-08-27T10:10:00Z'),
      human(PASS_BODY, '2026-08-27T10:30:00Z'),
    ],
  })
  assert.equal(d.merge, false)
})

test('T18 author login lookalikes are not the bot -> no', () => {
  for (const login of ['github-actions', 'github-actions[bot] ', 'Github-Actions[bot]', 'github-actions[bot]x']) {
    const d = decide({ comments: [{ user: { login }, body: PASS_BODY, created_at: '2026-08-27T10:15:00Z' }] })
    assert.equal(d.merge, false, `login ${JSON.stringify(login)} must not count as the bot`)
  }
})

// ---------------- lookalike / unicode verdict lines: must be conservative no ----------------
// These are what a nondeterministic tester agent might actually write. In a
// no-human pipeline, anything short of an unambiguous PASS must not merge.

test('T19 hedged verdict "Tester verdict — PASS?" -> conservative no', () => {
  assert.equal(isPassVerdict('## Tester verdict — PASS?'), false)
  assert.equal(decide({ comments: [bot('## Tester verdict — PASS?')] }).merge, false)
})

test('T20 negated verdict "Tester verdict — NOT PASS" -> conservative no', () => {
  assert.equal(isPassVerdict('## Tester verdict — NOT PASS'), false)
  assert.equal(decide({ comments: [bot('## Tester verdict — NOT PASS')] }).merge, false)
})

test('T21 negated verdict "Tester verdict: did not PASS" -> conservative no', () => {
  assert.equal(isPassVerdict('Tester verdict: did not PASS'), false)
})

test('T22 fullwidth unicode ＰＡＳＳ is not the word PASS -> no', () => {
  assert.equal(isPassVerdict('## Tester verdict — ＰＡＳＳ'), false)
})

test('T23 PASS as a fragment (SURPASS, PASSED, PASSable) -> no', () => {
  assert.equal(isPassVerdict('## Tester verdict — SURPASSED'), false)
  assert.equal(isPassVerdict('## Tester verdict — PASSED'), false)
  assert.equal(isPassVerdict('## Tester verdict — PASSable'), false)
})

test('T24 lowercase pass is not a verdict -> no', () => {
  assert.equal(isPassVerdict('## Tester verdict — pass'), false)
})

// ---------------- malformed comment objects must not crash or merge ----------------

test('T25 malformed comment entries (nulls, missing fields) -> filtered, no crash', () => {
  const d = decide({
    comments: [
      null,
      {},
      { user: null, body: PASS_BODY, created_at: '2026-08-27T10:15:00Z' },
      { user: { login: BOT }, body: 12345, created_at: '2026-08-27T10:15:00Z' },
      { user: { login: BOT }, body: PASS_BODY, created_at: null },
      { user: { login: BOT }, body: PASS_BODY }, // no created_at at all
    ],
  })
  assert.equal(d.merge, false)
})

// ---------------- CLI: exactly as the workflow invokes it ----------------

const SCRIPT = fileURLToPath(new URL('./auto-merge-decision.mjs', import.meta.url))

function cli(commentsContent, args) {
  const dir = mkdtempSync(join(tmpdir(), 'dan100-tester-'))
  const file = join(dir, 'comments.json')
  writeFileSync(file, commentsContent)
  return spawnSync(process.execPath, [SCRIPT, '--comments', file, ...args], { encoding: 'utf8' })
}

const FULL_ARGS = ['--since', SINCE, '--draft', 'false', '--prompt-labeled', 'true']

// Every rejection path must exit 1 AND must never have printed merge=yes.
function assertRefusedLoudly(r, label) {
  assert.equal(r.status, 1, `${label}: expected exit 1, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`)
  assert.ok(!r.stdout.includes('merge=yes'), `${label}: refused input must never emit merge=yes`)
}

test('T26 CLI happy path emits exactly merge=yes + reason, nothing else', () => {
  const r = cli(JSON.stringify([bot(PASS_BODY)]), FULL_ARGS)
  assert.equal(r.status, 0)
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0], 'merge=yes')
  assert.match(lines[1], /^reason=[^\n]*$/)
})

test('T27 CLI empty comments array -> merge=no (exit 0, defense-in-depth path)', () => {
  const r = cli('[]', FULL_ARGS)
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim().split('\n')[0], 'merge=no')
})

test('T28 CLI non-JSON comments file -> exit 1, never merge=yes', () => {
  assertRefusedLoudly(cli('this is not json {', FULL_ARGS), 'non-JSON file')
})

test('T29 CLI JSON object (not array) -> exit 1', () => {
  assertRefusedLoudly(cli('{"body":"## Tester verdict — PASS"}', FULL_ARGS), 'non-array JSON')
})

test('T30 CLI JSON scalar/empty file -> exit 1', () => {
  assertRefusedLoudly(cli('"PASS"', FULL_ARGS), 'JSON string')
  assertRefusedLoudly(cli('', FULL_ARGS), 'empty file')
})

test('T31 CLI missing --since -> exit 1', () => {
  assertRefusedLoudly(cli('[]', ['--draft', 'false', '--prompt-labeled', 'true']), 'missing --since')
})

test('T32 CLI missing --draft -> exit 1', () => {
  assertRefusedLoudly(cli('[]', ['--since', SINCE, '--prompt-labeled', 'true']), 'missing --draft')
})

test('T33 CLI missing --prompt-labeled -> exit 1', () => {
  assertRefusedLoudly(cli('[]', ['--since', SINCE, '--draft', 'false']), 'missing --prompt-labeled')
})

test('T34 CLI missing --comments -> exit 1', () => {
  const r = spawnSync(process.execPath, [SCRIPT, ...FULL_ARGS.slice(0)], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.ok(!r.stdout.includes('merge=yes'))
})

test('T35 CLI garbage --since values -> exit 1 each (a permissive since resurrects stale verdicts)', () => {
  for (const bad of ['', 'now', 'garbage', '2026-08-27', '2026-08-27T10:00:00', '2026-08-27T10:00:00+00:00', '2026-08-27 10:00:00Z']) {
    assertRefusedLoudly(
      cli(JSON.stringify([bot(PASS_BODY)]), ['--since', bad, '--draft', 'false', '--prompt-labeled', 'true']),
      `--since ${JSON.stringify(bad)}`,
    )
  }
})

test('T36 CLI non-boolean --draft values -> exit 1 each', () => {
  for (const bad of ['maybe', 'TRUE', 'True', '1', 'yes', ' false']) {
    assertRefusedLoudly(
      cli(JSON.stringify([bot(PASS_BODY)]), ['--since', SINCE, '--draft', bad, '--prompt-labeled', 'true']),
      `--draft ${JSON.stringify(bad)}`,
    )
  }
})

test('T37 CLI non-boolean --prompt-labeled values -> exit 1 each', () => {
  for (const bad of ['maybe', 'TRUE', '1', 'null']) {
    assertRefusedLoudly(
      cli(JSON.stringify([bot(PASS_BODY)]), ['--since', SINCE, '--draft', 'false', '--prompt-labeled', bad]),
      `--prompt-labeled ${JSON.stringify(bad)}`,
    )
  }
})

test('T38 CLI unknown flag -> exit 1 (strict parseArgs, no silent typo like --drafts)', () => {
  assertRefusedLoudly(
    cli(JSON.stringify([bot(PASS_BODY)]), [...FULL_ARGS, '--force-merge', 'true']),
    'unknown flag',
  )
})

test('T39 CLI error output does not leak comment bodies or token-like strings', () => {
  const secretBody = '## Tester verdict — PASS\nghp_SECRETSECRETSECRET1234'
  const r = cli(JSON.stringify([bot(secretBody)]), ['--since', 'garbage', '--draft', 'false', '--prompt-labeled', 'true'])
  assert.equal(r.status, 1)
  assert.ok(!`${r.stdout}${r.stderr}`.includes('ghp_SECRETSECRETSECRET1234'))
})
