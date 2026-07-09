// DAN-17 tester verification. Independent of the developer's start.test.js.
//
// The developer's suite proves the negative/parity path (no .env, no crash).
// This suite locks the acceptance criteria the other one does not exercise:
//
//   1. `npm start`'s start script — spawned verbatim from package.json, NOT with
//      a hand-typed --env-file — loads app/backend/.env so MONGODB_URI is defined,
//      logs "connected to MongoDB" (and never "MongoDB connection failed at
//      startup"), and GET /api/records returns 200 with { records: [...] }.
//   2. GET /healthz returns 200 without touching Mongo.
//   3. Cloud Run parity, re-asserted independently: with .env absent AND no
//      ambient MONGODB_URI, the exact start-script flags are a no-op (not a hard
//      error), the server still listens, and /healthz is 200.
//
// The positive case needs a reachable Mongo. It resolves MONGODB_URI from
// app/backend/.env (or the ambient env) and skips — never fails — if neither is
// available, so a clean `npm ci && npm test` stays green offline. The URI is
// never logged.
//
// Run with: node --test src/start.tester.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const backendDir = fileURLToPath(new URL('..', import.meta.url))
const indexPath = fileURLToPath(new URL('./index.js', import.meta.url))
const envPath = fileURLToPath(new URL('../.env', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// The exact argv `npm start` runs, minus the `node` executable — parsed from the
// start script so this test breaks if the script stops using the flag.
const startArgs = pkg.scripts.start.trim().replace(/^node\s+/, '').split(/\s+/)

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// Spawn the server exactly as `npm start` does (start-script argv), waiting for
// the "backend listening" line. Rejects if the process exits before listening —
// which is what a bare --env-file=.env would do when .env is missing.
function startServer({ port, env }) {
  const child = spawn(process.execPath, [...startArgs], {
    cwd: backendDir,
    env: { ...env, PORT: String(port) },
  })
  let out = ''
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d.toString()
      if (out.includes('backend listening on')) resolve()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code})\n${out}`)))
  })
  return { child, ready, getOutput: () => out }
}

// Wait for the async connect() log to land after the server is already listening
// (index.js listens first, connects after).
async function waitFor(getOutput, re, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (re.test(getOutput())) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

function haveMongoUri() {
  if (process.env.MONGODB_URI) return true
  if (!existsSync(envPath)) return false
  return /^\s*MONGODB_URI\s*=\s*\S/m.test(readFileSync(envPath, 'utf8'))
}

test('start script uses --env-file-if-exists=.env and never bare --env-file', () => {
  assert.match(pkg.scripts.start, /--env-file-if-exists=\.env\b/)
  // Bare --env-file=<file> hard-fails when the file is absent (breaks Cloud Run).
  assert.doesNotMatch(pkg.scripts.start, /--env-file=/)
  assert.match(pkg.scripts.start, /src\/index\.js/)
})

test('.env present: start script loads MONGODB_URI, connects, and GET /api/records is 200 { records }', async (t) => {
  if (!haveMongoUri()) {
    t.skip('no MONGODB_URI in app/backend/.env or environment — cannot reach Mongo')
    return
  }
  const port = await freePort()
  // Point MONGODB_DB at the scratch DB so the test never reads the app database,
  // while MONGODB_URI is loaded by the start script's --env-file-if-exists.
  const { child, ready, getOutput } = startServer({
    port,
    env: { ...process.env, MONGODB_DB: 'linear_example_test' },
  })
  t.after(() => child.kill('SIGKILL'))

  await ready
  const connected = await waitFor(getOutput, /connected to MongoDB/)
  assert.ok(connected, `expected "connected to MongoDB", got:\n${getOutput()}`)
  assert.doesNotMatch(getOutput(), /MongoDB connection failed at startup/)

  const health = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })

  const res = await fetch(`http://127.0.0.1:${port}/api/records`)
  assert.equal(res.status, 200, 'data route must be 200, not 500 — .env was loaded')
  const body = await res.json()
  assert.ok(Array.isArray(body.records), `expected { records: [...] }, got ${JSON.stringify(body)}`)
})

test('Cloud Run parity: start-script flags no-op with .env absent and no MONGODB_URI; server listens, /healthz 200', async (t) => {
  const port = await freePort()
  const env = { ...process.env }
  delete env.MONGODB_URI
  delete env.MONGODB_DB
  // Keep the real start-script argv (so src/index.js resolves against backendDir)
  // but retarget the env-file flag at a filename that does not exist. This proves
  // the flag the script uses (--env-file-if-exists) no-ops on a missing file
  // instead of hard-failing the way bare --env-file=.env would in a container.
  const missingEnvArgs = startArgs.map((a) =>
    a.startsWith('--env-file-if-exists=') ? '--env-file-if-exists=__no_such_dan17__.env' : a,
  )
  assert.ok(
    missingEnvArgs.some((a) => a === '--env-file-if-exists=__no_such_dan17__.env'),
    'start script must carry an --env-file-if-exists flag to retarget',
  )
  const child = spawn(process.execPath, [...missingEnvArgs], {
    cwd: backendDir,
    env: { ...env, PORT: String(port) },
  })
  let out = ''
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d.toString()
      if (out.includes('backend listening on')) resolve()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code})\n${out}`)))
  })
  t.after(() => child.kill('SIGKILL'))

  await ready // rejects if bare --env-file would have crashed on the missing file

  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'ok' })
  assert.match(out, /MongoDB connection failed at startup/)
})
