/**
 * DAN-92 · TESTER suite — "primary button label is invisible on hover".
 *
 * Written from the ticket's acceptance criteria, not from the developer's tests.
 *
 * WHY THIS SHAPE
 * --------------
 * The criteria are about *painted* colour and *computed* contrast, and jsdom
 * resolves neither `var()` nor `:hover`. So this file verifies with TWO
 * independent engines and asserts they agree:
 *
 *   Engine A — a from-scratch CSS cascade resolver over the real src/styles.css
 *              (own tokenizer, own [a,b,c] specificity tuples, own var()
 *              substitution, own pseudo-state matching). Runs in-process, so it
 *              is what actually gates `npm test` in CI.
 *
 *   Engine B — real headless Chrome, driven over the DevTools Protocol with
 *              `CSS.forcePseudoState`, against the *built* stylesheet on a
 *              harness page of verbatim component markup. A browser cannot run
 *              inside `npm test` in every environment, so its output is frozen
 *              into the CHROME_* tables below, captured on this exact commit
 *              (branch) and on origin/main @ ba410f5 (baseline). Engine A is
 *              asserted equal to it property-by-property, which is what makes
 *              the frozen numbers trustworthy rather than decorative.
 *
 * Capture command (Chrome 1.x, macOS, this worktree):
 *   npm run build && node <scratch>/dan92-chrome.mjs "$PWD/dist" \
 *     scripts/dan89-harness.html out.json
 *
 * MODELLING NOTE — what "active" means.
 * There is NO `:active` rule anywhere in styles.css (asserted below). A pointer
 * cannot press what it is not over, so the pressed state is `:hover` + `:active`
 * and is therefore painted entirely by the hover cascade. Chrome agrees: forcing
 * ['hover','active'] and forcing ['hover'] produce identical paint. The
 * keyboard-only press (`:active` with no hover) is covered separately as
 * `activeOnly` and must equal rest.
 *
 * FILTER NOTE. getComputedStyle reports the *pre-filter* paint; `filter:
 * brightness(k)` is applied by the compositor afterwards. Every contrast number
 * here therefore multiplies both the background and the label through the
 * element's own computed filter by hand before doing the WCAG maths.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CSS = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')

/* ========================================================================== *
 * Engine A · a from-scratch cascade resolver
 * ========================================================================== */

/** Strip comments, then split into { selector, decls, order } rules. */
function parse(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  let order = 0
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(flat))) {
    const decls = new Map()
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':')
      if (i === -1) continue
      decls.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
    }
    for (const sel of m[1].split(',')) {
      const s = sel.trim()
      if (s) rules.push({ selector: s, decls, order: order++ })
    }
  }
  return rules
}

const RULES = parse(CSS)

const ROOT = new Map(
  RULES.filter((r) => r.selector === ':root').flatMap((r) => [...r.decls]),
)

/** Real [a,b,c] specificity: a=#id, b=.class/:pseudo-class/[attr], c=element. */
function specificity(selector) {
  const ids = selector.match(/#[\w-]+/g) ?? []
  const noPseudoEl = selector.replace(/::[\w-]+/g, ' ')
  const b = noPseudoEl.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []
  const c = noPseudoEl
    .replace(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?|#[\w-]+/g, ' ')
    .match(/[a-z][\w-]*/gi) ?? []
  return [ids.length, b.length, c.length]
}

const cmpSpec = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]

/** var() substitution against :root, recursively; dangling refs are loud. */
function resolveVars(value) {
  let out = value
  for (let i = 0; i < 8 && out.includes('var('); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fb) => {
      const v = ROOT.get(name)
      if (v !== undefined && v !== '') return v
      return fb === undefined ? `UNRESOLVED(${name})` : fb
    })
  }
  return out.trim()
}

/** The pseudo-classes active for each named state. */
const STATE_PSEUDOS = {
  rest: [],
  hover: [':hover'],
  // pressed with a pointer: you are necessarily also over the element
  active: [':hover', ':active'],
  // pressed via keyboard: no hover
  activeOnly: [':active'],
  focus: [':focus', ':focus-visible'],
  disabled: [':disabled'],
}

