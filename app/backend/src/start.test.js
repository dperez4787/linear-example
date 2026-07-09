// DAN-17: `npm start` must load app/backend/.env locally without the operator
// passing --env-file by hand, and must NOT depend on .env existing (Cloud Run
// injects MONGODB_URI from Secret Manager and ships no .env). The fix lives in
// the `start` script: `node --env-file-if-exists=.env src/index.js`. Unlike
// bare `--env-file=.env`, `--env-file-if-exists` is a no-op when the file is
// absent instead of hard-failing at startup.
//
// Run with: node --test src/start.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const backendDir = fileURLToPath(new URL('..', import.meta.url))
const indexPath = fileURLToPath(new URL('./index.js', import.meta.url))

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

// Spawn the server the way the start script does — with --env-file-if-exists —
// and resolve once it logs that it is listening (or reject if it exits first).
function startServer({ envFile, port, env }) {
  const child = spawn(
    process.execPath,
    [`--env-file-if-exists=${envFile}`, indexPath],
    { cwd: backendDir, env: { ...env, PORT: String(port) } },
  )
  let out = ''
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d.toString()
      if (out.includes('backend listening on')) resolve()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })
    child.on('exit', (code) =>
      reject(new Error(`server exited early (code ${code})\n${out}`)),
    )
  })
  return { child, ready, getOutput: () => out }
}

test('the start script loads .env if present and is a no-op when absent (--env-file-if-exists)', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  // The flag is what repairs local dev (loads .env) without breaking Cloud Run
  // (no crash when .env is absent). Bare --env-file=.env would fail the latter.
  assert.match(pkg.scripts.start, /--env-file-if-exists=\.env\b/)
  assert.doesNotMatch(
    pkg.scripts.start,
    /--env-file=/,
    'must not use bare --env-file, which hard-fails when .env is absent',
  )
  assert.match(pkg.scripts.start, /src\/index\.js/)
})

test('Cloud Run parity: with no .env and no MONGODB_URI, the server still listens and /health is 200', async (t) => {
  const port = await freePort()
  // Strip MONGODB_URI/MONGODB_DB so the process environment mirrors a container
  // that has neither a .env file nor the secret yet at connect() time. Point
  // --env-file-if-exists at a path that does not exist to prove it is a no-op.
  const env = { ...process.env }
  delete env.MONGODB_URI
  delete env.MONGODB_DB
  const { child, ready, getOutput } = startServer({
    envFile: fileURLToPath(new URL('./__no_such__.env', import.meta.url)),
    port,
    env,
  })
  t.after(() => child.kill('SIGKILL'))

  await ready // rejects if the process crashed instead of listening

  const res = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'ok' })

  // The startup try/catch keeps the server up even though connect() failed for
  // lack of MONGODB_URI — that is the designed Cloud-Run-safe behavior.
  assert.match(getOutput(), /MongoDB connection failed at startup/)
})
