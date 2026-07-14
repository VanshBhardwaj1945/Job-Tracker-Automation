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

// ── Hierarchical category taxonomy (parent → mid → leaf) ─────────────────────
// A job is AI-tagged with one or more LEAF ids, but it ROLLS UP: a job tagged
// `inf_sre` also belongs to `swe_infra` and `swe`. Filters/analytics work at any
// level via the ancestor closure (see catPath / subtreeIds below).
export interface CatNode { id: string; label: string; parent: string | null; }

export const TAXONOMY: CatNode[] = [
  // ── top ──
  { id: "security", label: "Security", parent: null },
  { id: "swe", label: "SWE", parent: null },
  { id: "other", label: "Other", parent: null },

  // ── Security ──
  { id: "sec_iam", label: "IAM / Identity", parent: "security" },
  { id: "iam_iga", label: "IGA / provisioning / access reviews", parent: "sec_iam" },
  { id: "iam_pam", label: "PAM / privileged access", parent: "sec_iam" },
  { id: "iam_sso", label: "SSO / federation (OAuth·SAML·OIDC)", parent: "sec_iam" },
  { id: "iam_dir", label: "Directory / Entra / AD / SCIM", parent: "sec_iam" },
  { id: "iam_ciam", label: "CIAM / customer identity", parent: "sec_iam" },
  { id: "iam_authz", label: "Authorization / policy (OPA·Rego, RBAC/ABAC)", parent: "sec_iam" },

  { id: "sec_det", label: "Detection & Response", parent: "security" },
  { id: "det_soc", label: "SOC / monitoring / SIEM", parent: "sec_det" },
  { id: "det_eng", label: "Detection engineering", parent: "sec_det" },
  { id: "det_hunt", label: "Threat hunting", parent: "sec_det" },
  { id: "det_ir", label: "Incident response / DFIR / forensics", parent: "sec_det" },
  { id: "det_edr", label: "EDR / XDR / endpoint", parent: "sec_det" },
  { id: "det_ti", label: "Threat intelligence", parent: "sec_det" },
  { id: "det_malware", label: "Malware analysis / reverse engineering", parent: "sec_det" },

  { id: "sec_app", label: "Application Security", parent: "security" },
  { id: "app_prodsec", label: "Product security (ProdSec)", parent: "sec_app" },
  { id: "app_devsecops", label: "DevSecOps / pipeline / supply-chain", parent: "sec_app" },
  { id: "app_offensive", label: "Offensive / red team / pentest", parent: "sec_app" },
  { id: "app_review", label: "Secure code review / SAST·DAST", parent: "sec_app" },
  { id: "app_vuln", label: "Vuln research / bug bounty", parent: "sec_app" },

  { id: "sec_cloud", label: "Cloud & Infra Security", parent: "security" },
  { id: "cld_cspm", label: "Cloud security posture (CSPM)", parent: "sec_cloud" },
  { id: "cld_k8s", label: "Container / Kubernetes security", parent: "sec_cloud" },
  { id: "cld_net", label: "Network security / firewall / zero trust", parent: "sec_cloud" },
  { id: "cld_platform", label: "Platform / infra security engineering", parent: "sec_cloud" },

  { id: "sec_ai", label: "AI / ML Security", parent: "security" },
  { id: "ai_llm", label: "LLM / model security", parent: "sec_ai" },
  { id: "ai_redteam", label: "AI red teaming", parent: "sec_ai" },
  { id: "ai_mlpipe", label: "ML pipeline / data security", parent: "sec_ai" },

  { id: "sec_grc", label: "GRC & Compliance", parent: "security" },
  { id: "grc_risk", label: "Risk / audit", parent: "sec_grc" },
  { id: "grc_compliance", label: "Compliance (SOC 2·ISO·FedRAMP)", parent: "sec_grc" },
  { id: "grc_gov", label: "Security governance / policy", parent: "sec_grc" },

  { id: "sec_ot", label: "OT / ICS Security", parent: "security" },
  { id: "ot_crit", label: "Critical infrastructure", parent: "sec_ot" },
  { id: "ot_scada", label: "SCADA / industrial", parent: "sec_ot" },

  { id: "sec_data", label: "Data Security & Privacy", parent: "security" },
  { id: "dsec_dlp", label: "DLP / data protection", parent: "sec_data" },
  { id: "dsec_privacy", label: "Privacy engineering", parent: "sec_data" },
  { id: "dsec_crypto", label: "Cryptography / key management", parent: "sec_data" },

  { id: "sec_ts", label: "Trust & Safety / Fraud", parent: "security" },
  { id: "ts_fraud", label: "Abuse / fraud", parent: "sec_ts" },
  { id: "ts_integrity", label: "Platform / content integrity", parent: "sec_ts" },

  { id: "sec_general", label: "Security (general / other)", parent: "security" },

  // ── SWE ──
  { id: "swe_infra", label: "Infra / Platform / SRE", parent: "swe" },
  { id: "inf_sre", label: "SRE / reliability", parent: "swe_infra" },
  { id: "inf_devops", label: "DevOps / CI-CD / GitOps", parent: "swe_infra" },
  { id: "inf_platform", label: "Platform eng / internal tools", parent: "swe_infra" },
  { id: "inf_cloud", label: "Cloud engineering", parent: "swe_infra" },

  { id: "swe_backend", label: "Backend / Distributed Systems", parent: "swe" },
  { id: "be_api", label: "APIs / services", parent: "swe_backend" },
  { id: "be_distsys", label: "Distributed systems", parent: "swe_backend" },
  { id: "be_db", label: "Databases / storage", parent: "swe_backend" },

  { id: "swe_data", label: "Data / ML", parent: "swe" },
  { id: "da_dataeng", label: "Data engineering", parent: "swe_data" },
  { id: "da_ml", label: "ML / AI engineering", parent: "swe_data" },
  { id: "da_analytics", label: "Analytics", parent: "swe_data" },

  { id: "swe_full", label: "Fullstack / Web / Mobile", parent: "swe" },
  { id: "fs_frontend", label: "Frontend", parent: "swe_full" },
  { id: "fs_fullstack", label: "Fullstack", parent: "swe_full" },
  { id: "fs_mobile", label: "Mobile", parent: "swe_full" },

  { id: "swe_other", label: "Other SWE", parent: "swe" },
  { id: "so_qa", label: "QA / test", parent: "swe_other" },
  { id: "so_embedded", label: "Embedded / hardware", parent: "swe_other" },
  { id: "so_systems", label: "Systems / low-level", parent: "swe_other" },

  // ── Other ──
  { id: "oth_misc", label: "Non-technical / misc", parent: "other" },
];

