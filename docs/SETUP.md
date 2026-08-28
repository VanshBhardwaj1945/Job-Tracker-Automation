# Set It Up Yourself

A practical, step-by-step guide for **anyone** to run this — whatever AI you use,
wherever you want to host it. The fastest path: open the repo in any AI coding
assistant (Claude Code, Gemini CLI, OpenAI Codex, Cursor…) and say *"set this up
for me"* — see [`CONFIGURE_WITH_AI.md`](CONFIGURE_WITH_AI.md). Or do it by hand below.

For the *why* behind any of this, see **[How I Built It](HOW_I_BUILT_IT.md)**.

> **Use it to assist, not replace your effort.** Always review and edit AI-written
> resumes/cover letters before sending, verify every claim is true and authentic, and do
> your own research on each company — a genuine, personalized application still wins. See
> the Disclaimer in the [README](../README.md).

**Who this is for:** students and job-seekers who want the finding + tailoring +
tracking automated, at any budget — from "just run the finder on my laptop for
free" to "a fully hosted dashboard I open from my phone."

---

## 0. What you'll need

- **An AI provider** (required for scoring + documents) — use whatever you want:
  Anthropic, OpenAI, Google Gemini, or a **local model** (Ollama, etc.). See §2.
- Optional: a **Discord webhook** (instant alerts) and a **Gmail App Password**
  (email alerts + the inbox watcher).
- Only if you want the full hosted dashboard: a host for the Worker + a database +
  object storage + an auth layer. The reference is Cloudflare (free tier + one
  `terraform apply`); §3 covers local, Docker, your own server, and AWS / GCP / Azure.

## 1. Tell it about you

```bash
cp data/profile.example.json data/profile.json
```

Edit `data/profile.json`:

- `candidate.summary` — one or two sentences on who you are and what you're
  targeting. **This is what the AI scores every posting against**, so make it real.
- `role_ranking` — the role types you want, each with a `weight` (10 = dream,
  5 = acceptable). This anchors the scoring.
- `categories` — keyword lists for your priority buckets (retune freely).
- `ai_scoring.min_score` — raise to 70 if you only want strong fits (0-100 scale).

Drop your resume in as `data/resume.md` (plain markdown — this is what tailored
documents are generated from; nothing is ever invented).

Optionally add a `preferences.md` at the repo root — free text describing the
company tiers you care about, the product/industry areas you're drawn to, and
the role types you prefer. `scripts/sync_profile.py` pushes it into the tracker,
and the AI uses it for a separate **Like** (desirability) score on every job,
fully independent of the skills-fit match score. Without it, every job scores a
neutral 60 and the tiers behave like a single-axis tracker.

Optionally list specific companies to watch directly:

```bash
cp data/companies_master.example.json data/companies_master.json   # then edit
```

(You don't have to — the crowd-sourced feed covers everyone. Your list just
guarantees those companies are scraped at the source.)

## 2. Choose your AI provider (use whatever you want)

The monitor calls an LLM to score jobs and classify emails; the tracker uses one to
generate documents. Pick a provider with `AI_PROVIDER` and set its key — the code
routes to it (`monitor/ai_client.py`). Override any model with `AI_MODEL`.

| Provider | Env | Default model | Notes |
|---|---|---|---|
| **Anthropic** (default) | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | Cheapest for the high-volume scoring |
| **OpenAI** | `AI_PROVIDER=openai`, `OPENAI_API_KEY` | `gpt-4o-mini` | |
| **Google Gemini** | `AI_PROVIDER=gemini`, `GEMINI_API_KEY` | `gemini-2.0-flash` | |
| **Local / self-hosted** | `AI_PROVIDER=local`, `AI_BASE_URL` (e.g. Ollama `http://localhost:11434/v1`), `AI_MODEL` | your model | **Free & private** — any OpenAI-compatible server |

Cost tip: scoring runs on every posting, so a small/cheap model is ideal there; you
only need a stronger model for document generation. (The hosted tracker currently
targets Anthropic for documents — its model layer is isolated in
`tracker/src/docgen.ts`/`match.ts` if you want to point it elsewhere.)

## 3. Choose where to host it

Everyone's budget and comfort level is different — pick the row that fits. The
**monitor (Python)** runs literally anywhere. The **tracker** (dashboard + document
generation) is a portable Hono app; the reference deploy is Cloudflare, and the
notes below cover porting it.

### Just the finder — laptop / free

```bash
pip install -r requirements.txt
cp .env.example .env      # set AI_PROVIDER + key (+ Discord/email if you want alerts)
export $(grep -v '^#' .env | xargs)
python monitor/scraper.py --dry-run     # scrape + filter + score, print, save nothing
python monitor/scraper.py               # real run (alerts + saves state)
```

