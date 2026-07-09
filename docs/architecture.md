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

The Cloud Run service is named `linear-example-backend`. `firebase.json` lives at the repo
root and is the single source of that routing:

```jsonc
// firebase.json
{
  "hosting": {
    "public": "app/frontend/dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "/api/**", "run": { "serviceId": "linear-example-backend", "region": "us-central1" } },
      { "source": "**",       "destination": "/index.html" }
    ]
  }
}
```

The `/api/**` run rewrite must come before the `**` SPA fallback: rewrites match top-down,
and if the catch-all is first every API request is served `index.html` instead of reaching
Cloud Run. `public` is the Vite build output (`dist`), never the source tree.

Atlas must be in the same GCP region as Cloud Run. Cross-region adds tens of milliseconds
to every query, and on a table view that issues one query per page load it's the difference
between snappy and sluggish.

Atlas IP allowlist: set to `0.0.0.0/0`. Cloud Run has no static egress IP by default, and
the access control that matters is the database password (stored in Secret Manager) plus
TLS, not network origin — a VPC connector with Cloud NAT to obtain a static egress IP is
infrastructure an M0 reference app does not justify, and an open allowlist is what the free
tier expects.

## Remote execution

**Scope:** this relay is how a Linear ticket *wakes an agent* — it is agent-orchestration
infrastructure, not part of deploying the application. The deploy pipeline in the CI/CD
section triggers on `push to main`, which GitHub runs natively with no relay in the path.
The relay is therefore out of scope for this project's deploy tickets and is not sliced
below; it is documented here so the team-automation layer has a design, not because
shipping the CRUD app depends on it.

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
                │       --service-account=linear-example-run@…
                │       --set-secrets=MONGODB_URI=MONGODB_URI:latest
                │
                └── frontend job
                      (working-dir app/frontend) npm ci && npm run build
                      (working-dir repo root)    firebase deploy --only hosting
