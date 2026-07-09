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

## Remote execution

Linear cannot trigger an agent. The Linear MCP server is *pull* — it lets a running agent
read and write issues; it cannot wake one up. Every design here therefore needs a relay
that receives Linear's webhook and calls something.

```
Linear webhook (issue state change)
   │
   v
Cloud Run relay ── verify Linear signature ──> GitHub repository_dispatch
                                                  │
                                                  v
                                          GitHub Actions runner
                                            anthropics/claude-code-action@v1
                                            google-github-actions/auth (OIDC)
                                                  │
                                                  v
                                       gcloud run deploy + firebase deploy
```

Repo: `github.com/dperez4787/linear-example`.

### Why GitHub Actions rather than Claude Code Routines

Routines expose a documented `POST /v1/claude_code/routines/{id}/fire` endpoint, which is
the more direct fit and was the original plan. Two things rule it out.

**No secrets store.** Secrets in the Anthropic-managed cloud environment are plaintext
environment variables readable by anyone who can edit the environment. Since Step 6 deploys
to GCP, that means a long-lived service account key sitting in plaintext. GitHub Actions
supports OIDC Workload Identity Federation, so no service account key needs to exist at all.
This is the deciding factor.

**Research preview.** `/fire` ships behind the `experimental-cc-routine-2026-04-01` beta
header and is subject to breaking changes. The GitHub Action is GA.

Also relevant, if the decision is ever revisited: the cloud environment cannot be given a
`Dockerfile` or `devcontainer.json` — the base image is fixed, customizable only by a
root setup script (cached ~7 days) and `SessionStart` hooks. It has Node and Python
preinstalled but **not** `gcloud`.

The relay verifies Linear's webhook signature before dispatching. An unauthenticated relay
lets anyone on the internet start an agent that can push code.

## CI/CD

GitHub Actions is a runner, not a build system. It provides an Ubuntu VM with `docker`
preinstalled and executes shell steps. Nothing about containerization is automatic — the
workflow does it explicitly.

### Only the backend is containerized

The two halves deploy by different mechanisms, and conflating them causes confusion:

| | Artifact | Mechanism |
|---|---|---|
| `app/frontend` | static files from `npm run build` | uploaded to Firebase Hosting CDN |
| `app/backend`  | OCI container image | pushed to Artifact Registry, run by Cloud Run |

The SPA is never containerized. Cloud Run runs *only* container images, so the Express
service is the sole container in the system.

### Build with a Dockerfile on the runner, not Cloud Build

`gcloud run deploy --source .` would hand the source to **Cloud Build**, which containerizes
it with Google Cloud Buildpacks and no Dockerfile. We deliberately do not do this.

An explicit `app/backend/Dockerfile`, built with `docker build` on the runner:

- **Pins the Node version** to match `.nvmrc`. Buildpacks infer it, and the inference is a
  thing you debug in someone else's builder when it's wrong.
- **Needs no Cloud Build API and no Cloud Build IAM roles.** `cloudbuild.googleapis.com`
  stays disabled. Fewer permissions attached to the deploy identity is the whole point of
  choosing OIDC in the first place.
- **Is inspectable.** Twelve lines you can read beats an image you can only introspect after
  it's built.
- Builds on the runner in seconds, with layer caching, instead of round-tripping to GCP.

Revisit this only if the backend grows a native-dependency build chain messy enough that
maintaining the Dockerfile costs more than the opacity of buildpacks.

```dockerfile
# app/backend/Dockerfile
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
CMD ["node", "src/index.js"]
```

`npm ci` runs before `COPY src` so the dependency layer is cached and only reinstalls when
`package-lock.json` changes. The process must listen on `process.env.PORT`; Cloud Run injects
it and health-checks that port. `/healthz` must not touch Mongo — a database blip would
otherwise tear down the revision.

### Pipeline

```
push to main  ──┬── backend job
                │     setup-gcloud + auth (OIDC)
                │     docker build -t $IMAGE app/backend
                │     docker push $IMAGE
                │     deploy-cloudrun --image $IMAGE
                │
                └── frontend job
                      npm ci && npm run build
                      firebase deploy --only hosting
```

Image reference:

```
us-central1-docker.pkg.dev/project-d60a83c1-2c60-4d51-ad0/linear-example/backend:<git-sha>
```

Tag by commit SHA, never `latest`. Cloud Run resolves the tag to a digest at deploy time;
a mutable tag means a rollback can silently land on different bytes than it did originally.

### Authentication: no service account keys

`google-github-actions/auth@v2` exchanges the workflow's OIDC token for short-lived GCP
credentials via Workload Identity Federation. No `GOOGLE_APPLICATION_CREDENTIALS` file
exists anywhere — not on the runner, not in GitHub Secrets.

GCP project number for the WIF provider binding: **756865700041**.

The deploy service account needs exactly: `roles/artifactregistry.writer`,
`roles/run.admin`, `roles/iam.serviceAccountUser`, and `roles/firebasehosting.admin`.

### Secrets

| Secret | Lives in | Consumed by |
|---|---|---|
| `MONGODB_URI` | GCP Secret Manager | Cloud Run, via `--set-secrets` |
| `WIF_PROVIDER`, `DEPLOY_SA` | GitHub Secrets | the workflow's auth step |
| Linear webhook signing secret | Cloud Run relay env | the relay |

`MONGODB_URI` is never a GitHub Secret. The runner has no reason to hold a database
credential — it builds an image and asks Cloud Run to run it. Only the running service needs
to reach Mongo.

### Infrastructure state

| Item | Status |
|---|---|
| GCP project `project-d60a83c1-2c60-4d51-ad0` (number `756865700041`) | active, **billing enabled** |
| Artifact Registry `linear-example`, docker, `us-central1` | created |
| `artifactregistry.googleapis.com` | enabled |
| `run.googleapis.com` | not enabled |
| `iamcredentials.googleapis.com` (required for WIF) | not enabled |
| `secretmanager.googleapis.com` | not enabled |
| `firebasehosting.googleapis.com` | not enabled |
| `cloudbuild.googleapis.com` | not enabled — and intentionally stays that way |
| Atlas cluster region | **unconfirmed** — must be `us-central1` to match |

The Atlas region is the only entry that cannot be corrected later.

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
