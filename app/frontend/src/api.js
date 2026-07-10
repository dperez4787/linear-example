// The only module in the frontend that knows the API exists. Components import
// these functions and never call fetch() themselves (see CLAUDE.md). The records
// surface is a single GraphQL endpoint, POST /api/graphql (DAN-25); requests use
// the relative path so the client is same-origin in production (Firebase rewrites
// /api/** to Cloud Run) and works through the Vite dev proxy locally.
//
// Exported signatures and resolved shapes are unchanged from the REST version, so
// components do not change: listRecords() -> Record[], createRecord(record) -> the
// created Record, updateRecord(id, patch) -> the updated Record, deleteRecord(id)
// -> undefined.
//
// Auth lives here too, for the same reason fetch() does: a component must not
// touch getIdToken() or the Authorization header. Every request goes through
// authedFetch(), which attaches the signed-in user's Firebase ID token and maps
// a 401 to signed-out — the token is refreshed and the sign-out is triggered in
// exactly one place. Gate errors (401) are HTTP-level and never enter GraphQL, so
// the DAN-23 sign-out-on-401 behavior carries over unchanged.
import { getIdToken, signOutUser } from './auth.js'

const ENDPOINT = '/api/graphql'

// The Record selection set, shared by every operation so the resolved shape stays
// identical to the REST payload. Its exact formatting is a local choice, not part
// of the contract.
const RECORD_FIELDS = 'id name status amount notes createdAt updatedAt'

// Turn a non-2xx response into a thrown Error carrying the server's message when it
// sent one. HTTP-level errors — the auth gate's 401, a malformed request — are shaped
// { error: { message, field? } } by the Express error middleware (they never enter
// GraphQL execution). When `field` is present it is attached to the Error so the
// create form can surface the message against that exact field.
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

// fetch() with the ID token attached and 401 mapped to signed-out. When a user
// is signed in, the current token goes on as `Authorization: Bearer <token>`;
// when nobody is signed in the request goes out unauthenticated. A 401 means the
// token was missing/expired/rejected, so we sign the user out (which flips the app
// to the sign-in affordance via the auth context) and still throw, so the caller's
// own error handling unwinds.
async function authedFetch(url, init) {
  const token = await getIdToken()
  if (token) {
    init = {
      ...init,
      headers: { ...(init?.headers), Authorization: `Bearer ${token}` },
    }
  }
  const res = init === undefined ? await fetch(url) : await fetch(url, init)
  if (res.status === 401) {
    await signOutUser().catch(() => {})
    throw await toError(res)
  }
  return res
}

// Execute a GraphQL operation and return its `data`. Two error channels, matching
// the backend's transport split (see docs/architecture.md, Error mapping):
//  - HTTP-level (gate 401, malformed request): res is non-2xx -> throw via toError.
//  - Execution-level (validation, not-found): res is 200 with a non-empty `errors`
//    array -> throw the first error's message, carrying extensions.field when the
//    backend named the offending field, so the create form can point at it.
async function gql(query, variables) {
  const res = await authedFetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw await toError(res)
  const body = await res.json()
  if (body.errors?.length) {
    const err = new Error(body.errors[0].message)
    const field = body.errors[0].extensions?.field
    if (field) err.field = field
    throw err
  }
  return body.data
}

// All records. Resolves to a plain array (never null), so callers get [] for an
// empty collection.
export async function listRecords() {
  const data = await gql(`query { records { ${RECORD_FIELDS} } }`)
  return data.records ?? []
}

// Create a record from a new Record (no id) -> the created Record with its
// server-assigned id and timestamps, so the caller can append it without a
// re-fetch. A validation failure throws an Error carrying `field` (see gql).
export async function createRecord(record) {
  const data = await gql(
    `mutation ($input: CreateRecordInput!) { createRecord(input: $input) { ${RECORD_FIELDS} } }`,
    { input: record },
  )
  return data.createRecord
}

// Partial update -> the updated Record. The backend re-validates every field it
// receives, so a rejected update throws an Error the optimistic caller uses to roll
// back.
export async function updateRecord(id, patch) {
  const data = await gql(
    `mutation ($id: ID!, $input: UpdateRecordInput!) { updateRecord(id: $id, input: $input) { ${RECORD_FIELDS} } }`,
    { id, input: patch },
  )
  return data.updateRecord
}

// Delete by id -> nothing. The backend echoes the deleted id, which the caller
// ignores; a not-found (or any error) throws so the caller can restore the row it
// optimistically removed.
export async function deleteRecord(id) {
  await gql(`mutation ($id: ID!) { deleteRecord(id: $id) }`, { id })
}
