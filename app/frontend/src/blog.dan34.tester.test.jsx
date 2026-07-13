// DAN-34 tester lock — verifies the part-2 blog post published verbatim at
// public/blog/imdb-federation/index.html against the ticket's acceptance criteria.
// These are the tester agent's own checks on top of the developer's work; they do not
// modify product source. Vitest runs with cwd = app/frontend, so public/... is the
// source Vite copies verbatim into dist/blog/imdb-federation/index.html.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// The canonical sha256 of the published part-2 document. Originally the ticket
// attachment (imdb-federation-post-v1.html); re-pinned by the blog deep-dive
// revision (v2: Marquee/Concierge/governance screenshots, component diagram,
// data deep-dive, ticket catalog, honest ledger).
const CANONICAL_SHA256 =
  'c807879c454678cfcf052d75858352e33f85550bdc9a9ec95136ce08f916fc76'

const postPath = resolve(process.cwd(), 'public/blog/imdb-federation/index.html')
const postBytes = readFileSync(postPath) // Buffer — byte-exact, no encoding coercion
const post = postBytes.toString('utf8')

// Sibling blog assets that this ticket must NOT touch.
const blogIndexPath = resolve(process.cwd(), 'public/blog/index.html')
const agenticSdlcPath = resolve(process.cwd(), 'public/blog/agentic-sdlc/index.html')
const ticketsPath = resolve(process.cwd(), 'public/blog/tickets/index.html')

describe('DAN-34 · C1 verbatim byte-for-byte drop of the canonical asset', () => {
  it('sha256 of the published file equals the ticket-pinned canonical hash', () => {
    const sha = createHash('sha256').update(postBytes).digest('hex')
    expect(sha).toBe(CANONICAL_SHA256)
  })

  it('is exactly 1219330 bytes, as delivered', () => {
    expect(postBytes.length).toBe(1219330)
  })
})

describe('DAN-34 · C2 it is the part-2 document', () => {
  it('carries the verbatim title', () => {
    expect(post).toContain(
      '<title>Federating IMDb: An Agentic Build at Three Speeds</title>',
    )
  })

  it('is a complete standalone HTML document containing "Federating IMDb"', () => {
    expect(post.startsWith('<!doctype html>') || post.startsWith('<!DOCTYPE html>')).toBe(
      true,
    )
    expect(post).toContain('Federating IMDb')
  })
})

describe('DAN-34 · C3 self-contained — inline CSS, no external assets', () => {
  it('references no external scripts/styles/images/fonts (content links to github.com, linear.app, and the live estate are fine)', () => {
    const external = [...post.matchAll(/\b(?:src|href)="(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter(
        (u) =>
          !/^https?:\/\/(github\.com|linear\.app|dfp-imdb-browser\.web\.app|imdb-policy-service-dkuqnmldta-uc\.a\.run\.app)/.test(
            u,
          ),
      )
    expect(external).toEqual([])
  })
})

describe('DAN-34 · C4 no secret material committed', () => {
  it('contains no LINEAR_API_KEY token and no surviving signature= query param', () => {
    expect(post.match(/lin_api_/g)).toBeNull()
    expect(post.match(/signature=/g)).toBeNull()
  })
})

describe('DAN-34 · C5 known-transient links left exactly as authored (not "fixed")', () => {
  it('still links to /blog and /blog/agentic-sdlc/ — the accepted transient state', () => {
    expect(post).toMatch(/href="\/blog\/agentic-sdlc\/"/)
    expect(post).toMatch(/href="\/blog"/)
  })
})

describe('DAN-34 · C6 sibling blog assets untouched by this ticket', () => {
  it('/blog is the index screen and /blog/agentic-sdlc/ is part 1 (post-DAN-35)', () => {
    const blogIndex = readFileSync(blogIndexPath, 'utf8')
    expect(blogIndex).toContain('Building real systems with AI agents')
    const agenticSdlc = readFileSync(agenticSdlcPath, 'utf8')
    expect(agenticSdlc).toContain('An Agentic SDLC, End to End')
  })

  it('/blog/tickets/ archive still present', () => {
    const tickets = readFileSync(ticketsPath, 'utf8')
    expect(tickets.length).toBeGreaterThan(0)
    expect(tickets).toMatch(/id="DAN-\d+"/)
  })
})
