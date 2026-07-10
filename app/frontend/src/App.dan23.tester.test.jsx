import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

// DAN-23 tester regression. The developer's api.test.jsx proves api.js attaches
// the token when listRecords() is called directly; auth.test.jsx proves the
// signed-out gate hides record data. These add the piece neither covers on its
// own: driving the REAL composed tree (AuthProvider -> AuthGate -> App), signed
// in, and asserting that the request App fires through api.js lands on a RELATIVE
// URL carrying `Authorization: Bearer <token>` — criteria 5 (token attached) and
// 7 (same-origin, no absolute backend URL) proven end-to-end, not in isolation.
//
// auth.js is mocked exactly as the app composes it, so getIdToken() is the same
// function api.js's authedFetch() calls — the header path is genuinely exercised.
const authMock = vi.hoisted(() => {
  let currentUser = { displayName: 'Grace Hopper', email: 'grace@example.com' }
  const listeners = new Set()
  return {
    subscribeToAuth: vi.fn((listener) => {
      listeners.add(listener)
      listener(currentUser)
      return () => listeners.delete(listener)
    }),
    signInWithGoogle: vi.fn(async () => {}),
    signOutUser: vi.fn(async () => {
      currentUser = null
      listeners.forEach((l) => l(null))
    }),
    getIdToken: vi.fn(async () => (currentUser ? 'bearer-token-e2e' : null)),
  }
})

vi.mock('./auth.js', () => ({
  subscribeToAuth: authMock.subscribeToAuth,
  signInWithGoogle: authMock.signInWithGoogle,
  signOutUser: authMock.signOutUser,
  getIdToken: authMock.getIdToken,
}))

function renderGatedApp() {
  return render(
    <StrictMode>
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>
    </StrictMode>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DAN-23 tester · end-to-end token attachment through the mounted App', () => {
  // DAN-25 moved the records surface to POST /api/graphql; the token-attachment and
  // same-origin guarantees exercised here are transport-independent, so the
  // assertions target /api/graphql. The 401 sign-out path stays covered by
  // api.test.jsx (a gate 401 is HTTP-level and never enters GraphQL).
  it('the signed-in App fires listRecords with a RELATIVE url and a Bearer header', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ records: [] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    renderGatedApp()

    // App loads on mount; wait for the request to go out.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    const [url, options] = fetchMock.mock.calls[0]
    // Relative, same-origin — an absolute backend URL would break the Hosting
    // rewrite and reintroduce CORS.
    expect(url).toBe('/api/graphql')
    expect(url.startsWith('http')).toBe(false)
    // The token the mounted tree resolved is on the request.
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer bearer-token-e2e',
    })
  })
})

describe('DAN-23 tester · Firebase config is public, relative, and not a backend secret', () => {
  // Criterion 2: the web config must live in a committed module / VITE_ vars and
  // must NOT be sourced from any backend-secret mechanism. Asserted structurally
  // against the real firebase.js source.
  it('firebase.js sources config only from literals or VITE_ env vars', () => {
    const raw = readFileSync(join(process.cwd(), 'src', 'firebase.js'), 'utf8')
    // Strip comments — the module's prose explains it is deliberately NOT a
    // secret ("NOT in Secret Manager, NOT handled like MONGODB_URI"), which is
    // the correct thing to say; only the CODE is under test here.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    // No backend-secret plumbing in the actual code.
    expect(code).not.toMatch(/MONGODB_URI/)
    expect(code).not.toMatch(/[Ss]ecret\s?[Mm]anager/)
    // No non-VITE process.env / import.meta.env reference sources a value.
    expect(code).not.toMatch(/process\.env\./)
    for (const ref of code.match(/import\.meta\.env\.[A-Za-z_]+/g) ?? []) {
      expect(ref).toMatch(/import\.meta\.env\.VITE_/)
    }
  })

  // Criterion 7: no source file introduces an absolute backend URL. Every request
  // stays relative so Firebase Hosting rewrites /api/** to Cloud Run same-origin.
  it('no source file hardcodes an absolute backend URL', () => {
    const srcDir = join(process.cwd(), 'src')
    const sources = readdirSync(srcDir).filter(
      (f) => (f.endsWith('.js') || f.endsWith('.jsx')) && !f.includes('.test.'),
    )
    for (const file of sources) {
      const text = readFileSync(join(srcDir, file), 'utf8')
      expect(text, `${file} must not hardcode a Cloud Run / absolute API URL`).not.toMatch(
        /https?:\/\/[^\s'"]*\/api/,
      )
      expect(text, `${file} must not reference *.run.app`).not.toMatch(/\.run\.app/)
    }
  })
})
