import express from 'express'
import { createHandler } from 'graphql-http/lib/use/express'

import { authGate, firebaseVerifyToken } from './auth.js'
import { connect } from './db.js'
import { schema, rootValue } from './graphql.js'

const PORT = process.env.PORT ?? 8080

// The token verifier is injected so tests can substitute a stub (no emulator, no
// network); it defaults to the firebase-admin wrapper, which initializes lazily on
// first use so boot and /health stay credential- and network-free. See auth.js and
// docs/architecture.md (Authentication).
export function createApp({ verifyToken = firebaseVerifyToken } = {}) {
  const app = express()

  app.use(express.json())

  // Health check for Cloud Run. Must not touch Mongo — a database blip must not
  // fail the health check, or the revision gets torn down.
  //
  // Path is /health, NOT /healthz: the platform in front of Cloud Run intercepts
  // the exact path /healthz and returns a Google 404 before the request ever
  // reaches this container, so /healthz was unreachable over the public URL even
  // though the container served it correctly. Do not rename this back. See DAN-18
  // and docs/architecture.md (API contract).
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  // The records surface is a single GraphQL endpoint, POST /api/graphql. It mounts
  // AFTER /health (which stays unauthenticated and Mongo-free) and BEHIND the same
  // auth gate the REST routes used, with identical DAN-22 semantics: a missing/
  // non-Bearer header or any verifier rejection fails the request as a 401 via
  // next(err), before any GraphQL parsing and without ever reaching the data layer.
  // It must live under /api/** or the Firebase Hosting rewrite never routes it to
  // Cloud Run. See docs/architecture.md (GraphQL API) and graphql.js.
  app.use(
    '/api/graphql',
    authGate(verifyToken),
    createHandler({
      schema,
      rootValue,
      // Thread the verified caller's identity into GraphQL execution. The gate
      // attached the decoded token to req.auth (see auth.js); req.raw is the
      // Express request underneath graphql-http's adapter. Feature-request
      // resolvers read uid from this context (DAN-47); the records resolvers
      // ignore it.
      context: (req) => ({ uid: req.raw.auth.uid }),
    }),
  )

  // One error middleware maps thrown errors to status codes. Validation errors
  // from the schema/data layer carry `status` (400) and `field`; anything else
  // is an unexpected 500. Route handlers never call res.status(500) inline.
  // The 4-arg signature is what marks this as Express error-handling middleware,
  // so `next` must stay in the list even though it is unused.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? 500
    if (status >= 500) {
      // Log the real error server-side but don't leak internals to the client.
      console.error(err)
      res.status(status).json({ error: { message: 'Internal Server Error' } })
      return
    }
    const error = { message: err.message }
    if (err.field) error.field = err.field
    res.status(status).json({ error })
  })

  return app
}

async function main() {
  const app = createApp()

  // Listen first so /health is available immediately — Cloud Run health-checks
  // the port on startup, and the check must not depend on Mongo being reachable.
  app.listen(PORT, () => {
    console.log(`backend listening on ${PORT}`)
  })

  // Connect once at process start and reuse the pooled client. A failed
  // connection must NOT stop the server: /health has to keep returning 200 even
  // when Mongo is unreachable. Routes that need the db (added in a later ticket)
  // call getDb() and will surface a clear error until the connection succeeds.
  try {
    await connect()
    console.log('connected to MongoDB')
  } catch (err) {
    console.error('MongoDB connection failed at startup:', err.message)
  }
}

// Only start the server when run directly, so tests can import createApp without
// opening a connection or binding a port.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('failed to start backend:', err)
    process.exit(1)
  })
}
