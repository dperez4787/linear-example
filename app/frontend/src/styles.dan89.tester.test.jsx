import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => {
    listener(null)
    return () => {}
  }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => null),
}))

// DAN-89 · tester · "Buttons revert to blue"
//
// Independent verification, written without reusing the developer's suite. The
// difference that matters is where the CSS understanding comes from: this file
// does not hand-roll a regex parser. It hands `src/styles.css` to jsdom's real
// CSSOM (`document.styleSheets[].cssRules`) and matches selectors with the real
// DOM matcher (`Element.matches`), so parsing and selector semantics are the
// browser's, not mine. Only two things are done by hand — specificity ordering
// and `var()` substitution — because jsdom implements neither, and both are
// cross-checked below against real Chrome 151 computed styles captured while
// testing this branch:
//
//   .btn.btn--primary  rest   rgb(9, 105, 218) / text rgb(255, 255, 255)
//                      hover  rgb(246, 248, 250) filter brightness(0.95)
//                      active rgb(9, 105, 218) filter none
//                      focus  outline rgb(9, 105, 218)
//                      disabled rgb(9, 105, 218) opacity 0.6
//
// The grey hover fill is NOT this ticket's doing: `.btn:hover` (0,2,0) outranks
// `.btn--primary` (0,1,0), so the shared secondary hover has always won on the
// primary button. Chrome renders the identical grey on the pre-#65 stylesheet
// and on today's green `main`. It is asserted here as a pinned pre-existing
// fact so a future change to it is caught, not as a DAN-89 criterion.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CSS = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')

const BLUE = '#0969da'
const WHITE = '#ffffff'
const GREEN = '#1a7f37' // the fill DAN-77 (PR #65) introduced
const DAG_GREEN = '#15803d' // a *different*, older green, on .dag-node__state--done

// Catch any green, not just the one hex #65 used: a "revert" that swapped in a
// neighbouring green would otherwise sail past a literal-string check.
function greensIn(value) {
  const found = []
  for (const hex of value.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    if (g > r + 24 && g > b + 24) found.push(hex.toLowerCase())
  }
  for (const rgb of value.match(/rgba?\(([^)]*)\)/g) ?? []) {
    const [r, g, b] = rgb.replace(/rgba?\(|\)/g, '').split(/[,\s/]+/).map(Number)
    if (g > r + 24 && g > b + 24) found.push(rgb)
  }
  return found
}
const SUBTLE = '#f6f8fa'

/* -- the real CSSOM, driven by the real selector matcher --------------------- */

const styleEl = document.createElement('style')
styleEl.textContent = CSS
document.head.appendChild(styleEl)
const SHEET = styleEl.sheet ?? [...document.styleSheets].find((s) => s.ownerNode === styleEl)
if (!SHEET) throw new Error('styles.css did not parse into a CSSOM stylesheet')

// Flatten to one entry per comma-separated selector, keeping source order.
const RULES = []
for (const rule of SHEET.cssRules) {
  if (!rule.selectorText) continue
  for (const sel of rule.selectorText.split(',')) {
    const selector = sel.trim().replace(/\s+/g, ' ')
    if (selector) RULES.push({ selector, style: rule.style, order: RULES.length })
  }
}

// jsdom's CSSStyleDeclaration is index-accessible but not iterable and has no
// item(); read declarations positionally, verbatim (shorthands are not expanded).
function declNames(style) {
  const names = []
  for (let i = 0; i < style.length; i++) names.push(style[i])
  return names
}

const ROOT_VARS = {}
for (const { selector, style } of RULES) {
  if (selector !== ':root') continue
  for (const prop of declNames(style)) ROOT_VARS[prop] = style.getPropertyValue(prop).trim()
}

// The state pseudo-classes this ticket is about. A rule only applies when every
// state it names is active; anything left over must match structurally.
const STATE_PSEUDOS = [':hover', ':active', ':focus-visible', ':focus', ':disabled']

function split(selector) {
  let base = selector
  const states = []
  for (;;) {
    const hit = STATE_PSEUDOS.find((p) => base.endsWith(p))
    if (!hit) break
    states.push(hit.slice(1))
    base = base.slice(0, -hit.length)
  }
  return { base: base || '*', states }
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(\([^)]*\))?/g) ?? []).length
  const types = (
    selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, ' ').match(/[a-z][\w-]*/gi) ?? []
  ).length
  return ids * 10000 + classes * 100 + types
}

