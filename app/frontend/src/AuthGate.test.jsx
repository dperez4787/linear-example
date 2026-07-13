import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

// DAN-26: the SPA must offer a visible link to the static /blog case-study page,
// and it has to be reachable WITHOUT signing in — so the link is asserted in both
// the signed-out and the signed-in views the gate renders. auth.js is mocked the
// same way the composed-tree tests mock it (a subscribeToAuth that immediately
// pushes the configured user), so no Firebase and no network are involved.
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

describe('DAN-26 · AuthGate links to the /blog case study', () => {
  it('shows a visible /blog link in the signed-out view', async () => {
    authMock.user = null
    renderGate()

    // Confirm we are in the signed-out view, then assert the link.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /sign in with google/i }),
      ).toBeInTheDocument(),
    )
    const link = screen.getByRole('link', { name: /danny's blog/i })
    expect(link).toHaveAttribute('href', '/blog')
  })

  it('shows a visible /blog link in the signed-in view', async () => {
    authMock.user = { displayName: 'Grace Hopper', email: 'grace@example.com' }
    renderGate()

    // Confirm we are in the signed-in view (children rendered), then the link.
    await waitFor(() =>
      expect(screen.getByText('records ui')).toBeInTheDocument(),
    )
    const link = screen.getByRole('link', { name: /danny's blog/i })
    expect(link).toHaveAttribute('href', '/blog')
  })
})
