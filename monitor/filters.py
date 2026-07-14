#!/usr/bin/env python3
"""
filters.py — Title / location / recruiting-cycle filtering + job categorization.

Categories (defined in data/profile.json):
  security      — always wanted, top of every email
  relevant_swe  — cloud / DevOps / SRE / IAM / infra / backend / systems
  other_swe     — generic SWE; only kept if AI scoring promotes it
                  (or include_other_swe=true in profile.json)
"""

import re
from datetime import date

# ── Intern detection ──────────────────────────────────────────────────────────
# Word-boundary so 'internal', 'international', 'internet' never match.
INTERN_RE = re.compile(r"\bintern(?:s|ship|ships)?\b|\bco-?op\b", re.IGNORECASE)

# ── Seniority blocklist (word-boundary regexes) ───────────────────────────────
# NOTE: 'researcher'/'scientist'/'consultant' intentionally NOT here —
# "Security Researcher Intern" is a real internship we want.
SENIORITY_RE = re.compile(
    r"\b(senior|sr\.?|staff|principal|director|manager|head of|vp|"
    r"vice president|chief|distinguished|architect)\b",
    re.IGNORECASE,
)
LEAD_RE = re.compile(r"\blead\b\s+(engineer|developer|scientist)", re.IGNORECASE)

# ── Non-student / wrong-degree programs ───────────────────────────────────────
PROGRAM_RE = re.compile(
    r"\b(skillbridge|apprentice(?:ship)?|postdoc(?:toral)?|fellowship|"
    r"residency|phd|ph\.d|mba|part[- ]time)\b",
    re.IGNORECASE,
)

# ── Location: US-signal allowlist beats foreign blocklist ─────────────────────
US_STATE_CODES = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC",
}
US_SIGNAL_RE = re.compile(
    r"\b(united states|usa|u\.s\.a?\.?|alabama|alaska|arizona|arkansas|"
    r"california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|"
    r"illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|"
    r"massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|"
    r"nevada|new hampshire|new jersey|new mexico|new york|north carolina|"
    r"north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|"
    r"south carolina|south dakota|tennessee|texas|utah|vermont|virginia|"
    r"washington|west virginia|wisconsin|wyoming|"
    r"new york city|san francisco|austin|seattle|chicago|boston|atlanta|"
    r"dallas|denver|san jose|sunnyvale|mountain view|palo alto|santa clara|"
    r"san diego|los angeles|redmond|bellevue|arlington|reston|mclean|"
    r"san antonio|houston|phoenix|portland|raleigh|durham|charlotte|columbus|"
    r"pittsburgh|philadelphia|miami|tampa|boulder|ann arbor|madison|"
    r"minneapolis|nashville|baltimore|detroit|irvine|menlo park|cupertino|"
    r"plano|richardson|salt lake)\b",
    re.IGNORECASE,
)
# Word-boundary regex — the old substring check blocked 'Milwaukee' ('uk'!)
FOREIGN_RE = re.compile(
    r"\b(india|poland|serbia|france|germany|uk|united kingdom|canada|"
    r"australia|singapore|ireland|spain|italy|netherlands|brazil|mexico|"
    r"japan|china|korea|sweden|norway|denmark|finland|switzerland|austria|"
    r"belgium|portugal|czechia|czech republic|hungary|romania|israel|taiwan|"
    r"philippines|indonesia|thailand|vietnam|colombia|argentina|chile|panama|"
    r"south africa|nigeria|egypt|uae|saudi arabia|bangalore|bengaluru|"
    r"hyderabad|pune|mumbai|delhi|noida|gurgaon|chennai|toronto|vancouver|"
    r"montreal|ottawa|sydney|melbourne|london|paris|berlin|munich|amsterdam|"
    r"dublin|warsaw|krakow|prague|belgrade|budapest|bucharest|tel aviv|"
    r"zurich|stockholm|lisbon|madrid|barcelona|tokyo|seoul|beijing|shanghai|"
    r"shenzhen|taipei|manila|jakarta|bangkok|cairo|dubai|mexico city|"
    r"sao paulo|bogota|cape town)\b",
    re.IGNORECASE,
)


