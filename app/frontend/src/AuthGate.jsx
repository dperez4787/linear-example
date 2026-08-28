import { useState } from 'react'

import { useAuth } from './AuthContext.jsx'
import { useTranslation } from './i18n.js'
import LanguageSwitcher from './LanguageSwitcher.jsx'
import { useLanguagePreference } from './languagePreference.js'

// The auth boundary. It wraps the records UI (App) so that record data is only
// ever mounted for a signed-in user: when there is no user, `children` (the
// table, the create form, every record) is not rendered at all — only a sign-in
// affordance is. This lives OUTSIDE App on purpose: App stays a pure records
// component (and its existing tests keep rendering it directly), while the gate
// owns the "are we allowed to see records" decision.
export default function AuthGate({ children }) {
  const { user, initializing, signIn, signOut } = useAuth()
  const [signInError, setSignInError] = useState(null)
  const { t } = useTranslation()
  // DAN-97: the gate is where "post-auth" is actually known, so it is where the
  // signed-in user's stored language gets read and later switches get mirrored
  // back. The hook renders nothing and fails soft; see languagePreference.js.
  useLanguagePreference(user)

  if (initializing) {
    return <p>{t('common.loading')}</p>
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
          setSignInError(err?.message ?? t('auth.signInFailed'))
        }
      }
    }

    return (
      <>
        <header className="app-header">
          <div className="container app-header__inner">
            <span className="app-title">linear-example</span>
            <div className="app-header__actions">
              <LanguageSwitcher />
              <a className="app-link" href="/blog">
                {t('nav.blog')}
              </a>
            </div>
          </div>
        </header>
        <main className="container">
          <h1>{t('records.title')}</h1>
          <p>{t('auth.signInPrompt')}</p>
          <button className="btn btn--primary" type="button" onClick={handleSignIn}>
            {t('auth.signInWithGoogle')}
          </button>
          {signInError && <p role="alert">{signInError}</p>}
        </main>
      </>
    )
  }

  // The header is a top-level landmark (a sibling of App's <main>), so it maps
  // to role="banner" and holds the whole app-shell chrome: app identity, the
  // signed-in user, the case-study link, and Sign out — laid out with the
  // shared content container instead of running together at the viewport edge.
  return (
    <>
      <header className="app-header">
        <div className="container app-header__inner">
          <span className="app-title">linear-example</span>
          <div className="app-header__actions">
            <span className="app-header__user">
              {user.displayName ?? user.email ?? t('nav.signedIn')}
            </span>
            <LanguageSwitcher />
            <a className="app-link" href="/blog">
              {t('nav.blog')}
            </a>
            <button className="btn" type="button" onClick={() => signOut()}>
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      </header>
      {children}
    </>
  )
}
