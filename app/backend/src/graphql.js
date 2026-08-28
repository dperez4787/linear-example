// The GraphQL records surface: SDL schema, root resolvers, and the execution-layer
// error mapper. Mounted at POST /api/graphql behind the auth gate (see index.js).
// This replaces the five REST routes in the deleted routes.js; the contract, schema,
// and error shapes are recorded in docs/architecture.md (GraphQL API).
//
// The split from the REST version is unchanged where it matters: records.js is still
// the only place that talks to the Mongo driver, and schema.js is still the single
// validation enforcement point. Resolvers stay as thin as the REST handlers were —
// they call a records.js function and never validate or format errors inline.
import { buildSchema, GraphQLError } from 'graphql'

import {
  NotFoundError,
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
} from './records.js'
import { ValidationError } from './schema.js'
import { QuotaExhaustedError } from './aiGateway.js'
import { getUsage } from './aiUsage.js'
import { getLanguagePreference, setLanguagePreference } from './userPrefs.js'
import {
  startFeatureRequest,
  listFeatureRequests,
  getFeatureRequest,
  sendFeatureRequestMessage,
  approveFeatureRequestPlan,
  featureRequestProgress,
  featureRequestActivity,
  featureRequestCost,
  unevaluatedEntranceCriteria,
  isApprovable,
} from './featureRequests.js'

