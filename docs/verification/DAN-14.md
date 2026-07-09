# DAN-14 — Tester verification: Firebase Hosting config

Verified against the ticket's **agent-checkable** acceptance criteria on branch
`perezfdanny/dan-14-firebase-hosting-config-firebasejson-rewrite-to-cloud-run` (PR #16).

There is no test framework for a Hosting config file; the structural assertions below
*are* the test. They were run programmatically (not eyeballed) over the committed
`firebase.json` / `.firebaserc`.

## Agent-checkable criteria — ALL PASS

| # | Criterion | Result |
|---|-----------|--------|
| 1 | `firebase.json` at repo root, valid JSON, schema-conformant keys only | PASS |
| 2 | `hosting.public == "app/frontend/dist"` (confirmed as Vite's real emit dir via `npm run build`) | PASS |
| 3 | `/api/**` → `run{serviceId:"linear-example-backend", region:"us-central1"}` at index 0, **before** `**` → `/index.html` at index 1 (asserted `apiIdx < spaIdx` programmatically) | PASS |
| 4 | `.firebaserc` `projects.default == "project-d60a83c1-2c60-4d51-ad0"` | PASS |
| 5 | `hosting.ignore` excludes `firebase.json`, `**/.*` (dotfiles), `**/node_modules/**` | PASS |
| 6 | Only `firebase.json` and `.firebaserc` changed vs `main` | PASS |

`app/frontend/vite.config.js` sets no `build.outDir`, so Vite's default `dist` applies;
`npm ci && npm run build` produced `app/frontend/dist/index.html`, independently confirming
criterion 2. Untracked `dist/` was removed after the check and never staged.

## User-attested criteria — PENDING USER ATTESTATION (not pass, not fail)

These require a real deploy, which no agent can perform, and cannot be verified until
**DAN-19** (add GCP project to Firebase + create the Hosting site) is done and **DAN-15**'s
deploy job runs:

- A browser request to `/api/records` routed through Hosting to Cloud Run returns API JSON
  (not `index.html`).
- A deep-link SPA route serves `index.html`.

Context on the rewrite target: `linear-example-backend` is deployed and live in
`us-central1`, and `GET /api/records` on its direct Cloud Run URL returns 200 with real
Atlas data — so the rewrite's *target* resolves. What remains unverifiable here is Hosting's
*routing* to it, which only exists after the site is created and a deploy runs.
