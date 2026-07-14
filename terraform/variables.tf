variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID (dash.cloudflare.com → any zone → Overview → Account ID)."
}

variable "cloudflare_api_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "API token. Leave empty to use the CLOUDFLARE_API_TOKEN env var instead."
}

variable "zone_id" {
  type        = string
  description = "Zone ID for example.com (dash → example.com → Overview → Zone ID)."
}

variable "tracker_hostname" {
  type        = string
  default     = "jobs.example.com"
  description = "Hostname the tracker lives on. Must be in the zone above."
}

variable "team_domain" {
  type        = string
  description = "Cloudflare Zero Trust team domain, e.g. myteam.cloudflareaccess.com (Zero Trust dash → Settings → Custom Pages → Team domain)."
}

variable "allowed_email" {
  type        = string
  default     = "you@example.com"
  description = "The one email allowed through Cloudflare Access."
}

variable "anthropic_api_key" {
  type        = string
  sensitive   = true
  description = "Anthropic API key for the AI import endpoint (Haiku extraction)."
}

variable "github_repo" {
  type        = string
  default     = "YOUR_GITHUB_USERNAME/job-monitor"
  description = "Repo whose workflow runs the Activity page lists."
}

variable "github_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Optional fine-grained PAT (Actions: read) so the Activity page can list workflow runs once the repo is private. Empty = unauthenticated (public repos only)."
}
