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
infra/          Terraform for the GCP deploy environment (SAs, WIF, secret container, AR repo)
docs/           architecture.md — API contract, schema, components
.claude/agents/ product-owner, architect, developer, tester
```

Frontend and backend are independent npm packages. There is no root workspace; run
commands from inside `app/frontend` or `app/backend`. `infra/` is Terraform, not an npm
package; it is a sibling of `app/`, never nested under it. See `docs/architecture.md`
(Infrastructure as Code) for the tool choice, state backend, and what stays manual.

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
| `AI_GATEWAY_URL` | AI gateway base URL (DAN-48) — `.env` locally; read lazily, boot works without it |
| `AI_GATEWAY_KEY` | AI gateway bearer key (DAN-48) — `.env` locally, Secret Manager in Cloud Run; never a provider API key |
| `LINEAR_API_KEY` | Linear personal API key (DAN-51) — `.env` locally, Secret Manager in Cloud Run; read lazily, boot works without it. Sent as a bare `Authorization: <key>` header, no `Bearer` prefix |
| `LINEAR_TEAM_ID` | Linear team approved plans are filed into (DAN-51) — read lazily, no fallback in src. The DAN team's id: `e1ef74ec-5da2-42e9-8e2b-48840faf3647` |
| `LINEAR_STATE_READY_FOR_DEV` | Linear workflow-state id unblocked tickets are filed in (DAN-51) — read lazily, no fallback in src. The DAN team's Ready for Dev: `8d578131-713b-41ea-b940-135b55b7b86b` |

## GCP

| | |
|---|---|
| Project ID | `project-d60a83c1-2c60-4d51-ad0` |
| Project number | `756865700041` (needed for Workload Identity Federation) |
| Billing | enabled |
| Region | `us-central1` — Artifact Registry, Cloud Run, and Atlas all live here |
| Image repo | `us-central1-docker.pkg.dev/project-d60a83c1-2c60-4d51-ad0/linear-example` |

`gcloud` requires `CLOUDSDK_PYTHON` (see Local toolchain). The Atlas cluster's region is
still unconfirmed and must match `us-central1`; a cluster cannot be moved after creation.

Only the backend is containerized. See `docs/architecture.md` for the CI/CD pipeline —
in particular, the backend image is built from `app/backend/Dockerfile` on the GitHub
runner, not by Cloud Build, and no service account key is ever created.

## Local toolchain

Node is installed via `nvm` (`~/.nvm`), pinned by `.nvmrc` to the current LTS. Run
`nvm use` in the repo root to match it.

`nvm`'s installer writes to `~/.zshrc`, which only interactive shells read. This repo's
Node lives on `PATH` via `~/.zshenv` instead, so non-interactive shells — every command an
agent runs — can find it. If `node: command not found` appears in agent output, that file
is the first place to look.

The agent harness resets `PATH` after the shell profile loads, so `~/.zshenv`'s exported
variables survive but its `PATH` additions do not. Every agent command that needs `node`,
`npm`, `gh`, or `gcloud` must source it first:

```sh
source ~/.zshenv && npm test
```

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

`In Review` is the team's *ready for test* state. It means the ticket is waiting on the
tester, not on the user. It is not a signal to merge.

## Remote agents (GitHub Actions)

Planning stays local; implementation and testing can run remotely on the user's API
tokens. `.github/workflows/linear-agents.yml` polls Linear every 5 minutes and hands
tickets to the same checked-in agents this repo uses locally:

| Linear trigger | What runs |
|---|---|
| Status → `Ready for Dev` | developer agent: claims the ticket (moves it to In Progress), implements, opens a draft PR |
| Status → `In Review`, no `agent-tested` label | tester agent: verifies acceptance criteria, comments the verdict on the issue and the PR, lifts the draft on pass |

Pickup is not instant — the poll runs every 5 minutes and GitHub may delay scheduled
runs further. The status change *is* the claim, so a ticket is never picked up twice.
The `agent-tested` label marks a completed test run; the developer claim strips it, so
re-testing a ticket means dragging it back through `Ready for Dev`, or removing the
label and re-adding `In Review`.

CI differences from local sessions (the workflow prompt tells agents this too):

- No `~/.zshenv` — the runner installs Node from `.nvmrc` directly.
- MongoDB is a throwaway `mongo:7` service container, not Atlas. `MONGODB_URI` and
  `MONGODB_DB=linear_example_test` are preset; there is no `.env`.
- Linear access is the hosted Linear MCP server authenticated with the `LINEAR_API_KEY`
  repo secret, not the interactive OAuth session.
- The tester posts its PR verdict as a comment only — CI's identity authors the PR and
  GitHub forbids self-approval, so there is no formal review in the remote flow.
- Secrets: `ANTHROPIC_API_KEY` (billing) and `LINEAR_API_KEY`. The workflow only runs
  from `main`, so changes to it ship like any other PR.

Everything else — draft-PR gate, tester-lifts-the-draft, user merges — is unchanged.

## Git workflow

One ticket, one branch, one commit history, one pull request. `main` is protected by
convention: it only ever receives merges from a PR, and **agents never merge and never
push to `main`**. The user merges.

The branch name is not invented. Every Linear issue carries a `gitBranchName` field —
read it with `get_issue` and use it verbatim, so Linear links the branch, the PR, and the
issue automatically:

```sh
source ~/.zshenv
git checkout main && git checkout -b perezfdanny/dan-6-list-and-create-records-get-and-post-apirecords
```

Commit subjects start with the ticket ID: `DAN-6: Add GET and POST /api/records`. Say why
the change is shaped the way it is, not what the diff already shows. Work that belongs to
no ticket (a design doc, a toolchain fix) goes on its own branch with no ticket prefix.

Open a ticket PR with `gh pr create --draft`, and put the Linear issue URL in the body so
the issue and the PR cross-link. The PR body states what the ticket asked for and what was
actually verified — including anything that could not be verified. (Non-ticket PRs are
opened non-draft — see the draft-gate exemption below.)

**Every ticket PR is opened as a draft, and only the tester takes it out of draft.** GitHub
refuses to merge a draft, so this makes the review order structural rather than something
the user has to remember at the moment the merge button is in front of them. The tester
runs `gh pr ready` only after every acceptance criterion has passed.

**Non-ticket PRs are exempt from the draft gate.** Work that belongs to no ticket — a design
doc, a toolchain fix — has no acceptance criteria and no tester ever runs on it, so a draft
would sit undrafted forever. The author opens these **non-draft** (`gh pr create`, no
`--draft`), states in the body why it is exempt, and the user reviews and merges directly.
The draft gate exists to force a tester between the developer and the merge; where there is
no tester, there is no gate to lift.

`app/backend/.env` is gitignored and holds a live Atlas credential. Never stage it, never
echo it into a commit message, PR body, or Linear comment. Run `git check-ignore` if unsure.

### Who touches the branch

The developer creates the branch, implements the ticket, and opens the PR **as a draft**.
The tester checks out that same branch, adds its tests as a separate commit, and reviews
the PR — approving it or requesting changes — alongside its pass/fail comment on the Linear
issue. The tester does not open a second PR and does not fix the developer's code.

The tester also posts its verdict as a comment on the PR itself, not only on the Linear
issue. The person merging is looking at the PR, so that is where the evidence has to be.
A PR with no tester comment has not been tested.

Only when every criterion passes does the tester run `gh pr ready` to lift the draft. If a
criterion fails, the PR stays a draft and goes back to the developer. Agents still never
merge — lifting the draft is what hands the merge decision to the user.

A ticket is done when the tester has commented on the issue and reviewed the PR. It is
shipped when the user merges. Those are different events; do not conflate them. If you are
about to merge a PR that is still a draft or carries no tester comment, stop: the ticket is
not done, whatever its Linear state says.