export const CAT_BY_ID: Record<string, CatNode> = Object.fromEntries(TAXONOMY.map((n) => [n.id, n]));
export const CAT_IDS = TAXONOMY.map((n) => n.id);
export const CAT_CHILDREN: Record<string, string[]> = {};
for (const n of TAXONOMY) if (n.parent) (CAT_CHILDREN[n.parent] ??= []).push(n.id);
export const CAT_LEAVES = TAXONOMY.filter((n) => !CAT_CHILDREN[n.id]).map((n) => n.id);

/** node id → itself + all ancestors (for the rollup/cat_path). */
export function ancestorsOf(id: string): string[] {
  const out: string[] = [];
  let cur: string | null = id;
  while (cur && CAT_BY_ID[cur]) { out.push(cur); cur = CAT_BY_ID[cur].parent; }
  return out;
}
/** node id → itself + all descendants. */
export function subtreeIds(id: string): string[] {
  const out = [id];
  for (const c of CAT_CHILDREN[id] ?? []) out.push(...subtreeIds(c));
  return out;
}
/** Space-delimited rollup closure for a job's leaf tags → SQL-LIKE filtering. */
export function catPath(leafIds: string[]): string {
  const set = new Set<string>();
  for (const id of leafIds) for (const a of ancestorsOf(id)) set.add(a);
  return " " + [...set].join(" ") + " ";
}

// Back-compat: the old flat categories → the closest node in the new taxonomy.
export const LEGACY_CATEGORY_MAP: Record<string, string> = {
  iam: "sec_iam", detection: "sec_det", appsec: "sec_app", cloud_sec: "sec_cloud",
  ai_sec: "sec_ai", security: "sec_general", relevant_swe: "swe_infra",
  swe_infra: "swe_infra", swe_fullstack: "swe_full", swe_data: "swe_data",
  swe_other: "swe_other", other_swe: "swe_other", other: "oth_misc",
};

// legacy exports kept so existing imports compile; CATEGORIES is now all node ids.
export const CATEGORIES = CAT_IDS as readonly string[];
export type Category = string;
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(TAXONOMY.map((n) => [n.id, n.label]));

export function normalizeCategory(raw: unknown): Category {
  const s = String(raw ?? "");
  // Legacy first: some old flat values ("security", "other") collide with new
  // ROOT ids — we want them mapped to a concrete leaf/mid, not the bare root.
  if (LEGACY_CATEGORY_MAP[s]) return LEGACY_CATEGORY_MAP[s];
  if (CAT_BY_ID[s]) return s;
  return "oth_misc";
}

/** AI returns one or more leaf ids; keep valid ones, dedupe, fall back sensibly. */
export function normalizeCategories(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [...new Set(arr.map((x) => normalizeCategory(x)))];
  return out.length ? out : ["oth_misc"];
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