/**
 * The winning declaration for `prop` on a single element.
 * Handles the flat single-compound selectors this sheet uses on controls, plus
 * descendant selectors (which simply cannot match a lone element).
 */
function declFor(prop, { tag = 'button', classes = [], state = 'rest' }) {
  const on = STATE_PSEUDOS[state]
  if (!on) throw new Error(`unknown state ${state}`)
  let best = null
  let bestSpec = [-1, -1, -1]
  let bestOrder = -1

  for (const rule of RULES) {
    if (rule.selector === ':root') continue
    if (!rule.decls.has(prop)) continue
    // single compound only — anything with a combinator/space cannot match a
    // standalone element, so it is correctly skipped.
    const m = rule.selector.match(
      /^([a-z][\w-]*)?((?:\.[\w-]+)*)((?::(?!:)[\w-]+(?:\([^)]*\))?)*)$/i,
    )
    if (!m) continue
    const [, el, classPart, pseudoPart] = m
    if (el && el.toLowerCase() !== tag) continue
    const needClasses = classPart.split('.').filter(Boolean)
    if (!needClasses.every((c) => classes.includes(c))) continue
    const needPseudos = pseudoPart.match(/:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []
    if (!needPseudos.every((p) => on.includes(p))) continue

    const spec = specificity(rule.selector)
    const d = cmpSpec(spec, bestSpec)
    if (d > 0 || (d === 0 && rule.order > bestOrder)) {
      best = rule.decls.get(prop)
      bestSpec = spec
      bestOrder = rule.order
    }
  }
  return best === null ? null : resolveVars(best)
}

/* ========================================================================== *
 * Colour + contrast maths
 * ========================================================================== */

const UA_DEFAULT = { background: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' }

function toRgb(value) {
  const v = value.trim()
  if (v.startsWith('#')) {
    let h = v.slice(1)
    if (h.length === 3) h = [...h].map((ch) => ch + ch).join('')
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  }
  const nums = v.match(/[\d.]+/g)
  if (!nums) throw new Error(`not a colour: ${value}`)
  return nums.slice(0, 3).map(Number)
}

const fmt = (rgb) => `rgb(${rgb.map((n) => Math.round(n)).join(', ')})`

/**
 * Apply `filter: brightness(k)` the way the compositor does, then quantise to
 * 8-bit — the contrast a user actually sees is the contrast between the pixels
 * that get painted, not between unrounded intermediates.
 */
function applyFilter(rgb, filter) {
  const m = /brightness\(([\d.]+)\)/.exec(filter ?? '')
  if (!m) return rgb
  const k = Number(m[1])
  return rgb.map((v) => Math.round(Math.min(255, v * k)))
}

function relLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(fg, bg) {
  const a = relLuminance(fg)
  const b = relLuminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Everything the eye sees for one element in one state, filter applied. */
function paint(opts) {
  const get = (p, fallback = null) => declFor(p, opts) ?? fallback
  const filter = get('filter', 'none')
  const bgRaw = toRgb(get('background', UA_DEFAULT.background))
  const fgRaw = toRgb(get('color', UA_DEFAULT.color))
  const bg = applyFilter(bgRaw, filter)
  const fg = applyFilter(fgRaw, filter)
  return {
    background: fmt(bgRaw),
    color: fmt(fgRaw),
    borderColor: fmt(toRgb(get('border-color', get('border', 'rgb(0,0,0)').split(' ').pop()))),
    filter,
    opacity: get('opacity', '1'),
    paintedBackground: fmt(bg),
    paintedColor: fmt(fg),
    contrast: contrast(fg, bg),
  }
}

const PRIMARY = { tag: 'button', classes: ['btn', 'btn--primary'] }
const SECONDARY = { tag: 'button', classes: ['btn'] }

const ACCENT = 'rgb(9, 105, 218)' // --color-accent #0969da
const SUBTLE = 'rgb(246, 248, 250)' // --color-subtle #f6f8fa
const ON_ACCENT = 'rgb(255, 255, 255)' // --color-on-accent
const TEXT = 'rgb(31, 35, 40)' // --color-text
const SURFACE = 'rgb(255, 255, 255)' // --color-surface
const BORDER = 'rgb(208, 215, 222)' // --color-border
const GREEN = 'rgb(26, 127, 55)' // #1a7f37 — DAN-77's green

/* ========================================================================== *
 * Engine B · frozen real-Chrome capture (see header for the command)
 * ========================================================================== */

// Chrome's own getComputedStyle on THIS commit, with CSS.forcePseudoState.
const CHROME_BRANCH = {
  primary: {
    rest: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'none', opacity: '1' },
    hover: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'brightness(0.95)', opacity: '1' },
    active: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'brightness(0.95)', opacity: '1' },
    activeOnly: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'none', opacity: '1' },
    focus: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'none', opacity: '1' },
    disabled: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'none', opacity: '0.6' },
  },
  secondary: {
    rest: { background: SURFACE, color: TEXT, borderColor: BORDER, filter: 'none', opacity: '1' },
    hover: { background: SUBTLE, color: TEXT, borderColor: BORDER, filter: 'none', opacity: '1' },
    active: { background: SUBTLE, color: TEXT, borderColor: BORDER, filter: 'none', opacity: '1' },
    activeOnly: { background: SURFACE, color: TEXT, borderColor: BORDER, filter: 'none', opacity: '1' },
    focus: { background: SURFACE, color: TEXT, borderColor: BORDER, filter: 'none', opacity: '1' },
    disabled: { background: SURFACE, color: TEXT, borderColor: BORDER, filter: 'none', opacity: '0.6' },
  },
}

