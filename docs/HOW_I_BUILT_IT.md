# How I Built It — Job Tracker Automation

<img src="architecture.png" width="1000" alt="Cloud architecture">

> The deep-dive for anyone (recruiters, engineers, the curious) who wants to see
> **every decision I made and why** — architecture, the security model, cost
> engineering, and trade-offs. If you just want to run it, see
> **[Set it up yourself](SETUP.md)**.

This document explains what the system is, how it's built, and — more usefully —
*why* it's built this way. The design goal throughout: a personal, always-on
job-hunt platform with **no servers to babysit**, **low AI cost**, and a
security posture I'd be comfortable putting my name on.

## A note on how I actually use this (for recruiters reading)

I built this to **support** my search, not to outsource it — the effort and the
judgment stay mine:

- I keep a list of the **specific companies and roles I genuinely want**, so the
  system surfaces those the moment they post and I don't miss a deadline — while
  *also* casting a wider net so I catch strong roles I hadn't thought to look for.
- Every AI match score is a **starting point for triage, not a decision**. I still
  **research the company and role myself** before I apply.
- The generated resume and cover letter are a **baseline**. I review and edit every
  one by hand, make sure it's accurate and sounds like me, and tailor it further with
  my own research. **Nothing goes out that I haven't personally checked and made my own.**

The engineering here is in the automation, the infrastructure, and the security —
it removes the busywork (finding, tracking, first drafts) so I can spend my time on
the parts that actually matter: researching, tailoring, and applying thoughtfully.

---

## 1. Motivation

Last summer's internship hunt was death by a thousand tabs: refreshing job
boards, copy-pasting the same resume into a hundred portals, re-writing cover
letters from scratch, and missing good postings because I saw them a day too
late. I wanted one system that:

- **finds** relevant roles the moment they're posted, across many sources,
- **judges** each one against *my* profile so I only look at real fits,
- **tracks** everything I applied to and what happened next, and
- **writes** a tailored resume / cover letter / interview-prep sheet per job,

…and that I could open from **anywhere** — my phone between classes, my school
laptop, a library machine — without running a server or exposing anything public.
That "access anywhere, run nothing" requirement is why the whole thing lives on
serverless edge infrastructure behind zero-trust auth.

---

## 2. Architecture at a glance

Two halves that talk over one authenticated REST API:

- **The monitor** (Python, runs on GitHub Actions cron) — the *finder*. Scrapes
  job boards, filters, AI-scores, notifies, and pushes matches into the tracker.
- **The tracker** (Cloudflare Worker + D1 + R2) — the *system of record and the
  UI*. A single-page dashboard + REST API, plus the AI document generation.

Everything in front of the domain is gated by **Cloudflare Access** (zero trust).
Both humans (email login) and machines (GitHub Actions, via service tokens)
reach the Worker the same way: Access mints a signed JWT, and the Worker
**independently verifies it**. All of the cloud resources are defined in
**Terraform**.

---

## 3. Job discovery — three nets, widest to narrowest

Coverage comes from stacking three sources so nothing slips through:

1. **A crowd-sourced feed** (the Simplify internship lists) — thousands of
   contributors surface new postings within hours. Widest net; catches companies
   with no scrapeable API (e.g. Meta, Apple).
2. **ATS APIs** — direct, structured pulls from applicant-tracking systems
   (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Workable, Recruitee,
   BambooHR). A `classify.py` probe figures out which ATS each company uses and
   caches the answer in a registry, so the scraper never guesses.
3. **Built-in direct scrapers** — a few big employers (Google, Amazon, etc.)
   have bespoke career APIs handled directly.

Every source is **fail-soft**: one board being down or changing shape never
takes the run down.

## 4. Filtering & categorization

