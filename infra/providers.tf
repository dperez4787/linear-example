provider "google" {
  project = local.project_id
  region  = local.region
}

locals {
  project_id     = "project-d60a83c1-2c60-4d51-ad0"
  project_number = "756865700041"
  region         = "us-central1"

  # Owner/name of the GitHub repository whose OIDC tokens may impersonate the
  # deploy SA. This value is the security boundary; see the attribute condition
  # on the WIF provider and the workloadIdentityUser principalSet below.
  github_repository = "dperez4787/linear-example"
}
