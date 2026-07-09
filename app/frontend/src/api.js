// The only module in the frontend that knows the API exists. Components import
// these functions and never call fetch() themselves (see CLAUDE.md). Requests
// use relative paths so the client is same-origin in production (Firebase
// rewrites /api/** to Cloud Run) and works through the Vite dev proxy locally.

const BASE = '/api/records'

// Turn a non-2xx response into a thrown Error carrying the server's message
// when it sent one, so callers get a useful message instead of "[object]".
// The API shapes errors as { error: { message, field? } }; when `field` is
// present (a 400 validation error naming the offending field) it is attached to
// the Error so a caller — the create form — can surface the message against that
// exact field instead of dumping a generic banner.
async function toError(res) {
  let message = `Request failed with status ${res.status}`
  let field
  try {
    const body = await res.json()
    if (body?.error?.message) message = body.error.message
    if (body?.error?.field) field = body.error.field
  } catch {
    // Non-JSON or empty body — keep the status-based message.
  }
  const err = new Error(message)
  if (field) err.field = field
  return err
}

// GET /api/records -> Record[]. The API wraps the list as { records: [...] }
// (never a bare array, to leave room for pagination metadata); unwrap it here
// so callers get a plain array.
export async function listRecords() {
  const res = await fetch(BASE)
  if (!res.ok) throw await toError(res)
  const body = await res.json()
  return body.records ?? []
}

// POST /api/records with a new Record (no id) -> the created Record. The API
// responds { record } (201) with the server-assigned id and timestamps; unwrap
// it so the caller can append that canonical record to the table without a
// re-fetch. A 400 throws an Error carrying `field` (see toError) so the form can
// point at the rejected input; the record is not added.
export async function createRecord(record) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  })
  if (!res.ok) throw await toError(res)
  const body = await res.json()
  return body.record
}

// PATCH /api/records/:id with a partial Record -> the updated Record. The API
// responds { record } (200); unwrap it so callers get the record directly. The
// backend re-validates every field it receives, so a rejected PATCH surfaces as
// a thrown Error the optimistic caller uses to roll back.
export async function updateRecord(id, patch) {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw await toError(res)
  const body = await res.json()
  return body.record
}

// DELETE /api/records/:id -> nothing. Success is 204 No Content, so there is no
// body to parse or return; a non-2xx (e.g. 404) throws so the caller can restore
// the row it optimistically removed.
export async function deleteRecord(id) {
  const res = await fetch(`${BASE}/${id}`, { method: 'DELETE' })
  if (!res.ok) throw await toError(res)
}
