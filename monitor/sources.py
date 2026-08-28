#!/usr/bin/env python3
"""
sources.py — every place we pull jobs from.

ATS scrapers (routed via company_registry.json):
  greenhouse, lever, ashby, smartrecruiters, workday, eightfold

Built-in direct scrapers (companies with no public ATS API):
  Google, Amazon, Microsoft, Netflix — plus the Simplify crowd-sourced feed,
  which covers Meta / Apple / everyone else the registry misses.

Contract: every scraper returns list[dict] of raw postings
  {title, location, url, description}  — or None on hard failure
so the caller can track consecutive failures per company.
"""

import html
import json
import logging
import os
import re
import time

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger(__name__)

WD_DOMAINS = ["wd1", "wd2", "wd3", "wd5", "wd12"]


def make_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(total=2, backoff_factor=1.0,
                  status_forcelist=[429, 500, 502, 503, 504])
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update({
        "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "Accept": "application/json",
    })
    return s


SESSION = make_session()


def _raw(title, location, url, description=""):
    return {"title": title or "", "location": location or "Unknown",
            "url": url or "", "description": description or ""}


# ── Greenhouse ────────────────────────────────────────────────────────────────
def scrape_greenhouse(slug: str):
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    try:
        r = SESSION.get(url, timeout=15)
        if r.status_code != 200:
            return None
        return [
            _raw(j.get("title"), (j.get("location") or {}).get("name"),
                 j.get("absolute_url"), j.get("content", ""))
            for j in r.json().get("jobs", [])
        ]
    except Exception as e:
        log.warning(f"greenhouse/{slug}: {e}")
        return None


# ── Lever ─────────────────────────────────────────────────────────────────────
def scrape_lever(slug: str):
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        r = SESSION.get(url, timeout=15)
        if r.status_code != 200:
            return None
        return [
            _raw(j.get("text"), (j.get("categories") or {}).get("location"),
                 j.get("hostedUrl"), j.get("descriptionPlain", ""))
            for j in r.json()
        ]
    except Exception as e:
        log.warning(f"lever/{slug}: {e}")
        return None


# ── Ashby ─────────────────────────────────────────────────────────────────────
def scrape_ashby(slug: str):
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false"
    try:
        r = SESSION.get(url, timeout=15)
        if r.status_code != 200:
            return None
        return [
            _raw(j.get("title"), j.get("location"),
                 j.get("jobUrl") or j.get("applyUrl"),
                 j.get("descriptionPlain", ""))
            for j in r.json().get("jobs", [])
        ]
    except Exception as e:
        log.warning(f"ashby/{slug}: {e}")
        return None


# ── SmartRecruiters ───────────────────────────────────────────────────────────
def scrape_smartrecruiters(company_id: str):
    jobs, offset = [], 0
    try:
        while offset <= 300:
            url = (f"https://api.smartrecruiters.com/v1/companies/{company_id}"
                   f"/postings?limit=100&offset={offset}")
            r = SESSION.get(url, timeout=15)
            if r.status_code != 200:
                return None if offset == 0 else jobs
            data = r.json()
            content = data.get("content", [])
            for j in content:
                loc = j.get("location", {}) or {}
                loc_str = ", ".join(x for x in [loc.get("city"), loc.get("region"),
                                                loc.get("country", "").upper()] if x)
                ref = j.get("ref", "") or ""
                web = f"https://jobs.smartrecruiters.com/{company_id}/{j.get('id')}"
                jobs.append(_raw(j.get("name"), loc_str, web or ref))
            if len(content) < 100:
                break
            offset += 100
        return jobs
    except Exception as e:
        log.warning(f"smartrecruiters/{company_id}: {e}")
        return None


