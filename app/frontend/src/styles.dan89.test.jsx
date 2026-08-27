import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// DAN-89: "Buttons revert to blue" — the revert of DAN-77 (PR #65).
//
// The criteria are about painted colour, so this suite does what the DAN-77
// suite did, inverted: render the real components to enumerate the buttons that
// actually exist, parse the real src/styles.css, resolve the cascade (including
// var() substitution, which jsdom's getComputedStyle does not do), and assert on
// the value the browser would paint — in every one of the five states.
//
// The resolver below is carried over from the DAN-77 tester suite this revert
// deletes; it was cross-checked against real Chrome computed styles there.

const CSS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css')
const CSS = fs.readFileSync(CSS_PATH, 'utf8')

/* -- a small, explicit CSS cascade resolver ---------------------------------- */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

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

function specificity(selector) {
  const b = (selector.match(/\.[\w-]+|:[\w-]+(\([^)]*\))?|\[[^\]]*\]/g) ?? [])
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
      // declaration is dropped at computed-value time and the element silently
      // falls back to inherit/initial. That is exactly the failure mode a naive
      // revert of PR #65 introduces, so surface it loudly.
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
  for (const rule of RULES) {
    const { selector } = rule
    if (selector === ':root') continue
    // Only the flat, single-compound selectors this sheet uses on buttons.
    const m = selector.match(/^([a-z]*)((?:\.[\w-]+)*)((?::[\w-]+(?:\([^)]*\))?)*)$/)
    if (!m) continue
    const [, el, classPart, pseudoPart] = m
    if (el && el !== element) continue
    const wanted = classPart.split('.').filter(Boolean)
    if (!wanted.every(has)) continue
    const pseudos = pseudoPart.match(/:[\w-]+(?:\([^)]*\))?/g) ?? []
    // :active implies :hover — you are pressing what you are over.
    const active = state === 'active' ? [':hover', ':active'] : state ? [`:${state}`] : []
    if (!pseudos.every((p) => active.includes(p))) continue
    if (rule.decls[prop] === undefined) continue
    const spec = specificity(selector)
    if (spec >= bestSpec) {
      best = rule.decls[prop]
      bestSpec = spec
    }
  }
  return best === null ? null : resolveVars(best)
}

/* -- colour maths ------------------------------------------------------------ */

const rgb = (hex) => {
  const h = hex.trim().replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

const isGreen = (hex) => {
  const [r, g, b] = rgb(hex)
  return g > r && g > b
}

const isBlue = (hex) => {
  const [r, g, b] = rgb(hex)
  return b > r && b > g
}

const HEX = /^#[0-9a-fA-F]{6}$/

const STATES = [null, 'hover', 'focus-visible', 'active', 'disabled']
const PAINT_PROPS = ['color', 'background', 'background-color', 'border-color', 'outline-color']

/* -- the buttons the app actually renders ------------------------------------ */

const authMock = vi.hoisted(() => ({ user: null }))
vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => {
    listener(authMock.user)
    return () => {}
  }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => null),
}))

vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(async () => ({
    id: 'fr1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z',
    messages: [],
    approvable: true,
  })),
  sendFeatureRequestMessage: vi.fn(),
  listFeatureRequests: vi.fn(async () => []),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(() => new Promise(() => {})),
  featureRequestCost: vi.fn(async () => undefined),
  featureRequestActivity: vi.fn(async () => []),
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
  const r = render(
    <AuthProvider>
      <AuthGate>
        <div />
      </AuthGate>
    </AuthProvider>,
  )
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
      records={[
        {
          id: 'r1',
          name: 'Alpha',
          status: 'active',
          amount: 1,
          notes: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]}
      onUpdate={async () => {}}
      onDelete={async () => {}}
    />,
  )
}

const PRIMARY = ['btn', 'btn--primary']

/* -- criterion: every button that was green is blue again -------------------- */

