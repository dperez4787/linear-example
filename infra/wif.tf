# Workload Identity Federation: GitHub Actions OIDC tokens are exchanged for
# short-lived deploy-SA credentials, so no service-account key ever exists.
resource "google_iam_workload_identity_pool" "github" {
  project                   = local.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
  description               = "OIDC pool for GitHub Actions deploys of linear-example"

  depends_on = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = local.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Actions"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
  }

  # REQUIRED security boundary — not optional. Without this condition, any GitHub
  # repo's OIDC token could exchange for the deploy SA's credentials.
  attribute_condition = "assertion.repository == 'dperez4787/linear-example'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}