# ── Workable ──────────────────────────────────────────────────────────────────
def scrape_workable(slug: str):
    url = f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true"
    try:
        r = SESSION.get(url, timeout=15)
        if r.status_code != 200:
            return None
        jobs = []
        for j in r.json().get("jobs", []):
            loc = ", ".join(x for x in [j.get("city"), j.get("state"),
                                        j.get("country")] if x)
            jobs.append(_raw(j.get("title"), loc,
                             j.get("url") or f"https://apply.workable.com/{slug}/j/{j.get('shortcode', '')}",
                             re.sub(r"<[^>]+>", " ", j.get("description") or "")))
        return jobs
    except Exception as e:
        log.warning(f"workable/{slug}: {e}")
        return None


# ── Recruitee ─────────────────────────────────────────────────────────────────
def scrape_recruitee(slug: str):
    url = f"https://{slug}.recruitee.com/api/offers/"
    try:
        r = SESSION.get(url, timeout=15)
        if r.status_code != 200:
            return None
        return [
            _raw(j.get("title"), j.get("location"),
                 j.get("careers_url"),
                 re.sub(r"<[^>]+>", " ", j.get("description") or ""))
            for j in r.json().get("offers", [])
        ]
    except Exception as e:
        log.warning(f"recruitee/{slug}: {e}")
        return None


# ── BambooHR ──────────────────────────────────────────────────────────────────
def scrape_bamboohr(slug: str):
    url = f"https://{slug}.bamboohr.com/careers/list"
    try:
        r = SESSION.get(url, timeout=15)
        if r.status_code != 200:
            return None
        jobs = []
        for j in r.json().get("result", []):
            loc = j.get("location") or {}
            loc_str = ", ".join(x for x in [loc.get("city"), loc.get("state")] if x)
            jobs.append(_raw(j.get("jobOpeningName"), loc_str,
                             f"https://{slug}.bamboohr.com/careers/{j.get('id')}"))
        return jobs
    except Exception as e:
        log.warning(f"bamboohr/{slug}: {e}")
        return None


# ── Workday (CXS API, paginated 'intern' search) ─────────────────────────────
def scrape_workday(tenant: str, wd: str, board: str):
    if not (tenant and wd and board):
        return None
    base = f"https://{tenant}.{wd}.myworkdayjobs.com"
    api = f"{base}/wday/cxs/{tenant}/{board}/jobs"
    jobs, offset = [], 0
    try:
        while offset < 100:  # up to 100 intern postings per company
            r = SESSION.post(api, json={"appliedFacets": {}, "limit": 20,
                                        "offset": offset, "searchText": "intern"},
                             timeout=15)
            if r.status_code != 200:
                return None if offset == 0 else jobs
            data = r.json()
            postings = data.get("jobPostings", [])
            for j in postings:
                path = j.get("externalPath", "")
                jobs.append(_raw(j.get("title"), j.get("locationsText"),
                                 f"{base}/en-US/{board}/job{path}"))
            total = data.get("total", 0)
            offset += 20
            if offset >= total or not postings:
                break
            time.sleep(0.4)
        return jobs
    except Exception as e:
        log.warning(f"workday/{tenant}.{wd}/{board}: {e}")
        return None


# ── Eightfold ('api/apply/v2/jobs' portals: Netflix, Booz Allen, MITRE, …) ───
def scrape_eightfold(api_base: str, domain: str, queries=("intern",)):
    """api_base e.g. 'https://explore.jobs.netflix.net' or 'https://careers.boozallen.com'"""
    jobs, seen = [], set()
    try:
        for q in queries:
            url = (f"{api_base}/api/apply/v2/jobs?domain={domain}"
                   f"&query={requests.utils.quote(q)}&num=50&start=0")
            r = SESSION.get(url, timeout=15)
            if r.status_code != 200:
                continue
            for j in r.json().get("positions", []):
                key = j.get("canonicalPositionUrl") or j.get("id")
                if key in seen:
                    continue
                seen.add(key)
                jobs.append(_raw(j.get("name"),
                                 j.get("location") or ", ".join(j.get("locations", [])),
                                 j.get("canonicalPositionUrl"),
                                 j.get("job_description", "")))
            time.sleep(0.3)
        return jobs
    except Exception as e:
        log.warning(f"eightfold/{domain}: {e}")
        return None


