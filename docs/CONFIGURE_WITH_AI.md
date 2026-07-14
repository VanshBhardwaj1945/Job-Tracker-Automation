# Configure With Your AI Assistant

This repo is built to be set up by **any AI coding assistant** — Claude Code
(`CLAUDE.md`), Gemini CLI (`GEMINI.md`), OpenAI Codex / Cursor / Windsurf / others
(`AGENTS.md`). All of those point here. Open the repo in your assistant and say
*"set this up for me"*; it should follow the flow below. (You can also do it by
hand — see [`SETUP.md`](SETUP.md).)

## The interview (ask a few at a time; confirm before side effects)

1. **Who they are** — name, city, email, phone, GitHub, LinkedIn. Used only on
   their generated resumes/cover letters. → `data/profile.json` + `data/resume.md`.
2. **What they want** — target roles (ranked, weighted), the keywords that define
   their field, whether to include generic roles, and specific companies to watch.
   → `data/profile.json` + `data/companies_master.json`.
3. **Their resume** — have them paste it / point to a file; save as `data/resume.md`.
   This is what documents are tailored from — never invent content.
4. **How often** — the monitor runs hourly by default; adjust the schedule.
5. **Notifications** — Discord webhook? Gmail (App Password) for email + the inbox watcher?
6. **Where to host** — offer every option and set up their pick (see
   [`SETUP.md`](SETUP.md) → Hosting): local, Docker/container, personal server,
   or a cloud (Cloudflare reference, or adapt to AWS / GCP / Azure).
7. **Which AI provider** — the code defaults to Anthropic Claude, but the model
   layer is swappable to OpenAI / Google Gemini / a local model. Ask, then wire
   their key (see [`SETUP.md`](SETUP.md) → AI provider).
8. **Cover-letter voice (optional)** — how they like cover letters to read; bake it
   into the `cover_letter` instructions in `tracker/src/docgen.ts` (and the Python
   equivalents) so documents sound like them.

## Rules

- **Never invent the user's experience.** Documents come from their real
  `resume.md` + profile. If something's missing, ask.
- Secrets live in `.env` / `terraform.tfvars` / CI secrets — all gitignored.
  Never commit or print them.
- Prefer the smallest footprint the user wants; local/Docker are first-class.
- Keep the invariants in [`AGENTS.md`](../AGENTS.md) (fail-open, no hardcoded
  dates, dedupe, shared job-id formula, one auth path, profile-driven AI).

## Fast path

`cp data/profile.example.json data/profile.json`, fill `candidate.summary` +
`role_ranking`, drop a `data/resume.md`, set your AI key, and run
`python monitor/scraper.py --dry-run`.