// SDL built with graphql's own buildSchema — no @graphql-tools, because this flat
// surface has no nested type resolvers or custom scalars to wire.
//
// Decisions (docs/architecture.md, Schema):
//  - `status` is String, not an enum: schema.js is the single validation point, and
//    an enum would give that one field a differently-shaped, drift-prone error.
//  - Timestamps are ISO-8601 String, not a custom DateTime scalar: REST serialized
//    Dates through res.json() as ISO strings, so String keeps the wire format
//    byte-identical. records.js keeps returning Date objects; the resolvers below
//    convert the two date fields with .toISOString() (graphql's String would throw
//    on a raw Date anyway).
//  - `record` is nullable; the mutation return types are not. A not-found on the
//    query yields data.record: null alongside the error; a not-found on a mutation
//    nulls data overall.
//  - deleteRecord returns the deleted ID! — a mutation must return something, and
//    echoing the id needs no wrapper payload type.
export const schema = buildSchema(`
  type Record {
    id: ID!
    name: String!
    status: String!
    amount: Float!
    notes: String
    createdAt: String!
    updatedAt: String!
  }

  input CreateRecordInput {
    name: String!
    status: String!
    amount: Float!
    notes: String
  }

  input UpdateRecordInput {
    name: String
    status: String
    amount: Float
    notes: String
  }

  # DAN-48: the caller's AI usage ledger, read by the frontend's quota meter.
  # Written by the AI gateway client (aiGateway.js) on each successful call;
  # the collection is owned by aiUsage.js.
  type AiUsage {
    requests: Int!
    totalTokens: Int!
  }

  # DAN-49: createdAt is additive — no message existed before the mutation
  # that writes them, and every written message carries a timestamp.
  type FeatureRequestMessage {
    role: String!
    content: String!
    createdAt: String!
  }

  # DAN-49: the planner's structured draft, stored on the session once the
  # conversation converges. Nullable on FeatureRequest — no plan yet is the
  # normal early state, not an error.
  type PlanTicket {
    key: String!
    title: String!
    description: String!
    dependsOn: [String!]!
  }

  type Plan {
    tickets: [PlanTicket!]!
  }

  # DAN-50: the three hard gates the entrance-criteria evaluator scores after
  # every exchange. Non-null all the way down — a virgin session synthesizes
  # "not yet evaluated" gates at the presentation layer, so the frontend
  # (DAN-54) never branches on null.
  type EntranceCriterion {
    pass: Boolean!
    reason: String!
  }

  type EntranceCriteria {
    notTooBig: EntranceCriterion!
    notAmbiguous: EntranceCriterion!
    noBlockedDependencies: EntranceCriterion!
  }

  # DAN-51: a plan ticket filed in Linear on approval — the Linear-assigned
  # identity the frontend links to. Present only once the session is approved.
  type FiledTicket {
    key: String!
    identifier: String!
    url: String!
  }

  type FeatureRequest {
    id: ID!
    # gathering -> building -> shipped. A String, not an enum, for the same
    # reason Record.status is: featureRequests.js is the single enforcement
    # point, and an enum here would be a second copy of the list that can
    # drift. "gathering" is the conversation, "building" is approved with
    # tickets filed, and "shipped" (DAN-94) is terminal — reached when a
    # progress read observes every ticket DONE, and never left.
    #
    # Migration: no backfill. Sessions that shipped before DAN-94 are still
    # stored as "building" and heal themselves the first time anyone opens
    # their build view, because that view's existing progress poll is what
    # performs the flip. A shipped-and-never-reopened session keeps saying
    # "building" until someone looks at it — which is precisely when the wrong
    # word would have been read.
    status: String!
    model: String!
    createdAt: String!
    messages: [FeatureRequestMessage!]!
    plan: Plan
    entranceCriteria: EntranceCriteria!
    # DAN-75: true only when all three entrance gates pass AND a plan is
    # stored — exactly the precondition approveFeatureRequestPlan enforces,
    # so the Approve button can never promise what the mutation refuses.
    approvable: Boolean!
    # DAN-51: nullable — set when approval files the Linear project/tickets.
    linearProjectId: String
    # DAN-80: the filed project's Linear URL, persisted at approval time.
    # Nullable — unapproved sessions, and sessions approved before this field
    # existed, serve null.
    linearProjectUrl: String
    tickets: [FiledTicket!]
    # DAN-90: the AI-generated snake_case slug naming this session, generated
    # once at approval time and persisted. Matches ^[a-z0-9]+(_[a-z0-9]+)*$ and
    # is at most 50 characters. Nullable, and null is ordinary: an unapproved
    # session has no title yet, a session approved before this field existed
    # has none, and an approval whose titler call failed fell back to the
    # truncated project name and stored none either.
    title: String
  }

  input StartFeatureRequestInput {
    model: String!
  }

  # DAN-52: live per-ticket build status for the watch-it-build view, read
  # from Linear on demand (with a short server-side cache). One node per filed
  # ticket. \`state\` is one of BACKLOG | IN_PROGRESS | IN_REVIEW | DONE |
  # BOUNCED — a String, not an enum, for the same reason Record.status is
  # (the mapping in featureRequests.js is the single enforcement point, and an
  # enum would be a second copy of the list that can drift). \`prUrl\` is the
  # issue's PR attachment url when one exists, else null; \`blockedBy\` lists
  # the Linear issue ids this ticket is blocked by. Field names are the DAN-55
  # frontend contract — do not rename.
  type TicketProgress {
    issueId: ID!
    identifier: String!
    title: String!
    state: String!
    issueUrl: String!
    prUrl: String
    blockedBy: [ID!]!
  }

  # DAN-83: one event in the session's narrated build trail — the agents'
  # Linear issue comments, workflow state changes, and the PR attachment,
  # merged chronologically across all filed tickets. \`kind\` is one of
  # comment | state | pr — a String, not an enum, for the same reason
  # TicketProgress.state is. \`ts\` is the event's ISO-8601 timestamp as Linear
  # reported it. \`body\` is the (possibly ~500-char-truncated) comment body,
  # null for state and pr events; \`url\` links to the comment, issue, or PR.
  # Field names are the DAN-84 frontend contract — do not rename.
  type ActivityEvent {
    ts: String!
    ticketIdentifier: String!
    kind: String!
    summary: String!
    body: String
    url: String
  }

  # DAN-80: what one feature-request session has cost, proxied live from the
  # AI gateway's usage ledger (GET /v1/usage?group_by=prompt_id) and filtered
  # to the session. Non-null all the way down — a session the gateway has no
  # row for costs zeros, never null and never an error.
  type FeatureCost {
    calls: Int!
    tokensIn: Int!
    tokensOut: Int!
    costUsd: Float!
  }

  type Query {
    records: [Record!]!
    record(id: ID!): Record
    myAiUsage: AiUsage!
    featureRequests: [FeatureRequest!]!
    featureRequest(id: ID!): FeatureRequest
    featureRequestProgress(promptId: ID!): [TicketProgress!]!
    featureRequestActivity(promptId: ID!): [ActivityEvent!]!
    featureRequestCost(promptId: ID!): FeatureCost!
    # DAN-96: the CALLER's stored UI language, or null when they have never
    # chosen one. Takes no argument on purpose — the uid comes from the
    # verified token, so there is no shape of this query that reads someone
    # else's preference. Nullable because "not chosen yet" is the normal
    # first-load state: the frontend (DAN-97) falls back to its own default.
    # A String, not an enum, for the same reason Record.status is — userPrefs.js
    # is the single enforcement point and an enum would be a second copy of the
    # allowed list that can drift out of sync with it.
    languagePreference: String
  }

  type Mutation {
    createRecord(input: CreateRecordInput!): Record!
    updateRecord(id: ID!, input: UpdateRecordInput!): Record!
    deleteRecord(id: ID!): ID!
    startFeatureRequest(input: StartFeatureRequestInput!): FeatureRequest!
    sendFeatureRequestMessage(id: ID!, content: String!): FeatureRequest!
    approveFeatureRequestPlan(id: ID!): FeatureRequest!
    # DAN-96: upsert the caller's UI language and echo back what was stored.
    # Returns the stored String! rather than a wrapper payload type, the same
    # call deleteRecord makes — there is nothing else to report. Like the
    # query, it takes no uid: a caller can only ever write their own row.
    setLanguagePreference(language: String!): String!
  }
`)