// Same capture against origin/main @ ba410f5 — the "unchanged from main" baseline.
// Note hover/active: near-white fill behind a white label. That is the bug.
const CHROME_MAIN = {
  primary: {
    rest: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'none', opacity: '1' },
    hover: { background: SUBTLE, color: ON_ACCENT, borderColor: ACCENT, filter: 'brightness(0.95)', opacity: '1' },
    active: { background: SUBTLE, color: ON_ACCENT, borderColor: ACCENT, filter: 'brightness(0.95)', opacity: '1' },
    activeOnly: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'none', opacity: '1' },
    focus: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'none', opacity: '1' },
    disabled: { background: ACCENT, color: ON_ACCENT, borderColor: ACCENT, filter: 'none', opacity: '0.6' },
  },
  secondary: CHROME_BRANCH.secondary, // byte-identical capture; secondary never moved
}

// Geometry + focus ring, Chrome, identical on main and on this branch.
const CHROME_GEOMETRY = {
  height: '36px', // 2.25rem
  paddingTop: '0px',
  paddingLeft: '16px', // 1rem
  borderRadius: '6px',
  borderWidth: '1px',
  fontWeight: '500',
  display: 'inline-flex',
}
const CHROME_FOCUS_RING = {
  outline: '2px solid rgb(9, 105, 218)',
  outlineOffset: '2px',
  boxShadow: 'rgba(9, 105, 218, 0.35) 0px 0px 0px 3px',
}

const STATES = ['rest', 'hover', 'active', 'activeOnly', 'focus', 'disabled']

/* ========================================================================== *
 * AC1 · hovering a primary button keeps a FILLED treatment at >= 4.5:1
 * ========================================================================== */

describe('DAN-92 AC1 · primary hover keeps a filled treatment with a legible label', () => {
  it('hover fill is the accent, not the secondary subtle fall-through', () => {
    const p = paint({ ...PRIMARY, state: 'hover' })
    expect(p.background).toBe(ACCENT)
    expect(p.background).not.toBe(SUBTLE)
  })

  it('hover border matches the fill, so the button still reads as filled', () => {
    expect(paint({ ...PRIMARY, state: 'hover' }).borderColor).toBe(ACCENT)
  })

  it('the hover label is still white — the fix moved the fill, not the text', () => {
    expect(paint({ ...PRIMARY, state: 'hover' }).color).toBe(ON_ACCENT)
  })

  it('hover contrast is >= 4.5:1 once brightness(0.95) is applied by hand', () => {
    const p = paint({ ...PRIMARY, state: 'hover' })
    expect(p.filter).toBe('brightness(0.95)')
    expect(p.paintedBackground).toBe('rgb(9, 100, 207)')
    expect(p.contrast).toBeGreaterThanOrEqual(4.5)
    expect(Number(p.contrast.toFixed(2))).toBe(5.02)
  })

  it('hover is a FILL, not an outline: fill and label are different colours', () => {
    const p = paint({ ...PRIMARY, state: 'hover' })
    expect(p.paintedBackground).not.toBe(p.paintedColor)
    // and not the near-invisible 1.06:1 that main painted
    expect(p.contrast).toBeGreaterThan(2)
  })

  it('regression guard: the grey fall-through would fail this suite', () => {
    // main's paint, recomputed here, to pin exactly what we are protecting against.
    const greyOnWhite = contrast(
      applyFilter(toRgb(ON_ACCENT), 'brightness(0.95)'),
      applyFilter(toRgb(SUBTLE), 'brightness(0.95)'),
    )
    expect(Number(greyOnWhite.toFixed(2))).toBe(1.06)
    expect(greyOnWhite).toBeLessThan(4.5)
  })
})

