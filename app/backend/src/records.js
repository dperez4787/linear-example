// Data layer: every Mongo driver call for the `records` collection lives here.
// Route handlers call these functions and never touch the driver directly
// (see docs/architecture.md). Errors thrown here propagate to the one Express
// error middleware.
import { getDb } from './db.js'
import { validateCreate } from './schema.js'

const COLLECTION = 'records'

function collection() {
  return getDb().collection(COLLECTION)
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

export async function createRecord(input) {
  // Validate + strip unknown fields (including any client-supplied id/_id) here,
  // so an invalid or malicious payload never reaches the driver.
  const clean = validateCreate(input)

  const now = new Date()
  const doc = { ...clean, createdAt: now, updatedAt: now }

  const { insertedId } = await collection().insertOne(doc)
  return toRecord({ _id: insertedId, ...doc })
}
