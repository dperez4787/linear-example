# DAN-24 — Tester verification

Verified on branch `perezfdanny/dan-24-declare-identitytoolkit-securetoken-apis-in-infraapistf`,
commit `8e6915a`. Terraform v1.15.8, all commands run from `infra/`. There is no Terraform
test framework here — the commands below ARE the test.

## Agent-checkable criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | `terraform fmt -check` no diff | PASS | exit 0, no output |
| 2 | `init -backend=false && validate` | PASS | init OK; `Success! The configuration is valid.` (`-backend=false` because `versions.tf` carries the `backend "gcs"` block, DAN-11) |
| 3 | Exactly eight services, each `disable_on_destroy = false` | PASS | `locals.services` = `run`, `iamcredentials`, `secretmanager`, `firebasehosting`, `artifactregistry`, `cloudresourcemanager`, `identitytoolkit`, `securetoken`; `for_each = toset(local.services)` with `disable_on_destroy = false` on `google_project_service.enabled` (line 34) |
| 4 | `cloudbuild.googleapis.com` absent as a declaration | PASS | after stripping `#` comments, zero matches in `apis.tf`; the single occurrence (line 11) is a `#` comment documenting its deliberate absence — a comment, not a declaration |
| 5 | No `google_secret_manager_secret_version` resource in `infra/` | PASS | no `resource "google_secret_manager_secret_version"` block anywhere; matches are `#` comments / prose only; `secret.tf` untouched by this branch |
| 6 | architecture.md IaC section names both APIs + why | PASS | reconciliation-table row + prose bullet: back Firebase Authentication, enabled as a side effect of `addFirebase` during DAN-19 (not by hand). Edit confined to the IaC section (line 498+); Authentication section (lines 66, 385) and health-endpoint paragraph untouched |
| 7 | Internal consistency | PASS | `infra/README.md` "What Terraform owns" now reads "8 API enablements" and lists both new APIs, agreeing with `apis.tf`; `cloudbuild` exclusion column unchanged. No other present-reality count falsified. Deliberate historical non-changes left alone: `docs/architecture.md` "Declare the five API enablements" (line 739, DAN-16 scope) and `infra/DAN-20-VERIFICATION.md` "six services" (DAN-20 tester artifact) |
| 8 | Files changed vs `origin/main` | PASS | exactly `infra/apis.tf`, `infra/README.md`, `docs/architecture.md` |

## No-import determination — CONFIRMED CORRECT

`google_project_service`'s identity is `(project, service)` and its create op calls the
idempotent Service Usage *enable* API. Adding an already-enabled API to config, absent from
state, plans a **create-in-state** that succeeds as a no-op — no "already exists" collision,
unlike a named object such as the Artifact Registry repo (the one item that required `import`
at the DAN-11 bootstrap). No `terraform import` is needed. Corroborated by DAN-20's applied
outcome (`1 added` in 4s, no import).

## Pending user attestation (no agent may run `terraform apply`)

- After `terraform apply`, `terraform plan` reports no changes.
- Both `identitytoolkit.googleapis.com` and `securetoken.googleapis.com` appear in
  `terraform state list`.

Before the apply, `terraform plan` should read exactly **`2 to add, 0 to change, 0 to
destroy`** (the two new `google_project_service.enabled[...]` entries). Anything else —
especially any destroy — means stop and investigate. Until that apply runs, the repo
DESCRIBES the two APIs but Terraform's state does not MANAGE them; the merge alone
half-achieves the ticket.

I did NOT run `terraform apply`, `import`, `init` with a backend, or any mutating `gcloud`.
