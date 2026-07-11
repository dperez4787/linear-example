// DAN-29 tester verification. Independent of the developer's byte-for-byte replacement.
// Locks the v4 "completed cost appendix" invariants the ticket's acceptance criteria
// hinge on:
//   1. The static /blog asset (which Vite copies verbatim into dist/blog/index.html)
//      is byte-identical to the canonical v4 document — its sha256 is the pinned
//      3eb06653…bd2a, and its title is verbatim "An Agentic SDLC, End to End".
//   2. The v4 additions are baked in: live anchors to BOTH PR #29 and PR #30, the
//      literal $16.10 grand total, and exactly three embedded JPEG screenshots
//      (the new concurrent-In-Progress board capture is the third).
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
// Round 2 point 3 this lock now tracks the new canonical bytes; every v4 invariant below
// (PR #29 + #30 anchors, the $16.10 total, three screenshots) survives linkification.
const CANONICAL_SHA256 =
  'd9e6ea8a712eb616b4623cf0aab74a724e038389a6745cb3a00272a76777dcd7'

describe('DAN-29 · /blog is the canonical v4 document', () => {
  it('is byte-identical to the pinned v4 asset (sha256)', () => {
    const digest = createHash('sha256').update(blogBytes).digest('hex')
    expect(digest).toBe(CANONICAL_SHA256)
  })

  it('carries the delivered title verbatim and is a full HTML document', () => {
    expect(blog.startsWith('<!doctype html>')).toBe(true)
    expect(blog).toContain('<title>An Agentic SDLC, End to End</title>')
  })
})

describe('DAN-29 · completed-cost-appendix additions baked into v4', () => {
  it('links to BOTH PR #29 and PR #30 (the two documented deliveries)', () => {
    expect(blog).toContain(
      'href="https://github.com/dperez4787/linear-example/pull/29"',
    )
    expect(blog).toContain(
      'href="https://github.com/dperez4787/linear-example/pull/30"',
    )
  })

  it('states the $16.10 grand total', () => {
    expect(blog).toContain('$16.10')
  })

  it('embeds exactly three base64 JPEG screenshots', () => {
    const matches = blog.match(/data:image\/jpeg;base64/g) ?? []
    expect(matches).toHaveLength(3)
  })
})