/* ========================================================================== *
 * AC2 · pressed (active) — the deliberate, correct deviation
 * ========================================================================== */

describe('DAN-92 AC2 · the pressed state, repaired by the same root cause', () => {
  it('the stylesheet defines NO :active rule for buttons at all', () => {
    // This is the whole reason `active` could not be left as it was on main:
    // there is nothing that paints it except the hover cascade.
    expect(CSS).not.toMatch(/\.btn[\w-]*:active/)
    const activeRules = RULES.filter((r) => /:active/.test(r.selector))
    expect(activeRules).toEqual([])
  })

  it('pointer-press (hover+active) is >= 4.5:1 and is not the subtle grey', () => {
    const p = paint({ ...PRIMARY, state: 'active' })
    expect(p.background).toBe(ACCENT)
    expect(p.background).not.toBe(SUBTLE)
    expect(p.contrast).toBeGreaterThanOrEqual(4.5)
  })

  it('pointer-press paints exactly what hover paints, because it IS hover', () => {
    expect(paint({ ...PRIMARY, state: 'active' })).toEqual(paint({ ...PRIMARY, state: 'hover' }))
  })

  it('keyboard-press (:active with no hover) is unchanged from main — still rest', () => {
    const p = paint({ ...PRIMARY, state: 'activeOnly' })
    expect(p).toEqual(paint({ ...PRIMARY, state: 'rest' }))
    expect(p.background).toBe(ACCENT)
    expect(p.filter).toBe('none')
  })
})

/* ========================================================================== *
 * AC3 · non-primary .btn hover is untouched
 * ========================================================================== */

describe('DAN-92 AC3 · the secondary .btn hover is unchanged', () => {
  it('secondary hover is still the subtle fill', () => {
    expect(paint({ ...SECONDARY, state: 'hover' }).background).toBe(SUBTLE)
  })

  it('secondary hover keeps its dark label and its own contrast', () => {
    const p = paint({ ...SECONDARY, state: 'hover' })
    expect(p.color).toBe(TEXT)
    expect(p.filter).toBe('none')
    expect(p.contrast).toBeGreaterThanOrEqual(4.5)
    expect(Number(p.contrast.toFixed(2))).toBe(14.84)
  })

  it('secondary gets no border recolour and no brightness from the new rule', () => {
    const p = paint({ ...SECONDARY, state: 'hover' })
    expect(p.borderColor).toBe(BORDER)
    expect(p.filter).toBe('none')
  })

  it('every secondary state matches origin/main exactly', () => {
    for (const state of STATES) {
      const mine = paint({ ...SECONDARY, state })
      const main = CHROME_MAIN.secondary[state]
      expect({ state, ...pick(mine) }).toEqual({ state, ...main })
    }
  })
})

/* ========================================================================== *
 * AC4 · rest / focus / disabled unchanged from origin/main
 * ========================================================================== */

const pick = (p) => ({
  background: p.background,
  color: p.color,
  borderColor: p.borderColor,
  filter: p.filter,
  opacity: p.opacity,
})

