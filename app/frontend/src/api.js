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
//
// The thrown error also carries the first error's whole `extensions` object
// (DAN-54), so callers can branch on extensions.code — the quota-exhausted state
// keys off code === 'QUOTA_EXHAUSTED', which the backend's error mapper emits
// when the AI gateway reports the caller's quota is spent. `err.field` stays as
// its own property, unchanged, so the create form's field-scoped display keeps
// working.
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
    const extensions = body.errors[0].extensions
    if (extensions) err.extensions = extensions
    if (extensions?.field) err.field = extensions.field
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

// --- Feature requests (DAN-53) ----------------------------------------------

// The FeatureRequest selection set, shared by every feature-request operation so
// each resolves to the same shape: { id, status, model, createdAt, messages,
// approvable, entranceCriteria }, where each message is { role, content } and
// entranceCriteria is null until the first evaluation, then three gates each
// shaped { pass, reason }. Formatting is a local choice, not contract.
//
// NOTE: `approvable` and `entranceCriteria` are the shapes agreed for DAN-50/51
// and do not exist in the deployed schema yet — until those backend tickets
// land, every operation using this selection set fails GraphQL validation
// against the live server. The feature-request surface already depends on
// DAN-49's sendFeatureRequestMessage the same way, so this widens no gap the
// live app doesn't already have; component tests mock api.js and are unaffected.
const FEATURE_REQUEST_FIELDS = `id status model createdAt approvable
  messages { role content }
  entranceCriteria {
    notTooBig { pass reason }
    notAmbiguous { pass reason }
    noBlockedDependencies { pass reason }
  }`

// Start a new feature-request conversation for the given model -> the created
// FeatureRequest (its messages array starts empty; the first user message goes
// through sendFeatureRequestMessage).
export async function startFeatureRequest(model) {
  const data = await gql(
    `mutation ($input: StartFeatureRequestInput!) { startFeatureRequest(input: $input) { ${FEATURE_REQUEST_FIELDS} } }`,
    { input: { model } },
  )
  return data.startFeatureRequest
}

// Send one user message into an existing feature request -> the updated
// FeatureRequest, whose messages array now carries the user's message plus the
// role-labeled replies. NOTE: the backend mutation ships in DAN-49; this calls
// the operation name and shape agreed there — sendFeatureRequestMessage(id,
// content) returning the updated FeatureRequest — so no frontend change is
// needed when it lands.
export async function sendFeatureRequestMessage(id, content) {
  const data = await gql(
    `mutation ($id: ID!, $content: String!) { sendFeatureRequestMessage(id: $id, content: $content) { ${FEATURE_REQUEST_FIELDS} } }`,
    { id, content },
  )
  return data.sendFeatureRequestMessage
}

// One feature request by id -> the FeatureRequest, or throws NOT_FOUND (the
// backend reports not-found as an execution-level error, same as record(id)).
export async function featureRequest(id) {
  const data = await gql(
    `query ($id: ID!) { featureRequest(id: $id) { ${FEATURE_REQUEST_FIELDS} } }`,
    { id },
  )
  return data.featureRequest
}

// --- AI usage + approval (DAN-54) --------------------------------------------

// The caller's AI usage ledger -> { requests, totalTokens }. Backed by the
// myAiUsage query (DAN-48); read by the quota meter, which fetches it on mount
// and refreshes it after every exchange.
export async function myAiUsage() {
  const data = await gql(`query { myAiUsage { requests totalTokens } }`)
  return data.myAiUsage
}

// --- Build progress (DAN-55) --------------------------------------------------

// The TicketProgress selection set (DAN-52): one entry per filed ticket, shaped
// { issueId, identifier, title, state, issueUrl, prUrl, blockedBy }, where state
// is BACKLOG | IN_PROGRESS | IN_REVIEW | DONE | BOUNCED, prUrl is null until a
// PR exists, and blockedBy lists the identifiers of the tickets that block this
// one. Formatting is a local choice, not contract.
const TICKET_PROGRESS_FIELDS =
  'issueId identifier title state issueUrl prUrl blockedBy'

// Live build progress for an approved feature request -> TicketProgress[].
// Resolves to a plain array (never null) so the watch view can always map over
// it. Polled by WatchBuild roughly every 5 seconds. NOTE: the backend query
// ships in DAN-52 (PR #55); this calls the operation name and shape agreed
// there — featureRequestProgress(promptId) returning [TicketProgress!]! — so no
// frontend change is needed when it lands.
export async function featureRequestProgress(promptId) {
  const data = await gql(
    `query ($promptId: ID!) { featureRequestProgress(promptId: $promptId) { ${TICKET_PROGRESS_FIELDS} } }`,
    { promptId },
  )
  return data.featureRequestProgress ?? []
}

// Approve the plan of a feature request whose gates all pass -> the updated
// FeatureRequest, whose status is "building". NOTE: the backend mutation ships
// in DAN-51; this calls the operation name and shape agreed there —
// approveFeatureRequestPlan(id) returning the updated FeatureRequest — so no
// frontend change is needed when it lands.
export async function approveFeatureRequestPlan(id) {
  const data = await gql(
    `mutation ($id: ID!) { approveFeatureRequestPlan(id: $id) { ${FEATURE_REQUEST_FIELDS} } }`,
    { id },
  )
  return data.approveFeatureRequestPlan
}