// Presentation lives in the presentation layer: records.js returns Date objects
// (its Mongo round-trip tests stay honest), and this converts the two date fields
// to ISO strings before they cross the wire, matching what res.json() did in REST.
function toWire(record) {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

// The execution-layer analogue of the Express error middleware: one place that maps
// thrown data-layer errors to GraphQLErrors, so resolvers never format errors inline.
// Inside GraphQL execution, HTTP status codes stop being the error channel — a
// well-formed request returns 200 and reports failures in the `errors` array.
//
//   ValidationError (400, field) -> BAD_USER_INPUT, same message, extensions.field
//   NotFoundError   (404)        -> NOT_FOUND, message "record not found"
//   anything else                -> logged server-side; INTERNAL, generic message
//                                    (the same don't-leak rule as the middleware's 5xx)
// DAN-48 adds one branch: the AI gateway's 429 becomes QUOTA_EXHAUSTED with a
// human-readable message. Every OTHER gateway failure (GatewayError, network,
// misconfiguration) deliberately has NO branch — it falls through to INTERNAL,
// which logs the real error server-side and never leaks gateway details.
function mapError(err) {
  if (err instanceof QuotaExhaustedError) {
    return new GraphQLError(err.message, {
      extensions: { code: 'QUOTA_EXHAUSTED' },
    })
  }
  if (err instanceof ValidationError) {
    return new GraphQLError(err.message, {
      extensions: { code: 'BAD_USER_INPUT', field: err.field },
    })
  }
  if (err instanceof NotFoundError) {
    return new GraphQLError('record not found', {
      extensions: { code: 'NOT_FOUND' },
    })
  }
  // Don't leak internals: log the real error server-side, return a generic message.
  console.error(err)
  return new GraphQLError('Internal Server Error', {
    extensions: { code: 'INTERNAL' },
  })
}

// Wrap a resolver so every thrown data-layer error goes through mapError. A single
// wrapper rather than a graphql-http formatError hook keeps the mapping plain
// JavaScript — testable without the HTTP layer and not coupled to any handler option.
// Exported (DAN-48) so gateway-facing suites can exercise the exact mapping
// chain a production resolver uses. Arguments pass through untouched: buildSchema
// root fields are called (args, context, info), and context is how a resolver
// reaches the injected aiGateway and the caller's uid (see index.js).
export function resolver(fn) {
  return async (...forwarded) => {
    try {
      return await fn(...forwarded)
    } catch (err) {
      throw mapError(err)
    }
  }
}

// --- Feature-request sessions (DAN-47) ---

// createdAt is a Date in the data layer — on the session and (DAN-49) on each
// message; convert at the presentation boundary, same rule as toWire above.
// `plan` needs no conversion: it is plain strings and arrays.
//
// DAN-50: entranceCriteria and approvable are presentation-synthesized here.
// A session with no stored evaluation (virgin — no exchange has run yet)
// exposes the three "not yet evaluated" gates rather than storing them, and
// approvable is always derived, never persisted — so it cannot drift from the
// state it summarizes. DAN-75: approvable also requires a stored plan — the
// approve mutation refuses without one, and this bit must never promise what
// that mutation would refuse.
function toWireFeatureRequest(featureRequest) {
  const entranceCriteria = featureRequest.entranceCriteria ?? unevaluatedEntranceCriteria()
  return {
    ...featureRequest,
    createdAt: featureRequest.createdAt.toISOString(),
    messages: featureRequest.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
    entranceCriteria,
    approvable: isApprovable(entranceCriteria, featureRequest.plan),
    // DAN-90: explicit rather than relying on the spread, so a legacy session
    // (no such field) serves an unambiguous null instead of undefined.
    title: featureRequest.title ?? null,
  }
}

// Feature-request resolvers need the caller's uid, which buildSchema passes as
// the SECOND resolver argument — the GraphQL context, threaded from the auth
// gate via createHandler's context option in index.js. The records resolver()
// wrapper above predates context and drops it, so this variant forwards it;
// it is deliberately separate rather than an edit to resolver(), to keep the
// records surface untouched. Error mapping is the same one mapError, with one
// refinement: NotFoundError keeps its own message ("feature request not
// found") instead of mapError's hardcoded "record not found" — the code in
// extensions is identical either way.
function contextResolver(fn) {
  return async (args, context) => {
    try {
      return await fn(args, context)
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new GraphQLError(err.message, {
          extensions: { code: 'NOT_FOUND' },
        })
      }
      throw mapError(err)
    }
  }
}

