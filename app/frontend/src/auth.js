// The single place that knows Firebase Auth exists. Wraps the Firebase SDK so the
// rest of the app (api.js, the auth context) depends on these small functions,
// not on Firebase directly — the same "one module owns the boundary" rule api.js
// follows for the API. Google is the ONLY sign-in path: no email/password, no
// anonymous. Those providers are disabled in Firebase (DAN-21) and are absent
// from the code by design.
import { getApp, getApps, initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth'

import { firebaseConfig } from './firebase.js'

// Lazily create the Firebase app + Auth instance. Kept out of module scope so
// that importing this file (or api.js, which imports it) has no side effects —
// the SDK only touches persistence/network once an auth operation actually runs.
// Reuses an already-created app to survive Vite HMR and test re-imports.
let cachedAuth
function auth() {
  if (!cachedAuth) {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig)
    cachedAuth = getAuth(app)
  }
  return cachedAuth
}

// Subscribe to sign-in/sign-out transitions. Returns Firebase's unsubscribe
// function so a React effect can clean up. The listener is called with the
// current user (or null) once persistence resolves, then on every change.
export function subscribeToAuth(listener) {
  return onAuthStateChanged(auth(), listener)
}

// Google sign-in via popup — the only sign-in the app offers.
export async function signInWithGoogle() {
  return signInWithPopup(auth(), new GoogleAuthProvider())
}

export async function signOutUser() {
  return signOut(auth())
}

// The current user's Firebase ID token, or null when nobody is signed in. api.js
// calls this to attach `Authorization: Bearer <token>`; a null token means the
// request goes out unauthenticated (the backend is still permissive until
// DAN-22). getIdToken() returns a fresh token, refreshing it if near expiry.
export async function getIdToken() {
  const user = auth().currentUser
  return user ? user.getIdToken() : null
}
