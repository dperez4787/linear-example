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
import {
  startFeatureRequest,
  listFeatureRequests,
  getFeatureRequest,
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

  type FeatureRequestMessage {
    role: String!
    content: String!
  }

  type FeatureRequest {
    id: ID!
    status: String!
    model: String!
    createdAt: String!
    messages: [FeatureRequestMessage!]!
  }

  input StartFeatureRequestInput {
    model: String!
  }

  type Query {
    records: [Record!]!
    record(id: ID!): Record
    myAiUsage: AiUsage!
    featureRequests: [FeatureRequest!]!
    featureRequest(id: ID!): FeatureRequest
  }

  type Mutation {
    createRecord(input: CreateRecordInput!): Record!
    updateRecord(id: ID!, input: UpdateRecordInput!): Record!
    deleteRecord(id: ID!): ID!
    startFeatureRequest(input: StartFeatureRequestInput!): FeatureRequest!
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

// createdAt is a Date in the data layer; convert at the presentation boundary,
// same rule as toWire above.
function toWireFeatureRequest(featureRequest) {
  return {
    ...featureRequest,
    createdAt: featureRequest.createdAt.toISOString(),
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
  records: resolver(async () => (await listRecords()).map(toWire)),
  // DAN-48: the caller's usage totals — zeros for a fresh user, never null.
  // The uid comes from the GraphQL context (threaded by the auth gate through
  // createHandler's context fn in index.js), never from an argument, so a user
  // can only ever read their own ledger.
  myAiUsage: resolver(async (_args, context) => getUsage(context.uid)),
  record: resolver(async ({ id }) => toWire(await getRecord(id))),
  createRecord: resolver(async ({ input }) => toWire(await createRecord(input))),
  updateRecord: resolver(async ({ id, input }) => toWire(await updateRecord(id, input))),
  deleteRecord: resolver(async ({ id }) => {
    await deleteRecord(id)
    // A mutation must return something; echo the id. The frontend ignores it.
    return id
  }),
}