# ── Direct: Amazon ────────────────────────────────────────────────────────────
def scrape_amazon():
    jobs, seen = [], set()
    try:
        for q in ("security intern", "software intern"):
            url = (f"https://www.amazon.jobs/en/search.json"
                   f"?base_query={requests.utils.quote(q)}&result_limit=100&country[]=USA")
            r = SESSION.get(url, timeout=20)
            if r.status_code != 200:
                continue
            for j in r.json().get("jobs", []):
                path = j.get("job_path", "")
                if path in seen:
                    continue
                seen.add(path)
                if j.get("country_code") not in (None, "", "USA", "US"):
                    continue
                jobs.append(_raw(j.get("title"), j.get("normalized_location") or j.get("location"),
                                 f"https://www.amazon.jobs{path}",
                                 j.get("description_short", "")))
        return jobs
    except Exception as e:
        log.warning(f"amazon: {e}")
        return None


# ── Direct: Microsoft ─────────────────────────────────────────────────────────
def scrape_microsoft():
    jobs = []
    try:
        for q in ("security intern", "software engineer intern"):
            url = (f"https://gcsservices.careers.microsoft.com/search/api/v1/search"
                   f"?q={requests.utils.quote(q)}&l=en_us&pg=1&pgSz=20&flt=true")
            r = SESSION.get(url, timeout=20)
            if r.status_code != 200:
                continue
            result = (r.json().get("operationResult") or {}).get("result") or {}
            for j in result.get("jobs", []):
                jid = j.get("jobId")
                props = j.get("properties") or {}
                locs = props.get("locations") or []
                jobs.append(_raw(j.get("title"), "; ".join(locs[:3]),
                                 f"https://jobs.careers.microsoft.com/global/en/job/{jid}",
                                 props.get("description", "")))
        return jobs
    except Exception as e:
        log.warning(f"microsoft: {e}")
        return None


# ── Direct: Google ────────────────────────────────────────────────────────────
def scrape_google():
    """Google's careers API is undocumented and moves around; the Simplify feed
    is the reliable backstop for Google postings. Fail soft."""
    jobs = []
    try:
        url = ("https://careers.google.com/api/v3/search/"
               "?q=security%20intern&page_size=50")
        r = SESSION.get(url, timeout=20)
        if r.status_code != 200:
            return None
        for j in r.json().get("jobs", []):
            name = j.get("name", "")  # e.g. jobs/results/1234-title
            job_id = name.split("/")[-1] if name else ""
            locs = "; ".join(l.get("display", "") for l in (j.get("locations") or [])[:3])
            jobs.append(_raw(j.get("title"), locs,
                             f"https://careers.google.com/jobs/results/{job_id}",
                             (j.get("description") or "")[:3000]))
        return jobs
    except Exception as e:
        log.warning(f"google: {e}")
        return None