function resolveVars(value) {
  let out = value
  for (let i = 0; i < 6 && out.includes('var('); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fallback) => {
      const v = ROOT_VARS[name]
      if (v) return v
      // No definition and no fallback: the browser drops the declaration at
      // computed-value time and the element silently falls back to inherit /
      // initial. That is precisely how a careless revert breaks a rule it never
      // meant to touch, so make it loud rather than letting it read as "unset".
      return fallback === undefined ? `DANGLING(${name})` : fallback
    })
  }
  return out.trim()
}

// `background: <color>` and `background-color: <color>` are the same paint here;
// same for `border-color` and the `border-*-color` longhands jsdom expands to.
const PAINT_ALIASES = {
  background: ['background', 'background-color'],
  color: ['color'],
  'border-color': ['border', 'border-color', 'border-top-color'],
  filter: ['filter'],
  opacity: ['opacity'],
  outline: ['outline'],
}

/** Resolved value of `prop` on a detached element carrying `classes`, in `states`. */
function paint(prop, { classes = [], tag = 'button', states = [], ancestorClasses = null } = {}) {
  const el = document.createElement(tag)
  if (classes.length) el.className = classes.join(' ')
  let attachTo = document.body
  if (ancestorClasses) {
    const parent = document.createElement('div')
    parent.className = ancestorClasses.join(' ')
    document.body.appendChild(parent)
    attachTo = parent
  }
  attachTo.appendChild(el)
  try {
    const candidates = RULES.filter(({ selector }) => {
      const { base, states: need } = split(selector)
      if (!need.every((s) => states.includes(s))) return false
      try {
        return el.matches(base)
      } catch {
        return false
      }
    }).sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.order - b.order)

    let winner = null
    for (const rule of candidates) {
      for (const alias of PAINT_ALIASES[prop] ?? [prop]) {
        const v = rule.style.getPropertyValue(alias)
        if (v) winner = v
      }
    }
    return winner === null ? null : resolveVars(winner)
  } finally {
    el.remove()
    if (ancestorClasses) attachTo.remove()
  }
}

const FIVE_STATES = [[], ['hover'], ['active'], ['focus', 'focus-visible'], ['disabled']]