// Root resolvers for a buildSchema schema: a flat object whose function fields are
// called with the field's arguments. Each is the same one-liner the REST handler was.
export const rootValue = {
  featureRequests: contextResolver(async (_args, { uid }) =>
    (await listFeatureRequests(uid)).map(toWireFeatureRequest),
  ),
  featureRequest: contextResolver(async ({ id }, { uid }) =>
    toWireFeatureRequest(await getFeatureRequest(uid, id)),
  ),
  startFeatureRequest: contextResolver(async ({ input }, { uid }) =>
    toWireFeatureRequest(await startFeatureRequest(uid, input)),
  ),
  // DAN-49: the aiGateway comes from the GraphQL context (injected through
  // createApp, see index.js) — the resolver never constructs a client, and the
  // data layer owns the orchestration and every Mongo call.
  sendFeatureRequestMessage: contextResolver(async ({ id, content }, { uid, aiGateway }) =>
    toWireFeatureRequest(await sendFeatureRequestMessage(uid, id, content, aiGateway)),
  ),
  // DAN-51: the linearClient comes from the GraphQL context (injected through
  // createApp, see index.js) — same seam as the aiGateway; no test reaches
  // real Linear. `linearProjectId` and `tickets` need no wire conversion:
  // they are plain strings all the way down.
  // DAN-90: approval also takes the aiGateway — the SAME context-injected
  // client sendFeatureRequestMessage uses — for the titler call, so the
  // titler's tokens are metered on this session's promptId like every other
  // role. A gateway failure here does not fail the approval (see
  // generateTitle in featureRequests.js).
  approveFeatureRequestPlan: contextResolver(async ({ id }, { uid, linearClient, aiGateway }) =>
    toWireFeatureRequest(await approveFeatureRequestPlan(uid, id, linearClient, aiGateway)),
  ),
  // DAN-52: same linearClient seam. The data layer returns wire-ready plain
  // strings/nulls/arrays — no toWire conversion needed. Any Linear failure
  // (LinearError included) deliberately has no mapError branch: it falls
  // through to INTERNAL, logged server-side, nothing leaked.
  featureRequestProgress: contextResolver(async ({ promptId }, { uid, linearClient }) =>
    featureRequestProgress(uid, promptId, linearClient),
  ),
  // DAN-83: same linearClient seam and same rules as featureRequestProgress —
  // the data layer returns wire-ready strings/nulls, and a Linear failure has
  // no mapError branch: INTERNAL, logged server-side, nothing leaked.
  featureRequestActivity: contextResolver(async ({ promptId }, { uid, linearClient }) =>
    featureRequestActivity(uid, promptId, linearClient),
  ),
  // DAN-80: same aiGateway seam as sendFeatureRequestMessage. The data layer
  // returns wire-ready non-null numbers — no toWire conversion needed. A
  // gateway failure (GatewayError) deliberately has no mapError branch: it
  // falls through to INTERNAL, logged server-side, nothing leaked.
  featureRequestCost: contextResolver(async ({ promptId }, { uid, aiGateway }) =>
    featureRequestCost(uid, promptId, aiGateway),
  ),
  records: resolver(async () => (await listRecords()).map(toWire)),
  // DAN-48: the caller's usage totals — zeros for a fresh user, never null.
  // The uid comes from the GraphQL context (threaded by the auth gate through
  // createHandler's context fn in index.js), never from an argument, so a user
  // can only ever read their own ledger.
  myAiUsage: resolver(async (_args, context) => getUsage(context.uid)),
  // DAN-96: language preference. Same rule as myAiUsage — the uid comes from
  // the GraphQL context (threaded from the verified token by the auth gate,
  // see index.js) and never from an argument, which is what makes "a caller
  // can only ever read/write their own row" structural rather than a check
  // someone has to remember. resolver() (not contextResolver) because these
  // are records-style resolvers with no NotFoundError of their own: the
  // ValidationError userPrefs.js throws for a bad language goes through the
  // one mapError to BAD_USER_INPUT with extensions.field = 'language'.
  languagePreference: resolver(async (_args, context) => getLanguagePreference(context.uid)),
  setLanguagePreference: resolver(async ({ language }, context) =>
    setLanguagePreference(context.uid, language),
  ),
  record: resolver(async ({ id }) => toWire(await getRecord(id))),
  createRecord: resolver(async ({ input }) => toWire(await createRecord(input))),
  updateRecord: resolver(async ({ id, input }) => toWire(await updateRecord(id, input))),
  deleteRecord: resolver(async ({ id }) => {
    await deleteRecord(id)
    // A mutation must return something; echo the id. The frontend ignores it.
    return id
  }),
}
