# CLAUDE.md — setup assistant for Job Tracker Automation

You are helping a new user adopt this repo for their own job hunt. This project
finds jobs, AI-scores them against the user's profile, tracks applications, and
generates tailored resumes/cover letters. Read `docs/FULL_DOCUMENTATION.md` for
the full architecture before configuring anything.

## Your job when the user says "set this up"

Interview the user, then fill in the config. Ask these, in plain language, a few
at a time (don't dump all at once). Confirm before writing files or running
anything with side effects (deploys, pushes, API calls).

1. **Who they are** — name, city, email, phone, GitHub, LinkedIn. Used only on
   their generated resumes/cover letters. → goes in `data/profile.json` +
   `data/resume.md`.
2. **What they want** — target roles (ranked), the keywords that define their
   field, whether to include generic SWE roles, and any specific companies to
   watch. → `data/profile.json` (`candidate.summary`, `role_ranking`,
   `categories`, `include_other_swe`) + `data/companies_master.json`.
3. **Their resume** — have them paste it or point to a file; save it as
   `data/resume.md`. This is what the AI tailors from — never invent content.
4. **How often** — the monitor runs hourly by default; adjust the cron in
   `.github/workflows/` if they want.
5. **Notifications** — Discord webhook URL? Gmail for email alerts + the inbox
   watcher (needs a Gmail App Password)?
6. **Where to host** — offer the three modes and set up whichever they pick:
   - **Hosted:** Cloudflare Worker + D1 + R2 + Access via Terraform, monitor on
     GitHub Actions. Walk them through `terraform/terraform.tfvars`
     (Cloudflare account/zone/team domain, Anthropic key) and `terraform apply`.
     Note: enable R2 in the Cloudflare dashboard and give the API token
     **Workers R2 Storage: Edit**.
   - **Local:** `cd tracker && npm install && npm run dev` (local D1 + R2, auth
     bypassed) + run `python monitor/scraper.py` locally.
   - **Container:** `docker build -t job-monitor . && docker run --env-file .env
     ...` for the monitor.
7. **AI** — they need an Anthropic API key (the monitor + tracker call Claude).
   Optionally a GitHub username / portfolio URL to enrich resume context
   (`GITHUB_USERNAME`, `PORTFOLIO_URL` worker vars).
8. **Cover-letter voice (optional)** — ask how they like their cover letters to
   read (tone, structure, a signature opener). Bake it into the `cover_letter`
   instructions in `tracker/src/docgen.ts` so the AI writes in *their* voice.

## Rules

- **Never invent the user's experience.** Resumes/cover letters must come from
  their real `resume.md` + profile. If something's missing, ask.
- Secrets go in `.env` / `terraform.tfvars` / GitHub Actions secrets — all
  gitignored. Never commit them, never print them back.
- Prefer the smallest cloud footprint the user wants; local/Docker are valid.
- Keep the invariants in `AGENTS.md` (fail-open, no hardcoded dates, dedupe).

## Fast path

If they just want to try it: `cp data/profile.example.json data/profile.json`,
fill in `candidate.summary` + `role_ranking`, drop a `data/resume.md`, set
`ANTHROPIC_API_KEY`, and run `python monitor/scraper.py --dry-run`.
