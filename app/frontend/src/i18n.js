import i18next from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'

import en from './locales/en.json'
import es from './locales/es.json'

// DAN-95: the app's one i18n instance.
//
// Every component that needs UI text imports `useTranslation` FROM THIS MODULE
// rather than from `react-i18next` directly. That is the whole reason this file
// re-exports the hook: importing it here guarantees the instance below is
// initialized before any component can call `t`, so there is no provider to
// forget, no setup-file ordering to get right, and a component rendered on its
// own in a test still gets real English text instead of raw keys.
//
// No `i18next-browser-languagedetector`: the detection rule is "whatever the
// user last picked, else English", which is a localStorage read — a dependency
// for one `try/catch` would be more surface than it saves, and the detector's
// navigator/querystring/cookie orders are behaviour we would have to configure
// off anyway.

export const SUPPORTED_LANGUAGES = ['en', 'es']
export const DEFAULT_LANGUAGE = 'en'

// Language names are written in their own language — a reader looking for
// Spanish is looking for "Español", not for whatever English calls it — so
// these deliberately do NOT live in the dictionaries.
export const LANGUAGE_LABELS = {
  en: 'English',
  es: 'Español',
}

// The session's language preference. Namespaced so it cannot collide with
// anything else this origin stores.
export const LANGUAGE_STORAGE_KEY = 'linear-example.language'

// localStorage throws in Safari private mode and is absent in a non-browser
// runtime, and a language preference is never worth breaking boot over — both
// accessors degrade to "no stored preference".
export function readStoredLanguage() {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return SUPPORTED_LANGUAGES.includes(stored) ? stored : null
  } catch {
    return null
  }
}

function storeLanguage(language) {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Preference not persisted; the running session is still switched.
  }
}

// Keep the document's lang attribute honest — it is what screen readers pick a
// voice from and what the browser hyphenates by, so it has to follow the UI.
function syncDocumentLanguage(language) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
  }
}

// The boot decision, as a function so it is testable without re-importing the
// module: whatever the user last picked, else English.
export function resolveInitialLanguage() {
  return readStoredLanguage() ?? DEFAULT_LANGUAGE
}

// The language this instance was initialized with — the "next visit starts
// where you left off" value, captured at import.
export const initialLanguage = resolveInitialLanguage()

if (!i18next.isInitialized) {
  i18next.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
    lng: initialLanguage,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    // React escapes interpolated values already; escaping again would render
    // an apostrophe in a record name as `&#39;`.
    interpolation: { escapeValue: false },
    // Resources are bundled, so init is synchronous and there is nothing to
    // suspend on. Leaving Suspense on would make every component that calls
    // useTranslation require a boundary it does not otherwise need.
    react: { useSuspense: false },
    // i18next console.info's a Locize advert on init; in a 69-file Vitest run
    // that is 69 lines of noise between the results.
    showSupportNotice: false,
  })

  // Persist on every switch, wherever it came from, instead of only inside the
  // switcher's onChange — the preference is a property of the instance's
  // language, not of one component's click handler.
  i18next.on('languageChanged', (language) => {
    storeLanguage(language)
    syncDocumentLanguage(language)
  })

  syncDocumentLanguage(initialLanguage)
}

export function changeLanguage(language) {
  return i18next.changeLanguage(language)
}

export { i18next as i18n, useTranslation }
