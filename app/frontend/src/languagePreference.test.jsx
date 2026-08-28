import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, changeLanguage, i18n } from './i18n.js'

// DAN-97: cross-device language persistence. These exercise the whole bridge
// through the real header — AuthGate mounts the hook and renders DAN-95's
// switcher — with only api.js and auth.js mocked, so what is asserted is the
// user-visible outcome (which language the app lands in) rather than the hook's
// internals.
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

vi.mock('./api.js', () => ({
  languagePreference: vi.fn(async () => null),
  setLanguagePreference: vi.fn(async (language) => language),
  // AuthGate's children are stubbed in these tests, so nothing else in api.js
  // is reached; listRecords is here only so the module shape stays honest.
  listRecords: vi.fn(async () => []),
}))

const { languagePreference, setLanguagePreference } = await import('./api.js')

const SIGNED_IN = { uid: 'uid-grace', displayName: 'Grace Hopper' }

function renderApp() {
  return render(
    <AuthProvider>
      <AuthGate>
        <div>records ui</div>
      </AuthGate>
    </AuthProvider>,
  )
}

function selector() {
  return screen.getByRole('combobox', { name: /language|idioma/i })
}

beforeEach(() => {
  authMock.user = SIGNED_IN
  languagePreference.mockReset().mockResolvedValue(null)
  setLanguagePreference.mockReset().mockImplementation(async (language) => language)
})

// i18next is a singleton shared by the whole suite file set, so a test that
// switches the language has to put it back. This runs before the global
// cleanup(), so components are still mounted and the reset re-renders them —
// hence act().
afterEach(async () => {
  authMock.user = null
  await act(async () => {
    await changeLanguage(DEFAULT_LANGUAGE)
  })
  window.localStorage.clear()
})

describe('DAN-97 · a stored server preference decides the language on load', () => {
  it('lands a fresh load in Spanish with no user action', async () => {
    languagePreference.mockResolvedValue('es')

    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument(),
    )
    expect(selector()).toHaveValue('es')
    expect(languagePreference).toHaveBeenCalledTimes(1)
  })

  it('overrides the locally stored default rather than deferring to it', async () => {
    // DAN-95 boots this session in English (the module-level default); the
    // server says the user chose Spanish on some other device.
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
    languagePreference.mockResolvedValue('es')

    renderApp()

    await waitFor(() => expect(i18n.resolvedLanguage).toBe('es'))
    // And DAN-95's own persistence picks the server's value up, so the next
    // load of this device starts there even before the read returns.
    await waitFor(() =>
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es'),
    )
  })

  it('does not write the value it just read back to the server', async () => {
    languagePreference.mockResolvedValue('es')

    renderApp()

    await waitFor(() => expect(i18n.resolvedLanguage).toBe('es'))
    expect(setLanguagePreference).not.toHaveBeenCalled()
  })

  it('ignores a language this build does not ship', async () => {
    languagePreference.mockResolvedValue('fr')

    renderApp()

    await waitFor(() => expect(languagePreference).toHaveBeenCalled())
    expect(i18n.resolvedLanguage).toBe('en')
    expect(setLanguagePreference).not.toHaveBeenCalled()
  })

  it('leaves the UI in the local language when the read fails', async () => {
    languagePreference.mockRejectedValue(new Error('network down'))

    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument(),
    )
    expect(i18n.resolvedLanguage).toBe('en')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('DAN-97 · changing the language writes it through', () => {
  it('calls setLanguagePreference exactly once per change, with the new value', async () => {
    const user = userEvent.setup()
    renderApp()

    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    await user.selectOptions(selector(), 'es')

    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledTimes(1))
    expect(setLanguagePreference).toHaveBeenCalledWith('es')

    // Switching back is a second change, not a repeat of the first.
    await user.selectOptions(selector(), 'en')

    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledTimes(2))
    expect(setLanguagePreference).toHaveBeenLastCalledWith('en')
  })

  it('leaves the UI switched, with no error surfaced, when the write fails', async () => {
    const user = userEvent.setup()
    setLanguagePreference.mockRejectedValue(new Error('write rejected'))
    renderApp()

    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    await user.selectOptions(selector(), 'es')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument(),
    )
    expect(setLanguagePreference).toHaveBeenCalledWith('es')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // The local fallback still holds the choice for the next load.
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
  })

  it('does not touch the server while signed out', async () => {
    const user = userEvent.setup()
    authMock.user = null
    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument(),
    )

    await user.selectOptions(selector(), 'es')

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Iniciar sesión con Google' }),
      ).toBeInTheDocument(),
    )
    expect(languagePreference).not.toHaveBeenCalled()
    expect(setLanguagePreference).not.toHaveBeenCalled()
  })
})

describe('DAN-97 · no stored preference is exactly DAN-95 behaviour', () => {
  it('keeps the locally stored language when the server has none', async () => {
    // A null preference must not reset a user who picked Spanish on this device
    // before ever having a server row.
    languagePreference.mockResolvedValue(null)
    renderApp()

    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    await act(async () => {
      await changeLanguage('es')
    })
    // The pending/resolved null read never calls changeLanguage, so nothing
    // pulls the UI back to English.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument(),
    )
    expect(i18n.resolvedLanguage).toBe('es')
  })

  it('still boots in English with neither a server nor a local preference', async () => {
    languagePreference.mockResolvedValue(null)

    renderApp()

    await waitFor(() => expect(languagePreference).toHaveBeenCalled())
    expect(i18n.resolvedLanguage).toBe('en')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(setLanguagePreference).not.toHaveBeenCalled()
  })
})
