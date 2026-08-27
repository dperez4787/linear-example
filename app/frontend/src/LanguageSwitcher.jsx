import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, useTranslation } from './i18n.js'

// DAN-95: the language selector. It lives in the app header (AuthGate) because
// the header is the one chrome every route renders, signed in or out, so the
// control is reachable from the records table, the request flow, and the
// sign-in screen alike.
//
// A labelled <select>, not a pair of buttons or a custom dropdown: two options
// today and a native control that is already keyboard- and screen-reader-
// correct, matching the filter selects the records toolbar already uses.
//
// Switching calls i18n.changeLanguage, which re-renders every component holding
// the useTranslation hook — the UI updates in place with no reload and no state
// lost — and, through the languageChanged listener in i18n.js, writes the
// choice to localStorage so the next visit starts in the same language.
export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation()
  // resolvedLanguage is the language actually in effect after fallback;
  // i18n.language can be a region-tagged variant that matches no <option>.
  const current = i18n.resolvedLanguage ?? i18n.language

  return (
    <label className="language-switcher">
      {t('language.label')}
      <select
        className="control language-switcher__select"
        value={current}
        onChange={(event) => i18n.changeLanguage(event.target.value)}
      >
        {SUPPORTED_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {LANGUAGE_LABELS[language]}
          </option>
        ))}
      </select>
    </label>
  )
}