# ── Simplify crowd-sourced feed (SimplifyJobs/Summer20XX-Internships) ─────────
def scrape_simplify(seasons=("2027", "2026")):
    """Community GitHub internship lists — the single widest net we have.
    Covers Meta, Apple, and every company not in our registry. Two repos share
    the same listings.json schema: SimplifyJobs (Pitt CSC, the big one) and
    vanshb03 (CSCareers community — different contributors, postings sometimes
    land there first). Merged and deduped by URL."""
    repos = ("SimplifyJobs", "vanshb03")
    for season in seasons:
        jobs, seen_urls = [], set()
        for owner in repos:
            url = (f"https://raw.githubusercontent.com/{owner}/"
                   f"Summer{season}-Internships/dev/.github/scripts/listings.json")
            try:
                r = SESSION.get(url, timeout=30)
                if r.status_code != 200:
                    continue
                added = 0
                for j in r.json():
                    if not j.get("active", True):
                        continue
                    if j.get("is_visible") is False:
                        continue
                    u = j.get("url", "")
                    key = u.split("?")[0].rstrip("/").lower()
                    if not u or key in seen_urls:
                        continue
                    seen_urls.add(key)
                    jobs.append({
                        "title": j.get("title", ""),
                        "location": "; ".join(j.get("locations", [])[:3]),
                        "url": u,
                        "description": " ".join(j.get("terms", []) or ([j["season"]] if j.get("season") else [])),
                        "company": j.get("company_name", ""),
                        "date_posted": j.get("date_posted"),
                    })
                    added += 1
                log.info(f"simplify: {owner}/Summer{season} → {added} active listing(s)")
            except Exception as e:
                log.warning(f"simplify {owner}/Summer{season}: {e}")
        if jobs:
            return jobs
    return None


# ── Simplify curated top-lists (simplify.jobs/top-list/<slug>) ────────────────
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)


def scrape_simplify_toplists():
    """Simplify's curated top-list pages (e.g. FAANG-Software-Internships).

    The pages are server-rendered Next.js — __NEXT_DATA__ embeds every job hit
    with real requirements text, salary range, H1B sponsorship, and an `active`
    flag. One GET per slug, no key, no JS rendering. Slugs configurable via
    SIMPLIFY_TOPLISTS (comma-separated)."""
    slugs = [s.strip() for s in
             os.environ.get("SIMPLIFY_TOPLISTS", "FAANG-Software-Internships").split(",")
             if s.strip()]
    jobs = []
    for slug in slugs:
        try:
            r = SESSION.get(f"https://simplify.jobs/top-list/{slug}", timeout=30)
            if r.status_code != 200:
                log.warning(f"simplify_toplist/{slug}: HTTP {r.status_code}")
                continue
            m = _NEXT_DATA_RE.search(r.text)
            if not m:
                log.warning(f"simplify_toplist/{slug}: no __NEXT_DATA__ found")
                continue
            hits = (json.loads(m.group(1)).get("props", {})
                    .get("pageProps", {}).get("initialJobHits", []))
            n = 0
            for h in hits:
                if not h.get("active") or h.get("visible") is False:
                    continue
                company = ((h.get("job") or {}).get("company") or {}).get("name", "")
                if not company:
                    continue
                # Context line so the AI matcher sees comp/visa signal upfront.
                bits = []
                lo, hi, per = h.get("min_salary"), h.get("max_salary"), h.get("salary_period")
                if lo or hi:
                    unit = "/hr" if per == 1 else "/yr"
                    bits.append(f"Pay: ${lo or '?'}-${hi or '?'}{unit}")
                h1b = h.get("sponsors_h1b")
                if h1b is not None:
                    bits.append(f"Sponsors H1B: {'yes' if h1b else 'no'}")
                body = " ".join(
                    x for part in (h.get("requirements"), h.get("responsibilities"))
                    if part for x in (part if isinstance(part, list) else [str(part)]))
                desc = (" · ".join(bits) + "\n" if bits else "") + body
                jobs.append({
                    "title": h.get("title", ""),
                    "location": "; ".join(
                        l.get("value", "") for l in (h.get("locations") or [])[:3]),
                    "url": h.get("url", ""),
                    "description": desc[:5000],
                    "company": company,
                    "date_posted": h.get("start_date") or h.get("updated_date"),
                })
                n += 1
            log.info(f"simplify_toplist/{slug}: {n} active listing(s)")
        except Exception as e:
            log.warning(f"simplify_toplist/{slug}: {e}")
    return jobs or None


# ── Extra open job APIs (aggregators / boards beyond ATS + Simplify) ─────────
# All fail-soft. The keyed ones no-op cleanly when their env vars are absent.