/** Every className combination the app actually puts on a <button>, read from source. */
function buttonClassCombosFromSource() {
  const combos = new Set([[]].map(() => '')) // the unclassed <button> (RecordRow's Edit/Delete)
  for (const file of fs.readdirSync(HERE)) {
    if (!file.endsWith('.jsx') || file.includes('.test.')) continue
    const src = fs.readFileSync(path.join(HERE, file), 'utf8')
    for (const tag of src.match(/<button[\s\S]*?>/g) ?? []) {
      const m = tag.match(/className=\{?[`"]([^`"]*)[`"]/)
      combos.add(m ? m[1].trim() : '')
    }
  }
  return [...combos]
}

/* -- AC1 + AC2: the paint ---------------------------------------------------- */

describe('DAN-89 AC1/AC2 · the primary button is blue, and green in no state', () => {
  const primary = ['btn', 'btn--primary']

  it('resolves the accent blue for fill, border and label at rest', () => {
    expect(paint('background', { classes: primary })).toBe(BLUE)
    expect(paint('border-color', { classes: primary })).toBe(BLUE)
    expect(paint('color', { classes: primary })).toBe(WHITE)
  })

  it.each([
    ['default', []],
    ['active', ['active']],
    ['focus', ['focus', 'focus-visible']],
    ['disabled', ['disabled']],
  ])('fills blue when %s', (_name, states) => {
    expect(paint('background', { classes: primary, states })).toBe(BLUE)
    expect(paint('border-color', { classes: primary, states })).toBe(BLUE)
    expect(paint('color', { classes: primary, states })).toBe(WHITE)
  })

  // AMENDED BY DAN-92 (was: 'hover keeps the shared .btn:hover grey — pre-existing,
  // identical on main and pre-#65'). This test pinned the grey hover fill as a
  // known-bad, out-of-DAN-89-scope quirk: `.btn:hover` (0,2,0) outranked
  // `.btn--primary` (0,1,0), so the primary went near-white behind its white
  // label. DAN-92 is the ticket that fixes it, with `.btn.btn--primary:hover` at
  // (0,3,0). The expectation is inverted rather than deleted, so the state stays
  // covered and a regression back to the grey still fails here.
  it('hover keeps the primary blue fill — the grey fall-through was fixed by DAN-92', () => {
    expect(paint('background', { classes: primary, states: ['hover'] })).toBe(BLUE)
    expect(paint('border-color', { classes: primary, states: ['hover'] })).toBe(BLUE)
    // The darkening still comes from .btn--primary:hover, unchanged by DAN-92.
    expect(paint('filter', { classes: primary, states: ['hover'] })).toBe('brightness(0.95)')
    expect(paint('background', { classes: primary, states: ['hover'] })).not.toBe(SUBTLE)
    expect(paint('background', { classes: primary, states: ['hover'] })).not.toBe(GREEN)
  })

  it('the focus ring and the disabled treatment are the ones that always applied', () => {
    expect(paint('outline', { classes: primary, states: ['focus', 'focus-visible'] })).toContain(BLUE)
    expect(paint('opacity', { classes: primary, states: ['disabled'] })).toBe('0.6')
  })

  it('every button className in the source paints non-green in all five states', () => {
    const combos = buttonClassCombosFromSource()
    expect(combos.length).toBeGreaterThanOrEqual(6) // btn, btn btn--primary, sort-button, my-requests__row, chat-message__retry, activity-event__toggle, unclassed

    const offenders = []
    for (const combo of combos) {
      const classes = combo ? combo.split(/\s+/) : []
      for (const states of FIVE_STATES) {
        for (const prop of ['background', 'color', 'border-color', 'outline']) {
          const v = paint(prop, { classes, states })
          if (v && greensIn(v).length) {
            offenders.push(`<button class="${combo}">:${states.join(':') || 'default'} ${prop}=${v}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every green left in the sheet sits on a non-button selector', () => {
    const greenRules = [
      ...new Set(
        RULES.filter(({ style }) =>
          declNames(style).some((p) => greensIn(style.getPropertyValue(p)).length),
        ).map((r) => r.selector),
      ),
    ].sort()
    // Exactly the four AC5 non-button greens, and no more. `.dag-node__state--done`
    // and `.gates__state--pass` predate #65; the other two are the rules that used
    // to read --color-primary and now carry the literal.
    expect(greenRules).toEqual([
      '.activity-event--pr .activity-event__badge',
      '.dag-node__state--done',
      '.gates__state--pass',
      '.my-requests__status--building',
    ])
    for (const sel of greenRules) expect(sel).not.toMatch(/\bbtn\b|button/)
  })
})

/* -- the DAN-77 tokens are gone, and nothing dangles ------------------------- */

describe('DAN-89 · the DAN-77 token pair is gone without breaking its consumers', () => {
  it('drops --color-primary / --color-on-primary and restores --color-on-accent', () => {
    expect(ROOT_VARS['--color-primary']).toBeUndefined()
    expect(ROOT_VARS['--color-on-primary']).toBeUndefined()
    expect(ROOT_VARS['--color-on-accent']).toBe(WHITE)
    expect(ROOT_VARS['--color-accent']).toBe(BLUE)
  })

  it('no rule anywhere reads a custom property that is no longer defined', () => {
    const dangling = []
    for (const { selector, style } of RULES) {
      if (selector === ':root') continue
      for (const prop of declNames(style)) {
        const resolved = resolveVars(style.getPropertyValue(prop))
        if (resolved.includes('DANGLING(')) dangling.push(`${selector} { ${prop}: ${resolved} }`)
      }
    }
    expect(dangling).toEqual([])
  })

  it('the two rules that used to read --color-primary still resolve to a real green', () => {
    expect(paint('color', { tag: 'span', classes: ['my-requests__status--building'] })).toBe(GREEN)
    expect(
      paint('border-color', {
        tag: 'span',
        classes: ['activity-event__badge'],
        ancestorClasses: ['activity-event', 'activity-event--pr'],
      }),
    ).toBe(GREEN)
  })
})

/* -- AC3 + AC4: geometry, labels, inventory ---------------------------------- */

describe('DAN-89 AC3/AC4 · geometry, labels and inventory are untouched', () => {
  it('.btn keeps the exact box it had before #65', () => {
    // Literals, not tokens: a token that quietly changed value would pass a
    // token-to-token comparison. These are the values Chrome computes today
    // (36px tall, 0 16px padding, 6px radius, weight 500).
    expect(paint('height', { classes: ['btn'] })).toBe('2.25rem')
    expect(paint('padding', { classes: ['btn'] })).toBe('0 1rem')
    expect(paint('border-radius', { classes: ['btn'] })).toBe('6px')
    expect(paint('font-weight', { classes: ['btn'] })).toBe('500')
    expect(paint('display', { classes: ['btn'] })).toBe('inline-flex')
  })

  // AMENDED BY DAN-92 (was: 'the .btn / .btn--primary block is byte-identical to
  // the pre-#65 stylesheet'). DAN-92 adds one rule inside this very block, so the
  // pre-#65 text can no longer be the expectation. The check is still a genuine
  // byte-for-byte comparison of the whole contiguous block — the new rule and its
  // comment are reproduced verbatim below, not matched loosely — so it keeps
  // catching any unannounced edit to the button treatment.
  it('the .btn / .btn--primary block is byte-identical to pre-#65 plus DAN-92s hover fix', () => {
    const expected = `.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--control-height);
  padding: 0 var(--space-4);
  font: inherit;
  font-weight: 500;
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  cursor: pointer;
}

.btn:hover {
  background: var(--color-subtle);
}

.btn--primary {
  color: var(--color-on-accent);
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.btn--primary:hover {
  filter: brightness(0.95);
}

/* DAN-92: keep the primary fill on hover.

   \`.btn:hover\` is (0,2,0) and \`.btn--primary\` is only (0,1,0), so the shared
   secondary hover fill (--color-subtle, a near-white) has always outranked the
   primary's own background. The label stays white, so hovering any call-to-action
   made its text vanish (~1.06:1). This rule restores the fill at (0,3,0) — every
   primary button in the app carries both classes — so the brightness() above
   darkens the accent instead of the grey.

   Deliberately background/border only. \`filter\` stays on \`.btn--primary:hover\`
   alone: a filter here would outrank that rule rather than compose with it, so
   any future pressed/other state override would silently lose to this one. */
.btn.btn--primary:hover {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}`
    expect(CSS).toContain(expected)
    // and DAN-77's extra pressed-state override is gone
    expect(CSS).not.toMatch(/\.btn--primary:active/)
  })

  it('no component source file changed on this branch — only styles.css and tests', () => {
    let changed
    try {
      changed = execFileSync('git', ['diff', '--name-only', 'main...HEAD'], {
        cwd: HERE,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)
    } catch {
      // No `main` ref (shallow clone / tarball export). Say so rather than pass.
      console.warn('DAN-89: skipped the git-diff inventory check — no `main` ref available')
      return
    }
    const nonStyle = changed.filter((f) => f !== 'app/frontend/src/styles.css' && !f.includes('.test.'))
    expect(nonStyle).toEqual([])
  })

  it('AuthGate still renders exactly one primary button, same label, same class list', async () => {
    render(
      <AuthProvider>
        <AuthGate>
          <div>records ui</div>
        </AuthGate>
      </AuthProvider>,
    )
    const button = await screen.findByRole('button', { name: 'Sign in with Google' })
    expect(button.className).toBe('btn btn--primary')
    expect(button.type).toBe('button')
    expect(button.disabled).toBe(false)
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1)
  })
})

/* -- AC5: non-button elements ------------------------------------------------ */

describe('DAN-89 AC5 · non-button elements are visually unchanged', () => {
  it('links keep the accent blue', () => {
    expect(paint('color', { tag: 'a', classes: [] })).toBe(BLUE)
  })

  it('the status chip and the PR badge are still green', () => {
    expect(paint('color', { tag: 'span', classes: ['my-requests__status--building'] })).toBe(GREEN)
    expect(
      paint('border-color', {
        tag: 'span',
        classes: ['activity-event__badge'],
        ancestorClasses: ['activity-event', 'activity-event--pr'],
      }),
    ).toBe(GREEN)
  })

  it('the gate/DAG success greens are untouched', () => {
    expect(paint('color', { tag: 'span', classes: ['gates__state--pass'] })).toBe(GREEN)
    // A different, older green with a var() fallback; untouched by this branch.
    expect(paint('color', { tag: 'span', classes: ['dag-node__state--done'] })).toBe(DAG_GREEN)
  })

  it('the danger colour and the focus-ring shadow are unchanged', () => {
    expect(ROOT_VARS['--color-danger']).toBe('#cf222e')
    expect(ROOT_VARS['--focus-ring']).toBe('0 0 0 3px rgba(9, 105, 218, 0.35)')
  })

  it('.my-requests__status--building is a <span> chip nested in the row button, not a button', () => {
    // Documented judgement call. The chip lives inside <button class="my-requests__row">,
    // so a literal reading of AC1 ("no button renders green") could be argued
    // against it. AC5 names status chips as must-not-change, and the row button's
    // own fill/border/label colour carry no green — verified above across all five
    // states — so the chip stays green. Pinned here so the reading is explicit.
    const src = fs.readFileSync(path.join(HERE, 'MyRequests.jsx'), 'utf8')
    expect(src).toMatch(/<span\s+className=\{`my-requests__status my-requests__status--\$\{request\.status\}`\}/)
    expect(paint('color', { classes: ['my-requests__row'] })).not.toBe(GREEN)
    expect(paint('background', { classes: ['my-requests__row'] })).not.toBe(GREEN)
  })
})
