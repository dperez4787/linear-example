import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

// DAN-32 · App shell UI polish. This suite verifies the mechanically-checkable
// structure the ticket introduces — the header landmark and its contents, the
// signed-out landmark structure, and the presence of focus-visible hooks in the
// stylesheet. Visual quality (alignment, spacing, typography) is user-attested
// on the deployed site and is NOT asserted here.
//
// auth.js is mocked exactly as the other composed-tree suites do: a
// subscribeToAuth that immediately pushes the configured user, so no Firebase
// and no network are involved.
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

describe('DAN-32 · signed-in header landmark', () => {
  it('renders a banner holding the app title, user name, /blog link, and Sign out', async () => {
    authMock.user = { displayName: 'Grace Hopper', email: 'grace@example.com' }
    renderGate()

    await waitFor(() => expect(screen.getByText('records ui')).toBeInTheDocument())

    const banner = screen.getByRole('banner')
    const inBanner = within(banner)

    // App identity.
    expect(inBanner.getByText('linear-example')).toBeInTheDocument()
    // Signed-in user's display name.
    expect(inBanner.getByText('Grace Hopper')).toBeInTheDocument()
    // Case-study link.
    expect(inBanner.getByRole('link', { name: /danny's blog/i })).toHaveAttribute(
      'href',
      '/blog',
    )
    // Sign out control.
    expect(inBanner.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })
})

describe('DAN-32 · signed-out landmark structure', () => {
  it('renders the sign-in control and case-study link inside the shell landmarks', async () => {
    authMock.user = null
    renderGate()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /sign in with google/i }),
      ).toBeInTheDocument(),
    )

    // Same banner landmark as the signed-in view, carrying the case-study link.
    const banner = screen.getByRole('banner')
    expect(within(banner).getByRole('link', { name: /danny's blog/i })).toHaveAttribute(
      'href',
      '/blog',
    )
    // The records heading + sign-in control live in the main landmark.
    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { name: 'Records' })).toBeInTheDocument()
    expect(
      within(main).getByRole('button', { name: /sign in with google/i }),
    ).toBeInTheDocument()
  })
})

describe('DAN-32 · focus-visible hooks exist in the stylesheet', () => {
  // Vitest runs with the frontend package as cwd, so resolve the stylesheet
  // from there (import.meta.url is a virtual path under the transform).
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

  it('defines focus-visible rules targeting buttons, inputs, selects, and links', () => {
    expect(css).toMatch(/:focus-visible/)
    // The focus rule selects each interactive element type.
    expect(css).toMatch(/button:focus-visible/)
    expect(css).toMatch(/input:focus-visible/)
    expect(css).toMatch(/select:focus-visible/)
    expect(css).toMatch(/a:focus-visible/)
  })
})
