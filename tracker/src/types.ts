export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;             // uploaded PDFs (resumes/cover letters you submitted)
  ANTHROPIC_API_KEY: string;
  ACCESS_TEAM_DOMAIN: string; // e.g. "myteam.cloudflareaccess.com"
  ACCESS_AUD: string;         // Access application AUD tag
  ACCESS_ALLOWED_EMAIL?: string; // defense-in-depth: worker-enforced owner email
  DEV_MODE?: string;          // "1" only in wrangler dev — bypasses auth
  GITHUB_TOKEN?: string;      // optional — Activity page lists workflow runs
  GITHUB_REPO?: string;       // e.g. "YOUR_GITHUB_USERNAME/job-monitor"
  GITHUB_USERNAME?: string;   // optional — pulls your public repos into doc context
  PORTFOLIO_URL?: string;     // optional — pulls your site text into doc context
}

// AI-generated documents (chat) + files you upload. `upload_*` = a PDF you
// actually submitted, kept in R2 so you can review it before an interview.
export const DOC_KINDS = [
  "resume", "cover_letter", "interview_prep", "app_answers",
  "upload_resume", "upload_cover_letter", "upload_other",
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

// The four Opus-generated kinds (the rest are uploads).
export const GEN_KINDS = ["resume", "cover_letter", "interview_prep", "app_answers"] as const;
export type GenKind = (typeof GEN_KINDS)[number];

// "found" = surfaced by the monitor / not yet acted on. The UI's Recommended
// tab is found + high match score (the candidate applies the moment he sees a fit).
export const PHASES = [
  "found", "applied", "oa", "interview", "offer",
  "accepted", "rejected", "withdrawn", "not_applying", "archived",
] as const;
export type Phase = (typeof PHASES)[number];

// Phases where an inbound email event can still be relevant.
export const ACTIVE_PHASES: Phase[] = ["found", "applied", "oa", "interview", "offer"];

export const CATEGORIES = [
  "iam", "detection", "appsec", "cloud_sec", "ai_sec", "security",
  "swe_infra", "swe_fullstack", "swe_data", "swe_other", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  iam: "🪪 IAM / Identity",
  detection: "🕵️ Detection / SOC / IR",
  appsec: "🛡 AppSec / DevSecOps",
  cloud_sec: "☁️ Cloud Security",
  ai_sec: "🤖 AI Security",
  security: "🔐 Security (general)",
  swe_infra: "⚙️ SWE: Infra / Platform",
  swe_fullstack: "🖥 SWE: Fullstack / Web",
  swe_data: "📊 SWE: Data / ML",
  swe_other: "💻 SWE: Other",
  other: "📎 Other",
};

// v1 rows + the monitor's coarse categories map into the new set; the AI
// match step then refines (e.g. security → iam) when it has enough signal.
export const LEGACY_CATEGORY_MAP: Record<string, Category> = {
  security: "security",
  relevant_swe: "swe_infra",
  other_swe: "swe_other",
};

export function normalizeCategory(raw: unknown): Category {
  const s = String(raw ?? "");
  if ((CATEGORIES as readonly string[]).includes(s)) return s as Category;
  return LEGACY_CATEGORY_MAP[s] ?? "other";
}

/** Same id formula as scraper.make_job_id — changing it desyncs dedupe with the monitor. */
export async function makeJobId(company: string, title: string, url: string): Promise<string> {
  const raw = `${company.toLowerCase()}|${title.toLowerCase()}|${url.toLowerCase()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
