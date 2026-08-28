#!/usr/bin/env python3
"""Drive /api/rematch-all to completion from GitHub Actions.

The worker scores one small chunk (enrich + match + apply) per call and returns
{rescored, remaining}. Looping tracker_client.rematch_all() (which posts without
a cutoff → onlyMissing) converges: rescored rows get a match_score and drop out
of the unscored set. Reliable from Actions (unlike a browser, no Cloudflare
bot challenge). Fail-open: any error just stops the loop cleanly.

Usage: python scripts/rematch.py   (env: TRACKER_URL, TRACKER_CLIENT_ID/SECRET)
"""
import os
import sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "monitor"))
import tracker_client  # noqa: E402


def main() -> None:
    if not tracker_client.enabled():
        print("tracker not configured (TRACKER_* secrets missing) — nothing to do")
        return
    total, misses = 0, 0
    for i in range(1, 101):  # hard cap; each round handles ~8 jobs
        # REMATCH_ALL=1 (workflow env) re-scores EVERY row, not just unscored —
        # needed when the rubric/schema changes (e.g. the like_score axis).
        res = tracker_client.rematch_all(all_jobs=os.environ.get("REMATCH_ALL") == "1")
        if not res:
            # a timeout does NOT mean the chunk failed — the worker keeps
            # processing server-side. Back off and retry instead of quitting.
            misses += 1
            print(f"round {i}: no response (miss {misses}/5) — backing off")
            if misses >= 5:
                break
            time.sleep(20)
            continue
        misses = 0
        rescored = res.get("rescored", 0)
        remaining = res.get("remaining", 0)
        total += rescored
        print(f"round {i:2}: rescored={rescored} remaining={remaining}")
        if remaining == 0 or (rescored == 0 and i > 2):
            break
        time.sleep(1)
    print(f"done: {total} job(s) rescored")


if __name__ == "__main__":
    main()
