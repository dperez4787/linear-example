# GCS bucket that will hold remote Terraform state after the bootstrap migrates
# to it. Created by the first (local-state) apply; DAN-11 step 5 then points the
# backend at this bucket and runs `init -migrate-state`. Uniform bucket-level
# access and object versioning are on so state history survives an overwrite.
resource "google_storage_bucket" "tfstate" {
  project  = local.project_id
  name     = "project-d60a83c1-2c60-4d51-ad0-tfstate"
  location = local.region

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.enabled]
}
