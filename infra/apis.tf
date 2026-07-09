# API enablement. All six are already enabled in the current (non-greenfield)
# account, so declaring them is a benign no-op that reconciles a fresh account.
# cloudresourcemanager.googleapis.com is a prerequisite of the Firebase Management
# API; it was found disabled and enabled by hand during DAN-19, so it is declared
# here to bring that live state back under the repo's description.
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
    "cloudresourcemanager.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)

  project = local.project_id
  service = each.value

  disable_on_destroy = false
}
