import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// DAN-77 tester suite: "Change blue buttons to green".
//
// The acceptance criteria are about what the user sees, so this suite ties the
// two halves of that together:
//
//   1. the real components are rendered, and every <button> they emit is
//      enumerated — so the suite knows which buttons actually exist and which
//      class each one carries, rather than trusting a list in a comment;
//   2. the real src/styles.css is parsed and its cascade resolved (specificity
//      included, custom properties substituted) for those exact classes — so
//      the assertions are about the fill the browser will paint, not about the
//      presence of a string in a file.
//
// jsdom's getComputedStyle does not substitute var(), which is the whole
// mechanism this ticket changed, so the resolver below is deliberate rather
// than incidental. It was cross-checked against a real Chrome run (CDP
// forcePseudoState over the same rendered markup) while this ticket was being
// verified; every value asserted here matched Chrome's computed style.

const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf8',
)

/* -- a small, explicit CSS cascade resolver ---------------------------------- */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

// Every rule in the sheet, in source order, as { selector, decls }.
function parseRules(css) {
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(stripComments(css)))) {
    const decls = {}
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':')
      if (i === -1) continue
      decls[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    for (const selector of m[1].split(',')) {
      const s = selector.trim()
      if (s) rules.push({ selector: s, decls })
    }
  }
  return rules
}

const RULES = parseRules(CSS)

// (classes+pseudo-classes+attributes, elements+pseudo-elements). No ids in this
// sheet; the resolver asserts that rather than pretending to handle them.
function specificity(selector) {
  expect(selector).not.toMatch(/#/)
  const b = (selector.match(/\.[\w-]+|:[\w-]+(\([^)]*\))?|\[[^\]]*\]/g) ?? [])
    // ::before and friends count as elements, not classes.
    .filter((t) => !t.startsWith('::')).length
  const c = (selector.replace(/\.[\w-]+|:[\w-]+(\([^)]*\))?|\[[^\]]*\]/g, '')
    .match(/[a-z]+/g) ?? []).length
  return b * 10 + c
}

const ROOT = Object.assign(
  {},
  ...RULES.filter((r) => r.selector === ':root').map((r) => r.decls),
)

function resolveVars(value) {
  let out = value
  for (let i = 0; i < 5 && out.includes('var('); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fallback) => {
      const v = ROOT[name]
      if (v !== undefined && v !== '') return v
      // A var() with no definition and no fallback is a dangling reference: the
      // declaration would be dropped at computed-value time. Surface it loudly
      // instead of silently resolving to something plausible.
      if (fallback === undefined) return `UNRESOLVED(${name})`
      return fallback
    })
  }
  return out.trim()
}

// The winning declaration for `prop` on an element with `classes`, in `state`.
function computed(prop, { classes, state = null, element = 'button' }) {
  const has = (c) => classes.includes(c)
  let best = null
  let bestSpec = -1
  RULES.forEach((rule, order) => {
    const { selector } = rule
    if (selector === ':root') return
    // Only the flat, single-compound selectors this sheet uses on buttons.
    const m = selector.match(/^([a-z]*)((?:\.[\w-]+)*)((?::[\w-]+(?:\([^)]*\))?)*)$/)
    if (!m) return
    const [, el, classPart, pseudoPart] = m
    if (el && el !== element) return
    const wanted = classPart.split('.').filter(Boolean)
    if (!wanted.every(has)) return
    const pseudos = pseudoPart.match(/:[\w-]+(?:\([^)]*\))?/g) ?? []
    // A rule applies in `state` if all of its pseudo-classes are satisfied.
    // :active implies :hover (you are pressing what you are over).
    const active = state === 'active' ? [':hover', ':active'] : state ? [`:${state}`] : []
    if (!pseudos.every((p) => active.includes(p))) return
    if (rule.decls[prop] === undefined) return
    const spec = specificity(selector)
    if (spec > bestSpec || (spec === bestSpec && order >= 0)) {
      if (spec >= bestSpec) { best = rule.decls[prop]; bestSpec = spec }
    }
  })
  return best === null ? null : resolveVars(best)
}

/* -- colour maths ------------------------------------------------------------ */

const rgb = (hex) => {
  const h = hex.trim().replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// CSS filter: brightness() scales sRGB channels.
const brightness = (hex, k) =>
  '#' + rgb(hex).map((c) => Math.round(Math.min(255, c * k)).toString(16).padStart(2, '0')).join('')

const isGreen = (hex) => {
  const [r, g, b] = rgb(hex)
  return g > r && g > b
}
const isBlue = (hex) => {
  const [r, g, b] = rgb(hex)
  return b > r && b > g
}

/* -- the buttons the app actually renders ------------------------------------ */

const authMock = vi.hoisted(() => ({ user: null }))
vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => { listener(authMock.user); return () => {} }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => null),
}))
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(async () => ({
    id: 'fr1', status: 'open', model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z', messages: [], approvable: true,
  })),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(() => new Promise(() => {})),
  listRecords: vi.fn(async () => []),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
}))

