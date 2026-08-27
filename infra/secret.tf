# The MONGODB_URI secret CONTAINER only. There is deliberately NO
# google_secret_manager_secret_version resource anywhere in this config: creating
# the version would write the live Atlas connection string into Terraform state
# in plaintext — strictly worse than today, where it lives only in a gitignored
# .env and in Secret Manager. A human adds the version out of band with the value
# piped from stdin (see README.md). The value never touches a .tf file or state.
resource "google_secret_manager_secret" "mongodb_uri" {
  project   = local.project_id
  secret_id = "MONGODB_URI"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

# Runtime SA reads the secret at container startup. Granted at the RESOURCE level
# on this secret only — never project-wide secretmanager.secretAccessor.
resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  project   = google_secret_manager_secret.mongodb_uri.project
  secret_id = google_secret_manager_secret.mongodb_uri.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# The AI gateway virtual key (DAN-60). Same rule as MONGODB_URI: container only,
# NO google_secret_manager_secret_version — a human adds the version out of band
# so the value never touches a .tf file or Terraform state.
resource "google_secret_manager_secret" "ai_gateway_key" {
  project   = local.project_id
  secret_id = "AI_GATEWAY_KEY"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "ai_gateway_key_runtime_accessor" {
  project   = google_secret_manager_secret.ai_gateway_key.project
  secret_id = google_secret_manager_secret.ai_gateway_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# The Linear API key (DAN-60). Container only, NO version, same reasoning.
resource "google_secret_manager_secret" "linear_api_key" {
  project   = local.project_id
  secret_id = "LINEAR_API_KEY"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "linear_api_key_runtime_accessor" {
  project   = google_secret_manager_secret.linear_api_key.project
  secret_id = google_secret_manager_secret.linear_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
