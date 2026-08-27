import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

// DAN-92 · "primary button label is invisible on hover"
//
// `.btn:hover` is (0,2,0); `.btn--primary` is (0,1,0). The shared secondary
// hover fill therefore outranked the primary's own background, and since the
// label stayed white the text vanished into a near-white button. The fix adds
// `.btn.btn--primary:hover` at (0,3,0), restoring the fill through the token.
//
// Two independent verifications of the same claims, because neither alone is
// sufficient:
//
//   1. jsdom's real CSSOM + real `Element.matches`, with specificity ordering
//      and var() substitution done by hand (jsdom implements neither). Always
//      runs; deterministic; no browser needed. Technique borrowed from the
//      DAN-89 tester suite.
//   2. Real headless Chrome over CDP, with `CSS.forcePseudoState` forcing
//      :hover/:active/:focus and `CSS.getComputedStyleForNode` reading the
//      genuine computed values — the browser's own cascade, var() resolution
//      and pseudo-class matching, nothing hand-rolled. Skipped (loudly) when no
//      Chrome binary is present, so CI without a browser still passes on (1).
//
// Nothing here asserts a literal fill colour. PR #76 (DAN-89) reverts the
// primary from green `--color-primary` back to blue `--color-accent`, and this
// fix must be correct either way, so every primary assertion is expressed as
// "hover fill == rest fill" plus a measured contrast floor.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CSS_PATH = path.join(HERE, 'styles.css')
const CSS = fs.readFileSync(CSS_PATH, 'utf8')

const WHITE = 'rgb(255, 255, 255)'
const SUBTLE = '#f6f8fa' // --color-subtle: the secondary hover fill, unchanged by this ticket
const AA_NORMAL_TEXT = 4.5

/* -- colour maths ------------------------------------------------------------
   The label sits on the button's own background, and `filter: brightness()`
   repaints both together. getComputedStyle reports the *pre-filter* paint and
   the filter function separately, so the ratio a user actually sees is only
   available by applying the filter here. Per the CSS Filter Effects definition
   of `brightness()`, the multiply happens on the sRGB-encoded channels. */

function toRgb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16))
  const nums = value.match(/[\d.]+/g)
  if (!nums || nums.length < 3) throw new Error(`not a colour this test can read: ${value}`)
  return nums.slice(0, 3).map(Number)
}

const applyBrightness = (rgb, k) => rgb.map((c) => Math.min(255, c * k))

function luminance(rgb) {
  return rgb
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0)
}

function contrastRatio(a, b) {
  const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function brightnessOf(filter) {
  const m = /brightness\(\s*([\d.]+)\s*\)/.exec(filter ?? '')
  return m ? Number(m[1]) : 1
}

/** The ratio as rendered: filter applied to fill and label alike. */
function seenContrast({ background, color, filter }) {
  const k = brightnessOf(filter)
  const rgbToCss = (rgb) => `rgb(${rgb.join(', ')})`
  return contrastRatio(
    rgbToCss(applyBrightness(toRgb(background), k)),
    rgbToCss(applyBrightness(toRgb(color), k)),
  )
}

/* -- 1. cascade resolved against the real CSSOM ------------------------------ */

const STATE_PSEUDOS = [':hover', ':active', ':focus-visible', ':focus', ':disabled']

function splitStates(selector) {
  let base = selector
  const states = []
  for (;;) {
    const hit = STATE_PSEUDOS.find((p) => base.endsWith(p))
    if (!hit) break
    states.unshift(hit.slice(1))
    base = base.slice(0, -hit.length)
  }
  return { base: base || '*', states }
}

/** (ids, classes+attrs+pseudo-classes, types) packed into one comparable number. */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(\([^)]*\))?/g) ?? []).length
  const types = (
    selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, ' ').match(/[a-z][\w-]*/gi) ?? []
  ).length
  return ids * 10000 + classes * 100 + types
}

let RULES = []
let ROOT_VARS = {}

beforeAll(() => {
  const styleEl = document.createElement('style')
  styleEl.textContent = CSS
  document.head.appendChild(styleEl)
  const sheet = styleEl.sheet ?? [...document.styleSheets].find((s) => s.ownerNode === styleEl)
  if (!sheet) throw new Error('styles.css did not parse into a CSSOM stylesheet')

  RULES = []
  for (const rule of sheet.cssRules) {
    if (!rule.selectorText) continue
    for (const sel of rule.selectorText.split(',')) {
      const selector = sel.trim().replace(/\s+/g, ' ')
      if (selector) RULES.push({ selector, style: rule.style, order: RULES.length })
    }
  }

  ROOT_VARS = {}
  for (const { selector, style } of RULES) {
    if (selector !== ':root') continue
    for (let i = 0; i < style.length; i++) {
      ROOT_VARS[style[i]] = style.getPropertyValue(style[i]).trim()
    }
  }
})

