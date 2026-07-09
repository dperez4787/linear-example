# linear-example

A table-CRUD reference app built end-to-end by a team of Claude Code agents driven from Linear tickets.

## Stack

| Layer    | Choice |
|----------|--------|
| Frontend | React SPA — single table view with add/edit/delete |
| Backend  | Node.js + Express REST API |
| Database | MongoDB Atlas (free M0 tier, GCP region) |
| Deploy   | Cloud Run (backend), Firebase Hosting (frontend) — no Kubernetes |

## Layout

```
app/frontend/   React SPA
app/backend/    Express API + MongoDB client
docs/           architecture.md — API contract, schema, components
.claude/agents/ product-owner, architect, developer, tester
```

Frontend and backend are independent npm packages. There is no root workspace; run
commands from inside `app/frontend` or `app/backend`.

## MongoDB connection pattern

The connection string is **never** committed. It is read from `MONGODB_URI` — a `.env`
file locally (gitignored), a Secret Manager secret in Cloud Run.

Connect once at process start and reuse the client. Do not open a client per request —
`MongoClient` pools internally, and per-request connects will exhaust the M0 tier's
500-connection cap.

```js
// app/backend/src/db.js
import { MongoClient } from 'mongodb'

let db

export async function connect() {
  if (db) return db
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  db = client.db(process.env.MONGODB_DB ?? 'linear_example')
  return db
}

export function getDb() {
  if (!db) throw new Error('connect() must be awaited before getDb()')
  return db
}
```

Cloud Run scales to zero and reuses warm instances, so module-level connection caching is
correct there. The service runs `--min-instances=1 --cpu-boost` to avoid cold-start
connection latency.

## Environment

| Variable      | Where |
|---------------|-------|
| `MONGODB_URI` | `.env` locally, Secret Manager in Cloud Run |
| `MONGODB_DB`  | `linear_example` (app), `linear_example_test` (test runs only) |
| `PORT`        | Cloud Run injects this; default `8080` locally |

GCP project: `<GCP_PROJECT_ID>` — fill in before Step 6.

## Local toolchain

Node is installed via `nvm` (`~/.nvm`), pinned by `.nvmrc` to the current LTS. Run
`nvm use` in the repo root to match it.

`nvm`'s installer writes to `~/.zshrc`, which only interactive shells read. This repo's
Node lives on `PATH` via `~/.zshenv` instead, so non-interactive shells — every command an
agent runs — can find it. If `node: command not found` appears in agent output, that file
is the first place to look.

## Conventions

- ES modules (`"type": "module"`), Node 24 LTS.
- `async`/`await` only, no `.then()` chains.
- Express handlers stay thin: validate → call a function in `src/records.js` → send. No
  Mongo driver calls inside route handlers.
- Errors: throw from the data layer, catch in one Express error middleware that maps to
  status codes. Never `res.status(500)` inline.
- Frontend calls the API through `src/api.js`. No `fetch()` inside components.
- Tests colocate as `*.test.js` next to what they test. Backend uses `node:test` and
  `supertest`; frontend uses Vitest and Testing Library.
- Every ticket's acceptance criteria live on the Linear issue and are what the tester
  agent verifies against — not what the developer agent thinks it built.

## Agent workflow

`product-owner` writes Linear tickets → `architect` records design decisions in
`docs/architecture.md` → `developer` implements one ticket → `tester` verifies against
the ticket's acceptance criteria and comments pass/fail on the issue.

Agents work one ticket at a time. A ticket is not done until the tester has commented on it.
