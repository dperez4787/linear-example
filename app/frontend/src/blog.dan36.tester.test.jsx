// DAN-36 tester lock — verifies the byte-for-byte v5 replacement of part 1 at
// public/blog/agentic-sdlc/index.html and the single inserted "empowerment" paragraph,
// against the ticket's acceptance criteria. These are the tester agent's own checks,
// added on top of the developer's work; they do not modify product source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const part1Path = resolve(process.cwd(), 'public/blog/agentic-sdlc/index.html')
const part1Bytes = readFileSync(part1Path)
const part1 = part1Bytes.toString('utf8')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// The canonical v5 digest from the ticket (verified against the fetched Linear attachment).
const PART1_V5_SHA = 'd9e6ea8a712eb616b4623cf0aab74a724e038389a6745cb3a00272a76777dcd7'
// The pre-DAN-36 (v4 + DAN-31 linkification) digest the v5 file replaces.
const PART1_V4_SHA = 'bddf9fcde6c439f8377c9ccd735a215a978b4dfea8e1571ddad40562cc788c23'

describe('DAN-36 · C1 the shipped part-1 file is the canonical v5 attachment, byte-for-byte', () => {
  it('public/blog/agentic-sdlc/index.html sha256 is the v5 digest', () => {
    expect(sha256(part1Bytes)).toBe(PART1_V5_SHA)
  })
  it('is 933055 bytes', () => {
    expect(part1Bytes.length).toBe(933055)
  })
  it('is no longer the pre-revision v4 document', () => {
    expect(sha256(part1Bytes)).not.toBe(PART1_V4_SHA)
  })
})

describe('DAN-36 · C2 the empowerment aim is stated exactly once, inside "Initial goals"', () => {
  it('contains exactly one occurrence of the literal empowerment phrase', () => {
    const matches = part1.match(/empower product owners and designers/g) ?? []
    expect(matches.length).toBe(1)
  })
  it('the empowerment paragraph immediately follows the "All four were met…" paragraph, still inside the Initial goals section', () => {
    const goalsIdx = part1.indexOf('<h2>Initial goals</h2>')
    const allFourIdx = part1.indexOf('All four were met.')
    const empowerIdx = part1.indexOf('One aim underlies all four goals and deserves to be stated explicitly')
    expect(goalsIdx).toBeGreaterThan(-1)
    // ordering: heading, then "All four were met", then the empowerment paragraph
    expect(allFourIdx).toBeGreaterThan(goalsIdx)
    expect(empowerIdx).toBeGreaterThan(allFourIdx)
    // the empowerment paragraph is the very next <p> after the "All four were met" one
    const between = part1.slice(allFourIdx, empowerIdx)
    expect(between).not.toContain('<h2>')
    expect(between.match(/<p>/g) ?? []).toHaveLength(1) // only the opening tag of the empower <p>
  })
  it('states the empowerment aim as a bold lead sentence', () => {
    expect(part1).toContain(
      '<strong>One aim underlies all four goals and deserves to be stated explicitly: the point of this formality is to empower product owners and designers.</strong>',
    )
  })
})

describe('DAN-36 · C3 DAN-31 lineage and prior invariants survive the wholesale replacement', () => {
  it('preserves the part-1 title', () => {
    expect(part1).toContain('<title>An Agentic SDLC, End to End</title>')
  })
  it('preserves all 41 /blog/tickets/#DAN-n deep links', () => {
    const links = part1.match(/href="\/blog\/tickets\/#DAN-\d+"/g) ?? []
    expect(links).toHaveLength(41)
  })
  it('preserves the completed $16.10 cost appendix', () => {
    expect(part1).toContain('16.10')
  })
  it('preserves all three embedded JPEG screenshots', () => {
    const shots = part1.match(/data:image\/jpeg/g) ?? []
    expect(shots).toHaveLength(3)
  })
  it('preserves the PR #29 and #30 anchors', () => {
    expect(part1).toMatch(/pull\/29\b/)
    expect(part1).toMatch(/pull\/30\b/)
  })
})
