// Profile-aware job matching: score every job against the candidate's living profile
// (resume.md + extra profile context block, synced into meta by
// scripts/sync_profile.py) and extract the concrete tools/buzzwords the
// posting names — the analytics view aggregates those into project-idea signal.

import Anthropic from "@anthropic-ai/sdk";
import { normalizeCategory, normalizeCategories, catPath, TAXONOMY, CAT_CHILDREN, CAT_BY_ID, type Category } from "./types";
import { fetchUrlText, parseJobText, FORM_JUNK_RE } from "./parse";
import { logUsage } from "./usage";

// One tier up from Haiku for sharper judgment; the cached profile prefix
// (cache_control below) keeps the cost close to Haiku on repeat batches.
const MODEL = "claude-sonnet-4-6";
// Sonnet is slower than Haiku; background (waitUntil) paths apply per-batch, so a
// smaller batch means each chunk persists before the ~30s window closes.
const BATCH = 6;

// The candidate profile is stable for days, but rematches trickle in over hours
// (per-row ♻️, weekly digest). The default 5-min cache expires between them; the
// 1-hour cache keeps the ~11k-token profile prefix warm across a whole session
// of rematches/doc-gen. Needs the extended-cache beta header.
export const EXTENDED_CACHE_HEADER = { "anthropic-beta": "extended-cache-ttl-2025-04-11" };
export const CACHE_1H = { type: "ephemeral" as const, ttl: "1h" as const };

export interface MatchInput {
  id: string;
  company: string;
  title: string;
  location?: string;
  url?: string;
  description?: string;
  requirements?: string;
}

/** Monitor/bulk jobs often arrive with no description (Workday/SmartRecruiters
 *  list APIs don't include one), and raw page dumps read terribly. Fetch the
 *  posting page and run it through the same Haiku extraction as the import
 *  flow → clean markdown description + requirements, persisted for the UI. */
