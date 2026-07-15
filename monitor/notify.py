#!/usr/bin/env python3
"""
notify.py — Email (Gmail SMTP) + Discord webhook, grouped by category.

Security jobs always render first, then relevant SWE. Discord is the instant
channel (fires in <1s); email is the archive. Discord is optional — set the
DISCORD_WEBHOOK_URL secret and it just starts working.
"""

import logging
import os
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import requests

log = logging.getLogger(__name__)

EMAIL_SENDER = os.environ.get("EMAIL_SENDER", "")
EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")
EMAIL_TO = os.environ.get("EMAIL_TO", "")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "")

CATEGORY_META = {
    "security":     ("🔐", "Security", "#b91c1c"),
    "relevant_swe": ("⚙️", "Cloud / Infra / SRE", "#1d4ed8"),
    "other_swe":    ("💻", "Other SWE", "#6b7280"),
}
CATEGORY_ORDER = ["security", "relevant_swe", "other_swe"]


def _group(jobs):
    groups = {c: [] for c in CATEGORY_ORDER}
    for j in jobs:
        groups.setdefault(j.get("category", "other_swe"), []).append(j)
    for c in groups:
        groups[c].sort(key=lambda j: (-(j.get("ai_score") or 0), j["company"].lower()))
    return groups


def _job_row(job):
    score = job.get("ai_score")
    badge = (f'<span style="background:#ecfdf5;color:#047857;border-radius:4px;'
             f'padding:1px 6px;font-size:11px;font-weight:bold;">{score}/100</span> '
             if score is not None else "")
    reason = (f'<br><span style="color:#059669;font-size:11px;">↳ {job["ai_reason"]}</span>'
              if job.get("ai_reason") else "")
    return f"""
    <tr>
      <td style="padding:12px 8px;border-bottom:1px solid #eee;vertical-align:top;">
        <strong style="font-size:14px;color:#111;">{job['company']}</strong> {badge}<br>
        <span style="color:#333;font-size:13px;">{job['title']}</span><br>
        <span style="color:#888;font-size:12px;">📍 {job['location']}</span>
        <span style="color:#bbb;font-size:10px;"> · via {job['source']}</span>{reason}
      </td>
      <td style="padding:12px 8px;border-bottom:1px solid #eee;text-align:right;
                 vertical-align:middle;white-space:nowrap;">
        <a href="{job['url']}" style="background:#0a0a0a;color:white;padding:7px 14px;
           border-radius:5px;text-decoration:none;font-size:12px;font-weight:bold;">
          Apply →</a>
      </td>
    </tr>"""


def build_email_html(jobs, title="New Internship Postings"):
    run_time = datetime.now().strftime("%B %d, %Y at %I:%M %p UTC").lstrip("0")
    groups = _group(jobs)
    sections = ""
    for cat in CATEGORY_ORDER:
        if not groups.get(cat):
            continue
        emoji, label, color = CATEGORY_META[cat]
        rows = "".join(_job_row(j) for j in groups[cat])
        sections += f"""
        <h3 style="margin:22px 0 6px;font-size:14px;color:{color};">
          {emoji} {label} ({len(groups[cat])})</h3>
        <table style="width:100%;border-collapse:collapse;border:1px solid #eee;">
          {rows}</table>"""

    return f"""<html><body style="font-family:Arial,sans-serif;max-width:620px;
                                   margin:0 auto;padding:20px;">
      <div style="background:#0a0a0a;color:white;padding:16px 20px;border-radius:8px;">
        <h2 style="margin:0;font-size:18px;">🎯 {title}</h2>
        <p style="margin:6px 0 0;font-size:12px;color:#aaa;">{run_time}</p>
      </div>
      {sections}
      <p style="color:#bbb;font-size:11px;margin-top:14px;text-align:center;">
        job-monitor · hourly · security first</p>
    </body></html>"""


