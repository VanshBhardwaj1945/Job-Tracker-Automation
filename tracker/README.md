# job-tracker

Personal job tracker at **https://jobs.example.com** — Cloudflare Worker + D1,
behind Cloudflare Access, deployed by Terraform (`../terraform`). The [job monitor](../README.md)
feeds it; the gmail watcher updates it; this worker serves the UI and API.

```
monitor (hourly) ──► POST /api/jobs/bulk ──► phase "found"
 └─ AI match vs YOUR profile (background)
UI ── paste URL/description ──► /api/import ──► extract + match → preview → save
UI ── paste LinkedIn Applied page ──► /api/import-list ──► rows as "applied"
gmail_watch (2h) ──► /api/email-event ──► timeline events; rejections auto-flip
scripts/sync_profile.py ──► meta profile_resume + profile_extra ──► /api/rematch-all
```

## Views (Aurora-glass sidebar UI)

- **Tracker** — Recommended (found + match ≥ 7) · Found · Applied · OA · Interview ·
 Offer · Rejected · All. Search, category filter, sort, star importance, inline phase
 dropdowns, detail modal (markdown description/requirements, match reason, skills chips,
 notes, event timeline, edit-everything form, re-match). CSV export in the topbar.
- **Analytics** — KPI row (interview rate, avg days-to-response), applications/week +
 per-month area charts, category donut, pipeline funnel, sources, top companies,
 locations, match-score distribution, and tools & buzzwords from postings (split
 "applied" vs "everywhere" — project-idea signal).
- **Activity** — live GitHub Actions runs (needs `github_token` tfvar since the repo is
 private), heartbeat cards (monitor / tracker push / gmail watcher / profile sync), and
 the recent job-event feed. A Sunday digest workflow (`monitor/digest.py`) additionally
 sends follow-up nudges + auto-archives Found jobs stale 45+ days.

## Phases & categories

Phases: `found → applied → oa → interview → offer → accepted` (+ `rejected`,
`withdrawn`, `archived`). Categories: `iam` · `detection` · `appsec` · `cloud_sec` ·
`ai_sec` · `security` · `swe_infra` · `swe_other` · `other`.

## AI matching

`src/match.ts` scores every job 0–10 against the profile stored in D1 meta
(`profile_resume` = resume.md, `profile_extra` = the portfolio assistant's
knowledge block) and extracts the concrete tools the posting names. Update either
source doc → run `python scripts/sync_profile.py` (resume alone also syncs via the
Profile Sync workflow on push) → matches refresh.

## API

| Route | What |
|---|---|
| `GET /api/jobs` | filters: `phase`, `recommended=1`, `category`, `q`, `min_score`, `sort` |
| `POST /api/jobs` · `PATCH/DELETE /api/jobs/:id` | CRUD (phase changes log events) |
| `POST /api/jobs/bulk` | monitor upsert (INSERT OR IGNORE, background match) |
| `POST /api/import` | URL/text → extracted + matched draft |
| `POST /api/import-list` | pasted jobs list → rows (default phase `applied`) |
| `POST /api/jobs/:id/rematch` · `POST /api/rematch-all` | refresh match data |
| `GET /api/stats` | analytics aggregations (phases, categories, weekly/monthly, sources, locations, skills, timings) |
| `GET /api/activity` | GH workflow runs + heartbeats + recent events |
| `GET /api/export` | full CSV download |
| `POST /api/email-event` | gmail watcher verdicts |
| `GET/PUT /api/meta/:key` | watcher checkpoint, profile docs |

Auth: Cloudflare Access JWT, verified in-worker (`src/auth.ts`: signature via team
JWKS + `aud` + `iss`) — email login for humans, service token for CI. `DEV_MODE=1`
(wrangler dev only) bypasses.

## Security posture

- workers.dev disabled; the Access-protected custom domain is the only route, and the
 worker re-verifies every JWT itself (defense in depth).
- Only `http(s)` URLs are ever stored or rendered (`cleanUrl` on all write paths +
 `safeUrl` at render) — no `javascript:`/`data:` link injection.
- CSP / `X-Frame-Options: DENY` / `nosniff` / `no-referrer` on every response.
- `/api/import` fetches http(s) only; CSV export escapes + guards formula injection.
- All SQL is parameterized; the gmail classifier prompt treats email bodies as
 untrusted data (prompt-injection hardened).

## Dev & deploy

```bash
npm install
npm run dev # local worker + local D1, auth bypassed
npm run check # tsc
npm run build # esbuild → dist/worker.js (ui.html inlined)

# deploy (terraform state is local to the candidate's machine — CI validates, never applies)
npm run build && terraform -chdir=../terraform apply
```

Schema migrates itself on cold start (`src/db.ts`, versioned). Job id =
`sha256(company|title|url)[:16]` — must stay identical to `monitor/scraper.py`.