def scrape_themuse(pages: int = 3):
    """The Muse public API — internship-level roles at known companies. No key."""
    jobs = []
    try:
        for page in range(pages):
            r = SESSION.get("https://www.themuse.com/api/public/jobs",
                            params={"level": "Internship", "page": page, "descending": "true"},
                            timeout=20)
            if r.status_code != 200:
                break
            results = r.json().get("results", [])
            if not results:
                break
            for j in results:
                locs = "; ".join(l.get("name", "") for l in (j.get("locations") or [])[:3])
                jobs.append({
                    "title": j.get("name", ""),
                    "location": locs or "Unknown",
                    "url": (j.get("refs") or {}).get("landing_page", ""),
                    "description": re.sub(r"<[^>]+>", " ", j.get("contents") or "")[:2000],
                    "company": (j.get("company") or {}).get("name", ""),
                })
        log.info(f"themuse: {len(jobs)} internship listing(s)")
        return jobs
    except Exception as e:
        log.warning(f"themuse: {e}")
        return None


def scrape_remotive():
    """Remotive — remote software/security roles (some internships). No key."""
    try:
        r = SESSION.get("https://remotive.com/api/remote-jobs",
                        params={"category": "software-dev", "limit": 100}, timeout=20)
        if r.status_code != 200:
            return None
        jobs = []
        for j in r.json().get("jobs", []):
            jobs.append({
                "title": j.get("title", ""),
                "location": j.get("candidate_required_location", "Remote") or "Remote",
                "url": j.get("url", ""),
                "description": re.sub(r"<[^>]+>", " ", j.get("description") or "")[:2000],
                "company": j.get("company_name", ""),
            })
        log.info(f"remotive: {len(jobs)} remote role(s)")
        return jobs
    except Exception as e:
        log.warning(f"remotive: {e}")
        return None


def scrape_usajobs(keywords=("cybersecurity", "security engineer", "software")):
    """USAJOBS — federal internships / student roles. Free key:
    set USAJOBS_API_KEY + USAJOBS_EMAIL (https://developer.usajobs.gov/apirequest/)."""
    key, email = os.environ.get("USAJOBS_API_KEY"), os.environ.get("USAJOBS_EMAIL")
    if not (key and email):
        return None
    jobs = []
    try:
        for kw in keywords:
            r = SESSION.get(
                "https://data.usajobs.gov/api/search",
                headers={"Host": "data.usajobs.gov", "User-Agent": email, "Authorization-Key": key},
                params={"Keyword": kw, "HiringPath": "student", "ResultsPerPage": 50}, timeout=25)
            if r.status_code != 200:
                continue
            for it in r.json().get("SearchResult", {}).get("SearchResultItems", []):
                d = it.get("MatchedObjectDescriptor", {})
                details = (d.get("UserArea", {}).get("Details", {}) or {})
                jobs.append({
                    "title": d.get("PositionTitle", ""),
                    "location": d.get("PositionLocationDisplay", "United States") or "United States",
                    "url": d.get("PositionURI", ""),
                    "description": (details.get("JobSummary") or d.get("QualificationSummary") or "")[:2000],
                    "company": d.get("OrganizationName") or d.get("DepartmentName") or "US Government",
                })
        log.info(f"usajobs: {len(jobs)} federal listing(s)")
        return jobs
    except Exception as e:
        log.warning(f"usajobs: {e}")
        return None


