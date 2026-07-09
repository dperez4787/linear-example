import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import { signInWithGoogle, signOutUser, subscribeToAuth } from './auth.js'

// Holds the current Firebase user in React state and exposes sign-in/sign-out.
// This is the app's single source of auth truth: api.js maps a 401 to sign-out
// by calling signOutUser() (in auth.js), which fires onAuthStateChanged(null),
// which flows back through here to re-render the gate to the signed-out state —
// so a 401 becomes "signed out," not a generic error banner.
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  // `initializing` is true until Firebase resolves persisted auth on load, so the
  // gate can show a neutral loading state instead of flashing the sign-in screen
  // to an already-signed-in user.
  const [initializing, setInitializing] = useState(true)

  useEffect(() => {
    const unsubscribe = subscribeToAuth((nextUser) => {
      setUser(nextUser ?? null)
      setInitializing(false)
    })
    return unsubscribe
  }, [])

  const value = useMemo(
    () => ({
      user,
      initializing,
      signIn: signInWithGoogle,
      signOut: signOutUser,
    }),
    [user, initializing],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (ctx === null) {
    throw new Error('useAuth must be used within an <AuthProvider>')
  }
  return ctx
}
