// Data layer: every Mongo driver call for the `records` collection lives here.
// Route handlers call these functions and never touch the driver directly
// (see docs/architecture.md). Errors thrown here propagate to the one Express
// error middleware.
import { ObjectId } from 'mongodb'

import { getDb } from './db.js'
import { validateCreate, validateUpdate } from './schema.js'

const COLLECTION = 'records'

// Raised when a record can't be found — including when `:id` isn't even a valid
// ObjectId. It carries a 404 status the one Express error middleware maps to the
// `{ error: { message } }` response, so route handlers never format it inline.
export class NotFoundError extends Error {
  constructor(message = 'record not found') {
    super(message)
    this.name = 'NotFoundError'
    this.status = 404
  }
}

function collection() {
  return getDb().collection(COLLECTION)
}

// A malformed `:id` (not a valid ObjectId) is a 404, not a 400 — the client
// shouldn't have to distinguish "no such record" from "that couldn't possibly be
// a record" (see docs/architecture.md). Returns the ObjectId or throws 404.
function toObjectId(id) {
  if (!ObjectId.isValid(id)) {
    throw new NotFoundError()
  }
  return new ObjectId(id)
}

// `_id` (an ObjectId) is serialized to the client as a string `id`. The frontend
// never sees `_id`.
function toRecord({ _id, ...rest }) {
  return { id: _id.toString(), ...rest }
}

export async function listRecords() {
  const docs = await collection().find().toArray()
  return docs.map(toRecord)
}

// Single-record read. Mirrors its siblings: a malformed id is a 404 (via
// toObjectId), and a well-formed id that matched nothing is also a 404. Added
// for the GraphQL `record(id)` query — the old REST contract listed GET /:id but
// never implemented it, so there was no single-record read until now.
export async function getRecord(id) {
  const _id = toObjectId(id)
  const doc = await collection().findOne({ _id })
  if (!doc) {
    throw new NotFoundError()
  }
  return toRecord(doc)
}

export async function createRecord(input) {
  // Validate + strip unknown fields (including any client-supplied id/_id) here,
  // so an invalid or malicious payload never reaches the driver.
  const clean = validateCreate(input)

  const now = new Date()
  const doc = { ...clean, createdAt: now, updatedAt: now }

  const { insertedId } = await collection().insertOne(doc)
  return toRecord({ _id: insertedId, ...doc })
}

// Partial update. Validate the id (404 on malformed) then the body (400 on an
// invalid field) before touching the driver. `$set` only the provided fields
// plus a fresh `updatedAt`; `createdAt` is never in the update, so it stays put.
// `findOneAndUpdate` with returnDocument: 'after' hands back the updated doc in
// one round-trip, or null when no record matched the id — which is a 404.
export async function updateRecord(id, input) {
  const _id = toObjectId(id)
  const clean = validateUpdate(input)

  const updated = await collection().findOneAndUpdate(
    { _id },
    { $set: { ...clean, updatedAt: new Date() } },
    { returnDocument: 'after' },
  )

  if (!updated) {
    throw new NotFoundError()
  }
  return toRecord(updated)
}

// Delete by id. Malformed id is a 404 (via toObjectId); a valid id that matched
// nothing is also a 404. On success there is nothing to return — the route
// replies 204 with no body.
export async function deleteRecord(id) {
  const _id = toObjectId(id)

  const { deletedCount } = await collection().deleteOne({ _id })
  if (deletedCount === 0) {
    throw new NotFoundError()
  }
}
