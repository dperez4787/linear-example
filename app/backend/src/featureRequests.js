// Data layer for feature-request sessions: every Mongo driver call for the
// `feature_requests` collection lives here, mirroring records.js for the
// `records` collection. GraphQL resolvers call these functions and never touch
// the driver directly (see docs/architecture.md, CLAUDE.md).
//
// Unlike records — which any signed-in user reads and writes — feature-request
// sessions are per-user: every function takes the caller's Firebase `uid`
// (threaded from the auth gate through the GraphQL context, see index.js) and
// scopes every query with it. Another user's session is indistinguishable from
// a nonexistent one: both are a NotFoundError, the same "don't reveal what you
// can't have" principle as the malformed-id-is-a-404 rule in records.js.
import { ObjectId } from 'mongodb'

import { getDb } from './db.js'
import { NotFoundError } from './records.js'
import { ValidationError } from './schema.js'

const COLLECTION = 'feature_requests'

// The models a session may be opened against. Validation lives here (not in
// schema.js, which is the Record validation module) but throws the same
// ValidationError class, so the one GraphQL error mapper turns it into the
// same BAD_USER_INPUT + field shape as every record validation failure.
export const FEATURE_REQUEST_MODELS = ['claude-opus-5']

function collection() {
  return getDb().collection(COLLECTION)
}

// Same rule as records.js: a malformed id is a not-found, not a 400 — the
// client shouldn't have to distinguish "no such session" from "that couldn't
// possibly be a session id".
function toObjectId(id) {
  if (!ObjectId.isValid(id)) {
    throw new NotFoundError('feature request not found')
  }
  return new ObjectId(id)
}

// `_id` is serialized to the client as a string `id` (the promptId). The `uid`
// stays server-side: the caller already knows who they are, and the GraphQL
// type doesn't expose it.
function toFeatureRequest({ _id, uid, ...rest }) {
  return { id: _id.toString(), ...rest }
}

// Open a new feature-request session for the caller. Validates the model
// BEFORE touching the driver, so an invalid input never writes anything.
export async function startFeatureRequest(uid, input) {
  const model = input?.model
  if (!FEATURE_REQUEST_MODELS.includes(model)) {
    throw new ValidationError(
      `model must be one of ${FEATURE_REQUEST_MODELS.join(', ')}`,
      'model',
    )
  }

  const doc = {
    uid,
    status: 'gathering',
    model,
    messages: [],
    createdAt: new Date(),
  }

  const { insertedId } = await collection().insertOne(doc)
  return toFeatureRequest({ _id: insertedId, ...doc })
}

// The caller's sessions, newest first. `_id` breaks createdAt ties (two
// sessions started in the same millisecond) deterministically — ObjectIds are
// monotonic per process — so "newest first" is stable and testable.
export async function listFeatureRequests(uid) {
  const docs = await collection()
    .find({ uid })
    .sort({ createdAt: -1, _id: -1 })
    .toArray()
  return docs.map(toFeatureRequest)
}

// Single-session read, scoped to the caller. The uid is part of the filter, so
// another user's session id yields the same NotFoundError as an unknown or
// malformed one.
export async function getFeatureRequest(uid, id) {
  const _id = toObjectId(id)
  const doc = await collection().findOne({ _id, uid })
  if (!doc) {
    throw new NotFoundError('feature request not found')
  }
  return toFeatureRequest(doc)
}
