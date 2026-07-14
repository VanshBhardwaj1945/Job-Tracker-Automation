terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # Auth: set var.cloudflare_api_token or the CLOUDFLARE_API_TOKEN env var.
  # Token needs: Workers Scripts:Edit, D1:Edit, Access: Apps and Policies:Edit,
  # Access: Service Tokens:Edit, Zone:Read + DNS:Edit on example.com.
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
}
