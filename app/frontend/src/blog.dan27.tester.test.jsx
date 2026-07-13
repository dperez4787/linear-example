// DAN-27 tester verification. Independent of the developer's byte-for-byte replacement.
// Re-pinned in DAN-29 Round 2: v3.1 was superseded by the v4 completed-cost-appendix,
// so this lock now pins the CURRENT canonical bytes rather than a retired asset — the
// stale v3.1 pins (sha256 6d23be42…d651, exactly 2 screenshots) deadlocked the suite
// against the v4 file this branch ships. The lock keeps its DAN-27 lineage — it still
// asserts the loop-closing additions DAN-27 introduced (the PR #27 anchor and the live
// /blog and app URLs), all of which survive verbatim into v4 — while tracking the live
// bytes. The v4-specific additions (PR #29/#30, $16.10, the third screenshot) are
// locked by blog.dan29.tester.test.jsx.
// Invariants:
//   1. The static /blog asset (which Vite copies verbatim into dist/blog/index.html)
//      is byte-identical to the canonical v4 document — its sha256 is the pinned
//      3eb06653…bd2a, and its title is verbatim "An Agentic SDLC, End to End".
//   2. The loop-closing additions DAN-27 introduced are still present: a live anchor to
//      PR #27, the live /blog and app URLs, and (now) three embedded JPEG screenshots.
// These read the repo file directly (the source of dist/blog/index.html), mirroring
// the emulator GET /blog and diff-scope criteria at the unit level.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Vitest runs with cwd = app/frontend; public/blog/index.html is the source Vite
// copies verbatim into dist/blog/index.html.
const blogPath = resolve(process.cwd(), 'public/blog/agentic-sdlc/index.html')
const blogBytes = readFileSync(blogPath)
const blog = blogBytes.toString('utf8')

// Re-pinned in DAN-31: linkifying every DAN-* reference into a /blog/tickets/ deep
// link (and HTML-encoding the hyphen in the 5 <img alt> screenshot descriptions, which
// cannot syntactically hold an anchor) necessarily changes the blog's bytes. Per DAN-31
// Round 2 point 3 this lock now tracks the new canonical bytes; every DAN-27 lineage
// invariant below (PR #27 anchor, live URLs, three screenshots) survives linkification.
// Re-pinned again (v5): one empowerment paragraph added to "Initial goals" — the
// product-owner/designer aim stated explicitly. All lineage invariants survive.
const CANONICAL_SHA256 =
  '40b8093398a32469b11c6ed23d4503c6dd0c51ecc3e4d9201a0b9571bbedf0a8'

describe('DAN-27 · /blog is the canonical (v4) document', () => {
  it('is byte-identical to the pinned v4 asset (sha256)', () => {
    const digest = createHash('sha256').update(blogBytes).digest('hex')
    expect(digest).toBe(CANONICAL_SHA256)
  })

  it('carries the delivered title verbatim and is a full HTML document', () => {
    expect(blog.startsWith('<!doctype html>')).toBe(true)
    expect(blog).toContain('<title>An Agentic SDLC, End to End</title>')
  })
})

describe('DAN-27 · loop-closing additions (introduced in v3.1, retained in v4)', () => {
  it('links to PR #27 (the delivery this post documents)', () => {
    expect(blog).toContain(
      'href="https://github.com/dperez4787/linear-example/pull/27"',
    )
  })

  it('cites its own live /blog URL and the live app URL', () => {
    expect(blog).toContain(
      'https://project-d60a83c1-2c60-4d51-ad0.web.app/blog',
    )
    expect(blog).toContain('https://project-d60a83c1-2c60-4d51-ad0.web.app')
  })

  it('embeds exactly three base64 JPEG screenshots', () => {
    const matches = blog.match(/data:image\/jpeg;base64/g) ?? []
    expect(matches).toHaveLength(3)
  })
})
