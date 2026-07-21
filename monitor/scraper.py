#!/usr/bin/env python3
"""
scraper.py — Job Monitor orchestrator.

Pipeline per run (hourly via GitHub Actions):
  1. Load registry / profile / seen-jobs. Auto-bootstrap registry if empty.
  2. Scrape all registry companies in parallel + built-in direct sources
     (Google, Amazon, Microsoft, Netflix) + the Simplify crowd-sourced feed.
  3. Keyword-filter & categorize (security / relevant_swe / other_swe).
  4. Dedupe against seen_jobs.json.
  5. AI-score new jobs with Claude (optional, needs ANTHROPIC_API_KEY).
  6. Notify: Discord (instant) + email, grouped security-first.

Usage:
  python scraper.py             # normal run
  python scraper.py --dry-run   # scrape + filter, print, no notify/no state save
  python scraper.py --test      # send test notification + filter self-check
  python scraper.py --health    # send weekly health report
"""

import argparse
import hashlib
import json
import re
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import filters
import notify
import sources
from ai_score import score_jobs

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR.parent / "data"  # data/ lives at repo root
REGISTRY_FILE = DATA_DIR / "company_registry.json"
PROFILE_FILE = DATA_DIR / "profile.json"
SEEN_FILE = DATA_DIR / "seen_jobs.json"

MAX_WORKERS = 12
BASELINE_NOTIFY_CAP = 30  # first-ever run: don't flood the inbox


# ── File I/O ──────────────────────────────────────────────────────────────────
def load_json(path, default=None):
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return default


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


# ── Job assembly ──────────────────────────────────────────────────────────────
def make_job_id(company, title, url):
    raw = f"{company.lower()}|{title.lower()}|{url.lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


_WATCHSET = None


def _watchset():
    """Normalized set of watchlist companies (master list + registry + builtins).
    Simplify surfaces ALL companies; jobs from ones not in here are kept but
    flagged watchlisted=0 (filterable in the tracker UI)."""
    global _WATCHSET
    if _WATCHSET is None:
        import re as _re
        norm = lambda c: _re.sub(r"[^a-z0-9]", "", c.lower())
        names = set(load_json(DATA_DIR / "companies_master.json", []) or [])
        names |= set(load_json(REGISTRY_FILE, {}).get("companies", {}).keys())
        names |= {"Google", "Amazon", "Microsoft", "Netflix", "Meta", "Apple"}
        _WATCHSET = {norm(n) for n in names if n}
    return _WATCHSET


def is_watchlisted(company: str) -> bool:
    import re as _re
    return _re.sub(r"[^a-z0-9]", "", (company or "").lower()) in _watchset()


TERM_RE = re.compile(r"\b(spring|summer|fall|autumn|winter)\s*(20\d{2})\b", re.IGNORECASE)


def extract_term(*texts) -> str:
    """'Summer 2027, Fall 2026' from titles/terms/description snippets."""
    out = []
    for s, y in TERM_RE.findall(" ".join(t or "" for t in texts)):
        label = f"{'Fall' if s.lower() == 'autumn' else s.capitalize()} {y}"
        if label not in out:
            out.append(label)
    return ", ".join(out[:3])


def _norm_posted(v):
    """Feed post-dates come in mixed shapes (epoch secs/ms, ISO, plain date).
    Normalize to an ISO-8601 string so the tracker can compute freshness; None
    when absent/unparseable."""
    if not v:
        return None
    try:
        ts = float(v)
        if ts > 1e11:          # milliseconds → seconds
            ts /= 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (TypeError, ValueError):
        s = str(v).strip()
        return s or None


