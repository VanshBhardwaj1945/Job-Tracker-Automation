#!/usr/bin/env python3
"""
classify.py — Company → ATS routing builder.

For each company in data/companies_master.json:
  1. Probe public APIs directly: Greenhouse → Lever → Ashby → SmartRecruiters
     → Workday (curated seeds, then wd1/wd2/wd3/wd5/wd12 candidate grid).
  2. Companies with hardcoded direct portals (Eightfold etc.) are routed there.
  3. Big-tech with no public ATS (Google/Amazon/Microsoft/Netflix) are built
     into scraper.py; Meta/Apple/anything unprobeable is covered by the
     Simplify feed, so 'unknown' is not a hole anymore — just a slower path.
  4. Whatever's left goes to Claude in batches; Workday guesses from Claude
     are verified by probing before being trusted.

Re-runs only touch new companies and ones with 3+ consecutive scrape failures.

Usage:
  python classify.py                    # incremental
  python classify.py --force            # everything from scratch
  python classify.py --company "Wiz"    # one company
"""

import argparse
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from sources import SESSION, WD_DOMAINS

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR.parent / "data"  # data/ lives at repo root
MASTER_FILE = DATA_DIR / "companies_master.json"
REGISTRY_FILE = DATA_DIR / "company_registry.json"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = "claude-haiku-4-5-20251001"

# ── Curated Workday seeds (tenant, wd domain, board) ─────────────────────────
# Only entries with real public Workday boards. The old list contained
# hallucinated tenants (Meta/Amazon/Apple/Netflix/Microsoft don't use Workday).
WORKDAY_SEEDS = {
    "crowdstrike":        ("crowdstrike", "wd5", "crowdstrikecareers"),
    "nvidia":             ("nvidia", "wd5", "NVIDIAExternalCareerSite"),
    "palo alto networks": ("paloaltonetworks", "wd1", "PaloAltoNetworks"),
    "salesforce":         ("salesforce", "wd12", "External_Career_Site"),
    "workday":            ("workday", "wd5", "Workday"),
    "intel":              ("intel", "wd1", "External"),
    "qualcomm":           ("qualcomm", "wd5", "External"),
    "adobe":              ("adobe", "wd5", "external_experienced"),
    "visa":               ("visa", "wd1", "Jobs_at_Visa"),
    "mastercard":         ("mastercard", "wd1", "CorporateCareers"),
    "intuit":             ("intuit", "wd1", "Intuit"),
    "paypal":             ("paypal", "wd1", "jobs"),
    "capital one":        ("capitalone", "wd12", "Capital_One"),
    "gm":                 ("generalmotors", "wd5", "Careers_GM"),
    "northrop grumman":   ("ngc", "wd1", "Northrop_Grumman_External_Site"),
    "broadcom":           ("broadcom", "wd1", "External_Career"),
    "medtronic":          ("medtronic", "wd1", "MedtronicCareers"),
    "honeywell":          ("honeywell", "wd5", "External"),
}

# ── Companies handled directly inside scraper.py (no registry routing) ───────
BUILTIN_COMPANIES = {"google", "amazon", "microsoft", "netflix"}
# Covered only by the Simplify feed (no scrapeable public API)
SIMPLIFY_ONLY = {"meta", "apple"}

# ── Eightfold direct portals (api/apply/v2/jobs) ─────────────────────────────
EIGHTFOLD_PORTALS = {
    "Booz Allen Hamilton": ("https://careers.boozallen.com", "boozallen.com"),
    "MITRE Corporation":   ("https://careers.mitre.org", "mitre.org"),
    "Peraton":             ("https://careers.peraton.com", "peraton.com"),
    "ManTech":             ("https://careers.mantech.com", "mantech.com"),
    "Raytheon":            ("https://careers.rtx.com", "rtx.com"),
    "SAIC":                ("https://jobs.saic.com", "saic.com"),
    "Southwest Research Institute": ("https://swri.jobs", "swri.org"),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def entry(ats, **kw):
    return {"ats": ats, "verified": kw.pop("verified", True),
            "probe_method": kw.pop("probe_method", "api_probe"),
            "last_checked": now(), "consecutive_failures": 0,
            "zero_streak": 0, **kw}


# ── Slug candidates ───────────────────────────────────────────────────────────
def name_variants(name: str) -> list:
    base = name.lower().replace("&", "and")
    return list(dict.fromkeys([
        re.sub(r"[^a-z0-9]", "", base),                       # cloudflare
        re.sub(r"-+", "-", re.sub(r"[^a-z0-9-]", "", base.replace(" ", "-"))).strip("-"),
        base.split()[0] if " " in base else None,             # first word
        name.replace(" ", ""),                                # CamelCase-ish
    ]))


# ── Probes ────────────────────────────────────────────────────────────────────
def probe_greenhouse(name):
    for slug in filter(None, name_variants(name)):
        try:
            r = SESSION.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
                            timeout=8)
            if r.status_code == 200 and "jobs" in r.json():
                return slug
        except Exception:
            pass
    return None