/** Substitute var() the way computed-value time does, fallbacks included. */
function resolveVars(value) {
  let out = value
  for (let i = 0; i < 6 && out.includes('var('); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*|[^()]*\([^()]*\)[^()]*))?\)/g, (_, name, fallback) => {
      const defined = ROOT_VARS[name]
      if (defined) return defined
      // Undefined and no fallback: the browser drops the declaration entirely,
      // which would silently un-fill the button. Make that loud.
      return fallback === undefined ? `DANGLING(${name})` : fallback
    })
  }
  return out.trim()
}

const PAINT_ALIASES = {
  background: ['background', 'background-color'],
  color: ['color'],
  'border-color': ['border', 'border-color', 'border-top-color'],
  filter: ['filter'],
  opacity: ['opacity'],
  outline: ['outline'],
}

/** Winning value of `prop` for a <button class=...> in `states`, per the cascade. */
function resolved(prop, { classes = [], states = [] } = {}) {
  const el = document.createElement('button')
  if (classes.length) el.className = classes.join(' ')
  document.body.appendChild(el)
  try {
    const winners = RULES.filter(({ selector }) => {
      const { base, states: need } = splitStates(selector)
      if (!need.every((s) => states.includes(s))) return false
      try {
        return el.matches(base)
      } catch {
        return false
      }
    }).sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.order - b.order)

    let winner = null
    for (const rule of winners) {
      for (const alias of PAINT_ALIASES[prop] ?? [prop]) {
        const v = rule.style.getPropertyValue(alias)
        if (v) winner = v
      }
    }
    return winner === null ? null : resolveVars(winner)
  } finally {
    el.remove()
  }
}

const PRIMARY = ['btn', 'btn--primary']
const SECONDARY = ['btn']

const snapshot = (classes, states) => ({
  background: resolved('background', { classes, states }),
  color: resolved('color', { classes, states }),
  'border-color': resolved('border-color', { classes, states }),
  filter: resolved('filter', { classes, states }) ?? 'none',
  opacity: resolved('opacity', { classes, states }) ?? '1',
})

