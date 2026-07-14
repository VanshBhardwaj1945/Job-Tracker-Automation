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

import logging
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
    """Thousands of contributors surface postings within hours — the single
    widest net we have. Covers Meta, Apple, and every company not in our registry."""
    for season in seasons:
        url = (f"https://raw.githubusercontent.com/SimplifyJobs/"
               f"Summer{season}-Internships/dev/.github/scripts/listings.json")
        try:
            r = SESSION.get(url, timeout=30)
            if r.status_code != 200:
                continue
            jobs = []
            for j in r.json():
                if not j.get("active", True):
                    continue
                if j.get("is_visible") is False:
                    continue
                jobs.append({
                    "title": j.get("title", ""),
                    "location": "; ".join(j.get("locations", [])[:3]),
                    "url": j.get("url", ""),
                    "description": " ".join(j.get("terms", [])),
                    "company": j.get("company_name", ""),
                    "date_posted": j.get("date_posted"),
                })
            log.info(f"simplify: Summer{season} feed → {len(jobs)} active listings")
            return jobs
        except Exception as e:
            log.warning(f"simplify Summer{season}: {e}")
    return None


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
