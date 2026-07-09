# Architecture

Status: **strawman**. Written in Step 1 to give agents and tickets something concrete to
scope against. The `architect` agent owns this file from Step 4 onward and should revise
anything here that doesn't survive contact with a real ticket.

## Scope

One resource — `Record` — rendered as a table. Users can list, create, edit, and delete
rows. Access is gated by Google sign-in (see [Authentication](#authentication)): a signed-in
user may read and write every record, and there is no per-user data. No pagination, no search
in v1. Those are deliberate omissions, not oversights; adding them is a follow-up ticket, not
scope creep into the first four.

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

Health check at `GET /health` returning `200` — Cloud Run needs it, and it must not touch
Mongo, or a database blip will cause the revision to be torn down.

The path is `/health`, **not** `/healthz` (DAN-18). The platform in front of Cloud Run
intercepts the exact path `/healthz` and returns a Google `404` before the request ever
reaches the container, so `/healthz` was unreachable over the public URL even though the
container served it correctly (verified against the live service: same host, same revision,
`/healthz` → `404` with no `x-powered-by: Express` header, while every other path including
`/nonexistent` reached Express). `/health` is not intercepted. The endpoint was originally
specified as `/healthz` in DAN-5 — that criterion is superseded by this one. Do not rename
it back to `/healthz`; the platform will swallow it again.

## Authentication

Every `/api/records` request must carry a valid Firebase ID token; anonymous or invalid
requests get `401`. This is a **gate, not a data-model change** — any signed-in user reads
and writes every record. There is no `owner`/`uid` field, no migration, and no per-record
ownership check; adding per-user data is a separate decision, not this one. Sign-in is
Google-only (`signInWithPopup(GoogleAuthProvider)`); the frontend attaches the token as
`Authorization: Bearer <idToken>` and the backend verifies it with `firebase-admin`
(exact-pinned dependency).

### The verifier is injectable; `firebase-admin` is the default

`createApp()` takes an optional token verifier — `createApp({ verifyToken } = {})` —
defaulting to a wrapper over `firebase-admin`'s `getAuth().verifyIdToken(idToken)`. The auth
middleware calls `verifyToken(token)` and gates on whether it resolves. Tests inject a stub
that resolves for a known fake token and rejects otherwise: no emulator, no network, no extra
process in the suite. The existing `node:test` + `supertest` tests keep constructing the app
in-process; they simply build it with a stub verifier and send a bearer token.

**The trade-off, stated honestly.** The stub is not `firebase-admin`, so the suite never
exercises real signature verification, token expiry, or the `aud`/`iss` checks against the
project ID — the production `verifyIdToken` path is exercised only live, and "a real
Google-issued token is accepted by the deployed service" stays a **user-attested** criterion
(DAN-22 already lists it as one). We accept that gap. The alternative — the Firebase Auth
emulator (`firebase-tools` v15.22.4 is installed) — would drive the real `firebase-admin`
path but make a running emulator a **required** dependency of every `npm test` and of CI,
including the many tests that touch neither Mongo nor auth. For a reference app whose entire
test story is "runs in-process against a scratch DB," a mandatory external Auth process costs
more than it buys. The injectable seam is the boring choice and reuses the `createApp` factory
the codebase already has; the emulator is the escape hatch if the verification path itself
ever needs an automated regression test. The seam is a design boundary, not a per-developer
choice — the verifier is injected through `createApp`, never reached for as a module global
inside the middleware, so a test substitutes it without monkey-patching `firebase-admin`.

### Config surface: the project ID is a constant, not a new env var

Verifying an ID token needs only the **project ID** (`project-d60a83c1-2c60-4d51-ad0`), to
check the token's `aud`/`iss`. It needs **no** service-account key and **no** secret: on Cloud
Run `firebase-admin` picks up ADC from the runtime SA
(`linear-example-run@project-d60a83c1-2c60-4d51-ad0.iam.gserviceaccount.com`), and the public
keys it checks signatures against come from a public Google endpoint that needs no credential.
Do not introduce a key, a Secret Manager secret, or a GitHub Secret.

The project ID is a **constant in the backend, not a new env var**. It is a public, stable
identifier already hardcoded throughout the repo (`firebase.json`, `CLAUDE.md`, the image
path). A required env var would have to be plumbed into both the local `.env` and the Cloud
Run deploy, while the **no-`.env` boot path (DAN-17) must still work** — more surface for two
developers to set inconsistently, in exchange for a flexibility (repointing at another Firebase
project) this single-project app will never use. So: no new env var, **no new row in the
Environment table**, and nothing for the verifier to read at boot. `firebase-admin` is
initialized **lazily** — on the first verification, never at process start — so the server
boots and `/health` returns `200` with no `.env`, no ADC, and no network, exactly as DAN-17
and DAN-5 require. Boot must not import-and-initialize in a way that reaches the network, and
`/health` must stay both Mongo-free and auth-free.

### Where the gate mounts, and the 401 contract

The gate mounts **on `/api/records`, after `/health`, before the records router**:

```js
app.get('/health', …)                        // unauthenticated — the gate never covers it
app.use('/api/records', authGate, recordsRouter())
```

`/health` stays unauthenticated and Mongo-free: it is what Cloud Run health-checks, and it was
moved off `/healthz` in DAN-18 because the platform swallows that exact path. The gate must not
cover it.

`authGate` reads `Authorization: Bearer <token>`. A missing or non-`Bearer` header
short-circuits to `401` **without calling the verifier or the data layer**. Otherwise it awaits
`verifyToken(token)`; on success it continues to the router, and on **any** rejection it fails
the request. Errors never use `res.status(...)` inline — the middleware calls `next(err)` with
an error carrying `status: 401`, and the single existing error middleware maps it: its non-5xx
branch already emits exactly `{ error: { message } }`, the shape DAN-22 requires. This is also
how a **malformed token yields `401`, not `500`**: the auth middleware converts every
verification rejection into a `401` error before it can hit the `status ?? 500` default, so a
bad token can never fall through to the generic 500 branch. A request that fails the gate never
reaches `records.js`.

Treating *every* verification rejection as `401` means a transient failure to fetch Google's
public certs also surfaces as `401` rather than `503`. That is a deliberate simplification: the
rule "no verified token ⇒ unauthorized" is one line and cannot leak a `500` for a bad token —
which is exactly what the contract pins down — and distinguishing "your token is bad" from "our
cert fetch blipped" is not worth a second error path in a reference app.

A design consequence for the existing tests (not a mandate on their structure): the HTTP-level
tests in `routes.test.js` and `index.test.js` currently call `/api/records` with no token and
will now `401`. They must build the app with a stub verifier and send a bearer token to reach
the routes. The data-layer tests in `records.test.js` are unaffected — they call `records.js`
directly, below the gate.

## Backend structure

```
app/backend/src/
├── index.js      express app, middleware, listen
├── db.js         connect() / getDb(), module-level client
├── records.js    data layer — all Mongo calls live here
├── schema.js     validation for create + update
├── auth.js       the /api/records gate + default firebase-admin verifier (see Authentication)
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

The Cloud Run service allows **unauthenticated** invocations: the deploy passes
`--allow-unauthenticated`, granting `allUsers` → `roles/run.invoker`. This is required, not
incidental — Firebase Hosting invokes the `/api/**` rewrite anonymously, with no
service-agent identity to grant `run.invoker` to, so a private service would `403` both the
rewrite and `/health`. `--allow-unauthenticated` only lets the request *reach* Express; the
Firebase ID-token gate (see [Authentication](#authentication)) is the actual auth boundary.
Authentication is enforced in application code, **never by Cloud Run IAM** — flipping the
service to `--no-allow-unauthenticated` would break the anonymous Hosting rewrite and `/health`
alike, not secure the API.

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
it and health-checks that port. `/health` must not touch Mongo — a database blip would
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

### Provisioning

The deploy identity — API enablement, the Artifact Registry repo, both service accounts and
their IAM, the WIF pool/provider, and the `MONGODB_URI` secret container — is not stood up by
console clicks or a manual runbook. It is declared as code and applied with Terraform; see
[Infrastructure as Code](#infrastructure-as-code) below for the resource inventory, the
bootstrap sequence, how it reconciles the partially-built account, and what stays irreducibly
manual (the secret *value* and the Atlas cluster). The Atlas region remains the one thing that
cannot be corrected after creation and must be confirmed `us-central1` before the backend
scaffold (DAN-5) opens a connection — a blocker the user clears, since it needs Atlas org access
no agent has.

## Infrastructure as Code

The deploy environment is declared as code and applied with Terraform. This replaces the
manual, user-executed runbook that the deploy-prerequisites ticket (DAN-11) used to be. That
runbook was not wrong; it was *unverifiable*. Console state is invisible from the repo, so its
acceptance criteria were entirely user-attested — the only ticket in the project no tester could
check. As code, the configuration is a reviewable diff, and `terraform fmt`/`validate` are
assertions a tester can run with no cloud access; only live convergence stays user-attested.

### Terraform, not a shell script

This is ~8 resources in one project, created essentially once. A plain idempotent shell script
(`gcloud … || true`) would deliver "no console clicking" without a state file, a lockfile, or
drift tracking — a legitimate lighter option. We still choose **Terraform**, for one reason that
outweighs the overhead: the account is **not greenfield** (see Reconciling, below). Reconciling
a half-built environment is exactly what a declarative tool does well — `terraform plan` reports
the delta between declared intent and reality as a diff, and `import` adopts a resource that
already exists — whereas a shell script must hand-code an existence guard around every resource
and can never answer "does reality still match intent?" That reconcile-and-detect-drift property
is the value we are buying.

Cost, stated plainly: a state file that must now be stored and protected, a provider lockfile to
maintain, the bootstrap paradox (below), and one more tool the next reader must know. For 8
resources that overhead is real; we accept it because a checkable, reconcilable deploy identity
is the whole point of the ticket.

**Terraform over OpenTofu / Pulumi.** OpenTofu is a drop-in fork and a fine substitute if an org
has a policy against HashiCorp's BSL license; the BSL restricts offering Terraform as a competing
hosted service, not internal use like this, and the `google` provider is MPL and unaffected — so
the license does not bite us and Terraform stays the more widely recognized "boring" choice for a
reference app. Pulumi would pull a general-purpose language and its own runtime into the repo;
HCL is less for the next reader to learn. If this ever must become OpenTofu, the `.tf` files are
unchanged.

### Layout

Terraform lives in a top-level **`infra/`** directory, a sibling of `app/` and `docs/` — not
`app/infra`. `CLAUDE.md` defines everything under `app/` as an independent npm package
(`app/frontend`, `app/backend`, each with its own `package.json`, no root workspace); Terraform
is not an npm package, and nesting it there would break that invariant. `CLAUDE.md`'s Layout
section is updated to match.

### State backend and the bootstrap paradox

State lives in a GCS bucket named `project-d60a83c1-2c60-4d51-ad0-tfstate` (us-central1, uniform
bucket-level access, object versioning on). But the bucket must exist before Terraform can use it
as a backend, and the first run needs a credential that predates the WIF it is about to create.
Both are resolved by the same one-time local bootstrap:

1. A human with Owner on the project runs `gcloud auth application-default login`. This ADC
   credential — not the deploy SA — is what the first apply runs as. The deploy SA does not exist
   yet, and even once it does it is deliberately not allowed to administer IAM.
2. `cd infra && terraform init` with **local** state (no backend block yet).
3. `terraform import` the pre-existing Artifact Registry repo (see Reconciling).
4. `terraform apply` — creates the state bucket and every other resource.
5. Add the GCS backend block and run `terraform init -migrate-state` to move the now-existing
   local state into the bucket.

After that, state is remote and the bootstrap login is needed only for future infra changes.

### The secret value never enters state

This is the load-bearing call. If Terraform created the `MONGODB_URI` secret **version**, the
live Atlas connection string would be written to Terraform state in plaintext — strictly worse
than today, where it lives only in a gitignored `.env` and in Secret Manager. So **Terraform
creates the secret container and its resource-level IAM binding only; a human adds the version
once, out of band**, with the value piped from stdin so it never lands on a command line:

```
printf %s "$MONGODB_URI" | gcloud secrets versions add MONGODB_URI --data-file=-
```

The value never touches a `.tf` file, a variable, a plan, or state. This reuses the mechanism the
runbook already documented and keeps the connection string in exactly the two places it lives
now.

Terraform 1.11+ write-only arguments (`secret_data_wo` / `secret_data_wo_version` on
`google_secret_manager_secret_version`) are a real alternative — *verified*: the `google`
provider supports them (Terraform ≥ 1.11, provider ≥ 6.x) and the value is kept out of both plan
and state. We still do not use them in v1: they would route the plaintext through the operator's
`terraform apply` invocation (as a tfvar or env var), buy nothing for a single secret set once,
and add a Terraform-version floor. If the version ever needs to be declaratively managed, this is
the escape hatch — not persisting the value in state, and not letting the Atlas provider generate
it into state.

### Terraform manages GCP only — not Atlas

Terraform does **not** manage the MongoDB Atlas cluster in v1. Doing so would pin the region
declaratively, which is tempting because the region is a live landmine — it must be `us-central1`
and a cluster cannot be moved after creation. But the Atlas provider requires an org
**programmatic API key** with org privileges: a long-lived, standing credential with nowhere good
to live — precisely the kind of key the rest of this architecture works to eliminate (WIF, no SA
keys, secret value out of state). Spending a standing credential to guard a *one-time* region
confirmation is disproportionate, and M0 is a constrained free tier (one per project, no CMEK)
the provider handles awkwardly. So the cluster, its region, and the `0.0.0.0/0` allowlist stay a
user-attested prerequisite; the region confirmation still gates the backend scaffold (DAN-5)
exactly as before. Managing Atlas as code is a separate future decision that must first answer
where its API key would live.

### Reconciling the partially-built account

The account is **not empty**. The first runbook step was already run with the user; Terraform
must reconcile against this current state:

| Item | Current state | Terraform's move |
|---|---|---|
| `run`, `iamcredentials`, `secretmanager`, `firebasehosting` APIs | **enabled** | declare (no-op) |
| `artifactregistry.googleapis.com` | enabled | declare (no-op) |
| `cloudresourcemanager.googleapis.com` | **enabled** (by hand, DAN-19) | declare (no-op) |
| `cloudbuild.googleapis.com` | **disabled, intentionally** | leave undeclared |
| Artifact Registry repo `linear-example` (docker, us-central1) | **exists** | `import` |
| Deploy SA, runtime SA, all IAM, WIF pool/provider, `MONGODB_URI` container | do not exist | create |

- Declaring `google_project_service` for an already-enabled API is a benign no-op, so all six
  are declared. Each sets `disable_on_destroy = false` so a `terraform destroy` never yanks an
  API that predated Terraform.
- `cloudresourcemanager.googleapis.com` is a prerequisite of the Firebase Management API. It was
  found **disabled** on the live project and enabled by hand while diagnosing a `403` during
  DAN-19, leaving it enabled in the project but described nowhere in the repo. It is declared here
  so the config once again describes the live state; like the other already-enabled APIs its apply
  is a create-in-state no-op, not an `import` (a `google_project_service` reconciles by re-asserting
  enablement, not by adopting a pre-existing object, so no import address is needed).
- `cloudbuild.googleapis.com` is intentionally disabled and intentionally **absent** from the
  config — Terraform manages only what it declares, so leaving it out keeps it off without a
  fight.
- The Artifact Registry repo is the one item that is **not** benign: a plain apply would try to
  create it and fail "already exists." It is brought under management with `terraform import`, so
  the config stays complete (a fresh account gets the repo created) while the current account
  adopts the existing one:

  ```
  terraform import google_artifact_registry_repository.linear_example \
    projects/project-d60a83c1-2c60-4d51-ad0/locations/us-central1/repositories/linear-example
  ```

IAM bindings use the **additive** `google_project_iam_member`, never the authoritative
`google_project_iam_binding` — the authoritative form strips every other member of a role from
the project, which two developers choosing independently would get wrong. This is a boundary, not
a preference.

### Resource inventory

Terraform owns exactly the following, reusing the IDs fixed in the Authentication and Secrets
sections — **none are invented here**:

| Resource | Identity |
|---|---|
| API enablement | `run`, `iamcredentials`, `secretmanager`, `firebasehosting`, `artifactregistry`, `cloudresourcemanager` (never `cloudbuild`) |
| Artifact Registry repo (imported) | `linear-example`, docker, `us-central1` |
| WIF pool / provider | `github-pool` / `github-provider`, issuer `https://token.actions.githubusercontent.com`, condition `assertion.repository == 'dperez4787/linear-example'` |
| Deploy SA + IAM | `deploy@…`: `roles/artifactregistry.writer`, `roles/run.admin`, `roles/iam.serviceAccountUser`, `roles/firebasehosting.admin`; plus `roles/iam.workloadIdentityUser` on the repo principalSet |
| Runtime SA + IAM | `linear-example-run@…`: `roles/secretmanager.secretAccessor` on the `MONGODB_URI` secret only (resource-level) |
| Secret container | `MONGODB_URI` — version added by hand (see above) |

The WIF attribute condition is a **security boundary, not a nicety**: without it, any GitHub
repo's OIDC token can exchange for the deploy SA's credentials. Terraform must set it, and a
tester should treat its absence as a failure.

### What stays irreducibly manual

Terraform removes the console clicking; it does not remove these, and nobody should read "IaC"
as "fully automated":

- GCP account creation and enabling billing — a human with a credit card.
- The bootstrap `gcloud auth application-default login` — the identity the first apply runs as.
- Adding the `MONGODB_URI` secret **version** with the real connection string (value out of
  state, above).
- Creating the Atlas cluster in `us-central1`, minting its first credential, and setting the
  `0.0.0.0/0` allowlist.
- Setting the `WIF_PROVIDER` and `DEPLOY_SA` GitHub Secrets — needs a GitHub PAT or an existing
  `gh` auth (`gh secret set`).

### Relationship to the deploy workflows

The app deploy workflows (DAN-13, DAN-15) do **not** run `terraform apply`. An application push
and an infrastructure change have different cadences and blast radii, and firing an infra apply
from an app deploy would mean handing the deploy SA project-level IAM-admin rights — the opposite
of the least-privilege deploy identity the CI/CD section builds. Infra apply stays a deliberate,
human-run operation under the bootstrap ADC identity, outside CI, in v1.

`infra/` also gets no cloud-touching CI in v1: there is no CI at all until DAN-13, and a
`terraform plan` in CI would reintroduce the GCP-credential question this architecture spends
effort avoiding. What a tester *can* run with zero cloud access is `terraform fmt -check` and
`terraform init -backend=false && terraform validate` — those are the agent-checkable criteria
for the infra ticket. A live `terraform plan`/`apply` against the account is user-attested, the
same two-tier split the deploy tickets already use.

## Ticket slicing

The `product-owner` agent should cut roughly:

1. Backend scaffold — Express app, `/health`, Mongo connection, no routes.
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

**Acceptance-criteria convention for deploy/infra tickets (7, 9, 10, 11).** A live deploy to
Cloud Run or Firebase — and a live `terraform apply` — is not observable by an agent; no
developer or tester agent holds cloud credentials, so "the site is live at the Cloud Run URL" or
"the resources exist in GCP" is a criterion neither can honestly sign off. The product-owner must
therefore split every such ticket's acceptance criteria into two labeled groups, and the tester
verifies only the first:

- **Agent-checkable** — everything provable in the repo with no cloud access: the Dockerfile
  builds and `docker run` serves `/health` locally; the workflow YAML parses and passes
  `actionlint`; `firebase.json` is schema-valid and the rewrite order is correct; the deploy
  command lines contain the required flags (`--service-account`, `--set-secrets`, SHA tag, no
  `latest`, no Cloud Build); for the infra ticket, `terraform fmt -check` and `terraform init
  -backend=false && terraform validate` pass and the config declares the exact IDs and the WIF
  attribute condition.
- **User-attested** — the live outcome only the user can confirm after a real push or apply: the
  Cloud Run revision is serving, `/api/records` responds through the Firebase rewrite, the
  container read `MONGODB_URI` at startup; for the infra ticket, `terraform apply` converged and
  the resources exist. The tester records these as "pending user attestation," not as pass or
  fail.

7. **Deploy prerequisites as Terraform (GCP) + manual bootstrap.** Was a user-executed runbook;
   is now Infrastructure as Code (see that section). This ticket should be **re-sliced** by the
   product-owner into two parts, because they have different owners and different verifiability:
   - *(7a) Author `infra/` Terraform* — agent work. Declare the five API enablements (never
     `cloudbuild`), the imported Artifact Registry repo, the WIF pool `github-pool` / provider
     `github-provider` with the attribute mapping and the **required** `assertion.repository ==
     'dperez4787/linear-example'` condition, the deploy SA with exactly its four roles and the
     repo-principal `workloadIdentityUser` binding, the dedicated runtime SA with
     `secretmanager.secretAccessor` on the `MONGODB_URI` secret only, and the `MONGODB_URI` secret
     **container** (not its version). Agent-checkable: `fmt -check` and `validate` pass; the exact
     IDs and condition are present.
   - *(7b) Bootstrap + manual items* — user-attested. `gcloud auth application-default login`,
     `terraform import` the existing repo, `terraform apply`, `init -migrate-state`; then add the
     `MONGODB_URI` secret **version** with the real Atlas string, set the Atlas allowlist to
     `0.0.0.0/0`, confirm the cluster region, and set the `WIF_PROVIDER`/`DEPLOY_SA` GitHub
     Secrets. Depends on the Atlas region being confirmed first. Prerequisite for tickets 9 and
     11.

8. **Backend Dockerfile.** `app/backend/Dockerfile` (plus `.dockerignore`) exactly as in the
   CI/CD section — `node:24-slim`, `npm ci --omit=dev`, listen on `process.env.PORT`. Verified
   by `docker build` then `docker run` reaching `/health`. Depends on ticket 1 (needs a
   server that listens and a `/health` route).

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