const buttonsOf = (container) =>
  [...container.querySelectorAll('button')].map((b) => ({
    text: b.textContent.trim(),
    classes: b.className.split(/\s+/).filter(Boolean),
  }))

async function renderAuthGate() {
  const { AuthProvider } = await import('./AuthContext.jsx')
  const AuthGate = (await import('./AuthGate.jsx')).default
  const r = render(<AuthProvider><AuthGate><div /></AuthGate></AuthProvider>)
  await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument())
  return r
}

async function renderFeatureRequest() {
  const FRV = (await import('./FeatureRequestView.jsx')).default
  const r = render(<FRV onBack={() => {}} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument())
  return r
}

async function renderRecordTable() {
  const RecordTable = (await import('./RecordTable.jsx')).default
  return render(
    <RecordTable
      records={[{ id: 'r1', name: 'Alpha', value: 1, createdAt: '2026-01-01T00:00:00.000Z' }]}
      onUpdate={async () => {}}
      onDelete={async () => {}}
    />,
  )
}

const PRIMARY = ['btn', 'btn--primary']

/* -- criterion 1: the blue call-to-action buttons are green ------------------ */

describe('DAN-77 · criterion 1 — buttons that were blue are green', () => {
  it('the primary-button fill token is a green, and no longer the blue accent', () => {
    expect(ROOT['--color-primary']).toBeDefined()
    expect(isGreen(ROOT['--color-primary'])).toBe(true)
    expect(isBlue(ROOT['--color-primary'])).toBe(false)
  })

  it('.btn--primary paints that green — fill, border and label all resolve', () => {
    expect(computed('background', { classes: PRIMARY })).toBe(ROOT['--color-primary'])
    expect(computed('border-color', { classes: PRIMARY })).toBe(ROOT['--color-primary'])
    expect(computed('color', { classes: PRIMARY })).toBe(ROOT['--color-on-primary'])
    for (const prop of ['background', 'border-color', 'color']) {
      expect(computed(prop, { classes: PRIMARY })).not.toMatch(/UNRESOLVED/)
    }
  })

  it('no primary declaration still points at the removed --color-on-accent token', () => {
    // The ticket's change deletes --color-on-accent; a leftover var() reference
    // to it would drop the declaration and give the button a transparent label.
    expect(ROOT['--color-on-accent']).toBeUndefined()
    expect(stripComments(CSS)).not.toContain('--color-on-accent')
  })

  it('every call-to-action the app renders goes through that one class', async () => {
    const seen = []
    for (const renderScreen of [renderAuthGate, renderFeatureRequest]) {
      const { container, unmount } = await renderScreen()
      seen.push(...buttonsOf(container).filter((b) => b.classes.includes('btn--primary')))
      unmount()
    }
    const NewRecordForm = (await import('./NewRecordForm.jsx')).default
    const { container } = render(<NewRecordForm onCreate={async () => {}} />)
    seen.push(...buttonsOf(container).filter((b) => b.classes.includes('btn--primary')))

    expect(seen.map((b) => b.text).sort()).toEqual(
      ['Add', 'Approve plan', 'Send', 'Sign in with Google'],
    )
    // Every one of them is .btn .btn--primary — none re-styles itself locally.
    for (const b of seen) expect(b.classes.sort()).toEqual(PRIMARY)
  })
})

/* -- criteria 2 & 5: everything else is untouched ---------------------------- */

describe('DAN-77 · criteria 2 & 5 — secondary, destructive and non-blue buttons unchanged', () => {
  it('the secondary .btn keeps its white-on-border treatment', () => {
    expect(computed('background', { classes: ['btn'] })).toBe(ROOT['--color-surface'])
    expect(computed('color', { classes: ['btn'] })).toBe(ROOT['--color-text'])
    expect(computed('border', { classes: ['btn'] })).toBe(`1px solid ${ROOT['--color-border']}`)
    // The secondary button must not have picked up the new fill.
    expect(computed('background', { classes: ['btn'] })).not.toBe(ROOT['--color-primary'])
  })

  it('the danger colour is untouched', () => {
    expect(ROOT['--color-danger']).toBe('#cf222e')
  })

  it('the destructive and inline row controls stay unstyled browser defaults', async () => {
    const { container } = await renderRecordTable()
    const named = (t) => buttonsOf(container).find((b) => b.text === t)
    for (const label of ['Edit', 'Delete']) {
      expect(named(label)).toBeDefined()
      // No class at all: nothing in styles.css can have recoloured them.
      expect(named(label).classes).toEqual([])
    }
    // The sort headers are the app's other non-blue buttons.
    const sorters = buttonsOf(container).filter((b) => b.classes.includes('sort-button'))
    expect(sorters.length).toBeGreaterThan(0)
    for (const s of sorters) {
      expect(computed('background', { classes: s.classes })).toBe('none')
      expect(computed('color', { classes: s.classes })).toBe('inherit')
    }
  })

  it('the blue accent survives for the things that are not buttons', () => {
    // Links, the focus ring and the informational panel borders are the other
    // users of --color-accent; this ticket must not have moved them.
    expect(ROOT['--color-accent']).toBe('#0969da')
    expect(isBlue(ROOT['--color-accent'])).toBe(true)
    expect(computed('color', { classes: [], element: 'a' })).toBe(ROOT['--color-accent'])
  })
})

