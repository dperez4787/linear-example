// DAN-31 tester lock — verifies the ticket archive at public/blog/tickets/index.html
// and the linkification of public/blog/index.html against the ticket's acceptance
// criteria (Round-2 amendment). These are the tester agent's own checks, added on top
// of the developer's work; they do not modify product source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const blogPath = resolve(process.cwd(), 'public/blog/index.html')
const archivePath = resolve(process.cwd(), 'public/blog/tickets/index.html')
const blog = readFileSync(blogPath, 'utf8')
const archive = readFileSync(archivePath, 'utf8')

// Collect the archive's stable per-ticket anchor ids once.
const archiveIds = new Set(
  [...archive.matchAll(/id="(DAN-\d+)"/g)].map((m) => m[1]),
)

describe('DAN-31 · C1 archive is self-contained', () => {
  it('fetches no external scripts/styles/images/fonts (github.com / linear.app links in content are fine)', () => {
    const external = [...archive.matchAll(/\b(?:src|href)="(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => !/^https?:\/\/(github\.com|linear\.app)/.test(u))
    expect(external).toEqual([])
  })

  it('has exactly one inline <script> and it makes no network calls', () => {
    const scripts = [...archive.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    expect(scripts.length).toBe(1)
    expect(scripts[0][1]).not.toMatch(/\bsrc=/i) // inline, not external
    expect(scripts[0][2]).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|EventSource|import\s*\(/)
  })
})

describe('DAN-31 · C2 all 26 ticket ids present, no gaps', () => {
  it('has id="DAN-n" for every n in 5..30', () => {
    const missing = []
    for (let n = 5; n <= 30; n++) {
      if (!archive.includes(`id="DAN-${n}"`)) missing.push(`DAN-${n}`)
    }
    expect(missing).toEqual([])
    expect(archiveIds.size).toBe(26)
  })
})

describe('DAN-31 · C3 evidence content present', () => {
  it('carries the distinctive DAN-25 tester-verdict phrase', () => {
    expect(archive).toContain('all agent-checkable criteria verified')
    expect(archive).toContain('Missing or malformed Authorization header')
  })
  it('shows a visible UTC snapshot date line and per-comment timestamps with authors', () => {
    expect(archive).toMatch(/2026-\d{2}-\d{2}[^<]*UTC/)
    expect(archive).toMatch(/2026-07-10 00:49 UTC/) // DAN-25 verdict comment timestamp
    expect(archive).toContain('Daniel Perez') // comment author
  })
})

describe('DAN-31 · C4 privacy scrub', () => {
  it('contains no lin_api_ token and no surviving signature= query param', () => {
    expect(archive.match(/lin_api_/g)).toBeNull()
    expect(archive.match(/signature=/g)).toBeNull()
  })
})

describe('DAN-31 · C5 linkification outside <pre>', () => {
  const stripped = blog.replace(/<pre[\s\S]*?<\/pre>/gi, '')
  const anchors = [...stripped.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map((a) => [
    a.index,
    a.index + a[0].length,
    a[0],
  ])
  const goodAnchor = (idx) => {
    for (const [s, e, txt] of anchors) {
      if (idx >= s && idx < e) {
        const href = /href="([^"]*)"/i.exec(txt)
        return !!href && href[1].startsWith('/blog/tickets/#DAN-')
      }
    }
    return false
  }

  it('every DAN-\\d+ outside <pre> sits inside an /blog/tickets/#DAN- anchor', () => {
    const matches = [...stripped.matchAll(/DAN-\d+/g)]
    expect(matches.length).toBeGreaterThan(0)
    const bad = matches.filter((m) => !goodAnchor(m.index)).map((m) => m[0])
    expect(bad).toEqual([])
  })

  it('every deep-link fragment resolves to an existing archive id', () => {
    const targets = [...blog.matchAll(/href="\/blog\/tickets\/#(DAN-\d+)"/g)].map((m) => m[1])
    expect(targets.length).toBeGreaterThan(0)
    const missing = [...new Set(targets)].filter((t) => !archiveIds.has(t))
    expect(missing).toEqual([])
  })

  it('leaves DAN references inside <pre> blocks as plain verbatim text', () => {
    const pres = [...blog.matchAll(/<pre[\s\S]*?<\/pre>/gi)].map((m) => m[0]).join('\n')
    // the verbatim ticket bodies keep bare DAN-* not wrapped in anchors
    expect(pres).toMatch(/DAN-\d+/)
  })
})

describe('DAN-31 · C6 chips stay chips, wording unchanged', () => {
  it('.tid chips are now anchors carrying the chip class (styling applies via .tid)', () => {
    expect(blog).toMatch(/<a class="tid" href="\/blog\/tickets\/#DAN-\d+">DAN-\d+<\/a>/)
    // no plain <span class="tid">DAN-*</span> chip should remain unlinked
    expect(blog).not.toMatch(/<span class="tid">DAN-\d+<\/span>/)
    // the .tid rule still defines the chip treatment
    expect(blog).toMatch(/\.tid\s*\{[^}]*background:\s*var\(--chip-bg\)/)
  })
  it('linkified mono table cells keep the mono cell wrapper', () => {
    expect(blog).toMatch(/<td class="mono"><a href="\/blog\/tickets\/#DAN-\d+">DAN-\d+<\/a><\/td>/)
  })
})
