import { StrictMode } from 'react'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LanguageSwitcher from './LanguageSwitcher.jsx'
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, changeLanguage, i18n } from './i18n.js'
import { useLanguagePreference } from './languagePreference.js'

// DAN-97 TESTER · the hook's lifecycle edges, with api.js mocked.
//
// `dan97.tester.test.jsx` covers the criteria over a real socket. This file
// covers the things a socket cannot make happen on demand: a StrictMode double
// mount, a read that loses a race with the user, two switches inside one tick,
// and the identity of the effect's dependency (uid vs. the Firebase user
// object). The PR lists the StrictMode case explicitly as reasoned-about rather
// than observed, so it is asserted here rather than argued.
//
// The hook is driven directly, next to DAN-95's real switcher and the real
// i18next singleton, so `user` can be changed one field at a time — which is
// the whole point of tests 5 and 6.

vi.mock('./api.js', () => ({
  languagePreference: vi.fn(async () => null),
  setLanguagePreference: vi.fn(async (language) => language),
}))

const { languagePreference, setLanguagePreference } = await import('./api.js')

const ADA = { uid: 'uid-ada', displayName: 'Ada Lovelace' }
const BOB = { uid: 'uid-bob', displayName: 'Bob' }

function Harness({ user }) {
  useLanguagePreference(user)
  return <LanguageSwitcher />
}

const selector = () => screen.getByRole('combobox', { name: /language|idioma/i })

// A promise this test resolves by hand, so "the read is still in flight" is a
// state the test controls rather than a timing it hopes for.
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  languagePreference.mockReset().mockResolvedValue(null)
  setLanguagePreference.mockReset().mockImplementation(async (language) => language)
})

// Unmount before resetting the singleton: a reset with the hook still mounted
// fires `languageChanged` at it and would be counted as a write.
afterEach(async () => {
  cleanup()
  await act(async () => {
    await changeLanguage(DEFAULT_LANGUAGE)
  })
  window.localStorage.clear()
})

describe('DAN-97 · StrictMode double mount', () => {
  it('applies the stored preference once and still writes nothing back', async () => {
    languagePreference.mockResolvedValue('es')

    render(
      <StrictMode>
        <Harness user={ADA} />
      </StrictMode>,
    )

    await waitFor(() => expect(i18n.resolvedLanguage).toBe('es'))
    // React 18 mounts, unmounts and remounts the effect in StrictMode, so a
    // second read is expected and harmless; a WRITE would not be — it would
    // mean the echo guard does not survive the remount, and every StrictMode
    // load would issue a redundant mutation.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(setLanguagePreference).not.toHaveBeenCalled()
    expect(selector()).toHaveValue('es')
  })

  it('still writes exactly once for a real switch after the double mount', async () => {
    const user = userEvent.setup()
    render(
      <StrictMode>
        <Harness user={ADA} />
      </StrictMode>,
    )
    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    await user.selectOptions(selector(), 'es')

    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    // A leaked listener from the discarded first mount would double this.
    expect(setLanguagePreference).toHaveBeenCalledTimes(1)
    expect(setLanguagePreference).toHaveBeenCalledWith('es')
  })
})

describe('DAN-97 · the read racing the user', () => {
  it('a read that lands after the user switched does not undo their pick', async () => {
    const user = userEvent.setup()
    const read = deferred()
    languagePreference.mockReturnValue(read.promise)

    render(<Harness user={ADA} />)
    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    // The user gets there first.
    await user.selectOptions(selector(), 'es')
    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledWith('es'))

    // Only now does the server answer, with the stale value.
    await act(async () => {
      read.resolve('en')
      await read.promise
    })

    expect(i18n.resolvedLanguage).toBe('es')
    expect(selector()).toHaveValue('es')
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
  })

  it('a read that lands after unmount does not touch the language', async () => {
    const read = deferred()
    languagePreference.mockReturnValue(read.promise)

    const view = render(<Harness user={ADA} />)
    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    view.unmount()

    await act(async () => {
      read.resolve('es')
      await read.promise
    })

    expect(i18n.resolvedLanguage).toBe('en')
  })
})

describe('DAN-97 · repeated and rapid switches', () => {
  it('two switches in flight produce two writes, ending on the later value', async () => {
    render(<Harness user={ADA} />)
    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    // Both switches issued before either write settles.
    let pending
    setLanguagePreference.mockImplementation(async (language) => {
      pending = language
      await new Promise((resolve) => setTimeout(resolve, 20))
      return language
    })

    await act(async () => {
      await changeLanguage('es')
      await changeLanguage('en')
    })

    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledTimes(2))
    expect(setLanguagePreference.mock.calls.map(([l]) => l)).toEqual(['es', 'en'])
    expect(pending).toBe('en')
  })

  it('a failed write is not retried, but the next real change still syncs', async () => {
    render(<Harness user={ADA} />)
    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    setLanguagePreference.mockRejectedValueOnce(new Error('write rejected'))
    await act(async () => {
      await changeLanguage('es')
    })
    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledTimes(1))

    // The mirror is now stale, and nothing retries it — that is what "soft
    // failure" costs, and the criterion allows it. What must NOT be true is
    // that the session is stuck out of sync forever: the next change syncs.
    await act(async () => {
      await changeLanguage('en')
    })
    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledTimes(2))
    expect(setLanguagePreference).toHaveBeenLastCalledWith('en')
  })

  it('re-applying the language already in effect does not write again', async () => {
    render(<Harness user={ADA} />)
    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    await act(async () => {
      await changeLanguage('es')
    })
    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledTimes(1))

    await act(async () => {
      await changeLanguage('es')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(setLanguagePreference).toHaveBeenCalledTimes(1)
  })
})

describe('DAN-97 · which user the preference belongs to', () => {
  it('a token refresh (new object, same uid) does not re-read or stomp a switch', async () => {
    languagePreference.mockResolvedValue('en')
    const view = render(<Harness user={ADA} />)
    await waitFor(() => expect(languagePreference).toHaveBeenCalledTimes(1))

    await act(async () => {
      await changeLanguage('es')
    })
    await waitFor(() => expect(setLanguagePreference).toHaveBeenCalledWith('es'))

    // Firebase hands back a fresh object on every refresh; same person.
    view.rerender(<Harness user={{ uid: 'uid-ada', displayName: 'Ada Lovelace' }} />)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(languagePreference).toHaveBeenCalledTimes(1)
    expect(i18n.resolvedLanguage).toBe('es')
  })

  it('a different uid re-reads and applies that user\'s own preference', async () => {
    languagePreference.mockResolvedValue(null)
    const view = render(<Harness user={ADA} />)
    await waitFor(() => expect(languagePreference).toHaveBeenCalledTimes(1))
    expect(i18n.resolvedLanguage).toBe('en')

    languagePreference.mockResolvedValue('es')
    view.rerender(<Harness user={BOB} />)

    await waitFor(() => expect(languagePreference).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('es'))
    expect(setLanguagePreference).not.toHaveBeenCalled()
  })

  it('signing out stops the write-through', async () => {
    const view = render(<Harness user={ADA} />)
    await waitFor(() => expect(languagePreference).toHaveBeenCalled())

    view.rerender(<Harness user={null} />)

    await act(async () => {
      await changeLanguage('es')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // A write here would 401 and, via api.js's gate mapping, sign the user out
    // of the app for picking a language.
    expect(setLanguagePreference).not.toHaveBeenCalled()
    // DAN-95's local persistence still holds the choice.
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
  })
})
