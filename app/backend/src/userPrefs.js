// Data layer for per-user preferences (DAN-96). This module OWNS the
// `user_prefs` collection — every Mongo driver call for it lives here, the same
// rule records.js has for `records` and aiUsage.js has for `ai_usage`. GraphQL
// resolvers call these functions and never touch the driver (CLAUDE.md).
//
// One document per user, keyed by the Firebase uid as `_id`:
//
//   { _id: '<uid>', language: 'en' | 'es' }
//
// Keying on the uid rather than a generated id is what makes the uid scoping
// structural instead of a filter someone can forget: there is no query shape
// that reaches another user's row, because the uid IS the primary key. Every
// function below takes the caller's uid, which the auth gate derives from the
// verified token and threads through the GraphQL context (see auth.js and
// index.js) — it is never a client-supplied argument.
//
// There is no "create the user row" step anywhere: the write upserts, so a
// user's first preference write creates their document and a read before that
// is an ordinary null, not an error. That matches how the frontend (DAN-97)
// will use it — ask for the preference on load, fall back to its own default
// when there isn't one yet.
import { getDb } from './db.js'
import { ValidationError } from './schema.js'

const COLLECTION = 'user_prefs'

// The languages the app ships. Validation lives here rather than in schema.js
// — that module is the Record validation surface — but throws the same
// ValidationError class, so the one GraphQL error mapper in graphql.js turns a
// bad language into the same BAD_USER_INPUT + `field` shape as every other
// validation failure in the API. Exported so tests (and any future caller)
// assert against the one list instead of a second copy that can drift.
export const LANGUAGES = ['en', 'es']

function collection() {
  return getDb().collection(COLLECTION)
}

// Validate strictly, and case-sensitively: the stored value is a BCP-47-style
// tag the frontend hands straight to its i18n runtime, so accepting 'EN' and
// silently lowercasing it would make the wire contract ambiguous about what a
// read returns. 'EN', 'fr', '' and any non-string are all the same answer.
function validateLanguage(value) {
  if (typeof value !== 'string' || !LANGUAGES.includes(value)) {
    throw new ValidationError(`language must be one of ${LANGUAGES.join(', ')}`, 'language')
  }
  return value
}

// The caller's stored preference, or null when they have never set one.
// Null is the ordinary "not chosen yet" state, not an error — see above.
export async function getLanguagePreference(uid) {
  const doc = await collection().findOne({ _id: uid })
  return doc?.language ?? null
}

// Store the caller's preference and echo back what was stored. Validates
// BEFORE touching the driver, so a rejected value never writes anything —
// same ordering as startFeatureRequest in featureRequests.js.
//
// $set (not $setOnInsert) with upsert is what makes a second call overwrite
// rather than accumulate: one row per user, last write wins.
export async function setLanguagePreference(uid, language) {
  const value = validateLanguage(language)
  await collection().updateOne({ _id: uid }, { $set: { language: value } }, { upsert: true })
  return value
}
