import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'
import { signInWithGoogle, signOutUser } from './auth.js'

// A controllable in-memory stand-in for ./auth.js — the module that wraps the
// Firebase SDK. Mocking it here drives the whole gate (AuthProvider -> AuthGate
// -> App) through sign-in / sign-out / 401 with no real Firebase. The mutable
// user state lives in a vi.hoisted() closure so the (hoisted) vi.mock factory can
// reference it.
const authMock = vi.hoisted(() => {
  let currentUser = null
  const listeners = new Set()
  const emit = () => listeners.forEach((l) => l(currentUser))
  return {
    reset() {
      currentUser = null
      listeners.clear()
    },
    setUser(user) {
      currentUser = user
      emit()
    },
    subscribeToAuth: vi.fn((listener) => {
      listeners.add(listener)
      listener(currentUser) // resolve initial auth state immediately
      return () => listeners.delete(listener)
    }),
    signInWithGoogle: vi.fn(async () => {
      currentUser = { displayName: 'Ada Lovelace', email: 'ada@example.com' }
      emit()
    }),
    signOutUser: vi.fn(async () => {
      currentUser = null
      emit()
    }),
    getIdToken: vi.fn(async () => (currentUser ? 'test-id-token' : null)),
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

// This suite drives the REAL api.js (not a mock), so the fetch stub must return the
// GraphQL transport's response shape: HTTP 200 with { data: { records } } (DAN-25).
function stubFetchOk(records = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { records } }) })),
  )
}

beforeEach(() => {
  authMock.reset()
  authMock.subscribeToAuth.mockClear()
  authMock.signInWithGoogle.mockClear()
  authMock.signOutUser.mockClear()
  authMock.getIdToken.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuthGate · signed out', () => {
  it('renders a Google sign-in affordance and NO record data when no user is signed in', async () => {
    stubFetchOk([{ id: 'a1', name: 'Alpha', status: 'active', amount: 1, notes: '' }])

    renderGatedApp()

    expect(
      await screen.findByRole('button', { name: 'Sign in with Google' }),
    ).toBeInTheDocument()
    // The records UI is not mounted: no table, and the create form is absent.
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    // App is not mounted, so the API is never even hit while signed out.
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('AuthGate · sign-in', () => {
  it('signs in with Google (only) and then reveals the records table', async () => {
    stubFetchOk([{ id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'n' }])

    renderGatedApp()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }))

    // The records now load — the gate mounted App only after sign-in.
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(signInWithGoogle).toHaveBeenCalledTimes(1)
    // A sign-out affordance is now available.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })
})

describe('AuthGate · sign-out', () => {
  it('returns to the signed-out state when the user signs out', async () => {
    authMock.setUser({ displayName: 'Ada', email: 'ada@example.com' })
    stubFetchOk([{ id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'n' }])

    renderGatedApp()
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(
      await screen.findByRole('button', { name: 'Sign in with Google' }),
    ).toBeInTheDocument()
    expect(signOutUser).toHaveBeenCalled()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })
})

describe('AuthGate · 401 drops to signed-out (not an error banner)', () => {
  it('a 401 from the API returns the app to the sign-in affordance', async () => {
    authMock.setUser({ displayName: 'Ada', email: 'ada@example.com' })
    // Signed in, but the API rejects the token: every request 401s.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'unauthorized' } }),
      })),
    )

    renderGatedApp()

    // The 401 drove a sign-out, so the sign-in affordance is what the user sees —
    // NOT a generic "Could not load records" error banner.
    expect(
      await screen.findByRole('button', { name: 'Sign in with Google' }),
    ).toBeInTheDocument()
    expect(signOutUser).toHaveBeenCalled()
    expect(screen.queryByText(/Could not load records/)).not.toBeInTheDocument()
  })
})

// CLAUDE.md: components never call fetch() or touch the auth SDK directly — that
// belongs to api.js and auth.js. This asserts it structurally: no component
// source (.jsx) mentions fetch( or getIdToken.
describe('no fetch()/getIdToken() inside components', () => {
  it('no *.jsx component references fetch( or getIdToken', () => {
    // Vitest runs with cwd at the frontend package root, so components live here.
    const srcDir = join(process.cwd(), 'src')
    const componentFiles = readdirSync(srcDir).filter(
      (f) => f.endsWith('.jsx') && !f.includes('.test.'),
    )

    // Sanity: we are actually scanning the components, not an empty set.
    expect(componentFiles).toContain('App.jsx')
    expect(componentFiles).toContain('AuthGate.jsx')

    for (const file of componentFiles) {
      const source = readFileSync(join(srcDir, file), 'utf8')
      expect(source, `${file} must not call fetch()`).not.toMatch(/fetch\s*\(/)
      expect(source, `${file} must not call getIdToken`).not.toMatch(/getIdToken/)
    }
  })
})
