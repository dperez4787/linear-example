// DAN-30 tester verification. Independent of the developer's commit.
// Locks the Linguist-override invariants the ticket's acceptance criteria hinge on:
//   1. .gitattributes exists at the repo root and contains the exact single line
//      `app/frontend/public/blog/** linguist-documentation linguist-generated`.
//   2. Git actually resolves BOTH attributes as `set` on the target asset
//      app/frontend/public/blog/index.html (this is what GitHub Linguist reads:
//      linguist-documentation drops it from language stats, linguist-generated
//      collapses it in diffs).
//   3. The attributes do NOT leak onto other frontend source — api.js resolves
//      both as `unspecified`.
// These shell out to `git` via `git -C <repo root>` so they are independent of the
// cwd vitest happens to run from. No new dependency: node builtins + vitest only.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Vitest runs with cwd = app/frontend; the repo root is two levels up.
const repoRoot = resolve(process.cwd(), '..', '..')

const EXPECTED_LINE =
  'app/frontend/public/blog/** linguist-documentation linguist-generated'

function checkAttr(attr, path) {
  // `git check-attr <attr> -- <path>` prints `<path>: <attr>: <value>`.
  const out = execFileSync(
    'git',
    ['-C', repoRoot, 'check-attr', attr, '--', path],
    { encoding: 'utf8' },
  ).trim()
  return out.slice(out.lastIndexOf(':') + 1).trim()
}

describe('DAN-30 · .gitattributes file content', () => {
  it('exists at the repo root and contains the exact override line', () => {
    const contents = readFileSync(resolve(repoRoot, '.gitattributes'), 'utf8')
    const lines = contents.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toContain(EXPECTED_LINE)
  })
})

describe('DAN-30 · attributes resolve on the blog asset', () => {
  const target = 'app/frontend/public/blog/index.html'

  it('marks the blog page linguist-documentation (dropped from language stats)', () => {
    expect(checkAttr('linguist-documentation', target)).toBe('set')
  })

  it('marks the blog page linguist-generated (collapsed in diffs)', () => {
    expect(checkAttr('linguist-generated', target)).toBe('set')
  })
})

describe('DAN-30 · attributes do not leak onto other frontend source', () => {
  const other = 'app/frontend/src/api.js'

  it('leaves linguist-documentation unspecified on api.js', () => {
    expect(checkAttr('linguist-documentation', other)).toBe('unspecified')
  })

  it('leaves linguist-generated unspecified on api.js', () => {
    expect(checkAttr('linguist-generated', other)).toBe('unspecified')
  })
})
