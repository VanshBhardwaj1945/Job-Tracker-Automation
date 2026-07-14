# job-tracker infrastructure: D1 + Worker + custom domain + Cloudflare Access.
# Deploy: (cd ../tracker && npm run build) && terraform apply
# The worker self-migrates its D1 schema on first request — no SQL step here.

locals {
  script_name = "job-tracker"
  worker_path = "${path.module}/../tracker/dist/worker.js"
}

# ── Database ──────────────────────────────────────────────────────────────────
resource "cloudflare_d1_database" "tracker" {
  account_id = var.cloudflare_account_id
  name       = "job_tracker"
  # provider v5 sends this on update even when unset; null gets a 400 from the API
  read_replication = { mode = "disabled" }
}

# ── Object storage: uploaded resume/cover-letter PDFs you actually submitted ──
resource "cloudflare_r2_bucket" "docs" {
  account_id = var.cloudflare_account_id
  name       = "job-tracker-docs"
  location   = "ENAM"
}

# ── Access: app + policies + service token ───────────────────────────────────
# Human policy: only var.allowed_email may log in.
resource "cloudflare_zero_trust_access_policy" "email" {
  account_id = var.cloudflare_account_id
  name       = "job-tracker-owner"
  decision   = "allow"
  include = [{
    email = { email = var.allowed_email }
  }]
}

# Machine policy: GitHub Actions authenticates with the service token below.
resource "cloudflare_zero_trust_access_service_token" "actions" {
  account_id = var.cloudflare_account_id
  name       = "job-tracker-github-actions"
}

resource "cloudflare_zero_trust_access_policy" "service" {
  account_id = var.cloudflare_account_id
  name       = "job-tracker-service"
  decision   = "non_identity"
  include = [{
    service_token = { token_id = cloudflare_zero_trust_access_service_token.actions.id }
  }]
}

resource "cloudflare_zero_trust_access_application" "tracker" {
  account_id                = var.cloudflare_account_id
  name                      = "Job Tracker"
  type                      = "self_hosted"
  domain                    = var.tracker_hostname
  session_duration          = "730h" # ~1 month — it's a single-user personal app
  auto_redirect_to_identity = false
  app_launcher_visible      = true

  policies = [
    { id = cloudflare_zero_trust_access_policy.service.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.email.id, precedence = 2 },
  ]
}

# ── Worker ────────────────────────────────────────────────────────────────────
resource "cloudflare_workers_script" "tracker" {
  account_id          = var.cloudflare_account_id
  script_name         = local.script_name
  content             = file(local.worker_path)
  main_module         = "worker.js"
  compatibility_date  = "2025-06-01"
  compatibility_flags = ["nodejs_compat"] # @anthropic-ai/sdk imports node:fs/path lazily

  bindings = concat(
    [
      {
        name = "DB"
        type = "d1"
        id   = cloudflare_d1_database.tracker.id
      },
      {
        name        = "DOCS"
        type        = "r2_bucket"
        bucket_name = cloudflare_r2_bucket.docs.name
      },
      {
        name = "ANTHROPIC_API_KEY"
        type = "secret_text"
        text = var.anthropic_api_key
      },
      {
        name = "ACCESS_TEAM_DOMAIN"
        type = "plain_text"
        text = var.team_domain
      },
      {
        name = "ACCESS_AUD"
        type = "plain_text"
        text = cloudflare_zero_trust_access_application.tracker.aud
      },
      {
        name = "ACCESS_ALLOWED_EMAIL"
        type = "plain_text"
        text = var.allowed_email
      },
      {
        name = "GITHUB_REPO"
        type = "plain_text"
        text = var.github_repo
      },
    ],
    var.github_token == "" ? [] : [
      {
        name = "GITHUB_TOKEN"
        type = "secret_text"
        text = var.github_token
      },
    ]
  )
}

# No workers.dev route — the custom domain (behind Access) is the only way in.
# The worker also verifies the Access JWT itself, so even a stray route 403s.
resource "cloudflare_workers_script_subdomain" "tracker" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.tracker.script_name
  enabled     = false
}

# Custom domain — creates the DNS record + cert on the zone automatically.
# Does not touch apex/www (the portfolio site).
resource "cloudflare_workers_custom_domain" "tracker" {
  account_id = var.cloudflare_account_id
  zone_id    = var.zone_id
  hostname   = var.tracker_hostname
  service    = cloudflare_workers_script.tracker.script_name
}
