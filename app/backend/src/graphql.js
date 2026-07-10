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

  type Query {
    records: [Record!]!
    record(id: ID!): Record
  }

  type Mutation {
    createRecord(input: CreateRecordInput!): Record!
    updateRecord(id: ID!, input: UpdateRecordInput!): Record!
    deleteRecord(id: ID!): ID!
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
function mapError(err) {
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
function resolver(fn) {
  return async (args) => {
    try {
      return await fn(args)
    } catch (err) {
      throw mapError(err)
    }
  }
}

// Root resolvers for a buildSchema schema: a flat object whose function fields are
// called with the field's arguments. Each is the same one-liner the REST handler was.
export const rootValue = {
  records: resolver(async () => (await listRecords()).map(toWire)),
  record: resolver(async ({ id }) => toWire(await getRecord(id))),
  createRecord: resolver(async ({ input }) => toWire(await createRecord(input))),
  updateRecord: resolver(async ({ id, input }) => toWire(await updateRecord(id, input))),
  deleteRecord: resolver(async ({ id }) => {
    await deleteRecord(id)
    // A mutation must return something; echo the id. The frontend ignores it.
    return id
  }),
}
