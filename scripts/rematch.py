#!/usr/bin/env python3
"""Drive /api/rematch-all to completion from GitHub Actions.

The worker scores one small chunk (enrich + match + apply) per call and returns
{rescored, remaining}. Looping tracker_client.rematch_all() (which posts without
a cutoff → onlyMissing) converges: rescored rows get a match_score and drop out
of the unscored set. Reliable from Actions (unlike a browser, no Cloudflare
bot challenge). Fail-open: any error just stops the loop cleanly.

Usage: python scripts/rematch.py   (env: TRACKER_URL, TRACKER_CLIENT_ID/SECRET)
"""
import sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "monitor"))
import tracker_client  # noqa: E402


def main() -> None:
    if not tracker_client.enabled():
        print("tracker not configured (TRACKER_* secrets missing) — nothing to do")
        return
    total = 0
    for i in range(1, 61):  # hard cap; each round handles ~8 jobs
        res = tracker_client.rematch_all()
        if not res:
            print(f"round {i}: no response — stopping")
            break
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