def is_location_ok(location: str) -> bool:
    """US signal wins > foreign signal blocks > unknown passes."""
    loc = (location or "").strip()
    if not loc or loc.lower() in ("unknown", "n/a"):
        return True
    if US_SIGNAL_RE.search(loc):
        return True
    if any(tok.strip(",.()") in US_STATE_CODES for tok in loc.split()):
        return True
    if FOREIGN_RE.search(loc):
        return False
    return True  # ambiguous (e.g. plain "Remote") — let it through


# ── Recruiting cycle: date-aware, no hardcoded years ─────────────────────────
SEASON_START_MONTH = {"spring": 1, "summer": 5, "fall": 8, "autumn": 8, "winter": 12}
SEASON_RE = re.compile(r"\b(spring|summer|fall|autumn|winter)\s*[' ]?\s*(20\d{2})\b", re.IGNORECASE)
GRACE_DAYS = 45


def year_relevant(text: str, today: date = None) -> bool:
    """
    A '<season> <year>' mention is stale once that season started >45 days ago.
    If a posting mentions ANY current-or-future cycle it passes.
    Undated postings always pass.
    """
    today = today or date.today()
    mentions = SEASON_RE.findall(text or "")
    if not mentions:
        return True
    for season, year in mentions:
        start = date(int(year), SEASON_START_MONTH[season.lower()], 1)
        if (today - start).days <= GRACE_DAYS:
            return True  # current or future cycle
    return False  # every dated mention is stale


# ── Categorization ────────────────────────────────────────────────────────────
def _compile_keywords(keywords: list) -> list:
    """Short/ambiguous tokens get word boundaries ('iam' must not hit 'diamond')."""
    out = []
    for kw in keywords:
        pattern = re.escape(kw.lower())
        if len(kw) <= 4 or " " not in kw:
            pattern = rf"\b{pattern}\b" if len(kw) <= 4 else pattern
        out.append(re.compile(pattern, re.IGNORECASE))
    return out


class JobMatcher:
    def __init__(self, profile: dict):
        cats = profile.get("categories", {})
        self.security_res = _compile_keywords(cats.get("security", {}).get("keywords", []))
        self.relevant_res = _compile_keywords(cats.get("relevant_swe", {}).get("keywords", []))
        self.generic_res = _compile_keywords(["software engineer", "software developer",
                                              "software development", "swe"])
        self.include_other = profile.get("include_other_swe", False)

    def categorize(self, title: str, description: str = "") -> str | None:
        """Return 'security' | 'relevant_swe' | 'other_swe' | None (not a tech intern role)."""
        t = title or ""
        if any(r.search(t) for r in self.security_res):
            return "security"
        if any(r.search(t) for r in self.relevant_res):
            return "relevant_swe"
        if any(r.search(t) for r in self.generic_res):
            # Peek at description — a generic SWE title on an infra/security team counts
            d = (description or "")[:3000]
            if any(r.search(d) for r in self.security_res):
                return "security"
            if any(r.search(d) for r in self.relevant_res):
                return "relevant_swe"
            return "other_swe"
        return None

    def match(self, title: str, location: str, description: str = "",
              today: date = None) -> str | None:
        """Full gate. Returns category if the job passes, else None."""
        if not title or not INTERN_RE.search(title):
            return None
        if SENIORITY_RE.search(title) or LEAD_RE.search(title):
            return None
        if PROGRAM_RE.search(title):
            return None
        if not is_location_ok(location):
            return None
        if not year_relevant(f"{title} {description or ''}", today):
            return None
        cat = self.categorize(title, description)
        if cat == "other_swe" and not self.include_other:
            return "other_swe"  # kept for AI to judge; scraper drops it if no AI
        return cat
