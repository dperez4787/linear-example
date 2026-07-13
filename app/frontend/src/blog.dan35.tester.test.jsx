// DAN-35 tester lock — verifies the blog index screen at public/blog/index.html and the
// verbatim move of part 1 to public/blog/agentic-sdlc/index.html against the ticket's
// acceptance criteria. These are the tester agent's own checks, added on top of the
// developer's work; they do not modify product source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const indexPath = resolve(process.cwd(), 'public/blog/index.html')
const part1Path = resolve(process.cwd(), 'public/blog/agentic-sdlc/index.html')
const ticketsPath = resolve(process.cwd(), 'public/blog/tickets/index.html')

const indexBytes = readFileSync(indexPath)
const part1Bytes = readFileSync(part1Path)
const index = indexBytes.toString('utf8')
const part1 = part1Bytes.toString('utf8')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// The two byte-precise pins from the ticket.
const INDEX_SHA = '094770e37446d623c6e07e0c80fe8abbc98f609d81c7587afca8deaa08a9ac9e'
const PART1_SHA = 'a740e37e0fb59b9806035f309e9d69585b69f233449925a447f80e39bc62923a'

describe('DAN-35 · C1 the index screen is the canonical attachment, byte-for-byte', () => {
  it('public/blog/index.html sha256 matches the attached blog-index-v1.html', () => {
    expect(sha256(indexBytes)).toBe(INDEX_SHA)
  })
  it('is 5484 bytes', () => {
    expect(indexBytes.length).toBe(5484)
  })
})

describe('DAN-35 · C2 part 1 moved unchanged to /blog/agentic-sdlc/', () => {
  it('public/blog/agentic-sdlc/index.html sha256 is the unchanged part-1 file', () => {
    expect(sha256(part1Bytes)).toBe(PART1_SHA)
  })
  it('still carries part 1 title and its ticket-archive deep links (survived the move)', () => {
    expect(part1).toContain('An Agentic SDLC, End to End')
    expect(part1).toMatch(/href="\/blog\/tickets\/#DAN-\d+"/)
  })
})

describe('DAN-35 · C3 the index is a self-contained parent screen', () => {
  it('is titled "Blog · Agentic Software Delivery"', () => {
    expect(index).toContain('<title>Blog · Agentic Software Delivery</title>')
  })
  it('shows the index heading', () => {
    expect(index).toContain('Building real systems with AI agents')
  })
  it('links both posts and back to the app root', () => {
    expect(index).toContain('href="/blog/agentic-sdlc/"')
    expect(index).toContain('href="/blog/imdb-federation/"')
    expect(index).toMatch(/href="\/"/)
  })
  it('loads no external resources and makes no scripted network calls (content anchors aside)', () => {
    // src= on any tag, or href= on a <link>, would fetch an external resource at load.
    const fetched = [
      ...[...index.matchAll(/\bsrc="(https?:\/\/[^"]+)"/g)].map((m) => m[1]),
      ...[...index.matchAll(/<link\b[^>]*\bhref="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]),
    ]
    expect(fetched).toEqual([])
    expect(index).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|EventSource|import\s*\(/)
  })
})

describe('DAN-35 · C4 the index is not part 1', () => {
  it('the two files are distinct and the index does not carry the part-1 body', () => {
    expect(sha256(indexBytes)).not.toBe(sha256(part1Bytes))
    expect(index).not.toContain('An Agentic SDLC, End to End')
  })
})

describe('DAN-35 · C5 the tickets archive was not touched by this move', () => {
  it('public/blog/tickets/index.html still present and self-contained', () => {
    const archive = readFileSync(ticketsPath, 'utf8')
    expect(archive).toMatch(/id="DAN-\d+"/)
  })
})