describe('DAN-89 · the primary button is blue again', () => {
  it('paints the blue accent — fill, border and label — with nothing left dangling', () => {
    expect(computed('background', { classes: PRIMARY })).toBe(ROOT['--color-accent'])
    expect(computed('border-color', { classes: PRIMARY })).toBe(ROOT['--color-accent'])
    expect(computed('color', { classes: PRIMARY })).toBe(ROOT['--color-on-accent'])

    expect(isBlue(ROOT['--color-accent'])).toBe(true)
    for (const prop of ['background', 'border-color', 'color']) {
      expect(computed(prop, { classes: PRIMARY })).not.toMatch(/UNRESOLVED/)
    }
  })

  it('fills blue in default, focus and disabled', () => {
    for (const state of [null, 'focus-visible', 'disabled']) {
      const fill = computed('background', { classes: PRIMARY, state })
      expect(fill, `background in ${state ?? 'default'}`).toBe(ROOT['--color-accent'])
      expect(isBlue(fill), `background in ${state ?? 'default'}`).toBe(true)
    }
  })

  it('hover and pressed keep the shared .btn:hover fill — pre-existing, not this ticket', () => {
    // `.btn:hover` is (0,2,0) and `.btn--primary` is (0,1,0), so while hovered
    // (and therefore also while pressed) the shared secondary fill wins and the
    // primary button goes near-white behind white text.
    //
    // This is NOT introduced by DAN-89. Verified in real Chrome against both the
    // pre-revert (green) and post-revert (blue) stylesheets: hover and
    // hover+active both resolved to rgb(246, 248, 250) in each. The ticket asks
    // for the pre-#65 treatment and this *is* the pre-#65 treatment, so fixing
    // it here would be out of scope. Pinned so the quirk is visible to the next
    // reader instead of being rediscovered. See the DAN-89 PR/issue comment.
    for (const state of ['hover', 'active']) {
      expect(computed('background', { classes: PRIMARY, state })).toBe(ROOT['--color-subtle'])
    }
    expect(isGreen(ROOT['--color-subtle'])).toBe(false)
  })

  it('is green in none of the five states', () => {
    for (const state of STATES) {
      const fill = computed('background', { classes: PRIMARY, state })
      expect(isGreen(fill), `background in ${state ?? 'default'} is ${fill}`).toBe(false)
    }
  })

  it('carries no green anywhere in its cascade, filters included', () => {
    // brightness()/hue-rotate() on a blue fill is still blue, but a hue-rotate
    // could smuggle green past the token assertions above, so pin the filters.
    for (const state of STATES) {
      for (const prop of [...PAINT_PROPS, 'filter']) {
        const v = computed(prop, { classes: PRIMARY, state })
        if (v === null) continue
        expect(v, `${prop} in ${state ?? 'default'}`).not.toMatch(/hue-rotate|invert|sepia/)
        for (const hex of v.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
          expect(isGreen(hex), `${prop} in ${state ?? 'default'} is ${hex}`).toBe(false)
        }
      }
    }
  })

  it('restores the pre-#65 treatment: no .btn--primary:active override', () => {
    // DAN-77 added it; the revert takes it back out, so pressed collapses into
    // hover exactly as it did before PR #65.
    const selectors = RULES.map((r) => r.selector)
    expect(selectors).not.toContain('.btn--primary:active')
  })
})

describe('DAN-89 · the DAN-77 tokens are gone, with no dangling references', () => {
  it('drops --color-primary / --color-on-primary and restores --color-on-accent', () => {
    expect(ROOT['--color-primary']).toBeUndefined()
    expect(ROOT['--color-on-primary']).toBeUndefined()
    expect(ROOT['--color-on-accent']).toBeDefined()
  })

  it('leaves no rule reading a token that no longer exists', () => {
    // The trap in this ticket: DAN-74 and DAN-84 started consuming
    // --color-primary after PR #65 shipped, so deleting the token without
    // touching them would silently drop their declarations.
    const dangling = []
    for (const rule of RULES) {
      if (rule.selector === ':root') continue
      for (const [prop, value] of Object.entries(rule.decls)) {
        if (!value.includes('var(')) continue
        const resolved = resolveVars(value)
        if (resolved.includes('UNRESOLVED')) dangling.push(`${rule.selector} { ${prop}: ${value} }`)
      }
    }
    expect(dangling).toEqual([])
  })
})

/* -- criterion: no button renders green, on any screen, in any state --------- */

