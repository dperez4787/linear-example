import i18next from 'i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, changeLanguage, i18n } from './i18n.js'
import en from './locales/en.json'

// DAN-110: confirm — and pin — the fallback locale that will be used for text
// French does not cover yet.
//
// This ticket asked a question rather than for a feature, so it ships no
// production change: the answer was already correct in DAN-95's `fallbackLng`.
// What it ships instead is the answer written down as executable assertions,
// because "we checked once" decays and a test does not. DAN-112 (the French
// catalog) and DAN-113 (mixed rendering) are specified against what is proven
// here.
//
// The answer, in one line: **English**. A key missing from French renders the
// English string, interpolation and all.

// Every scenario below needs a French catalog, and French does not exist in
// this build yet — so it is built here, deliberately partial, as the stand-in
// for the half-finished catalog DAN-112 will land.
const PARTIAL_FRENCH = {
  records: {
    title: 'Enregistrements',
    // `records.table.*` and `records.loadError` are intentionally absent — they
    // are the "not translated yet" half.
    form: {
      // Present but empty. This is the shape a translator's placeholder takes,
      // and it does NOT behave like an absent key — see the empty-string case.
      submit: '',
    },
  },
}

// The scenarios run on a throwaway instance rather than the app's singleton,
// because proving them on the real one would mean adding 'fr' to
// SUPPORTED_LANGUAGES — which is DAN-111's decision to make, not this ticket's.
//
// To keep that stand-in honest, its fallback settings are READ OFF the live
// instance instead of being retyped. If someone changes `fallbackLng` in
// i18n.js, these assertions change with it and start failing, which is the
// whole point of pinning them. The single deliberate difference is 'fr' in
// `supportedLngs` — exactly the one line DAN-111 will add for real.
async function withFrenchCatalog() {
  const instance = i18next.createInstance()
  await instance.init({
    resources: {
      en: { translation: en },
      fr: { translation: PARTIAL_FRENCH },
    },
    lng: 'fr',
    fallbackLng: i18n.options.fallbackLng,
    returnEmptyString: i18n.options.returnEmptyString,
    supportedLngs: [...SUPPORTED_LANGUAGES, 'fr'],
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  })
  return instance
}

describe('DAN-110 · the fallback locale is English', () => {
  it('is configured as English on the app instance', () => {
    // i18next normalizes `fallbackLng` to an array; the assertion is on the
    // resolved option, not on what was passed in.
    expect(i18n.options.fallbackLng).toEqual(['en'])
    expect(DEFAULT_LANGUAGE).toBe('en')
  })

  it('is the same value the app boots in — one default, not two', () => {
    // If these ever diverged, a user with no stored preference and a user with
    // an untranslated string would see different languages, which is the kind
    // of split-brain default nobody debugs on the first try.
    expect(i18n.options.fallbackLng).toEqual([DEFAULT_LANGUAGE])
  })

  it('has English as a real, complete catalog to fall back to', () => {
    // A fallback language whose own catalog has holes is not a fallback. This
    // is the guarantee every assertion below leans on.
    expect(i18n.getResourceBundle('en', 'translation')).toEqual(en)
  })
})

describe('DAN-110 · what an incomplete French catalog renders', () => {
  it('renders French where French exists', async () => {
    const instance = await withFrenchCatalog()

    // Control case: without this, "everything renders English" would pass for
    // the boring reason that French was never consulted at all.
    expect(instance.t('records.title')).toBe('Enregistrements')
  })

  it('renders the English string where French is missing', async () => {
    const instance = await withFrenchCatalog()

    // This is the ticket's question, answered: untranslated text is English,
    // not a blank, not a raw key.
    expect(instance.t('records.table.name')).toBe('Name')
    expect(instance.t('records.table.empty')).toBe('No records yet.')
    expect(instance.t('nav.signOut')).toBe('Sign out')
  })

  it('still interpolates when it falls back', async () => {
    const instance = await withFrenchCatalog()

    // Worth its own case: falling back to a *template* and falling back to a
    // finished sentence are different code paths, and a fallback that dropped
    // the interpolation would render "Could not load records: {{message}}" at
    // the user.
    expect(instance.t('records.loadError', { message: 'boom' })).toBe(
      'Could not load records: boom',
    )
  })

  it('renders the raw key only when English is missing it too', async () => {
    const instance = await withFrenchCatalog()

    // The one way a user can still see a key path. It means the key is absent
    // from *English*, i.e. a bug in the calling component — never a French
    // coverage gap.
    expect(instance.t('records.table.notAKey')).toBe('records.table.notAKey')
  })

  // The sharp edge, recorded because DAN-112 is the ticket that can step on it.
  it('renders BLANK for a French key set to an empty string — no fallback', async () => {
    const instance = await withFrenchCatalog()

    // i18next's `returnEmptyString` defaults to true, so `""` is a translation
    // that happens to be empty, not a gap to fall through. An untranslated
    // string therefore has to be an ABSENT key in fr.json, never a `""`
    // placeholder, or the user gets an empty button instead of an English one.
    //
    // Left as current behaviour rather than "fixed" here: DAN-110 confirms the
    // fallback, it does not change the runtime, and i18n.test.js already fails
    // any catalog carrying an empty value — so the guardrail DAN-112 needs is
    // a test that exists, not config that does not.
    expect(instance.t('records.form.submit')).toBe('')
    expect(en.records.form.submit).toBe('Add')
  })

  it('resolves a regional variant through French, then English', async () => {
    const instance = await withFrenchCatalog()

    // A fr-CA browser is a realistic visitor. The chain is fr-CA → fr → en, so
    // regional users get the French catalog rather than skipping straight past
    // it to English.
    expect(instance.services.languageUtils.toResolveHierarchy('fr-CA')).toEqual(['fr', 'en'])
  })
})

// Recorded here because it is the precondition everything above is contingent
// on, and it is currently FALSE. Shipping fr.json on its own would change
// nothing a user can see.
describe('DAN-110 · French is not selectable yet — the gap DAN-111 closes', () => {
  afterEach(async () => {
    await changeLanguage(DEFAULT_LANGUAGE)
    i18n.removeResourceBundle('fr', 'translation')
    window.localStorage.clear()
  })

  it('is absent from the supported languages this build offers', () => {
    expect(SUPPORTED_LANGUAGES).not.toContain('fr')
  })

  it('resolves entirely to English even with a French catalog loaded', async () => {
    i18n.addResourceBundle('fr', 'translation', PARTIAL_FRENCH)

    await changeLanguage('fr')

    // `supportedLngs` filters 'fr' out of the resolve hierarchy before lookup,
    // so even the keys French DOES have are ignored: the selected language is
    // 'fr' while the resolved one is 'en'. Until DAN-111 adds 'fr' to
    // SUPPORTED_LANGUAGES, a French catalog is dead weight.
    expect(i18n.resolvedLanguage).toBe('en')
    expect(i18n.t('records.title')).toBe('Records')
  })
})
