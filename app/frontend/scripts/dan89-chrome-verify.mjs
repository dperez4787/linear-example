// DAN-89 tester · real-browser verification, kept for reproducibility.
//
// NOT part of `npm test` (it is not a *.test.js and it needs a Chrome binary).
// It serves `dist/` plus a harness page of verbatim component markup, drives
// headless Chrome over the DevTools Protocol, forces each pseudo-state with
// CSS.forcePseudoState, and prints Chrome's own computed styles — the thing a
// jsdom suite cannot give you, because jsdom resolves neither var() nor :hover.
//
//   cd app/frontend && npm run build \
//     && node scripts/dan89-chrome-verify.mjs "$PWD/dist" scripts/dan89-harness.html
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const DIST = process.argv[2]
const HTML = process.argv[3]

// --- serve dist + harness page ------------------------------------------------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/harness.html') {
    // Vite content-hashes the stylesheet name, so bind the placeholder to
    // whatever this build actually emitted.
    const css = fs.readdirSync(path.join(DIST, 'assets')).find((f) => f.endsWith('.css'))
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(String(fs.readFileSync(HTML)).replace('STYLESHEET', css))
  }
  const file = path.join(DIST, url === '/' ? 'index.html' : url)
  if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nf') }
  const ext = path.extname(file)
  const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/html'
  res.writeHead(200, { 'content-type': type })
  res.end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

// --- launch chrome ------------------------------------------------------------
const userDir = fs.mkdtempSync('/tmp/dan89-chrome-')
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=9333',
  `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' })

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json() } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('chrome did not come up')
}
const version = await waitJson('http://127.0.0.1:9333/json/version')

// --- minimal CDP client over Node's built-in WebSocket ------------------------
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
function send(method, params = {}, sessionId) {
  const i = ++id
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params, sessionId }))
  })
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('DOM.enable', {}, sessionId)
await send('CSS.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function goto(url) {
  await send('Page.navigate', { url }, sessionId)
  await new Promise((r) => setTimeout(r, 900))
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
async function nodeIdFor(selector) {
  const { root } = await send('DOM.getDocument', { depth: -1 }, sessionId)
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId)
  return nodeId
}
async function forceState(selector, states) {
  const nodeId = await nodeIdFor(selector)
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states }, sessionId)
}
const PAINT = `(el) => { const c = getComputedStyle(el); return {
  background: c.backgroundColor, color: c.color, borderColor: c.borderTopColor,
  filter: c.filter, opacity: c.opacity, outlineColor: c.outlineColor,
  height: c.height, padding: c.paddingTop + ' ' + c.paddingLeft,
  borderRadius: c.borderTopLeftRadius, fontWeight: c.fontWeight, label: el.textContent.trim() } }`

async function paint(selector) {
  return evaluate(`(${PAINT})(document.querySelector(${JSON.stringify(selector)}))`)
}

const results = []
function record(name, value) { results.push({ name, ...value }) }

// === 1. the REAL SPA: the sign-in button, reachable without auth ==============
await goto(`http://127.0.0.1:${PORT}/`)
const signInSel = await evaluate(`
  (() => { const b = [...document.querySelectorAll('button')].find(b => /sign in/i.test(b.textContent)); 
    if (!b) return null; b.setAttribute('data-probe','signin'); return 'button[data-probe=signin]' })()`)
if (signInSel) {
  record('REAL SPA · Sign in with Google · default', await paint(signInSel))
  for (const st of [['hover'], ['active'], ['focus', 'focus-visible']]) {
    await forceState(signInSel, st)
    record(`REAL SPA · Sign in with Google · ${st[0]}`, await paint(signInSel))
    await forceState(signInSel, [])
  }
  await evaluate(`document.querySelector('button[data-probe=signin]').disabled = true`)
  record('REAL SPA · Sign in with Google · disabled', await paint(signInSel))
  // a link on the same real page, for the non-button regression check
  const linkPaint = await evaluate(`(() => { const a = document.querySelector('a'); return a ? getComputedStyle(a).color + ' | ' + a.textContent.trim() : 'no link' })()`)
  record('REAL SPA · first <a> link color', { color: linkPaint })
} else {
  record('REAL SPA · Sign in with Google', { error: 'button not found on the rendered SPA' })
}

// === 2. harness: every primary button + the non-button greens =================
await goto(`http://127.0.0.1:${PORT}/harness.html`)
const targets = await evaluate(`[...document.querySelectorAll('[data-probe]')].map(e => e.dataset.probe)`)
for (const probe of targets) {
  const sel = `[data-probe="${probe}"]`
  record(`HARNESS · ${probe} · default`, await paint(sel))
  if (probe.startsWith('btn')) {
    for (const st of [['hover'], ['active'], ['focus', 'focus-visible']]) {
      await forceState(sel, st)
      record(`HARNESS · ${probe} · ${st[0]}`, await paint(sel))
      await forceState(sel, [])
    }
    await evaluate(`document.querySelector('${sel}').disabled = true`)
    record(`HARNESS · ${probe} · disabled`, await paint(sel))
    await evaluate(`document.querySelector('${sel}').disabled = false`)
  }
}

console.log(JSON.stringify(results, null, 2))
ws.close(); chrome.kill(); server.close()
process.exit(0)
