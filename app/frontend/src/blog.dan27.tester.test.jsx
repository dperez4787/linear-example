// DAN-27 tester verification. Independent of the developer's byte-for-byte replacement.
// Locks the v3.1 invariants the ticket's acceptance criteria hinge on:
//   1. The static /blog asset (which Vite copies verbatim into dist/blog/index.html)
//      is byte-identical to the canonical v3.1 document — its sha256 is the pinned
//      6d23be42…d651, and its title is verbatim "An Agentic SDLC, End to End".
//   2. The loop-closing additions baked into v3.1 are present: a live anchor to
//      PR #27, the live /blog and app URLs, and the two embedded JPEG screenshots.
// These read the repo file directly (the source of dist/blog/index.html), mirroring
// the emulator GET /blog and diff-scope criteria at the unit level.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Vitest runs with cwd = app/frontend; public/blog/index.html is the source Vite
// copies verbatim into dist/blog/index.html.
const blogPath = resolve(process.cwd(), 'public/blog/index.html')
const blogBytes = readFileSync(blogPath)
const blog = blogBytes.toString('utf8')

const CANONICAL_SHA256 =
  '6d23be420c9ba2183f1c191d795bdfb76492ee48d63131a7ca970c7f38c3d651'

describe('DAN-27 · /blog is the canonical v3.1 document', () => {
  it('is byte-identical to the pinned v3.1 asset (sha256)', () => {
    const digest = createHash('sha256').update(blogBytes).digest('hex')
    expect(digest).toBe(CANONICAL_SHA256)
  })

  it('carries the delivered title verbatim and is a full HTML document', () => {
    expect(blog.startsWith('<!doctype html>')).toBe(true)
    expect(blog).toContain('<title>An Agentic SDLC, End to End</title>')
  })
})

describe('DAN-27 · loop-closing additions baked into v3.1', () => {
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

  it('embeds exactly two base64 JPEG screenshots', () => {
    const matches = blog.match(/data:image\/jpeg;base64/g) ?? []
    expect(matches).toHaveLength(2)
  })
})