describe('DAN-92 · cascade resolved from styles.css (real CSSOM, hand-resolved specificity + var())', () => {
  it('AC1 · the primary keeps its own fill on hover instead of falling through to .btn:hover', () => {
    const rest = snapshot(PRIMARY, [])
    const hover = snapshot(PRIMARY, ['hover'])

    // Token-driven, not literal: whichever token paints the rest state must also
    // paint the hover state. Holds for green --color-primary and for the blue
    // --color-accent that PR #76 restores.
    expect(hover.background).toBe(rest.background)
    expect(hover['border-color']).toBe(rest['border-color'])
    expect(hover.color).toBe(rest.color)

    // Explicitly *not* the secondary treatment any more.
    expect(hover.background).not.toBe(SUBTLE)
    expect(hover.background).not.toContain('DANGLING(')
  })

  it('AC1 · the hovered label clears 4.5:1 against the fill it is painted on', () => {
    const hover = snapshot(PRIMARY, ['hover'])
    expect(seenContrast(hover)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    // And the bug itself: white on --color-subtle is ~1.06:1. Prove we left it.
    expect(contrastRatio(SUBTLE, WHITE)).toBeLessThan(1.1)
  })

  it('AC2 · plain .btn hover is untouched — still the subtle fill, still dark text', () => {
    const hover = snapshot(SECONDARY, ['hover'])
    expect(hover.background).toBe(SUBTLE)
    expect(hover.filter).toBe('none')
    expect(hover.color).toBe(resolved('color', { classes: SECONDARY }))
    expect(seenContrast(hover)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it('AC3 · rest, focus and disabled are byte-for-byte what they were', () => {
    for (const states of [[], ['focus', 'focus-visible'], ['disabled']]) {
      const s = snapshot(PRIMARY, states)
      expect(s.background).toBe(resolved('background', { classes: PRIMARY }))
      expect(s['border-color']).toBe(resolved('border-color', { classes: PRIMARY }))
      expect(s.color).toBe(resolved('color', { classes: PRIMARY }))
      expect(s.filter).toBe('none')
    }
    expect(resolved('opacity', { classes: PRIMARY, states: ['disabled'] })).toBe('0.6')
    expect(resolved('outline', { classes: PRIMARY, states: ['focus', 'focus-visible'] })).toContain(
      ROOT_VARS['--color-accent'],
    )
  })

  it('AC3 · the pressed step still darkens past hover — the new rule sets no filter', () => {
    // The fix is background/border only, precisely so that .btn--primary:hover
    // (0.95) and .btn--primary:active (0.88) keep their existing relationship.
    const hoverK = brightnessOf(snapshot(PRIMARY, ['hover']).filter)
    const activeK = brightnessOf(snapshot(PRIMARY, ['hover', 'active']).filter)
    expect(hoverK).toBeLessThan(1)
    expect(activeK).toBeLessThanOrEqual(hoverK)
    expect(seenContrast(snapshot(PRIMARY, ['hover', 'active']))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it('the new rule outranks .btn:hover, and does it without touching .btn:hover', () => {
    expect(specificity('.btn.btn--primary:hover')).toBeGreaterThan(specificity('.btn:hover'))
    expect(CSS).toMatch(/\.btn:hover\s*\{\s*background:\s*var\(--color-subtle\);\s*\}/)
    expect(CSS).toContain('.btn.btn--primary:hover')
  })

  it('the fix names a token and never a hex', () => {
    const rule = /\.btn\.btn--primary:hover\s*\{([^}]*)\}/.exec(CSS)
    expect(rule).not.toBeNull()
    expect(rule[1]).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    expect(rule[1]).toMatch(/var\(--color-/)
    // Nothing but the fill: no filter, no geometry, no label colour.
    const props = rule[1]
      .split(';')
      .map((d) => d.split(':')[0].trim())
      .filter(Boolean)
    expect(props.sort()).toEqual(['background', 'border-color'])
  })

  it('every primary button in the app carries both classes, so the rule reaches all of them', () => {
    const sources = fs
      .readdirSync(HERE)
      .filter((f) => f.endsWith('.jsx') && !f.includes('.test.'))
      .map((f) => fs.readFileSync(path.join(HERE, f), 'utf8'))
      .join('\n')
    const uses = sources.match(/className="[^"]*btn--primary[^"]*"/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(4) // Sign in with Google, Add, Approve plan, Send
    for (const use of uses) expect(use).toMatch(/"btn btn--primary"/)
  })
})

/* -- 2. the same claims, measured in real headless Chrome -------------------- */

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  process.env.CHROME_PATH,
].find((p) => p && fs.existsSync(p))

const PROBE_HTML = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<body>
  <button id="primary" class="btn btn--primary">Sign in with Google</button>
  <button id="secondary" class="btn">Cancel</button>
  <button id="disabled" class="btn btn--primary" disabled>Send</button>
</body>`

const PROBES = [
  { name: 'primary/rest', selector: '#primary', states: [] },
  { name: 'primary/hover', selector: '#primary', states: ['hover'] },
  { name: 'primary/active', selector: '#primary', states: ['hover', 'active'] },
  { name: 'primary/focus', selector: '#primary', states: ['focus', 'focus-visible'] },
  { name: 'primary/disabled', selector: '#disabled', states: [] },
  { name: 'secondary/rest', selector: '#secondary', states: [] },
  { name: 'secondary/hover', selector: '#secondary', states: ['hover'] },
]

const PROPS = [
  'background-color',
  'color',
  'border-top-color',
  'filter',
  'opacity',
  'outline-color',
  'height',
  'padding-left',
  'font-weight',
]

/**
 * Drives real Chrome over CDP in a child Node process.
 *
 * The child is deliberate: this suite runs under jsdom, whose `WebSocket` and
 * `fetch` are page-scoped shims, and CDP needs Node's own. The child speaks raw
 * CDP over Node 22+'s built-in global WebSocket, so no new dependency is added.
 */
function measureInChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan92-'))
  const pagePath = path.join(dir, 'probe.html')
  fs.writeFileSync(pagePath, PROBE_HTML)
  const driverPath = path.join(dir, 'driver.mjs')
  fs.writeFileSync(
    driverPath,
    `
import { spawn } from 'node:child_process'
const [chromePath, pagePath, payload] = process.argv.slice(2)
const { probes, props } = JSON.parse(payload)
const port = 9222 + Math.floor(Math.random() * 900)
const profile = pagePath.replace(/probe\\.html$/, 'profile')
const chrome = spawn(chromePath, [
  '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function endpoint() {
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version')
      if (res.ok) return (await res.json()).webSocketDebuggerUrl
    } catch {}
    if (Date.now() > deadline) throw new Error('Chrome DevTools endpoint never came up')
    await sleep(100)
  }
}
try {
  const ws = new WebSocket(await endpoint())
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  })
  const raw = (method, params, sessionId) => new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params: params ?? {}, sessionId }))
  })
  const { targetId } = await raw('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true })
  const s = (m, p) => raw(m, p, sessionId)
  await s('Page.enable'); await s('DOM.enable'); await s('CSS.enable')
  const loaded = new Promise((resolve) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) {
        ws.removeEventListener('message', onMsg); resolve()
      }
    }
    ws.addEventListener('message', onMsg)
  })
  await s('Page.navigate', { url: 'file://' + pagePath })
  await loaded
  const { root } = await s('DOM.getDocument', { depth: -1 })
  const out = {}
  for (const probe of probes) {
    const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: probe.selector })
    if (!nodeId) throw new Error('probe ' + probe.name + ': ' + probe.selector + ' matched nothing')
    await s('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: probe.states })
    const { computedStyle } = await s('CSS.getComputedStyleForNode', { nodeId })
    const all = Object.fromEntries(computedStyle.map((e) => [e.name, e.value]))
    out[probe.name] = Object.fromEntries(props.map((p) => [p, all[p]]))
    await s('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
  }
  process.stdout.write('<<<' + JSON.stringify(out) + '>>>')
  ws.close()
} finally {
  chrome.kill('SIGKILL')
}
process.exit(0)
`,
  )

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [driverPath, CHROME, pagePath, JSON.stringify({ probes: PROBES, props: PROPS })],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        /* the OS can have it */
      }
      const m = /<<<([\s\S]*)>>>/.exec(out)
      if (!m) return reject(new Error(`Chrome driver failed (exit ${code}): ${err || out}`))
      resolve(JSON.parse(m[1]))
    })
  })
}

const asPaint = (s) => ({ background: s['background-color'], color: s.color, filter: s.filter })

describe.skipIf(!CHROME)('DAN-92 · real headless Chrome, pseudo-states forced via CDP', () => {
  let measured

  beforeAll(async () => {
    measured = await measureInChrome()
  }, 120000)

  it('AC1 · hover paints the primary fill, not the secondary grey', () => {
    expect(measured['primary/hover']['background-color']).toBe(
      measured['primary/rest']['background-color'],
    )
    expect(measured['primary/hover']['border-top-color']).toBe(
      measured['primary/rest']['border-top-color'],
    )
    expect(measured['primary/hover'].color).toBe(WHITE)
    expect(measured['primary/hover']['background-color']).not.toBe(
      measured['secondary/hover']['background-color'],
    )
  })

  it('AC1 · the hovered label measures at least 4.5:1, filter included', () => {
    const ratio = seenContrast(asPaint(measured['primary/hover']))
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    // Guard rail on the maths itself: the pre-fix paint (white on #f6f8fa) is ~1.06.
    expect(contrastRatio(SUBTLE, WHITE)).toBeLessThan(1.1)
  })

  it('AC1 · hover is still visibly distinct from rest', () => {
    expect(brightnessOf(measured['primary/hover'].filter)).toBeLessThan(1)
    expect(measured['primary/rest'].filter).toBe('none')
  })

  it('AC2 · plain .btn hover is the unchanged subtle fill with unchanged dark text', () => {
    expect(measured['secondary/hover']['background-color']).toBe('rgb(246, 248, 250)')
    expect(measured['secondary/hover'].color).toBe(measured['secondary/rest'].color)
    expect(measured['secondary/hover'].filter).toBe('none')
    expect(seenContrast(asPaint(measured['secondary/hover']))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it('AC3 · rest, focus and disabled are identical to the rest paint; geometry untouched', () => {
    for (const name of ['primary/focus', 'primary/disabled']) {
      expect(measured[name]['background-color']).toBe(measured['primary/rest']['background-color'])
      expect(measured[name].color).toBe(WHITE)
      expect(measured[name].filter).toBe('none')
    }
    expect(measured['primary/disabled'].opacity).toBe('0.6')
    expect(measured['primary/focus']['outline-color']).toBe('rgb(9, 105, 218)')
    expect(measured['primary/rest'].height).toBe('36px')
    expect(measured['primary/rest']['padding-left']).toBe('16px')
    expect(measured['primary/rest']['font-weight']).toBe('500')
  })

  it('AC3 · pressed still steps darker than hover, and stays readable', () => {
    const hoverK = brightnessOf(measured['primary/hover'].filter)
    const activeK = brightnessOf(measured['primary/active'].filter)
    expect(activeK).toBeLessThanOrEqual(hoverK)
    expect(measured['primary/active']['background-color']).toBe(
      measured['primary/rest']['background-color'],
    )
    expect(seenContrast(asPaint(measured['primary/active']))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it('Chrome and the hand-resolved cascade agree on the hover fill', () => {
    // The two verifications are only worth having if they cross-check.
    const fromCssom = toRgb(snapshot(PRIMARY, ['hover']).background)
    const fromChrome = toRgb(measured['primary/hover']['background-color'])
    expect(fromChrome).toEqual(fromCssom)
  })
})

if (!CHROME) {
  // Not a silent skip: say why, so a green run is never mistaken for browser proof.
  console.warn(
    'DAN-92: no Chrome/Chromium binary found — the real-browser computed-style checks were skipped. ' +
      'Set CHROME_PATH to run them. The CSSOM cascade checks above still ran.',
  )
}
