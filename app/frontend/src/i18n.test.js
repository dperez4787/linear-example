import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_LABELS,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  changeLanguage,
  i18n,
  initialLanguage,
  readStoredLanguage,
  resolveInitialLanguage,
} from './i18n.js'
import en from './locales/en.json'
import es from './locales/es.json'

// DAN-95: the dictionaries and the instance itself. Component-level proof that
// a switch repaints the UI lives in LanguageSwitcher.test.jsx.

// Every leaf key, dotted — the shape i18next addresses translations by.
function leafKeys(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? leafKeys(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  )
}

function leafValues(object) {
  return Object.entries(object).flatMap(([, value]) =>
    value !== null && typeof value === 'object' ? leafValues(value) : [value],
  )
}

function placeholdersIn(value) {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
}

// Both dictionaries have to stay in step: a key present in one and missing from
// the other is a string that silently falls back to English (or renders the raw
// key), which is exactly the regression a translated app grows over time.
describe('DAN-95 · the English and Spanish dictionaries', () => {
  it('declare the same set of keys', () => {
    expect(leafKeys(es).sort()).toEqual(leafKeys(en).sort())
  })

  it('have no empty translations', () => {
    for (const dictionary of [en, es]) {
      for (const value of leafValues(dictionary)) {
        expect(typeof value).toBe('string')
        expect(value.trim()).not.toBe('')
      }
    }
  })

  // An interpolation dropped in translation renders a sentence missing its
  // subject; an invented one renders a literal `{{foo}}` to the user.
  it('use the same interpolation placeholders in both languages', () => {
    for (const key of leafKeys(en)) {
      const englishValue = key.split('.').reduce((o, k) => o[k], en)
      const spanishValue = key.split('.').reduce((o, k) => o[k], es)
      expect(placeholdersIn(spanishValue)).toEqual(placeholdersIn(englishValue))
    }
  })

  it('are actually translated — Spanish differs from English for the prose', () => {
    // Sampled, not exhaustive: some strings ("Tokens", "Linear") are correctly
    // identical, so a blanket "every value differs" rule would be wrong.
    expect(es.records.title).not.toBe(en.records.title)
    expect(es.featureRequest.send).not.toBe(en.featureRequest.send)
    expect(es.watchBuild.complete).not.toBe(en.watchBuild.complete)
    expect(es.activity.empty).not.toBe(en.activity.empty)
  })
})

describe('DAN-95 · the i18n instance', () => {
  afterEach(async () => {
    await changeLanguage(DEFAULT_LANGUAGE)
    window.localStorage.clear()
  })

  it('starts in English and offers exactly English and Spanish', () => {
    expect(DEFAULT_LANGUAGE).toBe('en')
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'es'])
    // Language names are written in their own language, so a reader can find
    // theirs without already reading the current one.
    expect(LANGUAGE_LABELS).toEqual({ en: 'English', es: 'Español' })
  })

  it('translates through the dictionaries and interpolates', async () => {
    expect(i18n.t('records.title')).toBe('Records')
    expect(i18n.t('records.loadError', { message: 'boom' })).toBe(
      'Could not load records: boom',
    )

    await changeLanguage('es')

    expect(i18n.t('records.title')).toBe('Registros')
    expect(i18n.t('records.loadError', { message: 'boom' })).toBe(
      'No se pudieron cargar los registros: boom',
    )
  })

  it('writes the chosen language to localStorage and to <html lang>', async () => {
    await changeLanguage('es')

    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
    expect(document.documentElement.lang).toBe('es')

    await changeLanguage('en')

    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('reads back only a supported stored language', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es')
    expect(readStoredLanguage()).toBe('es')

    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'klingon')
    expect(readStoredLanguage()).toBeNull()

    window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
    expect(readStoredLanguage()).toBeNull()
  })

  // Safari private mode throws on localStorage access; a language preference is
  // never worth breaking the app over.
  it('survives a localStorage that throws', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('access denied')
      })
    try {
      expect(readStoredLanguage()).toBeNull()
    } finally {
      getItem.mockRestore()
    }
  })
})

// The "session preference" half of the ticket: a language chosen on one visit
// is the language the next visit boots in. The boot decision is asserted as a
// function (re-importing the module cannot re-run init — i18next is a package
// singleton Vitest's module registry does not reset), plus the fact that the
// live instance really did boot from it.
describe('DAN-95 · the stored preference decides the next boot language', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('boots in Spanish when Spanish was stored', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es')
    expect(resolveInitialLanguage()).toBe('es')
  })

  it('boots in English when nothing was stored', () => {
    window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
    expect(resolveInitialLanguage()).toBe('en')
  })

  it('boots in English when the stored value is not a supported language', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr')
    expect(resolveInitialLanguage()).toBe('en')
  })

  it('is the value this instance was actually initialized with', () => {
    // Nothing was stored when this suite loaded, so the running instance booted
    // in English — the point is that `lng` came from resolveInitialLanguage(),
    // not from a hardcoded literal in the init call.
    expect(initialLanguage).toBe('en')
    expect(i18n.options.lng).toBe(initialLanguage)
  })
})
