import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, changeLanguage } from './i18n.js'
import LanguageSwitcher from './LanguageSwitcher.jsx'
import RecordTable from './RecordTable.jsx'

// DAN-95: the selector itself, and the thing that actually matters about it —
// toggling it repaints the UI around it immediately, with no reload, and the
// choice lands in localStorage.
//
// auth.js is mocked exactly as the other AuthGate suites do it (a
// subscribeToAuth that pushes the configured user straight through), so the
// header renders with no Firebase and no network.
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

// i18next is a singleton, so a test that switches the language has to put it
// back or it leaks into the next one.
// This runs before the global cleanup() (Vitest unwinds afterEach hooks in
// reverse registration order), so components are still mounted and the reset
// re-renders them — hence act().
afterEach(async () => {
  authMock.user = null
  await act(async () => {
    await changeLanguage(DEFAULT_LANGUAGE)
  })
  window.localStorage.clear()
})

function selector() {
  return screen.getByRole('combobox', { name: /language|idioma/i })
}

describe('DAN-95 · the language selector', () => {
  it('is a labelled control offering English and Spanish, starting on English', () => {
    render(<LanguageSwitcher />)

    const select = screen.getByLabelText('Language')
    expect(select).toHaveValue('en')
    expect(
      screen.getByRole('option', { name: 'English' }),
    ).toBeInTheDocument()
    // Named in its own language, not translated into the current one.
    expect(
      screen.getByRole('option', { name: 'Español' }),
    ).toBeInTheDocument()
  })

  it('repaints the surrounding UI immediately when toggled, and back again', async () => {
    const user = userEvent.setup()
    render(
      <>
        <LanguageSwitcher />
        <RecordTable records={[]} onSave={() => {}} onDelete={() => {}} />
      </>,
    )

    // English to start: table chrome, an empty state, and a filter label.
    expect(screen.getByText('No records yet.')).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: /Amount/ }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by name')).toBeInTheDocument()

    await user.selectOptions(selector(), 'es')

    // No remount, no reload — the same tree, now in Spanish.
    await waitFor(() =>
      expect(screen.getByText('Todavía no hay registros.')).toBeInTheDocument(),
    )
    expect(
      screen.getByRole('columnheader', { name: /Importe/ }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Filtrar por nombre')).toBeInTheDocument()
    expect(screen.queryByText('No records yet.')).not.toBeInTheDocument()

    // And the switch is reversible from the now-Spanish control.
    await user.selectOptions(selector(), 'en')

    await waitFor(() =>
      expect(screen.getByText('No records yet.')).toBeInTheDocument(),
    )
  })

  it('stores the chosen language in localStorage', async () => {
    const user = userEvent.setup()
    render(<LanguageSwitcher />)

    await user.selectOptions(selector(), 'es')

    await waitFor(() =>
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es'),
    )
  })
})

describe('DAN-95 · the selector lives in the app header', () => {
  it('is reachable without signing in, and switches the sign-in screen', async () => {
    const user = userEvent.setup()
    authMock.user = null
    render(
      <AuthProvider>
        <AuthGate>
          <div>records ui</div>
        </AuthGate>
      </AuthProvider>,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Sign in with Google' }),
      ).toBeInTheDocument(),
    )

    await user.selectOptions(selector(), 'es')

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Iniciar sesión con Google' }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByText('Inicia sesión para ver y gestionar los registros.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Registros' }),
    ).toBeInTheDocument()
  })

  it('switches the signed-in header chrome', async () => {
    const user = userEvent.setup()
    authMock.user = { displayName: 'Grace Hopper', email: 'grace@example.com' }
    render(
      <AuthProvider>
        <AuthGate>
          <div>records ui</div>
        </AuthGate>
      </AuthProvider>,
    )

    await waitFor(() =>
      expect(screen.getByText('records ui')).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()

    await user.selectOptions(selector(), 'es')

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Cerrar sesión' }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByRole('link', { name: 'Ir al blog de Danny' }),
    ).toBeInTheDocument()
    // The signed-in user's own name is data, not UI text — it must not change.
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
  })
})