def build_job(company, raw, source, category):
    return {
        "id": make_job_id(company, raw["title"], raw["url"]),
        "company": company,
        "title": raw["title"],
        "location": raw["location"],
        "url": raw["url"],
        "source": source,
        "category": category,
        # Kept through AI scoring + tracker push (better matching/skills
        # extraction); stripped before persisting to seen_jobs.json.
        "description": (raw.get("description") or "")[:5000],
        "watchlisted": 1 if is_watchlisted(company) else 0,
        "term": extract_term(raw["title"], raw.get("term_hint", ""),
                             (raw.get("description") or "")[:600]),
        "posted_at": _norm_posted(raw.get("date_posted")),
        "found_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Scrape one company (thread worker) ────────────────────────────────────────
def scrape_one(company, entry, matcher):
    raws = sources.scrape_registry_company(entry)
    if raws is None:
        return company, None
    jobs = []
    for raw in raws:
        cat = matcher.match(raw["title"], raw["location"], raw["description"])
        if cat:
            jobs.append(build_job(company, raw, entry.get("ats", "?"), cat))
    return company, jobs


# ── Failure / zero-streak tracking ────────────────────────────────────────────
def track_result(entry, success, n_raw_jobs):
    if success:
        entry["consecutive_failures"] = 0
    else:
        entry["consecutive_failures"] = entry.get("consecutive_failures", 0) + 1
    entry["zero_streak"] = 0 if n_raw_jobs else entry.get("zero_streak", 0) + 1


# ── Main run ──────────────────────────────────────────────────────────────────
def run(dry_run=False):
    registry = load_json(REGISTRY_FILE, {"_meta": {}, "companies": {}})
    profile = load_json(PROFILE_FILE, {})
    seen_data = load_json(SEEN_FILE, {"jobs": [], "runs": []})
    matcher = filters.JobMatcher(profile)
    companies = registry.get("companies", {})

    # Self-bootstrap: empty registry means classify.py never ran
    if not companies:
        log.warning("Registry empty — bootstrapping via classify.py (one-time)")
        import classify
        classify.run_classification()
        registry = load_json(REGISTRY_FILE, {"_meta": {}, "companies": {}})
        companies = registry.get("companies", {})

    log.info(f"Monitoring {len(companies)} registry companies "
             f"+ {len(sources.BUILTIN_SOURCES)} built-ins + Simplify feed")

    all_found = []

    # 1. Registry companies, in parallel
    scrapable = {c: e for c, e in companies.items()
                 if e.get("ats") in ("greenhouse", "lever", "ashby",
                                     "smartrecruiters", "workable", "recruitee",
                                     "bamboohr", "workday", "eightfold")}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(scrape_one, c, e, matcher): c
                   for c, e in scrapable.items()}
        for fut in as_completed(futures):
            company, jobs = fut.result()
            track_result(companies[company], jobs is not None, len(jobs or []))
            if jobs:
                log.info(f"  {company}: {len(jobs)} match(es)")
                all_found.extend(jobs)

    # 2. Built-in direct sources
    for name, fn in sources.BUILTIN_SOURCES.items():
        raws = fn()
        if raws is None:
            log.warning(f"  {name} (direct): failed")
            continue
        n = 0
        for raw in raws:
            cat = matcher.match(raw["title"], raw["location"], raw["description"])
            if cat:
                all_found.append(build_job(name, raw, "direct", cat))
                n += 1
        if n:
            log.info(f"  {name} (direct): {n} match(es)")

    # 3. Simplify crowd-sourced feed (widest net — covers everything else)
    simplify = sources.scrape_simplify()
    if simplify:
        n = 0
        for raw in simplify:
            cat = matcher.match(raw["title"], raw["location"], raw["description"])
            if cat:
                # simplify's "description" is just season terms — not a real
                # description; blank it so the tracker enriches from the URL
                all_found.append(build_job(raw.get("company", "?"),
                                           {**raw, "description": "",
                                            "term_hint": raw.get("description", "")},
                                           "simplify", cat))
                n += 1
        log.info(f"  Simplify feed: {n} match(es)")

    # 3b. Additional open job APIs (The Muse, Remotive, USAJOBS, Adzuna — keyed
    #     ones self-skip without env), plus any optional private feeds from an
    #     `extra_sources.py` module (not shipped in the open-source template).
    try:
        import extra_sources
        _private_feeds = tuple(extra_sources.FEEDS)
    except Exception:
        _private_feeds = ()
    for src_name, fn in tuple(sources.EXTRA_FEEDS) + _private_feeds:
        feed = fn()
        if not feed:
            continue
        n = 0
        for raw in feed:
            cat = matcher.match(raw["title"], raw["location"], raw.get("description", ""))
            if cat:
                all_found.append(build_job(raw.get("company", "?"), raw, src_name, cat))
                n += 1
        if n:
            log.info(f"  {src_name}: {n} match(es)")

    # ── Dedupe ────────────────────────────────────────────────────────────────
    seen_ids = {j["id"] for j in seen_data.get("jobs", [])}
    is_baseline = not seen_ids
    new_jobs, run_ids = [], set()
    for job in all_found:
        if job["id"] not in seen_ids and job["id"] not in run_ids:
            run_ids.add(job["id"])
            new_jobs.append(job)

    log.info(f"\nTotal matches: {len(all_found)} | New: {len(new_jobs)}")

    if dry_run:
        for j in sorted(new_jobs, key=lambda x: (x["category"], x["company"].lower())):
            log.info(f"  [{j['category']:12s}] {j['company']}: {j['title']} — {j['location']}")
        log.info("Dry run — no notifications, no state saved.")
        return

    notify_jobs = new_jobs
    if is_baseline and new_jobs:
        # First run ever: everything is "new". Alert only top security roles,
        # mark the rest as seen so future runs alert on genuinely-new postings.
        sec = [j for j in new_jobs if j["category"] == "security"]
        notify_jobs = sec[:BASELINE_NOTIFY_CAP]
        log.info(f"Baseline run: marking {len(new_jobs)} as seen, "
                 f"notifying top {len(notify_jobs)} security roles")

    if notify_jobs:
        # AI scoring (caps itself; fail-open). Security roles get scored first.
        notify_jobs.sort(key=lambda j: 0 if j["category"] == "security" else 1)
        notify_jobs = score_jobs(notify_jobs[:150], profile)

    if notify_jobs:
        for j in notify_jobs:
            log.info(f"  NEW [{j['category']}] {j['company']}: {j['title']}")
        notify.notify(notify_jobs)
        # Also land alerted jobs in the tracker as 'todo' rows (fail-open;
        # no-op unless the TRACKER_* secrets are configured).
        try:
            import tracker_client
            if tracker_client.enabled():
                res = tracker_client.push_jobs(notify_jobs)
                if res:
                    log.info(f"Tracker: {res.get('inserted', 0)}/{res.get('received', 0)} added as todo")
        except Exception as e:
            log.warning(f"Tracker push failed (non-fatal): {e}")
    else:
        log.info("Nothing new to send.")

    # ── Persist state ─────────────────────────────────────────────────────────
    # Descriptions never enter seen_jobs.json — the file would balloon.
    slim = [{k: v for k, v in j.items() if k != "description"} for j in new_jobs]
    seen_data["jobs"] = (seen_data["jobs"] + slim)[-5000:]
    seen_data.setdefault("runs", []).append({
        "ts": datetime.now(timezone.utc).isoformat(),
        "matched": len(all_found), "new": len(new_jobs),
        "notified": len(notify_jobs),
    })
    seen_data["runs"] = seen_data["runs"][-200:]
    seen_data["last_updated"] = datetime.now(timezone.utc).isoformat()
    save_json(SEEN_FILE, seen_data)
    save_json(REGISTRY_FILE, registry)

    # Heartbeat for the tracker's Activity page (fail-open, optional)
    try:
        import tracker_client
        if tracker_client.enabled():
            tracker_client.set_meta("sys_last_monitor", json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(),
                "matched": len(all_found), "new": len(new_jobs),
                "notified": len(notify_jobs),
            }))
    except Exception as e:
        log.warning(f"Heartbeat failed (non-fatal): {e}")
    log.info("State saved. Done.")