### Container (Docker) — anywhere

```bash
cp .env.example .env      # fill it in
docker build -t job-monitor .
docker run --rm --env-file .env -v "$PWD/data:/app/data" job-monitor
```

### Your own server / personal VM — cron or systemd

Clone it, `pip install -r requirements.txt`, put your env in `/etc/job-monitor.env`,
and schedule the monitor with cron:

```cron
0 * * * *  cd /opt/job-monitor && set -a && . /etc/job-monitor.env && python monitor/scraper.py
```

(or a systemd timer, or a Kubernetes CronJob using the Docker image).

### GitHub Actions — free, zero infra to manage

Add your keys under **Settings → Secrets and variables → Actions** (`AI_PROVIDER`
+ your provider key, `DISCORD_WEBHOOK_URL`, `EMAIL_*`, and the `TRACKER_*` trio if
you host the dashboard). The workflows in `.github/workflows/` run the monitor
hourly, the inbox watcher every 2h, and a weekly digest. Tune the crons.

### The full hosted dashboard

**Cloudflare (reference — free tier, one apply):**

```bash
cd tracker && npm install && npm run build
npm run dev            # optional: try the whole app locally (local D1 + R2, auth bypassed)
cd ../terraform
cp terraform.tfvars.example terraform.tfvars   # account/zone/team + your AI key
terraform init && terraform apply
```
- Enable R2 once in the Cloudflare dashboard and give your API token **Workers R2
  Storage: Edit**. After `apply`, wait ~45s for edge propagation.
- Point the monitor at it: add `TRACKER_URL` + the two service-token values
  (from `terraform output`) to your monitor env / Actions secrets.

**Other clouds (AWS / GCP / Azure / your server):** the tracker is a standard Hono
app; only three things are Cloudflare-specific, and each maps cleanly:

| Cloudflare piece | AWS | GCP | Azure | Self-hosted |
|---|---|---|---|---|
| Workers (compute) | Lambda + API Gateway, or a container on ECS/App Runner | Cloud Run | Container Apps / Functions | Node/Bun/Deno process |
| D1 (SQLite) | DynamoDB or RDS/Aurora | Firestore or Cloud SQL | Cosmos DB or Azure SQL | SQLite/Postgres |
| R2 (files) | S3 | Cloud Storage | Blob Storage | local disk / MinIO |
| Access (auth) | Cognito / ALB OIDC | IAP | Entra ID / App Service auth | any OAuth2 proxy |

Run the monitor next to it (Lambda + EventBridge, Cloud Run + Cloud Scheduler,
Azure Functions timer, or plain cron). The storage/auth swaps are small, isolated
edits — your AI assistant (see [`CONFIGURE_WITH_AI.md`](CONFIGURE_WITH_AI.md)) can
do the port for you. If you just want the finder + alerts, you don't need the
tracker at all.

## 4. Make the documents sound like you (optional)

The tracker generates tailored resumes/cover letters from your `resume.md`. To
give cover letters your voice, edit the `cover_letter` instructions in
`tracker/src/docgen.ts` (tone, structure, a signature opener). Set the worker
vars `GITHUB_USERNAME` / `PORTFOLIO_URL` to pull your public repos / site into
the document context.

## 5. Categories & the cost center (optional)

- **Category taxonomy.** Jobs are AI-tagged into a hierarchical tree
  (`tracker/src/types.ts`, `TAXONOMY`) and roll up (a leaf belongs to its
  parents). It ships security-heavy; edit `TAXONOMY` to add/rename branches for
  your field — the model prompt, the filters, and the analytics all read from
  that one array, so nothing else needs to change. After editing, re-tag jobs
  with a rematch pass.
- **Cost center.** Claude spend is charted automatically from the usage log. To
  include flat cloud costs, set a single meta key (any API client with your
  service token): `PUT /api/meta/cost_providers` with value
  `{"cloudflare":{"monthly":5},"azure":{"monthly":0}}` — the dashboard spreads
  each monthly figure across days and lets you toggle providers on the graph.
- **Skills you have vs should learn** auto-fills from your synced profile — no
  manual list needed, though you can still curate one via the meta key
  `known_skills` (a JSON array).

## 6. Built-in, zero config

These just work out of the box:

- **Three scoring axes per job**: a 0–100 **AI match** (skills fit), a 0–100
  **Like** score (desirability, from your optional `preferences.md` — neutral
  without it), and an estimated **Pay** tier. The apply-now tiers (Top /
  Recommended / For you / Take a look) gate on **both** match and like, and the
  rank sort blends all three; a **deep-insights** panel reads your own
  application history (fit quality, focus, conversion, momentum, follow-ups).
