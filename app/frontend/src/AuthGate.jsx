import { useState } from 'react'

import { useAuth } from './AuthContext.jsx'

// The auth boundary. It wraps the records UI (App) so that record data is only
// ever mounted for a signed-in user: when there is no user, `children` (the
// table, the create form, every record) is not rendered at all — only a sign-in
// affordance is. This lives OUTSIDE App on purpose: App stays a pure records
// component (and its existing tests keep rendering it directly), while the gate
// owns the "are we allowed to see records" decision.
export default function AuthGate({ children }) {
  const { user, initializing, signIn, signOut } = useAuth()
  const [signInError, setSignInError] = useState(null)

  if (initializing) {
    return <p>Loading…</p>
  }

  if (!user) {
    async function handleSignIn() {
      setSignInError(null)
      try {
        await signIn()
      } catch (err) {
        // A user closing the Google popup rejects with auth/popup-closed-by-user;
        // surface anything else so a real misconfiguration isn't silent.
        if (err?.code !== 'auth/popup-closed-by-user') {
          setSignInError(err?.message ?? 'Sign-in failed')
        }
      }
    }

    return (
      <main>
        <h1>Records</h1>
        <p>Sign in to view and manage records.</p>
        <button type="button" onClick={handleSignIn}>
          Sign in with Google
        </button>
        {signInError && <p role="alert">{signInError}</p>}
      </main>
    )
  }

  return (
    <>
      <header>
        <span>{user.displayName ?? user.email ?? 'Signed in'}</span>
        <button type="button" onClick={() => signOut()}>
          Sign out
        </button>
      </header>
      {children}
    </>
  )
}
