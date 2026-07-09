terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # The bootstrap apply ran against local state, because the bucket below is
  # created by that very apply. DAN-11 step 5 added this block and ran
  # `terraform init -migrate-state`; state now lives in GCS and the local
  # terraform.tfstate is no longer authoritative.
  backend "gcs" {
    bucket = "project-d60a83c1-2c60-4d51-ad0-tfstate"
    prefix = "infra"
  }
}
