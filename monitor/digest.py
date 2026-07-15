#!/usr/bin/env python3
"""
digest.py — Sunday-evening Discord digest + tracker housekeeping.

1. Pipeline snapshot: applied this week, totals per phase, interview rate.
2. Follow-up nudges: applied 14+ days ago with no response yet.
3. Prep reminders: anything sitting in OA / interview.
4. Top ⭐ recommended jobs still unapplied.
5. Housekeeping: Found jobs untouched for 45+ days get auto-archived
   (they're almost certainly closed postings by then).

Fail-open like everything else: any error logs and exits 0.
Run: python monitor/digest.py [--dry-run]   (Actions: cron "0 22 * * 0" / mode digest)
"""

import argparse
import logging
from datetime import datetime, timedelta, timezone

import notify
import tracker_client

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

FOLLOWUP_AFTER_DAYS = 14
ARCHIVE_FOUND_AFTER_DAYS = 45


def _days_ago(iso: str | None) -> float:
    if not iso:
        return 0.0
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).total_seconds() / 86400
    except ValueError:
        return 0.0


def run(dry_run: bool = False) -> None:
    if not tracker_client.enabled():
        log.error("TRACKER_* env not set — nothing to digest.")
        return

    stats = tracker_client.get_stats() or {}
    phases = stats.get("phases", {})
    applied_total = sum(phases.get(p, 0) for p in
                        ("applied", "oa", "interview", "offer", "accepted", "rejected"))
    interviews = sum(phases.get(p, 0) for p in ("interview", "offer", "accepted"))
    weekly = stats.get("weekly", [])
    applied_this_week = weekly[-1]["n"] if weekly else 0

    # Follow-up nudges: applied 14+ days, still sitting in 'applied'
    applied = tracker_client.list_jobs("phase=applied&sort=applied")
    followups = [j for j in applied if _days_ago(j.get("applied_at")) >= FOLLOWUP_AFTER_DAYS]

    # Prep reminders
    in_play = tracker_client.list_jobs("phase=oa,interview&sort=updated")

    # Top recommended still unapplied
    recommended = tracker_client.list_jobs("recommended=1&sort=rank")[:5]

    # Housekeeping: archive ancient Found rows
    found = tracker_client.list_jobs("phase=found&sort=updated")
    stale_found = [j for j in found if _days_ago(j.get("updated_at")) >= ARCHIVE_FOUND_AFTER_DAYS]
    archived = 0
    if not dry_run:
        for j in stale_found[:50]:
            if tracker_client.patch_job(j["id"], {"phase": "archived"}):
                archived += 1

    lines = [
        f"**This week:** {applied_this_week} application(s) · "
        f"{applied_total} total applied · {interviews} interview+ "
        f"({round(100 * interviews / applied_total) if applied_total else 0}% rate)",
    ]
    if in_play:
        lines.append("\n**🧪 In play — prep for these:**")
        lines += [f"· **{j['company']}** — {j['title']} ({j['phase']})" for j in in_play[:6]]
    if followups:
        lines.append(f"\n**⏰ No response in {FOLLOWUP_AFTER_DAYS}+ days — worth a follow-up:**")
        lines += [f"· **{j['company']}** — {j['title']} "
                  f"(applied {int(_days_ago(j.get('applied_at')))}d ago)" for j in followups[:8]]
    if recommended:
        lines.append("\n**⭐ Top recommended you haven't applied to:**")
        lines += [f"· **{j['company']}** — {j['title']} (🎯 {j.get('match_score', '?')}/100)"
                  for j in recommended]
    if archived or stale_found:
        lines.append(f"\n-# 🧹 auto-archived {archived if not dry_run else len(stale_found)} "
                     f"Found job(s) older than {ARCHIVE_FOUND_AFTER_DAYS}d")
    lines.append("-# jobs.example.com")

    body = "\n".join(lines)
    if dry_run:
        log.info("DRY RUN — digest would be:\n" + body)
        return
    # Self-heal match coverage weekly, cheaply, via the Message Batches API
    # (~50% off): first collect last week's batch (applies it), then submit a
    # fresh one for anything still missing scores. One-cycle lag by design —
    # no long-polling in the cron. Falls back to the synchronous path if the
    # batch endpoints aren't available (older worker).
    collected = tracker_client.rematch_batch_collect()
    if collected and collected.get("applied"):
        log.info(f"applied {collected['applied']} result(s) from last week's batch")
    submitted = tracker_client.rematch_batch_submit(cap=200)
    if submitted is None:
        res = tracker_client.rematch_all()
        log.info(f"batch unavailable — sync rematch queued {(res or {}).get('queued', 0)}")
    elif submitted.get("count"):
        log.info(f"submitted rematch batch {submitted.get('batch_id')} ({submitted['count']} jobs)")
    notify.send_discord_event("📬 Weekly job-hunt digest", body, 0x6366F1)
    log.info(f"Digest sent. followups={len(followups)} in_play={len(in_play)} archived={archived}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    try:
        run(dry_run=args.dry_run)
    except Exception as e:
        log.error(f"digest crashed (non-fatal): {e}")