def scrape_adzuna(pages: int = 2, what: str = "intern"):
    """Adzuna aggregator — broad US coverage (closest open thing to Indeed). Free key:
    set ADZUNA_APP_ID + ADZUNA_APP_KEY (https://developer.adzuna.com/)."""
    aid, akey = os.environ.get("ADZUNA_APP_ID"), os.environ.get("ADZUNA_APP_KEY")
    if not (aid and akey):
        return None
    jobs = []
    try:
        for page in range(1, pages + 1):
            r = SESSION.get(
                f"https://api.adzuna.com/v1/api/jobs/us/search/{page}",
                params={"app_id": aid, "app_key": akey, "what": what,
                        "results_per_page": 50, "content-type": "application/json"}, timeout=25)
            if r.status_code != 200:
                break
            for j in r.json().get("results", []):
                jobs.append({
                    "title": j.get("title", ""),
                    "location": (j.get("location") or {}).get("display_name", "US"),
                    "url": j.get("redirect_url", ""),
                    "description": (j.get("description") or "")[:2000],
                    "company": (j.get("company") or {}).get("display_name", ""),
                })
        log.info(f"adzuna: {len(jobs)} listing(s)")
        return jobs
    except Exception as e:
        log.warning(f"adzuna: {e}")
        return None


# ── YC startup internships (Work at a Startup is login-walled; this isn't) ───
# The WaaS search (the only interface with an internship filter) hides its
# Algolia jobs index behind login, BUT two public surfaces compose into a feed:
#   1. ycombinator.com/companies ships a fresh public Algolia search key for
#      YCCompany_production in an inline `AlgoliaOpts` blob (the key ROTATES —
#      scrape it every run, never hardcode it; a stale key 403s).
#   2. ycombinator.com/companies/<slug>/jobs is server-rendered Inertia: the
#      `data-page` attribute holds jobPostings JSON with a typed `type` field
#      ("Internship"/"Full-time"/...). The public /jobs directory pages surface
#      ~0 internships, so per-company pages are the way.
# Gated on YC_DAILY=1 — ~60 page fetches/run is too heavy for the hourly
# monitor and postings don't churn that fast; run it on a daily-ish cron.

# Query terms used to find hiring YC companies — tune to YOUR lanes via the
# YC_QUERIES env var (comma-separated).
_YC_QUERIES = tuple(
    q.strip() for q in os.environ.get(
        "YC_QUERIES",
        "security, identity access management, AI agents, "
        "developer tools, AI infrastructure, cybersecurity").split(",") if q.strip())
_YC_DATA_PAGE_RE = re.compile(r'data-page="([^"]*)"')


# SESSION defaults to Accept: application/json, which YC's HTML routes 406.
_YC_HTML_HEADERS = {"Accept": "text/html,application/xhtml+xml"}


def _yc_algolia_opts():
    r = SESSION.get("https://www.ycombinator.com/companies",
                    headers=_YC_HTML_HEADERS, timeout=20)
    r.raise_for_status()
    m = re.search(r'AlgoliaOpts = (\{.*?\})', r.text)
    return json.loads(m.group(1)) if m else None