```

The frontend job spans two working directories because there is no root workspace:
`npm ci && npm run build` run in `app/frontend` (that is where the frontend package and its
`package.json` live), then `firebase deploy` runs from the **repo root**, where `firebase.json`
lives and where `public: app/frontend/dist` resolves. Do not run `firebase deploy` from
`app/frontend` — the config isn't there and the `public` path would resolve wrong.

Image reference:

```
us-central1-docker.pkg.dev/project-d60a83c1-2c60-4d51-ad0/linear-example/backend:<git-sha>
```

Tag by commit SHA, never `latest`. Cloud Run resolves the tag to a digest at deploy time;
a mutable tag means a rollback can silently land on different bytes than it did originally.

### Authentication: no service account keys

`google-github-actions/auth@v2` exchanges the workflow's OIDC token for short-lived GCP
credentials via Workload Identity Federation. No long-lived service-account **key** exists
anywhere — not on the runner, not in GitHub Secrets. The auth step does write a short-lived,
auto-expiring credential-config file to the runner and exports `GOOGLE_APPLICATION_CREDENTIALS`
pointing at it, so Application Default Credentials work for tools that only speak ADC (the
Firebase CLI, below); that file is a federated token config, not a downloadable key, and dies
with the job.

**Two service accounts, distinct jobs.** The deploy SA is who the *workflow* acts as; the
runtime SA is who the *Cloud Run container* acts as. Conflating them is the "deploy is green,
container is dead" trap — deploy permissions don't include reading the secret the container
needs at startup.

*Deploy service account* — `deploy@project-d60a83c1-2c60-4d51-ad0.iam.gserviceaccount.com`.
Impersonated by the workflow via WIF. Needs exactly: `roles/artifactregistry.writer`,
`roles/run.admin`, `roles/iam.serviceAccountUser`, and `roles/firebasehosting.admin`. The
`serviceAccountUser` role is what lets it deploy a revision that *runs as* the runtime SA.

*Runtime service account* — `linear-example-run@project-d60a83c1-2c60-4d51-ad0.iam.gserviceaccount.com`,
a **dedicated** SA, not the default compute SA. It needs exactly `roles/secretmanager.secretAccessor`,
granted **on the `MONGODB_URI` secret only** (resource-level, not project-wide). Dedicated
rather than default compute because the default SA carries broad `Editor` and Google is phasing
off auto-granting it — a purpose-made SA holding one role is the least-privilege story the rest
of this doc already commits to. The Cloud Run deploy in ticket 9 must pass
`--service-account=linear-example-run@…` or the revision runs as the default SA and the
resource-scoped grant won't apply.

#### Workload Identity Federation — exact values

The developer pastes `WIF_PROVIDER` and `DEPLOY_SA` (GitHub Secrets) into
`google-github-actions/auth@v2`. Ticket 7 creates the pool, provider, and bindings with these
exact IDs:

| Thing | Value |
|---|---|
| Pool ID | `github-pool` |
| Provider ID | `github-provider` |
| Issuer URI | `https://token.actions.githubusercontent.com` |
| `WIF_PROVIDER` (full resource) | `projects/756865700041/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `DEPLOY_SA` | `deploy@project-d60a83c1-2c60-4d51-ad0.iam.gserviceaccount.com` |

Attribute mapping:

```
google.subject=assertion.sub
attribute.repository=assertion.repository
attribute.repository_owner=assertion.repository_owner
```

Attribute condition — **required, not optional**. Without it, any GitHub repo's OIDC token can
exchange for the deploy SA's credentials:

```
assertion.repository == 'dperez4787/linear-example'
```

The deploy SA is bound to the pool by a `roles/iam.workloadIdentityUser` grant scoped to the
repository principal, so only workflows from this repo can impersonate it:

```
principalSet://iam.googleapis.com/projects/756865700041/locations/global/workloadIdentityPools/github-pool/attribute.repository/dperez4787/linear-example
```

#### Firebase Hosting deploy auth

`firebase deploy` authenticates via ADC — it reads the `GOOGLE_APPLICATION_CREDENTIALS` the
auth step exported. This works cleanly on `firebase-tools >= 11.30` (which added ADC support
for hosting); pin an **exact** version in the workflow (`npm i -g firebase-tools@13.29.2` — any
exact pin at or above that floor is fine, the point is a pinned version, never a floating tag,
so a CLI release can't change deploy behavior under us). Exact invocation, run from the repo
root:

```
firebase deploy --only hosting --project project-d60a83c1-2c60-4d51-ad0 --non-interactive
```

Do **not** set `FIREBASE_TOKEN` and do **not** fall back to it: `FIREBASE_TOKEN` is a
long-lived refresh credential that reintroduces exactly the standing secret OIDC exists to
eliminate. If a specific `firebase-tools` release regresses ADC, the fallback is to pin down to
a known-good version — cost is bounded to editing one version string — not to switch auth
mechanisms.

### Secrets

| Secret | Lives in | Consumed by |
|---|---|---|
| `MONGODB_URI` | GCP Secret Manager | Cloud Run container, as the runtime SA, via `--set-secrets` |
| `WIF_PROVIDER`, `DEPLOY_SA` | GitHub Secrets | the workflow's auth step |
| Linear webhook signing secret | Cloud Run relay env | the relay |

`MONGODB_URI` is never a GitHub Secret. The runner has no reason to hold a database
credential — it builds an image and asks Cloud Run to run it. Only the running service needs
to reach Mongo, and it reads the secret as the runtime SA (see Authentication).

Ticket 7 must create both the `MONGODB_URI` secret **and an initial secret version holding the
real Atlas connection string**. `--set-secrets` in ticket 9 binds to `MONGODB_URI:latest`,
which resolves at deploy time and fails the deploy if no version exists — an empty secret
container is not enough.

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
| Deploy SA (`deploy@…`) + WIF pool/provider + repo binding | not created |
| Runtime SA (`linear-example-run@…`) + `secretAccessor` on `MONGODB_URI` | not created |
| `MONGODB_URI` secret **and initial version** | not created |
| Atlas cluster region | **unconfirmed** — must be `us-central1` to match |

Enabling the four disabled APIs, creating the WIF pool/provider and deploy service account,
creating the dedicated runtime service account and granting it `secretAccessor` on the secret,
and creating the `MONGODB_URI` secret with its first version are one-time account state rather
than per-deploy code, so they are collected into one bootstrap ticket (below) instead of
scattered across the tickets that consume them — that gives one place where the deploy identity
is established and verified.

**Ticket 7 is user-executed.** Every step in it — enabling APIs, creating the WIF pool, binding
service accounts, writing the real connection string into Secret Manager, confirming the Atlas
region — requires GCP-console/owner and Atlas-org access that no developer or tester agent has,
and none of it is observable from the repo. It therefore stays a Linear ticket for tracking and
as the dependency that gates tickets 9 and 11, but is explicitly flagged **USER-EXECUTED**: no
developer agent picks it up and no tester agent verifies it. Its acceptance criteria are
**user-attested** — the user confirms each resource exists (e.g. `gcloud iam service-accounts
list`, `gcloud secrets versions list MONGODB_URI` show what's expected). It is effectively a
prerequisite runbook that happens to be filed as an issue.

The Atlas region is the only entry that cannot be corrected later, and it is a hard
prerequisite: it must be confirmed — and the cluster recreated in `us-central1` if it is
anywhere else — before the backend scaffold ticket, which is the first thing to open a
connection. Confirming it needs Atlas org access, so it is a blocker the user must clear
before that ticket starts, not something an agent can settle from the repo.

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

### Deploy and infrastructure

These ship the pipeline described in the Deploy topology and CI/CD sections. Each leaves the
repo working on its own. The relay in Remote execution is deliberately not among them.

**Acceptance-criteria convention for deploy tickets (9, 10, 11).** A live deploy to Cloud Run
or Firebase is not observable by an agent — no developer or tester agent holds cloud
credentials, so "the site is live at the Cloud Run URL" is a criterion neither can honestly
sign off. The product-owner must therefore split every deploy ticket's acceptance criteria into
two labeled groups, and the tester verifies only the first:

- **Agent-checkable** — everything provable in the repo with no cloud access: the Dockerfile
  builds and `docker run` serves `/healthz` locally; the workflow YAML parses and passes
  `actionlint`; `firebase.json` is schema-valid and the rewrite order is correct; the deploy
  command lines contain the required flags (`--service-account`, `--set-secrets`, SHA tag, no
  `latest`, no Cloud Build).
- **User-attested** — the live outcome only the user can confirm after a real push: the Cloud
  Run revision is serving, `/api/records` responds through the Firebase rewrite, the container
  read `MONGODB_URI` at startup. The tester records these as "pending user attestation," not as
  pass or fail.

7. **Deploy prerequisites (GCP + Atlas) — USER-EXECUTED.** Enable `run`, `iamcredentials`,
   `secretmanager`, and `firebasehosting` APIs; create the WIF pool `github-pool` and provider
   `github-provider` with the attribute mapping and the `assertion.repository ==
   'dperez4787/linear-example'` condition (see Authentication); create the deploy SA with
   exactly the four roles and bind it to the repo principal; create the dedicated runtime SA
   and grant it `secretmanager.secretAccessor` on the `MONGODB_URI` secret; create the
   `MONGODB_URI` secret **and its first version** with the real Atlas string; set the Atlas
   allowlist to `0.0.0.0/0`. No repo code; the user runs it and attests each resource exists.
   Depends on the Atlas region being confirmed first. Prerequisite for tickets 9 and 11.

8. **Backend Dockerfile.** `app/backend/Dockerfile` (plus `.dockerignore`) exactly as in the
   CI/CD section — `node:24-slim`, `npm ci --omit=dev`, listen on `process.env.PORT`. Verified
   by `docker build` then `docker run` reaching `/healthz`. Depends on ticket 1 (needs a
   server that listens and a `/healthz` route).

9. **Backend deploy workflow.** A `push to main` GitHub Actions job that OIDC-auths, builds
   and pushes the image tagged by git SHA to Artifact Registry, and deploys the
   `linear-example-backend` Cloud Run service with `--min-instances=1 --cpu-boost`,
   `--service-account=linear-example-run@…`, and `--set-secrets=MONGODB_URI=MONGODB_URI:latest`.
   File: `.github/workflows/deploy.yml`. No `latest` image tag, no Cloud Build, no service
   account key. Depends on tickets 7 and 8.

10. **Firebase Hosting config.** Root `firebase.json` (and `.firebaserc`) with the `/api/**`
    → Cloud Run rewrite ahead of the `**` → `/index.html` SPA fallback, `public` set to
    `app/frontend/dist`. Depends on ticket 4 (a build to serve) and ticket 9 (the Cloud Run
    service must exist for the rewrite target to resolve).

11. **Frontend deploy workflow.** A second `push to main` job in `deploy.yml` that runs
    `npm ci && npm run build` in `app/frontend`, then `firebase deploy --only hosting
    --project project-d60a83c1-2c60-4d51-ad0 --non-interactive` from the **repo root**, using
    an exact-pinned `firebase-tools` (>= 11.30) authenticating via the ADC file the OIDC auth
    step exports — no `FIREBASE_TOKEN` (see Authentication). Depends on tickets 7, 10, and 4.