def probe_lever(name):
    for slug in filter(None, name_variants(name)):
        try:
            r = SESSION.get(f"https://api.lever.co/v0/postings/{slug}?mode=json",
                            timeout=8)
            if r.status_code == 200 and isinstance(r.json(), list):
                return slug
        except Exception:
            pass
    return None


def probe_ashby(name):
    for slug in filter(None, name_variants(name)):
        try:
            r = SESSION.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}",
                            timeout=8)
            if r.status_code == 200 and "jobs" in r.json():
                return slug
        except Exception:
            pass
    return None


def probe_smartrecruiters(name):
    for slug in filter(None, name_variants(name)):
        try:
            r = SESSION.get(f"https://api.smartrecruiters.com/v1/companies/{slug}"
                            f"/postings?limit=1", timeout=8)
            if r.status_code == 200 and "content" in r.json():
                return slug
        except Exception:
            pass
    return None


def probe_workable(name):
    for slug in filter(None, name_variants(name)):
        try:
            r = SESSION.get(f"https://apply.workable.com/api/v1/widget/accounts/{slug}",
                            timeout=8)
            if r.status_code == 200 and "jobs" in r.json():
                return slug
        except Exception:
            pass
    return None


def probe_recruitee(name):
    for slug in filter(None, name_variants(name)):
        try:
            r = SESSION.get(f"https://{slug}.recruitee.com/api/offers/", timeout=8)
            if r.status_code == 200 and "offers" in r.json():
                return slug
        except Exception:
            pass
    return None


def probe_bamboohr(name):
    for slug in filter(None, name_variants(name)):
        try:
            r = SESSION.get(f"https://{slug}.bamboohr.com/careers/list", timeout=8)
            if r.status_code == 200 and "result" in r.json():
                return slug
        except Exception:
            pass
    return None


def probe_workday_exact(tenant, wd, board):
    url = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs"
    try:
        r = SESSION.post(url, json={"appliedFacets": {}, "limit": 1, "offset": 0,
                                    "searchText": "intern"}, timeout=10)
        return r.status_code == 200 and "jobPostings" in r.text
    except Exception:
        return False


def probe_workday(name, tenant_hint=None, board_hint=None):
    """Seeds first; else grid-search wd domains × board candidates."""
    key = name.lower()
    if key in WORKDAY_SEEDS:
        tenant, wd, board = WORKDAY_SEEDS[key]
        if probe_workday_exact(tenant, wd, board):
            return tenant, wd, board
        # seed stale — fall through to grid search on that tenant
        tenant_hint = tenant_hint or tenant
        board_hint = board_hint or board
    tenants = [t for t in [tenant_hint,
                           re.sub(r"[^a-z0-9]", "", key)] if t]
    boards = [b for b in [board_hint, "External", "careers", "Careers",
                          "External_Career_Site", "jobs"] if b]
    for tenant in dict.fromkeys(tenants):
        for wd in WD_DOMAINS:
            for board in dict.fromkeys(boards):
                if probe_workday_exact(tenant, wd, board):
                    return tenant, wd, board
                time.sleep(0.1)
    return None


# ── Claude fallback ───────────────────────────────────────────────────────────
def classify_with_claude(companies):
    if not ANTHROPIC_API_KEY:
        log.warning("No ANTHROPIC_API_KEY — leaving unprobeable companies 'unknown' "
                    "(still covered by the Simplify feed)")
        return {c: {"ats": "unknown"} for c in companies}

    results = {}
    for i in range(0, len(companies), 20):
        batch = companies[i:i + 20]
        prompt = f"""For each company, identify its job-posting ATS platform.

Companies: {json.dumps(batch)}

Return ONLY a JSON object:
{{"CompanyName": {{"ats": "...", "confidence": "high|medium|low",
  "tenant": "workday tenant if ats=workday", "board": "workday board if known"}}}}

ats options: greenhouse | lever | ashby | smartrecruiters | workday | eightfold
| icims | taleo | oracle | phenom | custom | unknown.
No markdown, no explanation."""
        try:
            r = SESSION.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": ANTHROPIC_API_KEY,
                         "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": CLAUDE_MODEL, "max_tokens": 2000,
                      "messages": [{"role": "user", "content": prompt}]},
                timeout=45)
            if r.status_code == 200:
                text = re.sub(r"```(?:json)?", "",
                              r.json()["content"][0]["text"]).strip()
                results.update(json.loads(text))
            else:
                log.warning(f"Claude API {r.status_code}: {r.text[:150]}")
                results.update({c: {"ats": "unknown"} for c in batch})
        except Exception as e:
            log.warning(f"Claude classification failed: {e}")
            results.update({c: {"ats": "unknown"} for c in batch})
        time.sleep(1)
    return results