def send_email(jobs, subject=None, html=None):
    if not jobs and html is None:
        return
    n_sec = sum(1 for j in jobs if j.get("category") == "security")
    subject = subject or (
        f"🔐 {n_sec} security + {len(jobs) - n_sec} SWE intern posting(s)"
        if n_sec else f"⚙️ {len(jobs)} new intern posting(s)")
    html = html or build_email_html(jobs)
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(EMAIL_SENDER, EMAIL_PASSWORD)
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = EMAIL_SENDER
            msg["To"] = EMAIL_TO
            msg.attach(MIMEText(html, "html"))
            smtp.sendmail(EMAIL_SENDER, EMAIL_TO, msg.as_string())
        log.info(f"✓ Email sent → {EMAIL_TO}")
    except Exception as e:
        log.error(f"Email failed: {e}")
        raise


def send_discord(jobs):
    """Instant push. One embed per category, top 10 jobs each."""
    if not DISCORD_WEBHOOK_URL or not jobs:
        if not DISCORD_WEBHOOK_URL:
            log.info("Discord skipped (no DISCORD_WEBHOOK_URL)")
        return
    groups = _group(jobs)
    embeds = []
    for cat in CATEGORY_ORDER:
        if not groups.get(cat):
            continue
        emoji, label, color = CATEGORY_META[cat]
        lines = []
        for j in groups[cat][:10]:
            score = f" `{j['ai_score']}/100`" if j.get("ai_score") is not None else ""
            lines.append(f"**[{j['company']}]({j['url']})** — {j['title']}{score}\n"
                         f"-# 📍 {j['location']}")
        if len(groups[cat]) > 10:
            lines.append(f"…and {len(groups[cat]) - 10} more (see email)")
        embeds.append({
            "title": f"{emoji} {label} ({len(groups[cat])})",
            "description": "\n".join(lines)[:4000],
            "color": int(color.lstrip("#"), 16),
        })
    try:
        r = requests.post(DISCORD_WEBHOOK_URL, json={
            "username": "Job Monitor",
            "content": f"**{len(jobs)} new internship posting(s)**",
            "embeds": embeds[:10],
        }, timeout=15)
        if r.status_code in (200, 204):
            log.info("✓ Discord notification sent")
        else:
            log.warning(f"Discord webhook returned {r.status_code}")
    except Exception as e:
        log.warning(f"Discord failed: {e}")


def send_discord_event(title, description, color=0x5865F2):
    """Single-embed Discord message for tracker/email events (gmail_watch.py).
    Fail-open like everything else here."""
    if not DISCORD_WEBHOOK_URL:
        log.info("Discord event skipped (no DISCORD_WEBHOOK_URL)")
        return
    try:
        r = requests.post(DISCORD_WEBHOOK_URL, json={
            "username": "Job Tracker",
            "embeds": [{"title": title[:250],
                        "description": description[:4000],
                        "color": color}],
        }, timeout=15)
        if r.status_code not in (200, 204):
            log.warning(f"Discord event webhook returned {r.status_code}")
    except Exception as e:
        log.warning(f"Discord event failed: {e}")


def notify(jobs):
    send_discord(jobs)   # instant first
    send_email(jobs)


def send_health_report(stats: dict):
    """Weekly plaintext-ish health email so silent death gets noticed."""
    rows = "".join(
        f"<tr><td style='padding:4px 10px;'>{k}</td>"
        f"<td style='padding:4px 10px;text-align:right;'><b>{v}</b></td></tr>"
        for k, v in stats["summary"].items())
    failing = "".join(f"<li>{c} — {n} consecutive failures</li>"
                      for c, n in stats["failing"][:20]) or "<li>none 🎉</li>"
    html = f"""<html><body style="font-family:Arial,sans-serif;max-width:620px;
                                   margin:0 auto;padding:20px;">
      <h2>🩺 Job Monitor — Weekly Health Report</h2>
      <table style="border:1px solid #eee;border-collapse:collapse;">{rows}</table>
      <h3>Failing companies</h3><ul>{failing}</ul>
      <p style="color:#888;font-size:12px;">Failing companies are auto-reclassified
      on the next classify run. If total matches is 0 for a whole week, something
      upstream broke — check the Actions logs.</p>
    </body></html>"""
    send_email([], subject="🩺 Job Monitor weekly health report", html=html)