/* -- criterion 3: readable text ---------------------------------------------- */

describe('DAN-77 · criterion 3 — green buttons have readable text', () => {
  it('the label clears WCAG AA (4.5:1) against the green fill', () => {
    const ratio = contrast(ROOT['--color-on-primary'], ROOT['--color-primary'])
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('readability is not a regression on the blue it replaced', () => {
    const green = contrast(ROOT['--color-on-primary'], ROOT['--color-primary'])
    const blueBefore = contrast('#ffffff', '#0969da')
    // Within a tenth of a point of the fill it replaced.
    expect(green).toBeGreaterThan(blueBefore - 0.2)
  })

  it('the green fill is distinguishable from the page and from the danger colour', () => {
    expect(contrast(ROOT['--color-primary'], ROOT['--color-surface'])).toBeGreaterThan(3)
    expect(ROOT['--color-primary']).not.toBe(ROOT['--color-danger'])
  })
})

/* -- criterion 4: states stay distinguishable -------------------------------- */

describe('DAN-77 · criterion 4 — hover, pressed, focus and disabled stay distinct', () => {
  it('hover and pressed resolve to different filters, so they do not collapse', () => {
    const hover = computed('filter', { classes: PRIMARY, state: 'hover' })
    const active = computed('filter', { classes: PRIMARY, state: 'active' })
    expect(hover).toMatch(/^brightness\(/)
    expect(active).toMatch(/^brightness\(/)
    expect(active).not.toBe(hover)
    const k = (f) => Number(f.match(/brightness\(([\d.]+)\)/)[1])
    // Pressed is the darker of the two, and by a visible margin.
    expect(k(active)).toBeLessThan(k(hover) - 0.02)
  })

  it('the pressed fill is a visibly different colour from the resting fill', () => {
    const k = Number(
      computed('filter', { classes: PRIMARY, state: 'active' })
        .match(/brightness\(([\d.]+)\)/)[1],
    )
    const pressed = brightness(ROOT['--color-primary'], k)
    expect(pressed).not.toBe(ROOT['--color-primary'])
    expect(contrast(pressed, ROOT['--color-primary'])).toBeGreaterThan(1.1)
  })

  it('disabled dims the button and is not confusable with the resting state', () => {
    const opacity = computed('opacity', { classes: PRIMARY, state: 'disabled' })
    expect(Number(opacity)).toBeGreaterThan(0)
    expect(Number(opacity)).toBeLessThan(1)
    expect(computed('cursor', { classes: PRIMARY, state: 'disabled' })).toBe('default')
  })

  it('keyboard focus still draws a ring, in the accent blue, outside the fill', () => {
    const state = 'focus-visible'
    expect(computed('outline', { classes: PRIMARY, state })).toBe(`2px solid ${ROOT['--color-accent']}`)
    expect(computed('outline-offset', { classes: PRIMARY, state })).toBe('2px')
    expect(computed('box-shadow', { classes: PRIMARY, state })).toBe(ROOT['--focus-ring'])
    // Drawn on the page background, so it reads against the new green as it did
    // against the old blue.
    expect(contrast(ROOT['--color-accent'], ROOT['--color-surface'])).toBeGreaterThan(3)
  })

  it('the ring stays offset, which is the only reason blue-on-green works', () => {
    // The accent blue and the new green are within a hair of the same
    // luminance (~1.02:1), so a ring drawn flush against the fill would be
    // close to invisible. What saves it is outline-offset: the ring lands on
    // the page background, where it measures ~5.2:1. That makes the offset
    // load-bearing rather than cosmetic, so pin it.
    expect(contrast(ROOT['--color-accent'], ROOT['--color-primary'])).toBeLessThan(1.5)
    const offset = computed('outline-offset', { classes: PRIMARY, state: 'focus-visible' })
    expect(Number.parseFloat(offset)).toBeGreaterThan(0)
    expect(contrast(ROOT['--color-accent'], ROOT['--color-surface'])).toBeGreaterThan(4.5)
  })
})