describe('DAN-89 · no button renders green, anywhere', () => {
  it('every button the app renders resolves to a non-green paint in all five states', async () => {
    const seen = []
    for (const renderView of [renderAuthGate, renderFeatureRequest, renderRecordTable]) {
      const { container, unmount } = await renderView()
      seen.push(...buttonsOf(container))
      unmount()
    }
    expect(seen.length).toBeGreaterThan(0)

    for (const button of seen) {
      for (const state of STATES) {
        for (const prop of PAINT_PROPS) {
          const v = computed(prop, { classes: button.classes, state })
          if (v === null) continue
          expect(v, `${button.text}: ${prop} in ${state ?? 'default'}`).not.toMatch(/UNRESOLVED/)
          for (const hex of v.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
            expect(
              isGreen(hex),
              `button "${button.text}" ${prop} in ${state ?? 'default'} is ${hex}`,
            ).toBe(false)
          }
        }
      }
    }
  })

  it('no rule anywhere in the sheet paints a green on a button selector', () => {
    // Belt and braces for buttons behind views this suite does not mount: scan
    // every rule in the sheet, not just the ones the rendered markup matches.
    const offenders = []
    for (const rule of RULES) {
      if (rule.selector === ':root') continue
      const isButtonRule = /(^|[\s>+~])button\b/.test(rule.selector) || /\.btn\b/.test(rule.selector)
      if (!isButtonRule) continue
      for (const [prop, value] of Object.entries(rule.decls)) {
        for (const hex of resolveVars(value).match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
          if (isGreen(hex)) offenders.push(`${rule.selector} { ${prop}: ${hex} }`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

/* -- criterion: non-button elements are visually unchanged ------------------- */

describe('DAN-89 · non-button greens are untouched', () => {
  // These three render green and must keep doing so: two of them consumed
  // --color-primary, which this ticket deletes. They are <span>s — a status
  // chip, a build-state label and a timeline badge — not buttons.
  const green = (selector, prop) => {
    const rule = RULES.find((r) => r.selector === selector)
    expect(rule, `${selector} should still exist`).toBeDefined()
    const value = resolveVars(rule.decls[prop])
    expect(value, `${selector} { ${prop} }`).toMatch(HEX)
    expect(isGreen(value), `${selector} { ${prop}: ${value} }`).toBe(true)
    return value
  }

  it('.my-requests__status--building is still green', () => {
    expect(green('.my-requests__status--building', 'color')).toBe('#1a7f37')
  })

  it('.activity-event--pr .activity-event__badge is still green', () => {
    expect(green('.activity-event--pr .activity-event__badge', 'border-color')).toBe('#1a7f37')
  })

  it('.gates__state--pass and .dag-node__state--done are untouched', () => {
    expect(green('.gates__state--pass', 'color')).toBe('#1a7f37')
    expect(green('.dag-node__state--done', 'color')).toBe('#15803d')
  })

  it('links and the focus ring keep the accent blue they always had', () => {
    expect(ROOT['--color-accent']).toBe('#0969da')
    expect(ROOT['--focus-ring']).toContain('9, 105, 218')
  })
})

/* -- criterion: nothing but colour moved ------------------------------------- */

describe('DAN-89 · button geometry and behaviour are unchanged', () => {
  it('.btn keeps its size, spacing and radius', () => {
    const btn = RULES.find((r) => r.selector === '.btn')
    expect(btn).toBeDefined()
    expect(btn.decls['border-radius']).toBe('var(--radius)')
    expect(btn.decls.padding).toBeDefined()
    // .btn--primary is colour-only: it must not carry geometry of its own.
    const primary = RULES.filter((r) => r.selector.startsWith('.btn--primary'))
    for (const rule of primary) {
      for (const prop of Object.keys(rule.decls)) {
        expect(
          ['color', 'background', 'background-color', 'border-color', 'filter'],
          `${rule.selector} { ${prop} }`,
        ).toContain(prop)
      }
    }
  })

  it('the same four call-to-action buttons exist, with the same labels', async () => {
    const labels = []
    for (const renderView of [renderAuthGate, renderFeatureRequest]) {
      const { container, unmount } = await renderView()
      labels.push(
        ...buttonsOf(container)
          .filter((b) => b.classes.includes('btn--primary'))
          .map((b) => b.text),
      )
      unmount()
    }
    expect(labels).toContain('Sign in with Google')
    expect(labels).toContain('Send')
  })
})