function needsEnrichment(j: MatchInput): boolean {
  const d = j.description ?? "";
  if (!/^https?:\/\//i.test(j.url ?? "")) return false;
  if (d.length < 200) return true;                       // empty / thin
  if (d.length > 800 && !d.includes("\n")) return true;  // old raw-text blob
  if (FORM_JUNK_RE.test(d)) return true;                 // stored application-form junk
  return false;
}

export async function enrichInputs(
  db: D1Database, jobs: MatchInput[], apiKey: string, cap = 6, force = false
): Promise<void> {
  const targets = jobs
    .filter((j) => force ? /^https?:\/\//i.test(j.url ?? "") : needsEnrichment(j))
    .slice(0, cap);
  await Promise.allSettled(targets.map(async (j) => {
    const hadJunk = FORM_JUNK_RE.test(j.description ?? "");
    try {
      const text = await fetchUrlText(j.url!);
      let term = "";
      try {
        const parsed = await parseJobText(text, apiKey, db);
        // never store application-form boilerplate as a description
        j.description = FORM_JUNK_RE.test(parsed.description) ? "" : parsed.description.slice(0, 5000);
        j.requirements = FORM_JUNK_RE.test(parsed.requirements) ? "" : parsed.requirements.slice(0, 5000);
        term = parsed.term;
      } catch {
        // raw beats empty — unless the raw text is itself a form page
        j.description = FORM_JUNK_RE.test(text) ? "" : text.slice(0, 4000);
      }
      await db
        .prepare(`UPDATE jobs SET description = ?, requirements = ?,
                  term = CASE WHEN ? != '' THEN ? ELSE term END WHERE id = ?`)
        .bind(j.description ?? "", j.requirements ?? "", term, term, j.id)
        .run();
    } catch {
      // JS-rendered/bot-blocked: fall back to title matching. If the stored
      // description was application-form junk, clear it — the UI's
      // "couldn't fetch" hint beats form garbage.
      if (hadJunk) {
        j.description = "";
        await db.prepare("UPDATE jobs SET description = '' WHERE id = ?").bind(j.id).run()
          .catch(() => {});
      }
    }
  }));
}

export interface MatchResult {
  id: string;
  match_score: number;
  match_reason: string;
  skills: string[];
  likeability: number | null;
  company_blurb: string;
  category: Category;       // primary leaf (back-compat)
  categories: string[];    // all assigned leaf ids
}

let profileCache: { text: string; at: number } | null = null;
const PROFILE_TTL_MS = 5 * 60 * 1000;

export async function getProfile(db: D1Database): Promise<string> {
  if (profileCache && Date.now() - profileCache.at < PROFILE_TTL_MS) {
    return profileCache.text;
  }
  const rows = await db
    .prepare("SELECT key, value FROM meta WHERE key IN ('profile_resume', 'profile_extra')")
    .all<{ key: string; value: string }>();
  const parts = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  const text = [parts.profile_resume, parts.profile_extra].filter(Boolean).join("\n\n---\n\n");
  if (text) profileCache = { text, at: Date.now() }; // never cache "no profile yet"
  return text;
}

export function clearProfileCache(): void {
  profileCache = null;
}

// Split into a static SYSTEM prefix (profile + rubric — identical across every
// batch and every rematch) and a tiny per-batch user message (just the jobs).
// The system block is cache_control'd so batches 2..N in a run — and repeat
// rematch rounds within the 5-min TTL — hit the prompt cache at ~10% cost
// instead of re-billing the ~11k-token profile every 15 jobs.
const SYSTEM_PROMPT = `You are matching job postings against ONE specific candidate. Below is the candidate's
full profile (master resume + their portfolio assistant's knowledge base):

<candidate_profile>
{PROFILE}
</candidate_profile>

For EACH job the user sends, return:
- "match_score": 0-100 — how strong a fit THIS candidate is. BE HARSH; use the FULL range.
  Scores triage into three tiers by how squarely the role sits in the candidate's actual LANE
  (their specialties, as evidenced by their real projects, certs, and skills above):
  · 85-100 = TOP APPLICANT — squarely in-lane; the role's core day-to-day matches a majority of
    their real projects/certs/skills, right level (intern/new-grad), workable location/term.
    95+ is rare and tailor-made (≤ ~1 in 25); reserve 85 for a clearly in-lane role.
  · 70-84 = RECOMMENDED — adjacent, kinda in their lane; a related domain, or an infra/platform/
    backend role where their specialty is an EXPLICIT part of the mission.
  · 50-69 = TAKE A LOOK — generic overlap (shared tools/cloud/languages) with no real in-lane
    angle, or a tangential/unclear posting. Worth a glance, not a priority.
  · 0-49 = wrong domain, wrong level, wrong location, or no meaningful overlap.
  HARD CAPS (be strict): generic roles with no EXPLICIT in-lane signal cap at 65 no matter the
  brand or tech overlap; frontend/mobile/product-web/hardware ≤ 35; unclear-if-intern,
  non-early-career, or title-only (no description) ≤ 50 — uncertainty is NEVER a reason to
  score high. Only genuinely in-lane roles that match their projects/certs reach 85+. Expect
  most jobs in a batch to land 30-65, with 85+ genuinely rare.
- "match_reason": ≤ 25 words, second person, concrete — point at the specific experience or
  project of theirs that maps to this role. If it's a weak fit, say why in the same style.
- "skills": the concrete tools/technologies/frameworks/buzzwords the POSTING names
  (e.g. "Terraform", "Splunk", "Kubernetes", "OAuth", "Zero Trust", "CrowdStrike", "Python").
  Only what the posting mentions, ≤ 12 items, canonical capitalization, no duplicates.
- "pay": 1-10 — estimated COMPENSATION level for THIS role, independent of fit: the typical
  intern/new-grad total pay for this kind of role at this company. (10 = top-of-market like
  quant/HFT or elite AI; 7-8 = strong big-tech pay; 5-6 = solid median; ≤4 = below-market or
  unknown-low.) Use your knowledge of the company + role; 5 if genuinely unknown.
- "company_blurb": ≤ 40 words — what the company actually does, and what this role's team
  likely works on ("Palantir builds data-integration platforms for defense/intel; FDSE
  interns ship customer-facing pipelines and apps on Foundry/Gotham.").
- "categories": an array of 1-3 of the LEAF ids below that best fit — the DEEPEST/most
  specific leaves, not the parents. A job can span multiple branches: a security-flavored
  SRE role → ["inf_sre","cld_platform"]; an IAM detection role → ["iam_iga","det_eng"].
  Pick the single best if it's clearly one thing. Use only leaf ids from this list:
{CAT_GUIDE}

Return ONLY a JSON array, one object per job, same order as sent:
[{{"i": 0, "match_score": 88, "match_reason": "...", "skills": ["..."], "pay": 7,
  "company_blurb": "...", "categories": ["iam_iga"]}}]
No markdown, no explanation.`;

// A compact leaf reference for the prompt: "leaf_id — Top > Mid > Leaf label".
function catGuide(): string {
  const lines: string[] = [];
  for (const top of TAXONOMY.filter((n) => !n.parent)) {
    for (const midId of CAT_CHILDREN[top.id] ?? []) {
      const mid = CAT_BY_ID[midId];
      const leaves = CAT_CHILDREN[midId];
      if (!leaves) { lines.push(`  ${midId} — ${top.label} > ${mid.label}`); continue; }
      for (const leafId of leaves) lines.push(`  ${leafId} — ${top.label} > ${mid.label} > ${CAT_BY_ID[leafId].label}`);
    }
  }
  return lines.join("\n");
}

/** The cached system prefix (profile + rubric) — shared by the sync and batch
 *  paths so the scoring logic never drifts between them. */
export function buildMatchSystem(profile: string): string {
  return SYSTEM_PROMPT
    .replace("{PROFILE}", profile.slice(0, 40000))
    .replace("{CAT_GUIDE}", catGuide());
}

/** The per-job user payload the model scores. */
export function matchListing(batch: MatchInput[]): string {
  return JSON.stringify(
    batch.map((j, i) => ({
      i,
      company: j.company,
      title: j.title,
      location: j.location ?? "",
      description: (j.description ?? "").slice(0, 3000),
      requirements: (j.requirements ?? "").slice(0, 2000),
    })),
    null,
    1
  );
}

/** Turn one raw model object into a normalized MatchResult for `job`. */
export function normalizeMatchItem(item: Record<string, unknown>, job: MatchInput): MatchResult {
  return {
    id: job.id,
    match_score: Math.min(100, Math.max(0, Math.round(Number(item.match_score) || 0))),
    match_reason: String(item.match_reason ?? "").slice(0, 300),
    skills: Array.isArray(item.skills)
      ? [...new Set(item.skills.map((s) => String(s).slice(0, 40)))].slice(0, 12)
      : [],
    // `pay` (1-10 comp tier) is stored in the legacy `likeability` column.
    likeability: Number.isFinite(Number(item.pay ?? item.likeability))
      ? Math.min(10, Math.max(1, Number(item.pay ?? item.likeability))) : null,
    company_blurb: String(item.company_blurb ?? "").slice(0, 400),
    ...(() => {
      const cats = normalizeCategories(item.categories ?? item.category);
      return { category: cats[0], categories: cats };
    })(),
  };
}

/** Strip fences and parse the model's JSON-array reply. */
export function parseMatchReply(text: string): Array<Record<string, unknown>> {
  return JSON.parse(text.replace(/```(?:json)?/g, "").trim());
}

export { MODEL as MATCH_MODEL };

export async function matchJobs(
  jobs: MatchInput[],
  profile: string,
  apiKey: string,
  db?: D1Database
): Promise<MatchResult[]> {
  if (!profile || !jobs.length) return [];
  const client = new Anthropic({ apiKey, defaultHeaders: EXTENDED_CACHE_HEADER });
  const out: MatchResult[] = [];
  const system = buildMatchSystem(profile); // stable across batches → cache prefix

  for (let start = 0; start < jobs.length; start += BATCH) {
    const batch = jobs.slice(start, start + BATCH);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      system: [{ type: "text", text: system, cache_control: CACHE_1H }],
      messages: [{ role: "user", content: `Jobs:\n${matchListing(batch)}` }],
    });
    if (db) await logUsage(db, "match", MODEL, response.usage);
    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    for (const item of parseMatchReply(raw)) {
      const i = item.i;
      if (typeof i !== "number" || i < 0 || i >= batch.length) continue;
      out.push(normalizeMatchItem(item, batch[i]));
    }
  }
  return out;
}

export async function applyMatches(db: D1Database, results: MatchResult[]): Promise<void> {
  if (!results.length) return;
  const stmt = db.prepare(
    `UPDATE jobs SET match_score = ?, match_reason = ?, skills = ?, category = ?,
     categories = ?, cat_path = ?, likeability = ?, company_blurb = ?, updated_at = ? WHERE id = ?`
  );
  const ts = new Date().toISOString();
  await db.batch(
    results.map((r) =>
      stmt.bind(r.match_score, r.match_reason, JSON.stringify(r.skills), r.category,
                JSON.stringify(r.categories), catPath(r.categories),
                r.likeability, r.company_blurb, ts, r.id)
    )
  );
}

/** Fire-and-forget matching for freshly inserted jobs (bulk/import-list paths). */
export async function matchAndApply(
  db: D1Database,
  jobs: MatchInput[],
  apiKey: string
): Promise<number> {
  try {
    const profile = await getProfile(db);
    if (!profile) return 0;
    await enrichInputs(db, jobs, apiKey);
    // Apply per batch: waitUntil kills long runs (~30s) — incremental writes
    // mean whatever finished is persisted instead of losing everything.
    let applied = 0;
    for (let i = 0; i < jobs.length; i += BATCH) {
      const results = await matchJobs(jobs.slice(i, i + BATCH), profile, apiKey, db);
      await applyMatches(db, results);
      applied += results.length;
    }
    return applied;
  } catch (e) {
    console.error("matchAndApply failed:", e);
    return 0;
  }
}
