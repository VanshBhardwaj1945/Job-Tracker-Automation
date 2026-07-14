# Job Tracker Automation

<img src="docs/architecture.png" width="1000" alt="Cloud architecture">

> An end-to-end job-hunt automation platform: it **finds** relevant roles across the internet every hour, **scores** each one against your profile with an LLM, **tracks** everything you apply to, and **generates** tailored resumes, cover letters, and interview prep — all behind a private, single-page dashboard you can open from anywhere.

> I built this because I hated last summer's internship hunt — hundreds of tabs, copy-pasting the same resume, missing postings because I saw them a day late. I wanted one place that did the finding, the tailoring, and the tracking for me, and that I could open from my phone, my school laptop, anywhere.

**[Full documentation & design decisions →](docs/FULL_DOCUMENTATION.md)**

---

## What this demonstrates

A production-shaped, serverless, AI-driven system — not a tutorial. Every piece has a real job:

- **Serverless full-stack** on Cloudflare Workers (edge compute), **D1** (SQLite at the edge), and **R2** (object storage) — a single-page dashboard + REST API with **zero servers to run**.
- **Zero-trust auth**: Cloudflare Access in front of the app; the Worker independently verifies the signed **JWT** (audience + issuer + RS256 signature) and enforces the owner identity as defense-in-depth.
- **Infrastructure as Code**: the entire cloud footprint (Worker, D1, R2, DNS, Access policies, service tokens) is defined in **Terraform** — reproducible, reviewable, one `apply`.
- **Event-driven automation**: scheduled **GitHub Actions** workflows scrape job boards, watch email over IMAP, and sync data through the API with least-privilege **service tokens**.
- **Applied LLM engineering**: profile-aware job matching, structured extraction, and per-job document generation using Claude — with **prompt caching**, a **daily spend guardrail**, and the **Message Batches API** to keep cost low.

## Stack

| Layer | Tech |
|---|---|
| **Edge app** | Cloudflare Workers, Hono (router), TypeScript |
| **Data** | Cloudflare D1 (SQLite), self-migrating schema |
| **Object storage** | Cloudflare R2 (uploaded resumes / cover letters) |
| **Auth** | Cloudflare Zero Trust Access (email policy + service tokens), Worker-side JWT verification |
| **IaC** | Terraform (Cloudflare provider) |
| **Automation** | GitHub Actions (cron), Python 3.12 |
| **AI** | Anthropic Claude — Haiku (matching/extraction), Opus (documents), Message Batches |
| **Notifications** | Discord webhooks, Gmail (IMAP + SMTP) |
| **Frontend** | Single-page dark UI (no framework), PWA (installable) |

## How it works

```
                 hourly                        every 2h
  Job boards / ATS ─► Monitor ─► filter ─► AI score ─► Discord alert
  (Greenhouse,        (GitHub     (intern?   (Haiku)        + push to
   Lever, Ashby,       Actions)    US? cycle?)               the tracker
   Workday, Simplify…)                                          │
                                                                ▼
  You (phone / laptop) ──► Cloudflare Access ──► Worker ──► D1 (jobs, events, usage)
                            (verified JWT)         │         R2 (documents)
                                                   ├─► match each job vs YOUR profile (Haiku)
                                                   └─► generate resume / cover letter /
                                                       interview prep / answers (Opus)
  Gmail (IMAP) ──► Gmail watcher ──► classifies application emails ──► timeline + auto phase flip
```

## Run it your way

You choose how much cloud to use:

- **Fully hosted (recommended):** deploy the Worker + D1 + R2 + Access with Terraform, run the monitor on GitHub Actions cron. Nothing to keep running; open the dashboard from anywhere.
- **Local:** `wrangler dev` runs the whole Worker (UI + API) against a local D1 + R2; run the Python monitor on your own machine. No cloud account needed to try it.
- **Container:** a `Dockerfile` runs the monitor pipeline anywhere (host cron, Kubernetes CronJob, etc.) — see `.env.example`.

## Make it yours (with Claude)

This repo is built to be configured by **Claude Code**. Open the folder in Claude and say *"set this up for me"* — [`CLAUDE.md`](CLAUDE.md) tells Claude to interview you (what roles, which companies, how often, notifications, where to host, your identity for resumes) and fill in every config file. Or do it by hand:

1. `cp data/profile.example.json data/profile.json` and describe who you are + what you're targeting.
2. Add your resume as `data/resume.md` (or sync it — see the docs).
3. Pick a run mode above and follow [the docs](docs/FULL_DOCUMENTATION.md).

## Repo layout

| Path | What |
|---|---|
| `monitor/` | Python pipeline — scrape → filter → AI-score → notify → push to tracker |
| `tracker/` | Cloudflare Worker — dashboard UI + REST API + AI document generation |
| `terraform/` | All cloud infrastructure as code |
| `scripts/` | Profile sync helper |
| `data/` | Your config + runtime state (gitignored) |
| `docs/` | Full documentation + architecture diagram |

---

Built with [Claude Code](https://claude.com/claude-code). MIT licensed — fork it, make it yours.