def run_sync_tracker():
    """Backfill: push ALL currently-open matches to the tracker (chunked,
    INSERT OR IGNORE server-side → idempotent). For the tracker's cold start —
    jobs the monitor saw before the tracker existed never trigger 'new' pushes."""
    import tracker_client
    if not tracker_client.enabled():
        log.error("TRACKER_* env not set — cannot sync.")
        return
    registry = load_json(REGISTRY_FILE, {"_meta": {}, "companies": {}})
    profile = load_json(PROFILE_FILE, {})
    matcher = filters.JobMatcher(profile)
    companies = registry.get("companies", {})
    all_found = []

    scrapable = {c: e for c, e in companies.items()
                 if e.get("ats") in ("greenhouse", "lever", "ashby",
                                     "smartrecruiters", "workable", "recruitee",
                                     "bamboohr", "workday", "eightfold")}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(scrape_one, c, e, matcher): c
                   for c, e in scrapable.items()}
        for fut in as_completed(futures):
            _, jobs = fut.result()
            if jobs:
                all_found.extend(jobs)
    for name, fn in sources.BUILTIN_SOURCES.items():
        for raw in (fn() or []):
            cat = matcher.match(raw["title"], raw["location"], raw["description"])
            if cat:
                all_found.append(build_job(name, raw, "direct", cat))
    for raw in (sources.scrape_simplify() or []):
        cat = matcher.match(raw["title"], raw["location"], raw["description"])
        if cat:
            all_found.append(build_job(raw.get("company", "?"),
                                       {**raw, "description": "",
                                        "term_hint": raw.get("description", "")},
                                       "simplify", cat))

    # de-dupe within the run, then push in chunks (each chunk gets its own
    # background-match window server-side)
    seen_ids, unique = set(), []
    for j in all_found:
        if j["id"] not in seen_ids:
            seen_ids.add(j["id"])
            unique.append(j)
    log.info(f"Sync: {len(unique)} open match(es) → tracker")
    total_inserted = 0
    for i in range(0, len(unique), 40):
        chunk = unique[i:i + 40]
        res = tracker_client.push_jobs(chunk)
        if res:
            total_inserted += res.get("inserted", 0)
            log.info(f"  chunk {i//40 + 1}: {res.get('inserted', 0)}/{len(chunk)} new")
        time.sleep(2)  # let the worker's background matching breathe
    log.info(f"Sync done: {total_inserted} job(s) added to tracker. "
             "Run rematch-all later batches via the digest/profile-sync if needed.")


