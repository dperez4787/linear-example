# Docker image repository for the backend container. This repo ALREADY EXISTS in
# the current account, so a plain apply would fail "already exists"; the bootstrap
# adopts it with `terraform import` (address and command in README.md). Declared
# here so a fresh account creates it identically.
resource "google_artifact_registry_repository" "linear_example" {
  project       = local.project_id
  location      = local.region
  repository_id = "linear-example"
  format        = "DOCKER"

  depends_on = [google_project_service.enabled]
}