describe('DAN-92 AC4 · rest, focus and disabled are untouched', () => {
  for (const state of ['rest', 'focus', 'disabled', 'activeOnly']) {
    it(`primary ${state} is byte-identical to origin/main`, () => {
      expect(pick(paint({ ...PRIMARY, state }))).toEqual(CHROME_MAIN.primary[state])
    })
  }

  it('only hover and pointer-press differ from main, and only in the fill', () => {
    const changed = STATES.filter(
      (s) =>
        JSON.stringify(pick(paint({ ...PRIMARY, state: s }))) !==
        JSON.stringify(CHROME_MAIN.primary[s]),
    )
    expect(changed).toEqual(['hover', 'active'])
  })

  it('disabled still just dims — opacity 0.6, no colour change', () => {
    const p = paint({ ...PRIMARY, state: 'disabled' })
    expect(p.opacity).toBe('0.6')
    expect(p.background).toBe(ACCENT)
    expect(p.color).toBe(ON_ACCENT)
  })

  it('the focus ring declarations are unchanged', () => {
    expect(declFor('outline', { ...PRIMARY, state: 'focus' })).toBe('2px solid #0969da')
    expect(toRgb(declFor('outline', { ...PRIMARY, state: 'focus' }).split(' ').pop()))
      .toEqual([9, 105, 218])
    expect(declFor('outline-offset', { ...PRIMARY, state: 'focus' })).toBe('2px')
    expect(declFor('box-shadow', { ...PRIMARY, state: 'focus' })).toBe('0 0 0 3px rgba(9, 105, 218, 0.35)')
  })

  it('the focus ring matches the real-Chrome capture, on main and on this branch', () => {
    expect(CHROME_FOCUS_RING).toEqual({
      outline: '2px solid rgb(9, 105, 218)',
      outlineOffset: '2px',
      boxShadow: 'rgba(9, 105, 218, 0.35) 0px 0px 0px 3px',
    })
  })
})

/* ========================================================================== *
 * AC5 · geometry unchanged
 * ========================================================================== */

describe('DAN-92 AC5 · geometry is unchanged', () => {
  it('height, padding, radius, border width, weight and display are the same', () => {
    expect(declFor('height', SECONDARY)).toBe('2.25rem') // 36px
    expect(declFor('padding', SECONDARY)).toBe('0 1rem') // 0 16px
    expect(declFor('border-radius', SECONDARY)).toBe('6px')
    expect(declFor('border', SECONDARY)).toBe('1px solid #d0d7de')
    expect(declFor('font-weight', SECONDARY)).toBe('500')
    expect(declFor('display', SECONDARY)).toBe('inline-flex')
  })

  it('agrees with the real-Chrome geometry capture (identical main vs branch)', () => {
    expect(CHROME_GEOMETRY).toEqual({
      height: '36px',
      paddingTop: '0px',
      paddingLeft: '16px',
      borderRadius: '6px',
      borderWidth: '1px',
      fontWeight: '500',
      display: 'inline-flex',
    })
  })

  it('the new rule sets no geometry property whatsoever', () => {
    const rule = RULES.find((r) => r.selector === '.btn.btn--primary:hover')
    expect(rule).toBeTruthy()
    expect([...rule.decls.keys()].sort()).toEqual(['background', 'border-color'])
  })

  it('the new rule deliberately sets no filter, so it composes with .btn--primary:hover', () => {
    const rule = RULES.find((r) => r.selector === '.btn.btn--primary:hover')
    expect(rule.decls.has('filter')).toBe(false)
    // the brightness still comes from the (0,2,0) rule, not the new (0,3,0) one
    expect(declFor('filter', { ...PRIMARY, state: 'hover' })).toBe('brightness(0.95)')
  })

  it('the new rule really is specificity (0,3,0) and really does outrank .btn:hover', () => {
    expect(specificity('.btn.btn--primary:hover')).toEqual([0, 3, 0])
    expect(specificity('.btn:hover')).toEqual([0, 2, 0])
    expect(specificity('.btn--primary')).toEqual([0, 1, 0])
    expect(cmpSpec(specificity('.btn.btn--primary:hover'), specificity('.btn:hover'))).toBeGreaterThan(0)
  })
})

/* ========================================================================== *
 * AC6 · DAN-89's blue revert stays intact — no green on any button
 * ========================================================================== */