- **An internship gate** — clearly full-time/new-grad postings (seniority
  titles, years-of-experience bars, six-figure annual salaries) are dropped
  before alerting; anything ambiguous passes. Optionally set
  `LANE_EXCLUDE_SOC_GRC=1` to also drop unambiguously pure SOC-analyst /
  GRC / compliance / audit titles (off by default — it encodes a preference
  for engineering/build roles).
- **Drag-and-drop documents** — drop PDFs, DOCX, or `.md` files (several at
  once) onto a job's Documents section; each is kind-sorted by filename
  (resume / cover letter / briefing note) and saved instantly. PDFs and DOCX
  view **inline** (real pages, not extracted text); `.md` briefings render as a
  styled reading page. Notes **autosave** as you type.
- **Favorite buckets** — star any job into lists you name yourself ("Dream jobs" …).
- **Light / dark mode** toggle (bottom-left), remembered per browser.
- **Customizable dashboard** — on Analytics, hit *Customize layout* to drag panels
  and resize their width; the layout saves to your browser.
- Matching uses a **mid-tier model** by default (`AI_MODEL` overrides it) — prompt
  caching keeps the cost low.
- **Full re-score on demand** — dispatch the Job Monitor workflow in `rematch`
  mode to re-score every tracked job (it sets `REMATCH_ALL=1`); do this after
  changing your profile, preferences, or the scoring rubric.

## 7. LinkedIn via Apify (optional, OFF by default, bring your own token)

LinkedIn has no open jobs API and scraping it sits in a ToS gray area, so this
template ships **without** a LinkedIn feed. If you want one anyway, the clean
pattern is a paid scraping Actor on [Apify](https://apify.com) run **once a
day** (LinkedIn actors burn credit fast — never put one on an hourly loop):

1. Create an Apify account and grab your API token (Settings → Integrations).
   The free tier includes ~$5/month of credit.
2. Pick a maintained **pay-per-result** LinkedIn *jobs* Actor from the Apify
   Store (around $1 per 1,000 results; avoid monthly-rental actors unless you
   need volume). Note its actor id and input schema — input shapes are not
   standardized across actors.
3. Add a small feed function next to the other sources: POST your searches to
   `https://api.apify.com/v2/acts/<ACTOR_ID>/run-sync-get-dataset-items?token=<TOKEN>`,
   map each item to the standard job dict (`company/title/location/url/description`),
   return `[]` on any error (fail-open, like every other feed), and **cap the
   rows** (e.g. 80/day keeps you inside the free credit).
4. Gate it behind an env var (e.g. `LINKEDIN_DAILY=1`) that only your daily
   cron sets, so the hourly monitor never touches Apify.

Dedupe is already handled downstream (seen-jobs store + tracker id), so a daily
LinkedIn sweep coexists fine with the hourly open-API feeds.

## 8. Handshake job alerts (optional, for students)

If your school uses [Handshake](https://joinhandshake.com), its job-alert
emails can feed the tracker — no scraping, no extra credentials:

1. In Handshake: **Settings → Notifications**, set your job-alert interests and
   turn on **"New jobs: Email"**.
2. Make sure those alerts land in the **same Gmail inbox** the gmail watcher
   reads (`EMAIL_SENDER`) — school accounts often default to the school address,
   so check where Handshake actually sends.

That's it. The watcher recognizes the Handshake sender domain (end-anchored, so
lookalike domains are rejected), extracts the postings with the AI, unwraps the
click-tracking links, applies the internship gate (Handshake alerts include
full-time roles), and pushes new jobs into the tracker as Found. Extraction is
fail-open — a bad email never blocks your application-event classification.

## 9. YC startup internships (optional, $0)

A daily feed of internships at Y Combinator startups, built entirely from
public pages (no login, no API key). Enable it by setting `YC_DAILY=1` on a
daily run — the workflow ships a `yc` dispatch mode and a commented daily cron:

```yaml
YC_DAILY: "1"            # the gate — hourly runs skip the feed entirely
YC_QUERIES: "security, developer tools, AI infrastructure"   # optional: your lanes
YC_MAX_COMPANIES: "60"   # optional: page-fetch cap per run
```

It queries YC's public company search for hiring companies matching your terms,
reads each company's public jobs page, and keeps the internship postings. Keep
it on a daily cadence — it's ~60 page fetches per run, which is pointless
hourly and impolite always.

## Notes

- **Fail-open by design:** no API key → keyword-only results; tracker down → the
  monitor still runs. Nothing hard-fails.
- **Secrets never get committed** — `.env`, `terraform.tfvars`, and your real
  `data/*.json` are gitignored. Keep it that way.
- The **first ever run baselines** your inbox/feed so you don't get flooded; only
  genuinely new postings alert after that.
