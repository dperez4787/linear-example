import { useEffect } from 'react'

import { languagePreference, setLanguagePreference } from './api.js'
import { SUPPORTED_LANGUAGES, changeLanguage, i18n } from './i18n.js'

// DAN-97: makes a signed-in user's language choice follow them across devices
// by bridging DAN-95's i18n instance to DAN-96's uid-scoped preference.
//
// This is a bridge, NOT a second i18n path. It never renders text, never holds
// the language in React state, and never reads or writes localStorage. The one
// language of record is still i18next's, and DAN-95's `languageChanged`
// listener still writes localStorage on every switch — that stays the fallback
// for the pre-auth/unset case, exactly as before. All this adds is: read the
// server's value once when a user is present, and mirror later switches back.
//
// Both directions are deliberately soft. A language preference is never worth
// an error modal: a failed read leaves the user in whatever language DAN-95
// resolved locally, and a failed write leaves the UI switched for this session
// and merely un-synced for the next device. Same posture as the quota meter's
// read — the app is fully usable when the call does not land.
//
// Why hang the write off i18next's `languageChanged` rather than the switcher's
// onChange: for the same reason DAN-95 put the localStorage write there. The
// preference is a property of the instance's language, not of one component's
// click handler, so anything that switches the language — today the header
// selector, tomorrow a keyboard shortcut or a deep link — syncs without having
// to remember to.
export function useLanguagePreference(user) {
  // Keyed on the uid, not the user object: Firebase hands back a fresh object
  // on every token refresh, and re-running this effect on each of those would
  // re-read the preference and stomp a switch the user made in between.
  const uid = user?.uid ?? null

  useEffect(() => {
    // Signed out there is no preference to read, and — more importantly —
    // nothing to write to: api.js turns the gate's 401 into a sign-out, so an
    // unauthenticated write would be an actively harmful no-op.
    if (!uid) return undefined

    let active = true
    // The value the server and this client already agree on. A
    // `languageChanged` carrying it came FROM the server (we just applied it),
    // so writing it straight back would be an echo — and would break the
    // "exactly once per user change" contract this ticket is specified by.
    let syncedLanguage = null
    // Set the moment a switch originates on this client. The read is racing the
    // user; if the user got there first, their pick is the newer fact and the
    // in-flight read must not overwrite it.
    let switchedLocally = false

    async function applyStoredPreference() {
      let stored
      try {
        stored = await languagePreference()
      } catch {
        // Soft: the local default from DAN-95 stands.
        return
      }
      // A null preference means "never chosen" — leave DAN-95's resolution
      // alone. An unrecognized value means the server knows a language this
      // build does not; falling back beats rendering raw keys.
      if (!active || switchedLocally || !SUPPORTED_LANGUAGES.includes(stored)) return
      syncedLanguage = stored
      await changeLanguage(stored)
    }

    async function pushPreference(language) {
      if (!active || language === syncedLanguage) return
      // Record the intent before awaiting, so a rapid second switch is compared
      // against what we are sending, not against what we last confirmed.
      syncedLanguage = language
      switchedLocally = true
      try {
        await setLanguagePreference(language)
      } catch {
        // Soft: the switch already happened locally and localStorage already
        // has it; only the cross-device mirror is stale.
      }
    }

    i18n.on('languageChanged', pushPreference)
    // Subscribe first, then read: a user who switches while the read is in
    // flight still gets their switch written, and the echo guard keeps the
    // read's own apply from counting as a change.
    applyStoredPreference()

    return () => {
      active = false
      i18n.off('languageChanged', pushPreference)
    }
  }, [uid])
}
