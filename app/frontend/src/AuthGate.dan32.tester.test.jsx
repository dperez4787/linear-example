import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

// DAN-32 · App shell UI polish — TESTER verification.
//
// This suite is the tester's independent lock on the mechanically-checkable
// acceptance criteria of DAN-32. It asserts only on landmarks, roles, text, and
// the presence of focus-visible rules/hooks in the stylesheet — NOT on computed
// styles, class names, or aesthetics. Per the ticket, visual quality
// (alignment, spacing rhythm, control-height, typography hierarchy) is
// user-attested on the deployed site and is deliberately not asserted here.
//
// auth.js is mocked the same way the composed-tree suites do: subscribeToAuth
// immediately pushes the configured user, so there is no Firebase and no
// network.
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

describe('DAN-32 tester · signed-in header landmark holds all four items', () => {
  it('exposes a banner landmark with app title, user display name, /blog link, and Sign out', async () => {
    authMock.user = { displayName: 'Ada Lovelace', email: 'ada@example.com' }
    renderGate()

    await waitFor(() => expect(screen.getByText('records ui')).toBeInTheDocument())

    const banner = screen.getByRole('banner')
    const inBanner = within(banner)

    // App identity, the signed-in display name, the case-study link, Sign out —
    // all four inside the same header landmark.
    expect(inBanner.getByText('linear-example')).toBeInTheDocument()
    expect(inBanner.getByText('Ada Lovelace')).toBeInTheDocument()

    const link = inBanner.getByRole('link', { name: /danny's blog/i })
    expect(link).toHaveAttribute('href', '/blog')
    // The case-study link is a real anchor (an interactive hook the a:focus-visible
    // rule selects), not a button styled as a link.
    expect(link.tagName).toBe('A')

    const signOut = inBanner.getByRole('button', { name: /sign out/i })
    expect(signOut.tagName).toBe('BUTTON')
  })

  it('falls back to the email, then to a generic label, when displayName is absent', async () => {
    authMock.user = { email: 'grace@example.com' }
    renderGate()

    await waitFor(() => expect(screen.getByText('records ui')).toBeInTheDocument())
    const banner = screen.getByRole('banner')
    expect(within(banner).getByText('grace@example.com')).toBeInTheDocument()
  })
})

describe('DAN-32 tester · signed-out view uses the same shell landmarks', () => {
  it('renders the case-study link in the banner and the sign-in control in main', async () => {
    authMock.user = null
    renderGate()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /sign in with google/i }),
      ).toBeInTheDocument(),
    )

    // Signed-out is NOT a bare page: it carries the same banner landmark as the
    // signed-in view, holding the case-study link.
    const banner = screen.getByRole('banner')
    expect(within(banner).getByRole('link', { name: /danny's blog/i })).toHaveAttribute(
      'href',
      '/blog',
    )

    // The records heading and the sign-in control live inside the main landmark.
    const main = screen.getByRole('main')
    expect(
      within(main).getByRole('heading', { level: 1, name: 'Records' }),
    ).toBeInTheDocument()
    expect(
      within(main).getByRole('button', { name: /sign in with google/i }),
    ).toBeInTheDocument()
  })

  it('does not render the records children while signed out', async () => {
    authMock.user = null
    renderGate()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /sign in with google/i }),
      ).toBeInTheDocument(),
    )
    // Behavior frozen: the auth gate still withholds the records UI when there
    // is no user.
    expect(screen.queryByText('records ui')).not.toBeInTheDocument()
  })
})

describe('DAN-32 tester · focus-visible rules exist for every control type', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

  it('the stylesheet defines :focus-visible rules for button, input, select, and link', () => {
    expect(css).toMatch(/:focus-visible/)
    expect(css).toMatch(/button:focus-visible/)
    expect(css).toMatch(/input:focus-visible/)
    expect(css).toMatch(/select:focus-visible/)
    expect(css).toMatch(/a:focus-visible/)
  })
})