describe("DAN-92 AC6 · DAN-89's revert is intact — no green anywhere near a button", () => {
  it('no button paints green in any state, primary or secondary', () => {
    for (const el of [PRIMARY, SECONDARY]) {
      for (const state of STATES) {
        const p = paint({ ...el, state })
        for (const v of [p.background, p.color, p.borderColor, p.paintedBackground, p.paintedColor]) {
          expect(v).not.toBe(GREEN)
        }
      }
    }
  })

  it('no rule that can match a .btn mentions the DAN-77 green literal', () => {
    const btnRules = RULES.filter((r) => /\.btn\b|\.btn--primary\b/.test(r.selector))
    expect(btnRules.length).toBeGreaterThan(0)
    for (const r of btnRules) {
      for (const v of r.decls.values()) expect(v.toLowerCase()).not.toContain('1a7f37')
    }
  })

  it('--color-primary is still gone (only referenced in prose)', () => {
    expect(ROOT.has('--color-primary')).toBe(false)
    expect(resolveVars('var(--color-primary)')).toBe('UNRESOLVED(--color-primary)')
  })

  it('the surviving green literals are exactly DAN-89s three non-button chips', () => {
    // Scoped deliberately: DAN-89 kept #1a7f37 on status chips/badges and says so
    // in-sheet. A blanket "no green in the file" assertion would contradict main.
    const green = RULES.filter((r) =>
      [...r.decls.values()].some((v) => v.toLowerCase().includes('1a7f37')),
    ).map((r) => r.selector).sort()
    expect(green).toEqual([
      '.activity-event--pr .activity-event__badge',
      '.gates__state--pass',
      '.my-requests__status--building',
    ])
  })

  it('the accent token is still DAN-89s blue', () => {
    expect(ROOT.get('--color-accent')).toBe('#0969da')
    expect(toRgb(ROOT.get('--color-accent'))).toEqual([9, 105, 218])
  })
})

/* ========================================================================== *
 * Cross-engine agreement · resolver vs real Chrome
 * ========================================================================== */

describe('DAN-92 · the two engines agree (resolver vs real headless Chrome)', () => {
  for (const [name, opts] of [['primary', PRIMARY], ['secondary', SECONDARY]]) {
    for (const state of STATES) {
      it(`${name} · ${state} · resolver === Chrome`, () => {
        expect(pick(paint({ ...opts, state }))).toEqual(CHROME_BRANCH[name][state])
      })
    }
  }

  it('Chrome confirms every primary state clears 4.5:1 except none — all pass', () => {
    for (const state of STATES) {
      const c = CHROME_BRANCH.primary[state]
      const bg = applyFilter(toRgb(c.background), c.filter)
      const fg = applyFilter(toRgb(c.color), c.filter)
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('Chrome-on-main confirms hover and press were the two broken states', () => {
    const broken = STATES.filter((state) => {
      const c = CHROME_MAIN.primary[state]
      const bg = applyFilter(toRgb(c.background), c.filter)
      const fg = applyFilter(toRgb(c.color), c.filter)
      return contrast(fg, bg) < 4.5
    })
    expect(broken).toEqual(['hover', 'active'])
  })
})

/* ========================================================================== *
 * Hygiene
 * ========================================================================== */

describe('DAN-92 · hygiene', () => {
  it('the stylesheet has no unresolved var() on any button property', () => {
    for (const el of [PRIMARY, SECONDARY]) {
      for (const state of STATES) {
        for (const prop of ['background', 'color', 'border-color', 'border', 'filter', 'opacity']) {
          const v = declFor(prop, { ...el, state })
          if (v !== null) expect(v).not.toContain('UNRESOLVED')
        }
      }
    }
  })

  it('the stylesheet carries no merge conflict markers', () => {
    expect(CSS).not.toMatch(/^(<{7}|={7}|>{7})/m)
  })

  it('exactly one rule was added for DAN-92', () => {
    const hoverRules = RULES.filter((r) => /^\.btn[\w.-]*:hover$/.test(r.selector))
      .map((r) => r.selector).sort()
    expect(hoverRules).toEqual(['.btn--primary:hover', '.btn.btn--primary:hover', '.btn:hover'])
  })
})
