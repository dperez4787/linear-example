import express from 'express'

import { connect } from './db.js'
import { recordsRouter } from './routes.js'

const PORT = process.env.PORT ?? 8080

export function createApp() {
  const app = express()

  app.use(express.json())

  // Health check for Cloud Run. Must not touch Mongo — a database blip must not
  // fail the health check, or the revision gets torn down.
  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  app.use('/api/records', recordsRouter())

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

  // Listen first so /healthz is available immediately — Cloud Run health-checks
  // the port on startup, and the check must not depend on Mongo being reachable.
  app.listen(PORT, () => {
    console.log(`backend listening on ${PORT}`)
  })

  // Connect once at process start and reuse the pooled client. A failed
  // connection must NOT stop the server: /healthz has to keep returning 200 even
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
