# Set It Up Yourself

A practical, step-by-step guide to running this for your own job hunt. If you use
**Claude Code**, the fastest path is to open the repo and say *"set this up for me"* —
[`CLAUDE.md`](../CLAUDE.md) has Claude interview you and fill everything in. Otherwise,
do it by hand below.

For the *why* behind any of this, see **[How I Built It](HOW_I_BUILT_IT.md)**.

---

## 0. What you'll need

- An **Anthropic API key** (the monitor + tracker call Claude). Required.
- Optional: a **Discord webhook** (instant alerts) and a **Gmail App Password**
  (email alerts + the inbox watcher).
- For the hosted tracker: a **Cloudflare account** with a domain on it, and
  **Terraform** installed. Not needed for local/container runs.

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
- `ai_scoring.min_score` — raise to 7 if you only want strong fits.

Drop your resume in as `data/resume.md` (plain markdown — this is what tailored
documents are generated from; nothing is ever invented).

Optionally list specific companies to watch directly:

```bash
cp data/companies_master.example.json data/companies_master.json   # then edit
```

(You don't have to — the crowd-sourced feed covers everyone. Your list just
guarantees those companies are scraped at the source.)

## 2. Pick how you want to run it

### Option A — Just the finder, locally (simplest)

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python monitor/scraper.py --dry-run     # scrape + filter + score, print, save nothing
python monitor/scraper.py               # real run (alerts + saves state)
```

Add `DISCORD_WEBHOOK_URL` / `EMAIL_*` env vars (see `.env.example`) for alerts.

### Option B — In a container

```bash
cp .env.example .env        # fill it in
docker build -t job-monitor .
docker run --rm --env-file .env -v "$PWD/data:/app/data" job-monitor
```

Schedule it however you like (host cron, Kubernetes CronJob, …).

### Option C — The full hosted app (dashboard + tracking + document generation)

1. Build the worker:
   ```bash
   cd tracker && npm install && npm run build
   ```
2. Try it locally first (no cloud needed — local D1 + R2, auth bypassed):
   ```bash
   npm run dev        # open the printed localhost URL
   ```
3. Deploy to Cloudflare:
   ```bash
   cd ../terraform
   cp terraform.tfvars.example terraform.tfvars   # fill in account/zone/team + Anthropic key
   terraform init && terraform apply
   ```
   - **R2:** enable R2 once in the Cloudflare dashboard and give your API token
     **Workers R2 Storage: Edit** (uploads live in R2).
   - After `apply`, wait ~45s for edge propagation before hitting the Worker.
4. Point the monitor at the tracker so found jobs flow in: add
   `TRACKER_URL`, `TRACKER_CLIENT_ID`, `TRACKER_CLIENT_SECRET`
   (from `terraform output`) as GitHub Actions repo secrets, and let the
   included workflows run on cron.

## 3. Automate it (GitHub Actions)

Add your secrets under **Settings → Secrets and variables → Actions**:
`ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL`, `EMAIL_SENDER`, `EMAIL_PASSWORD`,
`EMAIL_TO`, and (if hosted) the three `TRACKER_*` values. The workflows in
`.github/workflows/` run the monitor hourly, the inbox watcher every 2h, and a
weekly digest. Tune the cron schedules to taste.

## 4. Make the documents sound like you (optional)

The tracker generates tailored resumes/cover letters from your `resume.md`. To
give cover letters your voice, edit the `cover_letter` instructions in
`tracker/src/docgen.ts` (tone, structure, a signature opener). Set the worker
vars `GITHUB_USERNAME` / `PORTFOLIO_URL` to pull your public repos / site into
the document context.

## Notes

- **Fail-open by design:** no API key → keyword-only results; tracker down → the
  monitor still runs. Nothing hard-fails.
- **Secrets never get committed** — `.env`, `terraform.tfvars`, and your real
  `data/*.json` are gitignored. Keep it that way.
- The **first ever run baselines** your inbox/feed so you don't get flooded; only
  genuinely new postings alert after that.
