# infra/ — deploy identity as Terraform

Terraform for the GCP deploy environment of `linear-example`: API enablement, the
Artifact Registry repo, the Workload Identity Federation pool/provider, the deploy
and runtime service accounts and their IAM, the `MONGODB_URI` secret **container**,
and the GCS bucket that will hold remote state.

This directory is a top-level sibling of `app/` and `docs/`. It is **not** an npm
package and is never nested under `app/`. See the **Infrastructure as Code** section
of `docs/architecture.md` for the decisions this config implements — they are settled
there, not re-derived here.

## What Terraform owns (and deliberately does not)

| Owned by Terraform | Deliberately NOT owned |
|---|---|
| 6 API enablements (`run`, `iamcredentials`, `secretmanager`, `firebasehosting`, `artifactregistry`, `cloudresourcemanager`) | `cloudbuild.googleapis.com` — left undeclared so it stays disabled |
| Artifact Registry repo `linear-example` (imported) | The `MONGODB_URI` secret **version** (the value — added by hand, out of state) |
| WIF pool `github-pool` + provider `github-provider` | The MongoDB Atlas cluster, its region, its `0.0.0.0/0` allowlist |
| Deploy SA + its 4 project roles + `workloadIdentityUser` binding | The `WIF_PROVIDER` / `DEPLOY_SA` GitHub Secrets |
| Runtime SA + resource-scoped `secretAccessor` on `MONGODB_URI` | |
| `MONGODB_URI` secret **container** | |
| GCS state bucket `project-d60a83c1-2c60-4d51-ad0-tfstate` | |

The secret **value never enters Terraform state**: this config declares
`google_secret_manager_secret` (the container) but no
`google_secret_manager_secret_version`. See the bootstrap steps for how the version
is added.

## Verify without cloud access (agent-checkable)

No GCP credentials are needed for any of these:

```sh
terraform fmt -check
terraform init -backend=false   # also writes the committed .terraform.lock.hcl
terraform validate
```

## Bootstrap (one-time, user-executed — DAN-11)

This is the **user-attested** half. It creates live GCP resources and requires a human
with Owner on the project. None of it runs in CI, and no agent performs it.

1. **Authenticate as a human Owner** (the deploy SA does not exist yet, and is never
   allowed to administer IAM):

   ```sh
   gcloud auth application-default login
   ```

2. **Initialize with local state** — no backend block yet, because the state bucket does
   not exist until step 4 creates it:

   ```sh
   cd infra
   terraform init
   ```

3. **Import the pre-existing Artifact Registry repo** so the apply adopts it instead of
   failing "already exists":

   ```sh
   terraform import google_artifact_registry_repository.linear_example \
     projects/project-d60a83c1-2c60-4d51-ad0/locations/us-central1/repositories/linear-example
   ```

4. **Apply** — creates the state bucket, service accounts, IAM, WIF pool/provider, and
   the `MONGODB_URI` secret container. This writes `terraform.tfstate` into this directory
   (local state), which `.gitignore` keeps out of git:

   ```sh
   terraform apply
   ```

5. **Migrate state to GCS.** Add the backend block below to `versions.tf` (inside the
   `terraform { ... }` block), then re-init and move the local state into the bucket:

   ```hcl
   backend "gcs" {
     bucket = "project-d60a83c1-2c60-4d51-ad0-tfstate"
     prefix = "infra"
   }
   ```

   ```sh
   terraform init -migrate-state
   ```

   The committed config keeps **no** `backend "gcs"` block — not even commented out — so
   that `terraform init` in steps 2–4 uses local state, which is what the first apply
   requires. Add the block only at this step.

6. **Add the `MONGODB_URI` secret version** with the real Atlas connection string, piped
   from stdin so the value never lands on a command line, in a plan, or in state:

   ```sh
   printf %s "$MONGODB_URI" | gcloud secrets versions add MONGODB_URI --data-file=-
   ```

7. **Remaining manual prerequisites** (see `docs/architecture.md`): confirm the Atlas
   cluster is in `us-central1`, set its allowlist to `0.0.0.0/0`, and set the
   `WIF_PROVIDER` and `DEPLOY_SA` GitHub Secrets.

## Exact identifiers

| Thing | Value |
|---|---|
| Project ID / number | `project-d60a83c1-2c60-4d51-ad0` / `756865700041` |
| Region | `us-central1` |
| WIF pool / provider | `github-pool` / `github-provider` |
| Issuer | `https://token.actions.githubusercontent.com` |
| Attribute condition | `assertion.repository == 'dperez4787/linear-example'` |
| Deploy SA | `deploy@project-d60a83c1-2c60-4d51-ad0.iam.gserviceaccount.com` |
| Runtime SA | `linear-example-run@project-d60a83c1-2c60-4d51-ad0.iam.gserviceaccount.com` |
| State bucket | `project-d60a83c1-2c60-4d51-ad0-tfstate` |
