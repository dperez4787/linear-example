import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import NewRecordForm from './NewRecordForm.jsx'
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  changeLanguage,
  i18n,
} from './i18n.js'
import en from './locales/en.json'
import es from './locales/es.json'

// DAN-110 (tester) — independent verification of the ticket's question:
// "what does a user see for text that is not yet translated?"
//
// The developer's own file, i18n.fallback.test.js, answers this on a
// *throwaway* i18next instance built inside the test. That instance is
// configured by the test itself, so on its own it proves what i18next does
// when you configure it that way — not what THIS APP does. These tests
// deliberately take the other route: every fallback scenario below runs on the
// app's real singleton (`i18n` from src/i18n.js, the same object every
// component's `t` is bound to), and two of them go all the way through a
// rendered React component so the assertion is on text in the DOM rather than
// on a `t()` return value.
//
// French cannot be the vehicle for that, because 'fr' is not in
// SUPPORTED_LANGUAGES and `supportedLngs` strips it before lookup (pinned at
// the bottom). Spanish can: it is a real, supported, non-default language, so
// punching a hole in the Spanish catalog reproduces exactly the situation
// DAN-112's half-finished French catalog will create, on the instance that
// actually ships.

// Spanish with holes: the shape a partially-translated catalog has.
// - records.form.heading / .submit  → translated
// - records.form.nameLabel          → ABSENT (the untranslated half)
// - records.table.*                 → ABSENT
// - records.loadError               → ABSENT, and it interpolates
// - records.form.namePlaceholder    → "" (a translator's placeholder)
const PARTIAL_ES = {
  records: {
    form: {
      heading: 'Añadir un registro',
      submit: 'Añadir',
      ariaLabel: 'Nuevo registro',
      namePlaceholder: '',
    },
    status: { active: 'activo', pending: 'pendiente', archived: 'archivado' },
  },
}

// Swap the app instance's Spanish catalog for the partial one and switch to it.
// Everything is put back in afterEach, so no other test file — and no later
// test in this one — inherits a mutilated catalog.
async function useIncompleteSpanish() {
  i18n.removeResourceBundle('es', 'translation')
  i18n.addResourceBundle('es', 'translation', PARTIAL_ES)
  await changeLanguage('es')
}

afterEach(async () => {
  // Unmount first, then switch back: a live component subscribed to
  // `languageChanged` would otherwise re-render outside act() during teardown.
  cleanup()
  await act(async () => {
    await changeLanguage(DEFAULT_LANGUAGE)
  })
  i18n.removeResourceBundle('es', 'translation')
  i18n.addResourceBundle('es', 'translation', es)
  i18n.removeResourceBundle('fr', 'translation')
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
})

describe('DAN-110 · the fallback locale, read off the instance that ships', () => {
  it('is English on the app singleton', () => {
    // The ticket's question, answered against the live object rather than a
    // reading of the source: i18next normalizes `fallbackLng` to an array.
    expect(i18n.options.fallbackLng).toEqual(['en'])
    expect(DEFAULT_LANGUAGE).toBe('en')
  })

  it('is English even for a language the app does not support at all', async () => {
    // `resolvedLanguage` is the language `t` actually reads from. Ask for
    // something absurd and it lands on English, not on a blank UI.
    await changeLanguage('de-CH')
    expect(i18n.resolvedLanguage).toBe('en')
    expect(i18n.t('records.title')).toBe('Records')
  })

  it('falls back to a catalog that is itself complete', () => {
    // A fallback with holes is not a fallback. English is the source of truth
    // for the key set, so this is the guarantee the rest of the file leans on.
    expect(i18n.getResourceBundle('en', 'translation')).toEqual(en)
    expect(Object.keys(en).length).toBeGreaterThan(0)
  })
})