# ── Health report ─────────────────────────────────────────────────────────────
def run_health():
    registry = load_json(REGISTRY_FILE, {"companies": {}})
    seen = load_json(SEEN_FILE, {"jobs": [], "runs": []})
    companies = registry.get("companies", {})
    from collections import Counter
    ats_counts = Counter(e.get("ats", "?") for e in companies.values())
    runs = seen.get("runs", [])[-56:]  # ~1 week hourly... last 56 runs
    failing = sorted(
        ((c, e.get("consecutive_failures", 0)) for c, e in companies.items()
         if e.get("consecutive_failures", 0) >= 3),
        key=lambda x: -x[1])
    stats = {
        "summary": {
            "Companies in registry": len(companies),
            **{f"· on {k}": v for k, v in sorted(ats_counts.items())},
            "Jobs in seen history": len(seen.get("jobs", [])),
            "Runs recorded (last 200)": len(seen.get("runs", [])),
            "Matches, last ~week": sum(r["matched"] for r in runs),
            "New jobs, last ~week": sum(r["new"] for r in runs),
            "Companies failing (3+)": len(failing),
        },
        "failing": failing,
    }
    for k, v in stats["summary"].items():
        log.info(f"  {k}: {v}")
    notify.send_health_report(stats)


# ── Test mode ─────────────────────────────────────────────────────────────────
def run_filter_check() -> bool:
    """Filter self-check with canned titles. Pure — no network, no secrets.
    Used by --test (with fake notifications after) and --check (CI gate)."""
    bad = [
        ("Senior Software Engineer, Fullstack", "Remote Poland"),
        ("Software Engineer - Database Engine Internals", "Belgrade, Serbia"),
        ("Software Engineer (Internal Query Engine Testing Tools)", "Dublin, Ireland"),
        ("Detection Engineer- SkillBridge Intern", "Remote - USA"),
        ("Machine Learning PhD Intern", "Seattle, WA"),
        ("Security Engineer Intern", "Bengaluru, India"),
        ("Security Intern (Summer 2025)", "Austin, TX"),
    ]
    good = [
        ("Security Engineer Intern", "Austin, TX"),
        ("Security Researcher Intern", "Remote, USA"),          # old code blocked this!
        ("IAM Engineering Intern", "Milwaukee, WI"),            # and this ('uk' bug)!
        ("Cloud Infrastructure Intern", "San Antonio, TX"),
        ("Site Reliability Engineer Intern - Summer 2027", "Remote"),
    ]
    profile = load_json(PROFILE_FILE, {})
    m = filters.JobMatcher(profile)
    ok = True
    for title, loc in bad:
        if m.match(title, loc) not in (None, "other_swe"):
            log.error(f"  SHOULD BLOCK: {title} ({loc})")
            ok = False
        else:
            log.info(f"  blocked: {title}")
    for title, loc in good:
        if m.match(title, loc) in (None,):
            log.error(f"  SHOULD PASS: {title} ({loc})")
            ok = False
        else:
            log.info(f"  passes:  {title} → {m.match(title, loc)}")
    log.info("All filter checks passed" if ok else "FILTER BUGS — see above")
    return ok


