# linear-example

A table-CRUD reference app built **end-to-end by a team of Claude Code agents** — a
product-owner, an architect, a developer, and a tester — each driven from Linear tickets.
The point of the project is less the CRUD app and more the *story of how it was built*:
tickets in, working software out, with implementation and testing runnable remotely on
GitHub Actions.

## Links

- **Live app:** https://project-d60a83c1-2c60-4d51-ad0.web.app/
- **Blog (the case study of the build):** https://project-d60a83c1-2c60-4d51-ad0.web.app/blog
- **Marquee — the IMDb browser (built on the same agentic estate):** https://dfp-imdb-browser.web.app/titles
- **IMDb Graph Governance — field-level policy control plane:** https://imdb-policy-service-dkuqnmldta-uc.a.run.app/

The blog is the write-up of how this repo was built, and /blog is the index of every post.

## What it is

One resource — a `Record` — rendered as a single table with add, edit, and delete, plus
client-side sort and filter. Access is gated by Google sign-in. It is deliberately small so
the interesting part is the *process*: a `product-owner` agent writes Linear tickets, an
`architect` agent records the design in `docs/architecture.md`, a `developer` agent
implements one ticket, and a `tester` agent verifies it against the ticket's acceptance
criteria. See [Agent team and workflow](#agent-team-and-workflow) below.

## Stack

| Layer    | Choice |
|----------|--------|
| Frontend | React SPA built with Vite — single table view with add/edit/delete |
| Backend  | Node.js + Express serving a single GraphQL endpoint at `POST /api/graphql` |
| Database | MongoDB Atlas (free M0 tier) |
| Deploy   | Cloud Run (backend container) + Firebase Hosting (SPA and static blog), with `/api/**` rewritten to Cloud Run |
| Infra    | Terraform in `infra/` for the deploy identity — API enablement, Workload Identity Federation, service accounts, and the secret container |

The API is **GraphQL**, not REST: a single endpoint `POST /api/graphql` exposes queries
`records` / `record(id)` and mutations `createRecord` / `updateRecord` / `deleteRecord`.
It began life as five REST routes under `/api/records`; DAN-25 superseded that contract and
the REST routes were **removed, not aliased** (they now return `404`). The full schema,
error mapping, and the reasons behind each decision live in
[`docs/architecture.md`](docs/architecture.md).

## Repo layout

```
app/frontend/    React SPA (Vite)          — independent npm package
app/backend/     Express + GraphQL + Mongo — independent npm package
infra/           Terraform for the GCP deploy environment (sibling of app/)
docs/            architecture.md — API contract, schema, component structure, decisions
.claude/agents/  product-owner, architect, developer, tester
```

`app/frontend` and `app/backend` are independent npm packages — there is **no root
workspace**. Run npm commands from inside each package, never from the repo root. `infra/`
is Terraform, not an npm package, and lives as a sibling of `app/`, never nested under it.

## Agent team and workflow

The four checked-in agents live in [`.claude/agents/`](.claude/agents):

- **`product-owner`** — turns feature requests into scoped Linear tickets with testable
  acceptance criteria.
- **`architect`** — records design decisions in `docs/architecture.md`.
- **`developer`** — implements one ticket at a time.
- **`tester`** — verifies a ticket against its Linear acceptance criteria and comments the
  verdict.

The workflow is **one ticket, one branch, one PR**:

- The ticket branch name is not invented — it is Linear's `gitBranchName` field, used
  verbatim, so Linear links the branch, the PR, and the issue automatically.
- Every ticket PR is opened as a **draft**. Only the **tester** lifts the draft
  (`gh pr ready`), and only after every acceptance criterion passes. GitHub refuses to merge
  a draft, so the review order is structural rather than something the merger has to
  remember.
- **Agents never merge and never push to `main`.** The **user** merges. Lifting the draft is
  what hands the merge decision to the user.

### Remote pipeline

Implementation and testing can run remotely on GitHub Actions.
[`.github/workflows/linear-agents.yml`](.github/workflows/linear-agents.yml) polls Linear
and hands tickets to the same checked-in agents:

| Linear trigger | What runs |
|---|---|
| Status → `Ready for Dev` | developer agent: claims the ticket, implements, opens a draft PR |
| Status → `In Review` (without the `agent-tested` label) | tester agent: verifies the acceptance criteria, comments the verdict, lifts the draft on pass |

## Running locally

Node is pinned by [`.nvmrc`](.nvmrc); match it with:

```sh
nvm use
```

The frontend and backend are separate packages, so `npm install` and `npm test` run
**inside each package**, not from the repo root:

```sh
# backend
cd app/backend && npm install && npm test

# frontend
cd app/frontend && npm install && npm test
```

To run the backend, provide a MongoDB connection string. It is read from the `MONGODB_URI`
environment variable — locally from a **gitignored** `app/backend/.env` file that is
**never committed**:

```sh
# app/backend/.env  (gitignored — do not commit)
MONGODB_URI=mongodb+srv://<user>:<password>@your-cluster.example.mongodb.net/
```

Then:

```sh
cd app/backend && npm start
```

Environment variables:

| Variable      | Purpose |
|---------------|---------|
| `MONGODB_URI` | Mongo connection string. From `app/backend/.env` locally; from Secret Manager on Cloud Run. Never committed. |
| `MONGODB_DB`  | Database name. Defaults to `linear_example` (`linear_example_test` for test runs). |
| `PORT`        | Server port. Cloud Run injects it; defaults to `8080` locally. |

Start the frontend dev server (Vite) with `npm run dev` inside `app/frontend`.

## Deeper docs

- [`docs/architecture.md`](docs/architecture.md) — the API contract, data model, component
  structure, deploy topology, and the reasoning behind each decision.
- [`CLAUDE.md`](CLAUDE.md) — the conventions the agents follow: stack, MongoDB connection
  pattern, the git workflow, and the remote-agent setup.
