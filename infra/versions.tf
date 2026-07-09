terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # State is intentionally LOCAL in the committed config. The one-time bootstrap
  # (see README.md) runs the first `terraform apply` against local state because
  # the GCS state bucket does not exist yet — it is created by that very apply.
  # DAN-11 step 5 adds the `backend "gcs"` block and runs `init -migrate-state`.
  # The paste-ready block lives in README.md, deliberately not here: `terraform
  # fmt -check` and `validate` both ignore comments, so a commented-out backend
  # block would be unverifiable text that could be silently uncommented.
}
