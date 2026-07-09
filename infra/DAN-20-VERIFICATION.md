# DAN-20 — Tester verification

There is no Terraform test framework in this repo; the commands below ARE the test.
Run from `infra/` with `source ~/.zshenv` first. Terraform v1.15.8.

## Agent-checkable acceptance criteria — all PASS

| # | Criterion | Command | Result |
|---|---|---|---|
| 1 | `terraform fmt -check` no diff | `terraform fmt -check` | exit 0, no diff |
| 2 | `init -backend=false && validate` succeed | `terraform init -backend=false && terraform validate` | init OK, `Success! The configuration is valid.` |
| 3 | Exactly six services, each `disable_on_destroy = false` | `grep googleapis.com apis.tf` | list holds `run`, `iamcredentials`, `secretmanager`, `firebasehosting`, `artifactregistry`, `cloudresourcemanager`; `for_each = toset(local.services)` with `disable_on_destroy = false` on the resource |
| 4 | `cloudbuild.googleapis.com` absent as a declaration | `grep -rn cloudbuild *.tf` | only a COMMENT in `apis.tf`; no `google_project_service` and no list member |
| 5 | No `google_secret_manager_secret_version` in `infra/` | `grep -rn google_secret_manager_secret_version .` | only comment/prose; no resource. `secret.tf` untouched by this branch |
| 6 | architecture.md IaC section names `cloudresourcemanager` + why | diff review | reconciliation + identity tables updated within IaC section; DAN-18 health paragraph (lines 52-62) untouched |
| 7 | README "What Terraform owns" agrees with apis.tf | grep review | now "6 API enablements", lists `cloudresourcemanager`, right column still says `cloudbuild` left undeclared; no stray "5"/"five" API claim remains |
| 8 | Files changed vs origin/main | `git diff --stat origin/main...HEAD` | exactly `infra/apis.tf`, `infra/README.md`, `docs/architecture.md` |

## No-import determination — CONFIRMED CORRECT

`google_project_service`'s identity is (project, service); its create operation calls the
Service Usage enable API, which is idempotent. Adding it to config with the API already
enabled live but absent from state plans a create-in-state that succeeds as a no-op — there
is no "already exists" collision, unlike a named object such as the Artifact Registry repo
(which is why only that repo needed `terraform import` at DAN-11's `17 added, 0 changed,
0 destroyed` apply). No `terraform import` is required.

## User-attested (pending — no agent may run `terraform apply`)

Before apply, `terraform plan` should show **`1 to add, 0 to change, 0 to destroy`**
(the new `google_project_service.enabled["cloudresourcemanager.googleapis.com"]`). After
apply, `terraform plan` reports no changes and the service appears in `terraform state list`.
Until that apply runs, the repo DESCRIBES the API but Terraform state does not MANAGE it.