def run_test():
    log.info("TEST MODE — filter self-check + real notification with fake data")
    run_filter_check()
    fake = [
        build_job("CrowdStrike", {"title": "Security Engineer Intern",
                                  "location": "Austin, TX", "url": "https://example.com/1",
                                  "description": ""}, "workday", "security"),
        build_job("Wiz", {"title": "IAM Engineer Intern", "location": "Remote, USA",
                          "url": "https://example.com/2", "description": ""},
                  "lever", "security"),
        build_job("Cloudflare", {"title": "Infrastructure Engineer Intern",
                                 "location": "Austin, TX", "url": "https://example.com/3",
                                 "description": ""}, "greenhouse", "relevant_swe"),
    ]
    fake[0]["ai_score"], fake[0]["ai_reason"] = 9, "exact security fit"
    fake[1]["ai_score"], fake[1]["ai_reason"] = 8, "IAM matches profile"
    fake[2]["ai_score"], fake[2]["ai_reason"] = 7, "infra, relevant"
    notify.send_discord(fake)
    notify.send_email(fake, subject="[TEST] Job Monitor — fake data, links go to example.com",
                      html=notify.build_email_html(fake, title="[TEST] Fake data — not real postings"))
    log.info("Test complete. Check inbox/Discord.")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--test", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--health", action="store_true")
    p.add_argument("--check", action="store_true",
                   help="filter self-check only (no network/secrets); nonzero exit on failure — CI gate")
    p.add_argument("--sync-tracker", action="store_true",
                   help="backfill ALL currently-open matches into the tracker (idempotent)")
    args = p.parse_args()
    if args.sync_tracker:
        run_sync_tracker()
        sys.exit(0)
    if args.check:
        sys.exit(0 if run_filter_check() else 1)
    elif args.test:
        run_test()
    elif args.health:
        run_health()
    else:
        run(dry_run=args.dry_run)
