import express from 'express'

import { connect } from './db.js'

const PORT = process.env.PORT ?? 8080

export function createApp() {
  const app = express()

  app.use(express.json())

  // Health check for Cloud Run. Must not touch Mongo — a database blip must not
  // fail the health check, or the revision gets torn down.
  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  // No /api/records routes yet — added in a later ticket.

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
