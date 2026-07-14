#!/usr/bin/env python3
"""
tracker_client.py — thin client for the job-tracker worker.

Auth is a Cloudflare Access service token (CF-Access-Client-Id/Secret headers);
Access validates it and hands the worker a JWT. Fail-open everywhere: any
error logs a warning and returns None/False — the tracker being down must
never break the monitor or the gmail watcher (AGENTS.md invariant #1).

Env: TRACKER_URL, TRACKER_CLIENT_ID, TRACKER_CLIENT_SECRET.
"""

import logging
import os

import requests

log = logging.getLogger(__name__)

TRACKER_URL = os.environ.get("TRACKER_URL", "").rstrip("/")
CLIENT_ID = os.environ.get("TRACKER_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("TRACKER_CLIENT_SECRET", "")


def enabled() -> bool:
    return bool(TRACKER_URL and CLIENT_ID and CLIENT_SECRET)


def _request(method: str, path: str, json_body=None, timeout=25):
    if not enabled():
        return None
    try:
        r = requests.request(
            method,
            f"{TRACKER_URL}{path}",
            json=json_body,
            headers={
                "CF-Access-Client-Id": CLIENT_ID,
                "CF-Access-Client-Secret": CLIENT_SECRET,
            },
            timeout=timeout,
        )
        if r.status_code >= 400:
            log.warning(f"tracker {method} {path} → {r.status_code}: {r.text[:200]}")
            return None
        return r.json()
    except Exception as e:
        log.warning(f"tracker {method} {path} failed: {e}")
        return None


def push_jobs(jobs: list) -> dict | None:
    """Bulk-add monitor alerts as 'todo' rows. Existing ids are ignored server-side."""
    return _request("POST", "/api/jobs/bulk", {"jobs": jobs})


def get_active_jobs() -> list:
    """Jobs an inbound email could still be about (todo→offer)."""
    res = _request("GET", "/api/jobs?phase=todo,applied,oa,interview,offer&sort=updated")
    return res.get("jobs", []) if res else []


def post_email_event(company: str, verdict: str, subject: str = "", detail: str = "") -> dict | None:
    return _request("POST", "/api/email-event",
                    {"company": company, "verdict": verdict,
                     "subject": subject, "detail": detail})


def list_jobs(query: str = "") -> list:
    """Generic job list, e.g. list_jobs('phase=applied&sort=applied')."""
    res = _request("GET", f"/api/jobs{'?' + query if query else ''}")
    return res.get("jobs", []) if res else []


def patch_job(job_id: str, fields: dict) -> dict | None:
    return _request("PATCH", f"/api/jobs/{job_id}", fields)


def get_stats() -> dict | None:
    return _request("GET", "/api/stats")


def rematch_all() -> dict | None:
    """Queue AI re-matching for active jobs missing match data (after profile sync)."""
    return _request("POST", "/api/rematch-all", timeout=30)


def rematch_batch_collect() -> dict | None:
    """Apply results from a previously-submitted rematch batch (no-op if none/pending)."""
    return _request("POST", "/api/rematch-batch/collect", timeout=60)


def rematch_batch_submit(all_jobs: bool = False, cap: int = 200) -> dict | None:
    """Submit a rematch batch via Anthropic's Message Batches API (~50% cheaper)."""
    q = f"?cap={cap}" + ("&all=1" if all_jobs else "")
    return _request("POST", f"/api/rematch-batch{q}", timeout=60)


def get_meta(key: str):
    res = _request("GET", f"/api/meta/{key}")
    return res.get("value") if res else None


def set_meta(key: str, value: str) -> bool:
    return _request("PUT", f"/api/meta/{key}", {"value": str(value)}) is not None
