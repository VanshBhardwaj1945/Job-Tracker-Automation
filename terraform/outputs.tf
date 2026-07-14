output "tracker_url" {
  value       = "https://${var.tracker_hostname}"
  description = "Set as the TRACKER_URL GitHub repo secret."
}

output "service_token_client_id" {
  value       = cloudflare_zero_trust_access_service_token.actions.client_id
  description = "Set as the TRACKER_CLIENT_ID GitHub repo secret."
}

output "service_token_client_secret" {
  value       = cloudflare_zero_trust_access_service_token.actions.client_secret
  sensitive   = true
  description = "Set as the TRACKER_CLIENT_SECRET GitHub repo secret (terraform output -raw service_token_client_secret)."
}

output "access_app_aud" {
  value       = cloudflare_zero_trust_access_application.tracker.aud
  description = "Access application AUD (already wired into the worker as ACCESS_AUD)."
}

output "d1_database_id" {
  value = cloudflare_d1_database.tracker.id
}