# ── Per-company classification ────────────────────────────────────────────────
def classify_company(company):
    key = company.lower()
    if key in BUILTIN_COMPANIES:
        return entry("builtin", probe_method="hardcoded")
    if key in SIMPLIFY_ONLY:
        return entry("simplify_only", probe_method="hardcoded")
    if company in EIGHTFOLD_PORTALS:
        api_base, domain = EIGHTFOLD_PORTALS[company]
        return entry("eightfold", api_base=api_base, domain=domain,
                     probe_method="hardcoded")

    slug = probe_greenhouse(company)
    if slug:
        return entry("greenhouse", slug=slug)
    slug = probe_lever(company)
    if slug:
        return entry("lever", slug=slug)
    slug = probe_ashby(company)
    if slug:
        return entry("ashby", slug=slug)
    slug = probe_smartrecruiters(company)
    if slug:
        return entry("smartrecruiters", slug=slug)
    slug = probe_workable(company)
    if slug:
        return entry("workable", slug=slug)
    slug = probe_recruitee(company)
    if slug:
        return entry("recruitee", slug=slug)
    slug = probe_bamboohr(company)
    if slug:
        return entry("bamboohr", slug=slug)
    wd = probe_workday(company)
    if wd:
        tenant, wdn, board = wd
        return entry("workday", tenant=tenant, wd=wdn, board=board)
    return None  # → Claude


def run_classification(force=False, single_company=None):
    registry = {"_meta": {}, "companies": {}}
    if REGISTRY_FILE.exists() and not force:
        registry = json.loads(REGISTRY_FILE.read_text())
        registry.setdefault("_meta", {})
        registry.setdefault("companies", {})
    master = json.loads(MASTER_FILE.read_text())

    if single_company:
        todo = [single_company]
    elif force:
        todo = master
    else:
        existing = registry["companies"]
        todo = [c for c in master
                if c not in existing
                or existing[c].get("consecutive_failures", 0) >= 3]

    if not todo:
        log.info("Registry up to date.")
        return

    log.info(f"Classifying {len(todo)} companies…")
    needs_claude = []
    for company in todo:
        result = classify_company(company)
        if result:
            registry["companies"][company] = result
            log.info(f"  ✓ {company} → {result['ats']}")
        else:
            needs_claude.append(company)
        time.sleep(0.15)

    if needs_claude:
        log.info(f"{len(needs_claude)} companies → Claude fallback")
        for company, data in classify_with_claude(needs_claude).items():
            ats = data.get("ats", "unknown")
            if ats == "workday":
                wd = probe_workday(company, data.get("tenant"), data.get("board"))
                if wd:
                    tenant, wdn, board = wd
                    registry["companies"][company] = entry(
                        "workday", tenant=tenant, wd=wdn, board=board,
                        probe_method="claude+probe")
                    log.info(f"  ✓ {company} → workday (claude, verified)")
                    continue
                ats = "unknown"  # Claude's workday guess didn't verify
            registry["companies"][company] = entry(
                ats if ats in ("greenhouse", "lever", "ashby", "smartrecruiters",
                               "workable", "recruitee", "bamboohr",
                               "eightfold") else "unknown",
                verified=False, probe_method="claude_api")
            log.info(f"  · {company} → {ats} (claude, unverified)")

    registry["_meta"]["last_classified"] = now()
    registry["_meta"]["total_companies"] = len(registry["companies"])
    REGISTRY_FILE.write_text(json.dumps(registry, indent=2))

    from collections import Counter
    counts = Counter(v["ats"] for v in registry["companies"].values())
    log.info("── Summary ──")
    for ats, n in counts.most_common():
        log.info(f"  {ats:16s} {n}")
    log.info("'unknown' companies are still covered by the Simplify feed.")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--force", action="store_true")
    p.add_argument("--company", type=str)
    args = p.parse_args()
    run_classification(force=args.force, single_company=args.company)