describe('DAN-110 · an incomplete catalog on the real instance', () => {
  it('renders the translation where the catalog has one', async () => {
    // Control. Without it, "everything came out English" would also pass if
    // the partial catalog were never consulted at all.
    await useIncompleteSpanish()
    expect(i18n.resolvedLanguage).toBe('es')
    expect(i18n.t('records.form.heading')).toBe('Añadir un registro')
  })

  it('renders the English string where the catalog has a hole', async () => {
    await useIncompleteSpanish()
    expect(i18n.t('records.form.nameLabel')).toBe('New name')
    expect(i18n.t('records.table.empty')).toBe('No records yet.')
    expect(i18n.t('nav.signOut')).toBe('Sign out')
  })

  it('keeps interpolating through the fallback', async () => {
    // A fallback that dropped interpolation would put the raw
    // "Could not load records: {{message}}" template in front of a user.
    await useIncompleteSpanish()
    expect(i18n.t('records.loadError', { message: 'boom' })).toBe(
      'Could not load records: boom',
    )
  })

  it('renders the raw key path only when English is missing it too', async () => {
    // The one remaining way a user sees a key. It means the key is absent from
    // ENGLISH — a bug in the calling component, never a translation gap.
    await useIncompleteSpanish()
    expect(i18n.t('records.table.notAKey')).toBe('records.table.notAKey')
  })

  it('renders BLANK, not English, for a key present as an empty string', async () => {
    // Confirming the developer's finding on the live instance: i18next's
    // `returnEmptyString` defaults to true, so "" is a translation that
    // happens to be empty rather than a gap to fall through. An untranslated
    // string in fr.json must therefore be an ABSENT key, never a ""
    // placeholder — otherwise the user gets an empty control instead of an
    // English one. Recorded as current behaviour; DAN-110 changes no runtime.
    await useIncompleteSpanish()
    expect(i18n.options.returnEmptyString).not.toBe(false)
    expect(i18n.t('records.form.namePlaceholder')).toBe('')
    expect(en.records.form.namePlaceholder).toBe('Name')
  })
})

describe('DAN-110 · what the user actually sees, rendered', () => {
  it('shows a mixed form: translated where translated, English where not', async () => {
    // The point of this case is that it is not a `t()` call — it is a real
    // component, mounted, read out of the DOM the way a user reads a screen.
    await useIncompleteSpanish()
    render(<NewRecordForm onCreate={async () => {}} />)

    // Translated half.
    expect(screen.getByRole('heading', { name: 'Añadir un registro' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Añadir' })).toBeInTheDocument()

    // Untranslated half — English, not blank and not a key path.
    expect(screen.getByLabelText('New name')).toBeInTheDocument()
    expect(screen.getByLabelText('New amount')).toBeInTheDocument()
    expect(screen.queryByLabelText('records.form.nameLabel')).toBeNull()
  })

  it('shows nothing at all where the catalog says ""', async () => {
    // The trap above, visible on screen: the name input's placeholder is
    // empty, not "Name".
    await useIncompleteSpanish()
    render(<NewRecordForm onCreate={async () => {}} />)

    expect(screen.getByLabelText('New name')).toHaveAttribute('placeholder', '')
  })
})

describe('DAN-110 · French today: not selectable, so 100% English', () => {
  it('is not among the languages this build offers', () => {
    expect(SUPPORTED_LANGUAGES).not.toContain('fr')
  })

  it('resolves a fr-CA visitor straight to English, skipping fr entirely', () => {
    // The developer's stand-in asserts fr-CA → ['fr', 'en'], which is true of
    // an instance that lists 'fr' in `supportedLngs`. On the instance that
    // ships today it is ['en']: 'fr' is filtered out before lookup. Both are
    // correct; only this one describes the current build, and the difference
    // is exactly what DAN-111 changes.
    expect(i18n.services.languageUtils.toResolveHierarchy('fr-CA')).toEqual(['en'])
  })

  it('ignores a French catalog even for the keys it does have', async () => {
    i18n.addResourceBundle('fr', 'translation', { records: { title: 'Enregistrements' } })
    await changeLanguage('fr')

    // Selected 'fr', resolved 'en'. Landing fr.json without DAN-111 ships a
    // file no user can reach.
    expect(i18n.resolvedLanguage).toBe('en')
    expect(i18n.t('records.title')).toBe('Records')
  })
})
