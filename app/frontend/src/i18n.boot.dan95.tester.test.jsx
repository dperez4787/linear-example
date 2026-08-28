import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// DAN-95 · INDEPENDENT TESTER SUITE — the "second visit".
//
// AC4 is not only "write the preference to localStorage", it is "the session's
// language preference is stored" — which is worth nothing unless a later visit
// comes back up in it. That is a BOOT-TIME behaviour: it happens once, when
// src/i18n.js is first evaluated and initializes the i18next singleton.
//
// It therefore cannot be proven in a file that has already imported the module
// (vi.resetModules() re-evaluates the app's own modules but not the i18next
// package behind them, so the already-initialized instance survives and the
// re-run init is skipped). This file exists so the preference is written to
// localStorage BEFORE the first import of i18n.js in this process, exactly as a
// browser reload would find it — hence the top-level await imports below, which
// must stay dynamic: a static `import App from './App.jsx'` would evaluate
// i18n.js before the setItem on line 1 of the body ever ran.

vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => {
    listener({ displayName: 'Test User', email: 'test@example.com' })
    return () => {}
  }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => 'token'),
}))

vi.mock('./api.js', () => ({
  listRecords: vi.fn(async () => []),
  createRecord: vi.fn(async (r) => ({ ...r, id: 'r1' })),
  updateRecord: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteRecord: vi.fn(async () => {}),
}))

// The preference a previous session left behind.
window.localStorage.setItem('linear-example.language', 'es')

const { i18n, initialLanguage, LANGUAGE_STORAGE_KEY } = await import('./i18n.js')
const { default: App } = await import('./App.jsx')
const { AuthProvider } = await import('./AuthContext.jsx')
const { default: AuthGate } = await import('./AuthGate.jsx')
const { default: es } = await import('./locales/es.json')
const { default: en } = await import('./locales/en.json')

describe('DAN-95 AC4 · a later visit comes back up in the stored language', () => {
  // Guard: if some other file had already initialized the singleton, the
  // premise of this file would be false and every assertion below would be
  // meaningless. Fail loudly instead.
  it('used the stored preference as the boot language', () => {
    expect(LANGUAGE_STORAGE_KEY).toBe('linear-example.language')
    expect(i18n.isInitialized).toBe(true)
    expect(initialLanguage).toBe('es')
    expect(i18n.language).toBe('es')
    expect(i18n.options.lng).toBe('es')
  })

  it('renders the whole app shell in Spanish with no user interaction at all', async () => {
    render(
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>,
    )

    // Empty state, heading, navigation, buttons and labels — all Spanish on
    // first paint, nothing toggled.
    await screen.findByText(es.records.table.empty)
    expect(screen.getByRole('heading', { name: es.records.title })).toBeInTheDocument()
    expect(screen.getByText(es.nav.blog)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es.nav.signOut })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es.records.form.submit })).toBeInTheDocument()
    expect(screen.getByLabelText(es.records.table.filterByName)).toBeInTheDocument()

    // The switcher reflects the restored language rather than defaulting to en.
    expect(screen.getByLabelText(es.language.label).value).toBe('es')

    // No English survives on the restored screen.
    expect(screen.queryByText(en.records.table.empty)).toBeNull()
    expect(screen.queryByRole('button', { name: en.nav.signOut })).toBeNull()
  })

  it('sets <html lang> from the stored preference at boot', () => {
    expect(document.documentElement.lang).toBe('es')
  })
})
