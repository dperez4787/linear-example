# API enablement. All five are already enabled in the current (non-greenfield)
# account, so declaring them is a benign no-op that reconciles a fresh account.
# cloudbuild.googleapis.com is intentionally absent: Terraform manages only what
# it declares, so leaving it out keeps it off (the runner builds the image with
# a Dockerfile, never Cloud Build). disable_on_destroy = false so a destroy
# never yanks an API that predated Terraform.
locals {
  services = [
    "run.googleapis.com",
    "iamcredentials.googleapis.com",
    "secretmanager.googleapis.com",
    "firebasehosting.googleapis.com",
    "artifactregistry.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)

  project = local.project_id
  service = each.value

  disable_on_destroy = false
}
