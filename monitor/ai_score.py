#!/usr/bin/env python3
"""
ai_score.py — Claude relevance scoring.

Keyword filters are the coarse net; Claude is the fine one. Each NEW job
(post-keyword-filter, pre-email) is scored 0-10 against the candidate profile
and re-categorized. Jobs under min_score are dropped; 'other_swe' jobs that
Claude finds relevant (e.g. a generic SWE title on a security team) get promoted.

Fail-open: if there's no ANTHROPIC_API_KEY or the API errors, keyword results
stand as-is (other_swe gets dropped unless include_other_swe=true).
"""

import json
import logging
import os
import re

import ai_client

log = logging.getLogger(__name__)

PROMPT = """You are screening internship postings for this candidate:

{summary}

The candidate's role preferences, ranked (weight 10 = perfect target, 5 = acceptable fallback):
{ranking}

For EACH job below, return a relevance score and category. Anchor the score to the
ranking above: a job matching a weight-10 role type should score 9-10, weight-8 → 7-8,
weight-5 → 5-6, and anything outside the ranked list scores by profile fit (usually ≤4).

Categories:
- "security"     — any security/cyber/IAM/identity/detection role (top priority)
- "relevant_swe" — cloud, DevOps, SRE, infrastructure, platform, backend, distributed systems
- "other"        — everything else (frontend, mobile, product SWE, data, hardware, non-tech)

Score 0-10 (10 = perfect fit). Penalize: non-US locations, PhD/MBA-only roles,
non-student programs, roles unrelated to the profile. A generic "Software Engineer
Intern" on a security/infra/cloud team should be scored on the team, not the title.

Jobs:
{jobs}

Return ONLY a JSON array, one object per job, same order:
[{{"i": 0, "score": 8, "category": "security", "reason": "max 8 words"}}]
No markdown, no explanation."""


def score_jobs(jobs: list, profile: dict) -> list:
    """Mutates jobs in place: adds ai_score/ai_reason, may re-assign category.
    Returns the filtered list (score >= min_score). Fail-open on any error."""
    cfg = profile.get("ai_scoring", {})
    if not cfg.get("enabled", True) or not ai_client.available() or not jobs:
        if not ai_client.available():
            log.info("AI scoring skipped (no AI provider configured — set AI_PROVIDER + key)")
        return [j for j in jobs if j["category"] != "other_swe"
                or profile.get("include_other_swe")]

    model = cfg.get("model") or ai_client.default_model()
    min_score = cfg.get("min_score", 5)
    summary = profile.get("candidate", {}).get("summary", "")
    ranking = "\n".join(
        f"  {r['weight']}/10 — {r['role']}"
        for r in profile.get("role_ranking", [])) or "  (no ranking provided)"
    kept = []

    for batch_start in range(0, len(jobs), 25):
        batch = jobs[batch_start:batch_start + 25]
        listing = json.dumps([
            {"i": i, "company": j["company"], "title": j["title"],
             "location": j["location"],
             # short snippet — enough to catch "SWE intern on a security team"
             "snippet": (j.get("description") or "")[:400]}
            for i, j in enumerate(batch)
        ], indent=1)
        try:
            text = ai_client.complete(
                PROMPT.format(summary=summary, ranking=ranking, jobs=listing),
                max_tokens=2000, model=model,
            )
            text = re.sub(r"```(?:json)?", "", text).strip()
            results = {item["i"]: item for item in json.loads(text)}
        except Exception as e:
            log.warning(f"AI scoring failed ({e}) — keeping keyword results for batch")
            kept.extend(j for j in batch if j["category"] != "other_swe"
                        or profile.get("include_other_swe"))
            continue

        for i, job in enumerate(batch):
            res = results.get(i, {})
            job["ai_score"] = res.get("score")
            job["ai_reason"] = res.get("reason", "")
            ai_cat = res.get("category")
            if ai_cat in ("security", "relevant_swe"):
                job["category"] = ai_cat  # promotion/correction
            elif ai_cat == "other":
                job["category"] = "other_swe"
            score = job["ai_score"] if isinstance(job.get("ai_score"), (int, float)) else min_score
            if job["category"] == "other_swe" and not profile.get("include_other_swe"):
                log.info(f"  AI dropped (other): {job['company']} — {job['title']}")
                continue
            if score < min_score:
                log.info(f"  AI dropped (score {score}): {job['company']} — {job['title']}")
                continue
            kept.append(job)

    return kept
