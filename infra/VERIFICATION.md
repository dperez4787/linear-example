# DAN-16 tester verification

There is no Terraform test framework in this repo, and `terraform validate` cannot
inspect a live plan. The commands below **are** the test for this ticket; they need no
cloud credentials. This note records what the tester ran and, just as importantly, what
was **not** verified here because it is user-attested in DAN-11.

## Verified with no cloud access (run from `infra/`)

```sh
terraform fmt -check                          # exit 0, no diff
terraform init -backend=false && terraform validate   # "Success! The configuration is valid."
```

Static checks (grep / git, run from repo root):

- No `backend "gcs"` block in any `infra/*.tf`, not even commented out; the paste-ready
  block lives only in `README.md`, naming bucket `project-d60a83c1-2c60-4d51-ad0-tfstate`.
- No `google_secret_manager_secret_version` resource anywhere in `infra/` — the secret
  value never enters Terraform state. Only the `google_secret_manager_secret` container
  is declared.
- No `google_project_iam_binding` anywhere — deploy-SA roles use additive
  `google_project_iam_member`.
- `git check-ignore -v infra/terraform.tfstate` matches; `.terraform.lock.hcl` is NOT
  ignored and IS tracked.
- APIs declared for exactly `run`, `iamcredentials`, `secretmanager`, `firebasehosting`,
  `artifactregistry` (not `cloudbuild`), each `disable_on_destroy = false`.
- WIF issuer, three attribute mappings, and the `assertion.repository ==
  'dperez4787/linear-example'` condition all present.

## NOT verified here — user-attested in DAN-11

`terraform apply`, `terraform import`, `terraform init -migrate-state`, `gcloud` auth,
and adding the `MONGODB_URI` secret version were **not** run. This ticket creates zero
live GCP resources by design; live convergence is the user-executed follow-up (DAN-11).
