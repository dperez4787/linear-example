// DAN-26 tester verification. Independent of the developer's own AuthGate.test.jsx.
// Locks the invariants the ticket's acceptance criteria hinge on:
//   1. The static /blog asset that Vite copies verbatim into dist/blog/index.html
//      carries the delivered document (title "An Agentic SDLC, End to End") and the
//      one implementer addition: a single visible back-link to the app at href="/".
//   2. The SPA renders a visible <a href="/blog"> in BOTH the signed-out and the
//      signed-in views, so the case study is reachable without signing in.
// The static-asset checks read the repo file directly (the source of dist/blog),
// mirroring the emulator GET /blog and the diff-scope criterion at the unit level.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

// Vitest runs with cwd = app/frontend; public/blog/index.html is the source Vite
// copies verbatim into dist/blog/index.html.
const blogPath = resolve(process.cwd(), 'public/blog/agentic-sdlc/index.html')
const blog = readFileSync(blogPath, 'utf8')

describe('DAN-26 · static /blog asset', () => {
  it('is the delivered case-study document (title verbatim)', () => {
    expect(blog).toContain('<title>An Agentic SDLC, End to End</title>')
    expect(blog.startsWith('<!doctype html>')).toBe(true)
  })

  it('has exactly one visible back-link to the app at href="/"', () => {
    const backLinks = blog.match(/<a[^>]*\shref="\/"[^>]*>/g) ?? []
    expect(backLinks).toHaveLength(1)
    // The back-link carries visible text, not an empty anchor.
    const anchor = blog.match(/<a[^>]*\shref="\/"[^>]*>([\s\S]*?)<\/a>/)
    expect(anchor?.[1].replace(/&larr;|\s|<[^>]*>/g, '').length).toBeGreaterThan(0)
  })
})

// auth.js is mocked exactly the way the composed-tree tests mock it: a
// subscribeToAuth that immediately pushes the configured user. No Firebase,
// no network.
const authMock = vi.hoisted(() => ({ user: null }))

vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => {
    listener(authMock.user)
    return () => {}
  }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => (authMock.user ? 'token' : null)),
}))

function renderGate() {
  return render(
    <AuthProvider>
      <AuthGate>
        <div>records ui</div>
      </AuthGate>
    </AuthProvider>,
  )
}

afterEach(() => {
  authMock.user = null
})

describe('DAN-26 · SPA links to /blog in both auth states', () => {
  it('signed-out view shows a visible <a href="/blog">', async () => {
    authMock.user = null
    renderGate()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /sign in with google/i }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('link', { name: /danny's blog/i })).toHaveAttribute(
      'href',
      '/blog',
    )
  })

  it('signed-in view shows a visible <a href="/blog">', async () => {
    authMock.user = { displayName: 'Ada Lovelace', email: 'ada@example.com' }
    renderGate()
    await waitFor(() => expect(screen.getByText('records ui')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /danny's blog/i })).toHaveAttribute(
      'href',
      '/blog',
    )
  })
})
