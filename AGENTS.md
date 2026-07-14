# AGENTS.md — invariants for anyone (human or AI) editing this repo

1. **Fail-open / fail-soft.** A dependency being down (tracker, an ATS, an API
   key) must never take a run down. Log and continue.
2. **No hardcoded dates.** Recruiting-cycle logic is computed from today's date
   so it never rots.
3. **Dedupe is sacred.** The `seen_jobs` set and the tracker's normalized
   company+title key prevent duplicate alerts/rows — don't bypass them.
4. **Secrets never touch git.** Keys/tokens live in env / Terraform vars /
   Actions secrets; state and personal config are gitignored.
5. **The job-id formula is shared.** `sha256(company|title|url)[:16]` is computed
   identically in the Python monitor and the TypeScript worker — change one, change both.
6. **One auth path.** Everything reaching the Worker is a verified Access JWT.
7. **Profile drives the AI.** Matching and documents use the user's real synced
   profile/resume — never invent experience.
