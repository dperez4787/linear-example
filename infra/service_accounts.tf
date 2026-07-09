# Two distinct service accounts. The DEPLOY SA is who the GitHub Actions workflow
# acts as (impersonated via WIF); the RUNTIME SA is who the Cloud Run container
# acts as. Conflating them is the "deploy is green, container is dead" trap.
resource "google_service_account" "deploy" {
  project      = local.project_id
  account_id   = "deploy"
  display_name = "GitHub Actions deploy identity (impersonated via WIF)"
}

resource "google_service_account" "runtime" {
  project      = local.project_id
  account_id   = "linear-example-run"
  display_name = "Cloud Run runtime identity for linear-example-backend"
}

# Deploy SA project roles. Additive google_project_iam_member, never the
# authoritative google_project_iam_binding — the authoritative form would strip
# every other member of the role from the project. This is a boundary.
locals {
  deploy_roles = [
    "roles/artifactregistry.writer",
    "roles/run.admin",
    "roles/iam.serviceAccountUser",
    "roles/firebasehosting.admin",
  ]
}

resource "google_project_iam_member" "deploy" {
  for_each = toset(local.deploy_roles)

  project = local.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# Only OIDC tokens from this exact repo may impersonate the deploy SA. The
# principalSet is scoped by the attribute.repository mapped on the WIF provider.
resource "google_service_account_iam_member" "deploy_wif_user" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${local.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${local.github_repository}"
}
