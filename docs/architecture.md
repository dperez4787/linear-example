# Architecture

Status: **strawman**. Written in Step 1 to give agents and tickets something concrete to
scope against. The `architect` agent owns this file from Step 4 onward and should revise
anything here that doesn't survive contact with a real ticket.

## Scope

One resource — `Record` — rendered as a table. Users can list, create, edit, and delete
rows. No auth, no pagination, no search in v1. Those are deliberate omissions, not
oversights; adding them is a follow-up ticket, not scope creep into the first four.

## Data model

Collection: `records`

| Field       | Type     | Notes |
|-------------|----------|-------|
| `_id`       | ObjectId | Mongo-assigned |
| `name`      | string   | required, 1–120 chars |
| `status`    | string   | one of `active`, `pending`, `archived` |
| `amount`    | number   | required, finite, >= 0 |
| `notes`     | string   | optional, <= 1000 chars |
| `createdAt` | Date     | set on insert |
| `updatedAt` | Date     | set on insert and every update |

Validation lives in the backend, in one schema module, and is applied on both create and
update. The frontend may mirror it for UX but is never the enforcement point.

`_id` is serialized to the client as a string `id`. The frontend never sees `_id`.

## API contract

Base path `/api/records`. JSON in, JSON out. All responses are objects, never bare arrays —
that leaves room to add pagination metadata without a breaking change.

| Method   | Path                | Body            | Success            | Errors |
|----------|---------------------|-----------------|--------------------|--------|
| `GET`    | `/api/records`      | —               | `200 {records:[]}` | — |
| `POST`   | `/api/records`      | Record, no `id` | `201 {record}`     | `400` invalid |
| `GET`    | `/api/records/:id`  | —               | `200 {record}`     | `404` |
| `PATCH`  | `/api/records/:id`  | partial Record  | `200 {record}`     | `400`, `404` |
| `DELETE` | `/api/records/:id`  | —               | `204` no body      | `404` |

`PATCH` rather than `PUT`: the table edits individual cells, so partial update is the
natural verb and avoids clients having to round-trip the whole document.

Errors are `{ error: { message, field? } }`. A malformed `:id` that isn't a valid ObjectId
is a `404`, not a `400` — the client shouldn't have to distinguish "no such record" from
"that couldn't possibly be a record".

Health check at `GET /healthz` returning `200` — Cloud Run needs it, and it must not touch
Mongo, or a database blip will cause the revision to be torn down.

## Backend structure

```
app/backend/src/
├── index.js      express app, middleware, listen
├── db.js         connect() / getDb(), module-level client
├── records.js    data layer — all Mongo calls live here
├── schema.js     validation for create + update
└── routes.js     express router, thin handlers
```

The split matters for the tester agent: `records.js` is unit-testable against a scratch
database, and `routes.js` is testable with `supertest` without a database at all if
`records.js` is stubbed.

## Frontend structure

```
app/frontend/src/
├── App.jsx           layout, loads records once
├── api.js            the only module that knows the API exists
├── RecordTable.jsx   renders rows, owns the "which row is editing" state
├── RecordRow.jsx     one row — display mode and edit mode
└── NewRecordForm.jsx create
```

State lives in `App.jsx` and flows down. No state manager in v1 — one resource and one
screen doesn't justify one, and introducing Redux/Zustand here would be a decision the
next reader has to unwind.

Mutations are optimistic-with-rollback: apply locally, fire the request, restore the prior
value and surface an error if it fails. The alternative — spinner on every keystroke-commit —
makes an inline-editable table feel broken.

## Deploy topology

```
Browser ──> Firebase Hosting (static SPA)
              │  /api/* rewrite
              v
           Cloud Run (backend, min-instances=1, cpu-boost)
              │  MONGODB_URI from Secret Manager
              v
           MongoDB Atlas M0 (GCP region, same as Cloud Run)
```

Firebase Hosting rewrites `/api/**` to the Cloud Run service, so the SPA and API are
same-origin and there is no CORS configuration to maintain. The backend still sets CORS
headers for local development, where Vite serves on a different port.

Atlas must be in the same GCP region as Cloud Run. Cross-region adds tens of milliseconds
to every query, and on a table view that issues one query per page load it's the difference
between snappy and sluggish.

Atlas IP allowlist: Cloud Run has no static egress IP by default. Either allow `0.0.0.0/0`
(acceptable for M0 with a strong DB password, and what the free tier expects) or attach a
VPC connector with Cloud NAT. Decide this in Step 6 — it is the one piece of infra that
routinely surprises people.

## Ticket slicing

The `product-owner` agent should cut roughly:

1. Backend scaffold — Express app, `/healthz`, Mongo connection, no routes.
2. `GET /api/records` + `POST /api/records`.
3. `PATCH /api/records/:id` + `DELETE /api/records/:id`.
4. Frontend scaffold + `api.js` + read-only table.
5. Inline edit + delete in the table.
6. Create form.

Each is independently testable and leaves the app in a working state. Ticket 1 exists so
the developer agent's first ticket isn't also the one that discovers the Atlas connection
string is wrong.
