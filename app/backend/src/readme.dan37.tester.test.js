// DAN-37 tester verification — locks the agent-checkable invariants of the
// repo-root README.md so a future edit cannot silently regress them. This is a
// documentation ticket, so there is no runtime behavior to drive; instead we
// assert every criterion the Linear issue marks "agent-checkable" against the
// committed file. Colocated in the backend package because that is where
// `node:test` already runs; it reads the repo-root README, touching no db.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const readmePath = resolve(repoRoot, 'README.md')

test('README.md exists at the repo root', () => {
  assert.ok(existsSync(readmePath), 'README.md must exist at the repo root')
})

const readme = readFileSync(readmePath, 'utf8')
const lines = readme.split('\n')
const first40 = lines.slice(0, 40).join('\n')

test('both live links appear within the first 40 lines', () => {
  assert.match(first40, /https:\/\/project-d60a83c1-2c60-4d51-ad0\.web\.app\/(?!blog)/)
  assert.match(first40, /https:\/\/project-d60a83c1-2c60-4d51-ad0\.web\.app\/blog/)
})

test('names all four agents', () => {
  for (const agent of ['product-owner', 'architect', 'developer', 'tester']) {
    assert.ok(readme.includes(agent), `README must name the ${agent} agent`)
  }
})

test('states the draft-PR gate: PRs open as drafts and only the tester lifts the draft', () => {
  assert.match(readme, /draft/i)
  assert.match(readme, /tester\b[\s\S]*?lift|lift[\s\S]*?draft/i)
})

test('states agents never merge and never push to main; the user merges', () => {
  assert.match(readme, /never merge/i)
  assert.match(readme, /main/)
  assert.match(readme, /user\*{0,2}\s+merges/i)
})

test('describes the API as GraphQL at POST /api/graphql', () => {
  assert.match(readme, /POST\s+`?\/api\/graphql`?/i)
  assert.match(readme, /GraphQL/)
})

test('does not claim the current API is REST', () => {
  // Historical mention ("began life as REST", "GraphQL, not REST") is allowed;
  // a present-tense REST claim about the current API is not.
  assert.doesNotMatch(readme, /\bREST API\b/i)
  assert.doesNotMatch(readme, /API is (?:a )?REST/i)
})

test('mentions the full stack', () => {
  for (const term of ['React', 'Express', 'MongoDB Atlas', 'Cloud Run', 'Firebase Hosting', 'Terraform']) {
    assert.ok(readme.includes(term), `README must mention ${term}`)
  }
})

test('every repo-relative path it references exists in the tree', () => {
  const paths = [
    'app/frontend',
    'app/backend',
    'infra',
    'docs/architecture.md',
    '.claude/agents',
    '.github/workflows/linear-agents.yml',
    '.nvmrc',
    'CLAUDE.md',
  ]
  for (const p of paths) {
    // Only assert existence for paths the README actually references.
    if (readme.includes(p)) {
      assert.ok(existsSync(resolve(repoRoot, p)), `referenced path ${p} must exist`)
    }
  }
})

test('contains no real MongoDB connection string — only an obvious placeholder', () => {
  const matches = readme.match(/mongodb\+srv:\/\/[^\s`)]+/g) ?? []
  for (const uri of matches) {
    assert.ok(
      uri.includes('<user>:<password>'),
      `mongodb+srv URI must use the <user>:<password> placeholder, got: ${uri}`,
    )
  }
})

test('code fences are balanced (valid Markdown, no unclosed fence)', () => {
  const fences = lines.filter((l) => l.startsWith('```')).length
  assert.equal(fences % 2, 0, 'triple-backtick code fences must be balanced')
})