def scrape_yc_startups():
    """YC startup internship postings via public company pages. Daily-gated."""
    if os.environ.get("YC_DAILY") != "1":
        return None  # hourly runs skip — see the cadence note above
    try:
        opts = _yc_algolia_opts()
        if not opts:
            log.warning("yc_startups: AlgoliaOpts blob not found on /companies")
            return None
        app, key = opts["app"], opts["key"]
    except Exception as e:
        log.warning(f"yc_startups: key scrape failed: {e}")
        return None

    # Enumerate hiring companies for the query terms (slug -> blurb for context).
    slugs, blurbs = [], {}
    for q in _YC_QUERIES:
        try:
            r = SESSION.post(
                f"https://{app.lower()}-dsn.algolia.net/1/indexes/YCCompany_production/query",
                json={"query": q, "hitsPerPage": 25,
                      "facetFilters": [["isHiring:true"]],
                      "attributesToRetrieve": ["name", "slug", "one_liner", "batch"]},
                headers={"X-Algolia-Application-Id": app, "X-Algolia-API-Key": key},
                timeout=15)
            r.raise_for_status()
            for h in r.json().get("hits", []):
                s = h.get("slug")
                if s and s not in blurbs:
                    slugs.append(s)
                    blurbs[s] = (h.get("name") or s,
                                 h.get("one_liner") or "", h.get("batch") or "")
        except Exception as e:
            log.warning(f"yc_startups: company query '{q}': {e}")
        time.sleep(0.3)

    cap = int(os.environ.get("YC_MAX_COMPANIES", "60"))
    slugs = slugs[:cap]
    jobs, pages_ok = [], 0
    for s in slugs:
        try:
            r = SESSION.get(f"https://www.ycombinator.com/companies/{s}/jobs",
                            headers=_YC_HTML_HEADERS, timeout=20)
            if r.status_code != 200:
                continue
            m = _YC_DATA_PAGE_RE.search(r.text)
            if not m:
                continue
            props = json.loads(html.unescape(m.group(1))).get("props", {})
            pages_ok += 1
            name, one_liner, batch = blurbs.get(s, (s, "", ""))
            for j in props.get("jobPostings", []):
                title = j.get("title") or ""
                if j.get("type") != "Internship" and "intern" not in title.lower():
                    continue
                path = j.get("url") or ""
                if not path:
                    continue
                bits = [b for b in (
                    f"YC {batch}".strip() if batch else "",
                    one_liner,
                    f"Pay: {j['salaryRange']}" if j.get("salaryRange") else "",
                    f"Visa: {j['visa']}" if j.get("visa") else "",
                    f"Role: {j['prettyRole']} / {j['roleSpecificType']}"
                    if j.get("prettyRole") else "") if b]
                jobs.append({
                    "title": title,
                    "location": j.get("location") or "",
                    "url": "https://www.ycombinator.com" + path,
                    "description": " · ".join(bits)[:5000],
                    "company": name,
                })
        except Exception as e:
            log.warning(f"yc_startups/{s}: {e}")
        time.sleep(0.5)
    log.info(f"yc_startups: {len(jobs)} internship(s) across "
             f"{pages_ok}/{len(slugs)} company page(s)")
    return jobs or None


# All extra feeds, in call order (keyed ones self-skip without env).
EXTRA_FEEDS = (
    ("themuse", scrape_themuse),
    ("remotive", scrape_remotive),
    ("usajobs", scrape_usajobs),
    ("adzuna", scrape_adzuna),
    ("simplify_toplist", scrape_simplify_toplists),
    ("yc_startups", scrape_yc_startups),
)


# ── Registry router ───────────────────────────────────────────────────────────
def scrape_registry_company(entry: dict):
    """Route a company_registry.json entry to the right scraper."""
    ats = entry.get("ats", "unknown")
    if ats == "greenhouse":
        return scrape_greenhouse(entry.get("slug", ""))
    if ats == "lever":
        return scrape_lever(entry.get("slug", ""))
    if ats == "ashby":
        return scrape_ashby(entry.get("slug", ""))
    if ats == "smartrecruiters":
        return scrape_smartrecruiters(entry.get("slug", ""))
    if ats == "workable":
        return scrape_workable(entry.get("slug", ""))
    if ats == "recruitee":
        return scrape_recruitee(entry.get("slug", ""))
    if ats == "bamboohr":
        return scrape_bamboohr(entry.get("slug", ""))
    if ats == "workday":
        return scrape_workday(entry.get("tenant", ""), entry.get("wd", "wd1"),
                              entry.get("board", ""))
    if ats == "eightfold":
        return scrape_eightfold(entry.get("api_base", ""), entry.get("domain", ""),
                                queries=("intern", "security"))
    return []  # unknown/taleo/icims — covered by the Simplify feed


# Built-in direct sources run every time, independent of the registry
BUILTIN_SOURCES = {
    "Google": scrape_google,
    "Amazon": scrape_amazon,
    "Microsoft": scrape_microsoft,
    "Netflix": lambda: scrape_eightfold("https://explore.jobs.netflix.net",
                                        "netflix.com", queries=("intern",)),
}
