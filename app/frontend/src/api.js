// The only module in the frontend that knows the API exists. Components import
// these functions and never call fetch() themselves (see CLAUDE.md). Requests
// use relative paths so the client is same-origin in production (Firebase
// rewrites /api/** to Cloud Run) and works through the Vite dev proxy locally.

const BASE = '/api/records'

// Turn a non-2xx response into a thrown Error carrying the server's message
// when it sent one, so callers get a useful message instead of "[object]".
async function toError(res) {
  let message = `Request failed with status ${res.status}`
  try {
    const body = await res.json()
    if (body?.error?.message) message = body.error.message
  } catch {
    // Non-JSON or empty body — keep the status-based message.
  }
  return new Error(message)
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
