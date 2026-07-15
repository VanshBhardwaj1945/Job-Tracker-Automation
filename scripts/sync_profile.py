#!/usr/bin/env python3
"""
scripts/sync_profile.py — push the candidate's living profile docs into the tracker.

Sources:
  1. resume.md (repo root)                    → meta key profile_resume
  2. extra-context's <extra_context> knowledge block from
     the portfolio site's function_app.py (local
     checkout; override with EXTRA_APP_PATH)        → meta key profile_extra

The tracker's AI match step reads both, so updating either doc + rerunning
this script makes every future match (and /rematch-all) use the new profile.

Auth: TRACKER_URL / TRACKER_CLIENT_ID / TRACKER_CLIENT_SECRET env vars.
Locally, missing values are pulled from `terraform output` automatically.

Usage:
  python scripts/sync_profile.py                # resume + extra + rematch
  python scripts/sync_profile.py --resume-only  # CI (extra repo not present)
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESUME = ROOT / "resume.md"
EXTRA_APP = Path(os.environ.get(
    "EXTRA_APP_PATH",
    Path.home() / "Desktop/Projects/an optional extra-context source"))


def _terraform_output(name: str) -> str:
    try:
        return subprocess.run(
            ["terraform", f"-chdir={ROOT / 'terraform'}", "output", "-raw", name],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout.strip()
    except Exception:
        return ""


def ensure_tracker_env() -> None:
    mapping = {
        "TRACKER_URL": "tracker_url",
        "TRACKER_CLIENT_ID": "service_token_client_id",
        "TRACKER_CLIENT_SECRET": "service_token_client_secret",
    }
    for env, tf_out in mapping.items():
        if not os.environ.get(env):
            val = _terraform_output(tf_out)
            if val:
                os.environ[env] = val


def extra_block() -> str | None:
    if not EXTRA_APP.exists():
        return None
    m = re.search(r"<extra_context>([\s\S]*?)</extra_context>", EXTRA_APP.read_text())
    return m.group(1).strip() if m else None


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--resume-only", action="store_true",
                   help="skip the extra block (used in CI where the portfolio repo isn't checked out)")
    args = p.parse_args()

    ensure_tracker_env()
    sys.path.insert(0, str(ROOT / "monitor"))
    import tracker_client  # noqa: E402  (needs env set first)

    if not tracker_client.enabled():
        print("ERROR: TRACKER_URL/TRACKER_CLIENT_ID/TRACKER_CLIENT_SECRET not set "
              "(and terraform output unavailable).")
        return 1

    if not RESUME.exists():
        print(f"ERROR: {RESUME} not found")
        return 1
    resume = RESUME.read_text().strip()
    if not tracker_client.set_meta("profile_resume", resume):
        print("ERROR: failed to sync resume to tracker")
        return 1
    print(f"profile_resume synced ({len(resume):,} chars)")

    if not args.resume_only:
        block = extra_block()
        if block:
            if tracker_client.set_meta("profile_extra", block):
                print(f"profile_extra synced ({len(block):,} chars)")
            else:
                print("WARN: extra sync failed (resume still synced)")
        else:
            print(f"WARN: no <extra_context> block found at {EXTRA_APP} — skipped")

    res = tracker_client.rematch_all()
    if res:
        print(f"re-match queued for {res.get('queued', 0)} job(s)")
    else:
        print("WARN: rematch-all call failed (profile is synced; matches update on next inserts)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