Raw postings pass through `filters.py`, which is deliberately strict so the AI
only sees plausible candidates. A posting must: be a real intern/co-op role
(word-boundary matching so "Internal Tools" doesn't slip through), have no
seniority marker, not be a non-student program, be US-based, and reference the
current-or-future recruiting cycle (**computed from today's date — nothing is
hardcoded to rot**). Survivors get a coarse category from the profile's keyword
lists before the LLM refines it.

De-duplication is layered: a per-run `seen_jobs` set (only genuinely new
postings continue), plus a normalized company+title key in the tracker so the
same role found on two boards — or found by the monitor *and* added by hand —
collapses to a single row.

## 5. The AI pipeline (applied LLM engineering)

Claude does the judgment work; the deterministic filters are the cheap coarse
net. Key decisions:

- **Model routing by job.** The high-volume, low-stakes work (scoring every
  posting, extracting structured fields from a page, classifying emails) uses
  **Claude Haiku** — fast and cheap. The rare, high-value work (generating a
  tailored resume or cover letter) uses **Claude Opus**.
- **Profile-aware matching.** Every job is scored 0–10 against the user's synced
  profile with a calibrated, deliberately harsh rubric (a tracker where
  everything is a 9 is useless). The model also extracts the concrete
  tools/keywords each posting names — aggregated later into "what should I learn
  / build" signal.
- **Prompt caching.** The candidate profile (the big, stable part of every
  matching and document prompt) is sent as a cached prefix, so repeated calls
  pay ~10% for it instead of full price. Extended (1-hour) cache keeps it warm
  across a whole session of matches and document generations.
- **Message Batches.** The weekly re-scoring pass goes through Anthropic's
  Message Batches API (~50% cheaper, asynchronous) — it isn't latency-sensitive,
  so there's no reason to pay real-time rates.
- **A spend guardrail.** Every Claude call logs its token usage; document
  generation checks the day's spend against a configurable cap and refuses
  cleanly if exceeded. The dashboard surfaces spend + cache-hit rate so cost is
  never a mystery.
- **Document generation.** Per job, Opus drafts a resume, cover letter,
  interview-prep sheet, or application answers — grounded strictly in the user's
  real materials (resume, optional GitHub repos, optional site). Resumes export
  to a pixel-matched one-page `.docx`; you can also copy the full prompt to run
  on your own Claude subscription for zero API cost, or upload the file you
  actually submitted (stored in R2 for later review).

## 6. The tracker (edge full-stack)

- **Cloudflare Worker + Hono** serve both the single-page UI and a REST API from
  one edge script — no origin server, global by default.
- **D1** (SQLite at the edge) holds jobs, an event timeline, saved-document
  metadata, and a token-usage log. The schema **self-migrates** on cold start
  (Terraform can't run SQL), so deploys never need a manual migration step.
- **R2** stores the actual document files (the PDF/DOCX you submitted), streamed
  back through the authenticated Worker — the bucket itself is never public.
- **UI:** a dependency-free single-page app (dark, Linear-inspired) with phase
  tabs, AI match tiers, analytics, an activity feed, and the document tools.
  It's a **PWA** — installable to a phone home screen.

## 7. Security model

The posture is "one narrow, verified way in, and least privilege everywhere,"
described here at the level of *approach* (not a runbook):

- **Zero-trust edge.** Cloudflare Access fronts the entire domain; the workers.dev
  subdomain is disabled, so the Access-protected custom domain is the only route
  to the Worker.
- **Independent JWT verification.** Rather than trusting the edge blindly, the
  Worker verifies every request's Access JWT itself — signature (RS256 against
  the rotating JWKS), audience, issuer, and expiry — and pins the algorithm to
  block "alg=none"–style forgeries. It fails closed.
- **Defense in depth.** On top of the Access policy, the Worker independently
  enforces the owner's identity, so a mis-widened policy still can't let another
  human in. Machine callers (GitHub Actions) use scoped, non-interactive
  **service tokens**.
- **One auth path.** Humans and machines authenticate the same way; there is no
  second, weaker door.
- **Input hygiene.** URLs are scheme-checked (no `javascript:`/`data:`), uploads
  are type/size-limited, generated files are size-capped, and responses carry
  strict security headers (CSP, `X-Frame-Options: DENY`, `nosniff`,
  `no-referrer`). LLM prompts that ingest untrusted page/email text are
  structured to resist injection.
- **Secrets** live only in Terraform variables, GitHub Actions secrets, and
  Worker secret bindings — never in the repo. State and config files are
  gitignored.

## 8. Cost

Designed to run for pocket change. The serverless pieces (Workers/D1/R2) sit
comfortably in free tiers at personal volume; the only real cost is the
Anthropic API, which is dominated by cheap Haiku matching and kept low by prompt
caching, batching, and the daily cap. Opus is only used when you explicitly
generate a document (or you route that to your own subscription for free).

## 9. Reliability & self-healing

Fail-open is the rule: the tracker being down never breaks the monitor, a missing
API key degrades to keyword-only results, and a broken board is skipped. The
monitor tracks per-company failure/zero-match streaks and auto-re-probes dead
ATS endpoints; a weekly digest summarizes activity and re-heals match coverage.
CI (typecheck + build + config validation) runs on every push.

## 10. Run modes

| Mode | What runs where |
|---|---|
| **Hosted** | Worker + D1 + R2 + Access on Cloudflare (Terraform), monitor on GitHub Actions cron. Zero servers; open from anywhere. |
| **Local** | `wrangler dev` = full Worker against local D1 + R2 (auth bypassed); run the monitor on your machine. |
| **Container** | `Dockerfile` runs the monitor pipeline anywhere (host cron, K8s CronJob). |

See [`CLAUDE.md`](../CLAUDE.md) to have Claude Code configure any of these for you.

## 11. File map

| Path | Role |
|---|---|
| `monitor/scraper.py` | Orchestrates a run: scrape → filter → AI-score → notify → push |
| `monitor/sources.py` | Per-ATS + direct scrapers |
| `monitor/classify.py` | Probes which ATS a company uses; maintains the registry |
| `monitor/filters.py` | Intern / seniority / location / cycle filtering + categorization |
| `monitor/ai_score.py` | Claude relevance scoring against your profile |
| `monitor/gmail_watch.py` | IMAP inbox watcher → classifies application emails |
| `monitor/digest.py` | Weekly digest + housekeeping + match self-heal |
| `monitor/notify.py` | Discord + email delivery |
| `monitor/tracker_client.py` | Fail-open client for the tracker API |
| `tracker/src/index.ts` | Worker entry — auth, security headers, routing, PWA assets |
| `tracker/src/auth.ts` | Cloudflare Access JWT verification |
| `tracker/src/api.ts` | REST API (jobs, events, imports, documents, stats) |
| `tracker/src/db.ts` | Versioned self-migrating D1 schema |
| `tracker/src/match.ts` | Profile-aware AI matching + enrichment + prompt caching |
| `tracker/src/docgen.ts` | Per-job document generation (Opus) |
| `tracker/src/docxgen.ts` | Markdown → one-page styled `.docx` |
| `tracker/src/batch.ts` | Message Batches path for cheap re-scoring |
| `tracker/src/usage.ts` | Token-usage logging + cost accounting |
| `tracker/src/ui.html` | The single-page dashboard |
| `terraform/` | All cloud infrastructure as code |
| `scripts/sync_profile.py` | Pushes your resume + extra context into the tracker |

## 12. Design decisions & trade-offs

- **Serverless over a VM/container app** — the whole point was zero maintenance
  and access-anywhere. Workers + D1 + R2 give a global, always-on app with no
  patching, no scaling, and a generous free tier. (You can still run it locally
  or in a container if you prefer — see run modes.)
- **Zero-trust auth over rolling my own login** — Cloudflare Access handles
  identity; the Worker just verifies the token. Less code, fewer ways to get
  auth wrong, and the same path works for both the UI and automation.
- **Terraform over click-ops** — the infra is reviewable and reproducible; one
  `apply` stands the whole thing up, and there's no drift between "what's
  deployed" and "what's written down."
- **Model routing over one big model** — Haiku for the 99% (cheap, high-volume
  judgment), Opus for the 1% that's worth it (writing). Caching + batching +
  a spend cap keep the bill in pocket-change territory.
- **Fail-open everywhere** — a personal tool that breaks loudly is worse than one
  that degrades quietly and keeps finding jobs.
