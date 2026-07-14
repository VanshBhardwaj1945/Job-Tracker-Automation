// REST API. All routes are mounted under /api and sit behind the auth
// middleware in index.ts.

import { Hono } from "hono";
import type { Env, GenKind } from "./types";
import { ACTIVE_PHASES, CATEGORIES, PHASES, GEN_KINDS, DOC_KINDS, makeJobId, normalizeCategory } from "./types";
import { fetchUrlText, parseJobText, parseJobList } from "./parse";
import { getProfile, matchJobs, matchAndApply, clearProfileCache, applyMatches, enrichInputs, type MatchInput } from "./match";
import { docChat, buildDocPrompt, type ChatMessage } from "./docgen";
import { rowCost } from "./usage";
import { submitRematchBatch, collectRematchBatch } from "./batch";
import { markdownToDocx } from "./docxgen";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const api = new Hono<{ Bindings: Env }>();

const now = () => new Date().toISOString();

/** Only http(s) URLs are stored — kills javascript:/data: link injection. */
function cleanUrl(u: unknown): string {
  const s = String(u ?? "").trim();
  return /^https?:\/\//i.test(s) ? s.slice(0, 2000) : "";
}

/** Normalized identity for a posting, IGNORING the URL — so the same role found
 *  on two boards (or found by the monitor and added manually) collapses to one.
 *  Deliberately NOT the id formula (id = sha256(company|title|url), kept in sync
 *  with the monitor's seen_jobs). Strips a trailing term/season so
 *  "SWE Intern - Summer 2026" and "SWE Intern" match. */
function normKey(company: string, title: string): string {
  const n = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const t = n(title)
    .replace(/\b(summer|fall|spring|winter)\b/g, "")
    .replace(/\b20\d\d\b/g, "")
    .replace(/\s+/g, " ").trim();
  return `${n(company)}|${t}`;
}

/** Find an existing job that is the same posting under a different URL/id. */
async function findNormDup(
  db: D1Database, company: string, title: string, excludeId?: string
): Promise<JobRow | null> {
  const key = normKey(company, title);
  const rows = await db.prepare("SELECT * FROM jobs").all<JobRow>();
  return rows.results.find((r) => r.id !== excludeId && normKey(r.company, r.title) === key) ?? null;
}

interface JobRow {
  id: string;
  company: string;
  title: string;
  location: string;
  url: string;
  source: string;
  category: string;
  ai_score: number | null;
  ai_reason: string;
  match_score: number | null;
  match_reason: string;
  skills: string;
  description: string;
  requirements: string;
  phase: string;
  importance: number;
  watchlisted: number;
  term: string;
  likeability: number | null;
  company_blurb: string;
  notes: string;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

const SORTS: Record<string, string> = {
  // triage order: best personal match first, AI score as fallback signal
  rank: `COALESCE(match_score, -1) DESC, COALESCE(ai_score, -1) DESC,
         importance DESC, updated_at DESC`,
  updated: "updated_at DESC",
  created: "created_at DESC",
  applied: "applied_at DESC NULLS LAST",
  score: "COALESCE(match_score, ai_score) DESC NULLS LAST",
  company: "company COLLATE NOCASE ASC, title ASC",
};

// Triage tiers over Found, by profile match score:
// top = in your lane (apply first), rec = strong, look = worth a skim.
const TIER_WHERE: Record<string, string> = {
  top: "phase = 'found' AND match_score >= 8",
  rec: "phase = 'found' AND match_score BETWEEN 6 AND 7",
  look: "phase = 'found' AND match_score BETWEEN 4 AND 5",
};
// legacy alias (digest uses recommended=1): rec-or-better
const RECOMMENDED_WHERE = "phase = 'found' AND match_score >= 6";

// ── List / filter ────────────────────────────────────────────────────────────
api.get("/jobs", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];

  if (q.tier && TIER_WHERE[q.tier]) {
    where.push(`(${TIER_WHERE[q.tier]})`);
  } else if (q.recommended === "1") {
    where.push(`(${RECOMMENDED_WHERE})`);
  } else if (q.phase) {
    const phases = q.phase.split(",").filter((p) => (PHASES as readonly string[]).includes(p));
    if (phases.length) {
      where.push(`phase IN (${phases.map(() => "?").join(",")})`);
      binds.push(...phases);
    }
  }
  if (q.category && (CATEGORIES as readonly string[]).includes(q.category)) {
    where.push("category = ?");
    binds.push(q.category);
  }
  if (q.company) {
    where.push("company LIKE ? COLLATE NOCASE");
    binds.push(`%${q.company}%`);
  }
  if (q.q) {
    where.push("(company LIKE ? COLLATE NOCASE OR title LIKE ? COLLATE NOCASE OR location LIKE ? COLLATE NOCASE)");
    binds.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  if (q.term) {
    where.push("term LIKE ?");
    binds.push(`%${q.term}%`);
  }
  if (q.watchlist === "1" || q.watchlist === "0") {
    where.push("watchlisted = ?");
    binds.push(Number(q.watchlist));
  }
  if (q.min_score) {
    where.push("COALESCE(match_score, ai_score) >= ?");
    binds.push(Number(q.min_score));
  }

  const orderBy = SORTS[q.sort ?? ""] ?? SORTS.rank;
  const sql = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${orderBy} LIMIT 1000`;
  const [jobs, counts, rec, termRows] = await Promise.all([
    c.env.DB.prepare(sql).bind(...binds).all<JobRow>(),
    c.env.DB.prepare("SELECT phase, COUNT(*) AS n FROM jobs GROUP BY phase").all<{ phase: string; n: number }>(),
    c.env.DB.prepare(`SELECT
        SUM(CASE WHEN ${TIER_WHERE.top} THEN 1 ELSE 0 END) AS top,
        SUM(CASE WHEN ${TIER_WHERE.rec} THEN 1 ELSE 0 END) AS rec,
        SUM(CASE WHEN ${TIER_WHERE.look} THEN 1 ELSE 0 END) AS look
      FROM jobs`).first<{ top: number; rec: number; look: number }>(),
    c.env.DB.prepare("SELECT DISTINCT term FROM jobs WHERE term != ''").all<{ term: string }>(),
  ]);
  const termSet = new Set<string>();
  for (const r of termRows.results) {
    for (const t of r.term.split(",").map((x) => x.trim()).filter(Boolean)) termSet.add(t);
  }
  return c.json({
    jobs: jobs.results,
    counts: Object.fromEntries(counts.results.map((r) => [r.phase, r.n])),
    tiers: { top: rec?.top ?? 0, rec: rec?.rec ?? 0, look: rec?.look ?? 0 },
    recommended: (rec?.top ?? 0) + (rec?.rec ?? 0),
    terms: [...termSet].sort(),
  });
});

// ── Single job + its event timeline ──────────────────────────────────────────
api.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!job) return c.json({ error: "not found" }, 404);
  const events = await c.env.DB
    .prepare("SELECT * FROM events WHERE job_id = ? ORDER BY ts DESC LIMIT 100")
    .bind(id)
    .all();
  return c.json({ job, events: events.results });
});

// ── Create one (manual add / import save) ────────────────────────────────────
api.post("/jobs", async (c) => {
  const b = await c.req.json<Partial<JobRow> & { skills?: string | string[] }>();
  if (!b.company || !b.title) return c.json({ error: "company and title are required" }, 400);
  const url = cleanUrl(b.url);
  const id = b.id || (await makeJobId(b.company, b.title, url));
  const existing = await c.env.DB.prepare("SELECT id, phase FROM jobs WHERE id = ?").bind(id).first();
  if (existing) return c.json({ error: "already tracked", id, existing }, 409);

  // Same posting already tracked under a different URL/id (e.g. the monitor
  // found it, now you're adding it manually as 'applied'). Don't duplicate —
  // merge into the existing row: advance its phase, fill any blank fields.
  const dup = await findNormDup(c.env.DB, b.company, b.title);
  if (dup) {
    const ts = now();
    const reqPhase = (PHASES as readonly string[]).includes(b.phase ?? "") ? b.phase! : dup.phase;
    const setApplied = reqPhase !== dup.phase &&
      ["applied", "oa", "interview", "offer", "accepted"].includes(reqPhase) && !dup.applied_at;
    await c.env.DB.prepare(
      `UPDATE jobs SET phase = ?, url = CASE WHEN url = '' THEN ? ELSE url END,
              description = CASE WHEN description = '' THEN ? ELSE description END,
              notes = CASE WHEN notes = '' THEN ? ELSE notes END,
              applied_at = CASE WHEN ? THEN ? ELSE applied_at END, updated_at = ?
       WHERE id = ?`
    ).bind(reqPhase, url, b.description ?? "", b.notes ?? "", setApplied ? 1 : 0, ts, ts, dup.id).run();
    if (reqPhase !== dup.phase) await logEvent(c.env.DB, dup.id, "phase_change", `${dup.phase} → ${reqPhase} (merged duplicate add)`);
    return c.json({ id: dup.id, merged: true, from_phase: dup.phase, to_phase: reqPhase }, 200);
  }

  const ts = now();
  const phase = (PHASES as readonly string[]).includes(b.phase ?? "") ? b.phase! : "found";
  const skills = Array.isArray(b.skills) ? JSON.stringify(b.skills) : (b.skills ?? "[]");
  await c.env.DB
    .prepare(
      `INSERT INTO jobs (id, company, title, location, url, source, category, ai_score, ai_reason,
                         match_score, match_reason, skills, term,
                         description, requirements, phase, importance, notes, created_at, updated_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id, b.company, b.title, b.location ?? "", url, b.source ?? "manual",
      normalizeCategory(b.category),
      b.ai_score ?? null, b.ai_reason ?? "",
      b.match_score ?? null, b.match_reason ?? "", skills, String(b.term ?? "").slice(0, 80),
      b.description ?? "", b.requirements ?? "",
      phase, Math.min(5, Math.max(1, b.importance ?? 3)), b.notes ?? "",
      ts, ts, phase === "applied" ? ts : null
    )
    .run();
  await logEvent(c.env.DB, id, "created", `added via ${b.source ?? "manual"}`);

  // No match data supplied (e.g. manual add without the AI import path) —
  // compute it in the background.
  if (b.match_score == null) {
    const input: MatchInput = {
      id, company: b.company, title: b.title, location: b.location ?? "",
      url, description: b.description ?? "", requirements: b.requirements ?? "",
    };
    c.executionCtx.waitUntil(matchAndApply(c.env.DB, [input], c.env.ANTHROPIC_API_KEY));
  }
  return c.json({ id }, 201);
});

// ── Bulk upsert from the monitor (new rows only; existing rows untouched) ────
api.post("/jobs/bulk", async (c) => {
  const b = await c.req.json<{ jobs: Array<Record<string, unknown>> }>();
  if (!Array.isArray(b.jobs)) return c.json({ error: "jobs array required" }, 400);
  const ts = now();
  const stmt = c.env.DB.prepare(
    `INSERT INTO jobs (id, company, title, location, url, source, category, ai_score, ai_reason,
                       description, watchlisted, term, phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'found', ?, ?)
     ON CONFLICT(id) DO UPDATE SET watchlisted = excluded.watchlisted,
       term = CASE WHEN excluded.term != '' THEN excluded.term ELSE jobs.term END`
  );
  const incoming = b.jobs.slice(0, 500).map((j) => ({
    id: String(j.id ?? ""),
    company: String(j.company ?? "?"),
    title: String(j.title ?? "?"),
    location: String(j.location ?? ""),
    url: cleanUrl(j.url),
    category: normalizeCategory(j.category),
    ai_score: typeof j.ai_score === "number" ? j.ai_score : null,
    ai_reason: String(j.ai_reason ?? ""),
    description: String(j.description ?? "").slice(0, 5000),
    watchlisted: j.watchlisted === 0 || j.watchlisted === false ? 0 : 1,
    term: String(j.term ?? "").slice(0, 80),
  }));
  let inserted: MatchInput[] = []; // carries url → enrichment fetches descriptions
  if (incoming.length) {
    // upsert refreshes the watchlisted flag on existing rows, so meta.changes
    // can't distinguish inserts — check existence explicitly first
    const existing = new Set<string>();
    for (let i = 0; i < incoming.length; i += 80) {
      const chunk = incoming.slice(i, i + 80);
      const rows = await c.env.DB
        .prepare(`SELECT id FROM jobs WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk.map((j) => j.id))
        .all<{ id: string }>();
      for (const r of rows.results) existing.add(r.id);
    }
    // Cross-URL dedup: build a normalized-key → id map of everything already
    // tracked, so a monitor find of a job you added manually (different URL →
    // different id) doesn't create a second row.
    const allRows = await c.env.DB.prepare("SELECT id, company, title FROM jobs")
      .all<{ id: string; company: string; title: string }>();
    const seenKeys = new Map<string, string>();
    for (const r of allRows.results) seenKeys.set(normKey(r.company, r.title), r.id);
    const toUpsert = incoming.filter((j) => {
      if (existing.has(j.id)) return true; // exact match → normal upsert refresh
      const k = normKey(j.company, j.title);
      if (seenKeys.has(k)) return false;   // same posting under another id → skip
      seenKeys.set(k, j.id);               // also dedups within this batch
      return true;
    });
    if (toUpsert.length) {
      await c.env.DB.batch(
        toUpsert.map((j) =>
          stmt.bind(j.id, j.company, j.title, j.location, j.url, "monitor",
                    j.category, j.ai_score, j.ai_reason, j.description, j.watchlisted, j.term, ts, ts)
        )
      );
    }
    inserted = toUpsert.filter((j) => !existing.has(j.id));
  }
  if (inserted.length) {
    c.executionCtx.waitUntil(matchAndApply(c.env.DB, inserted, c.env.ANTHROPIC_API_KEY));
  }
  c.executionCtx.waitUntil(setMeta(c.env.DB, "sys_last_monitor_push",
    JSON.stringify({ ts, received: incoming.length, inserted: inserted.length })));
  return c.json({ received: incoming.length, inserted: inserted.length });
});

// ── Edit (phase changes get an event row) ────────────────────────────────────
api.patch("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<Partial<JobRow>>();
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!job) return c.json({ error: "not found" }, 404);

  const editable = [
    "company", "title", "location", "url", "category", "ai_score", "ai_reason",
    "description", "requirements", "phase", "importance", "notes", "applied_at", "watchlisted", "term",
  ] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of editable) {
    if (!(f in b)) continue;
    let v: unknown = b[f];
    if (f === "phase" && !(PHASES as readonly string[]).includes(String(v))) continue;
    if (f === "category") v = normalizeCategory(v);
    if (f === "importance") v = Math.min(5, Math.max(1, Number(v) || 3));
    sets.push(`${f} = ?`);
    binds.push(v);
  }
  if (!sets.length) return c.json({ error: "no valid fields" }, 400);

  const ts = now();
  if (b.phase && b.phase !== job.phase) {
    await logEvent(c.env.DB, id, "phase_change", `${job.phase} → ${b.phase}`);
    if (b.phase === "applied" && !job.applied_at && !("applied_at" in b)) {
      sets.push("applied_at = ?");
      binds.push(ts);
    }
  }
  sets.push("updated_at = ?");
  binds.push(ts, id);
  await c.env.DB.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  const updated = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  return c.json({ job: updated });
});

api.delete("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM events WHERE job_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

// ── AI import: paste a URL or raw description, get a draft (with match) ──────
api.post("/import", async (c) => {
  const b = await c.req.json<{ url?: string; text?: string }>();
  let text = (b.text ?? "").trim();
  const url = cleanUrl(b.url);

  if (!text && !url) {
    return c.json({ error: (b.url ?? "").trim() ? "only http(s) URLs are supported" : "provide url or text" }, 400);
  }
  if (!text) {
    try {
      text = await fetchUrlText(url);
    } catch (e) {
      return c.json(
        { error: `Couldn't fetch that page (${(e as Error).message}). Paste the job description text instead.` },
        422
      );
    }
  }

  let draft;
  try {
    draft = await parseJobText(text, c.env.ANTHROPIC_API_KEY, c.env.DB);
  } catch (e) {
    return c.json({ error: `AI extraction failed: ${(e as Error).message}` }, 502);
  }
  const id = await makeJobId(draft.company, draft.title, url);

  // Match against the profile right away — description is available here,
  // so this is the highest-quality match we can produce.
  let match: { match_score?: number; match_reason?: string; skills?: string[]; category?: string } = {};
  try {
    const profile = await getProfile(c.env.DB);
    if (profile) {
      const [m] = await matchJobs(
        [{ id, company: draft.company, title: draft.title, location: draft.location,
           description: draft.description, requirements: draft.requirements }],
        profile,
        c.env.ANTHROPIC_API_KEY
      );
      if (m) match = { match_score: m.match_score, match_reason: m.match_reason,
                       skills: m.skills, category: m.category };
    }
  } catch (e) {
    console.error("import match failed:", e); // draft still returns without match
  }

  const existing = await c.env.DB
    .prepare("SELECT id, phase FROM jobs WHERE id = ?")
    .bind(id)
    .first<{ id: string; phase: string }>();
  return c.json({
    draft: { ...draft, ...match, url, id, source: url ? "link" : "pasted" },
    duplicate: existing ?? null,
  });
});

// ── Bulk paste-import (LinkedIn "Applied" page dump etc.) ────────────────────
api.post("/import-list", async (c) => {
  const b = await c.req.json<{ text: string; phase?: string }>();
  const text = (b.text ?? "").trim();
  if (!text) return c.json({ error: "text required" }, 400);
  const phase = (PHASES as readonly string[]).includes(b.phase ?? "") ? b.phase! : "applied";

  let parsed;
  try {
    parsed = await parseJobList(text, c.env.ANTHROPIC_API_KEY, c.env.DB);
  } catch (e) {
    return c.json({ error: `AI extraction failed: ${(e as Error).message}` }, 502);
  }
  if (!parsed.length) return c.json({ error: "no jobs found in that text" }, 422);

  const ts = now();
  const created: Array<{ id: string; company: string; title: string }> = [];
  const skipped: Array<{ company: string; title: string; phase: string }> = [];
  for (const j of parsed.slice(0, 100)) {
    const jUrl = cleanUrl(j.url);
    const id = await makeJobId(j.company, j.title, jUrl);
    const existing = await c.env.DB
      .prepare("SELECT id, phase FROM jobs WHERE id = ?")
      .bind(id)
      .first<{ id: string; phase: string }>();
    if (existing) {
      // Already tracked — if it was only "found" and we now know it's applied, flip it.
      if (existing.phase === "found" && phase === "applied") {
        await c.env.DB
          .prepare("UPDATE jobs SET phase = 'applied', applied_at = COALESCE(applied_at, ?), updated_at = ? WHERE id = ?")
          .bind(ts, ts, id)
          .run();
        await logEvent(c.env.DB, id, "phase_change", "found → applied (bulk import)");
        created.push({ id, company: j.company, title: j.title });
      } else {
        skipped.push({ company: j.company, title: j.title, phase: existing.phase });
      }
      continue;
    }
    await c.env.DB
      .prepare(
        `INSERT INTO jobs (id, company, title, location, url, source, category, phase,
                           importance, created_at, updated_at, applied_at)
         VALUES (?, ?, ?, ?, ?, 'linkedin_paste', 'other', ?, 3, ?, ?, ?)`
      )
      .bind(id, j.company, j.title, j.location, jUrl, phase, ts, ts,
            phase === "applied" ? ts : null)
      .run();
    await logEvent(c.env.DB, id, "created", "bulk import");
    created.push({ id, company: j.company, title: j.title });
  }

  const toMatch: MatchInput[] = created.map((j) => {
    const p = parsed.find((x) => x.company === j.company && x.title === j.title);
    return { id: j.id, company: j.company, title: j.title, location: p?.location ?? "" };
  });
  if (toMatch.length) {
    c.executionCtx.waitUntil(matchAndApply(c.env.DB, toMatch, c.env.ANTHROPIC_API_KEY));
  }
  return c.json({ created, skipped, phase });
});

// ── Tailored document chat (Opus 4.8): resume / cover letter / prep / answers ──
// Back-compat: /resume == /doc/resume (the original UI hit /resume).
api.post("/jobs/:id/resume", (c) => docRoute(c, "resume"));
api.post("/jobs/:id/doc/:kind", (c) => docRoute(c, c.req.param("kind")));

async function docRoute(c: any, rawKind: string) {
  const kind = rawKind as GenKind;
  if (!GEN_KINDS.includes(kind)) return c.json({ error: "unknown document kind" }, 400);
  const id = c.req.param("id");
  const job = (await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first()) as JobRow | null;
  if (!job) return c.json({ error: "not found" }, 404);
  const b = (await c.req.json()) as { messages?: ChatMessage[]; master_override?: string };
  const messages = (b.messages ?? [])
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 20000) }));
  try {
    const reply = await docChat(
      c.env, c.env.DB, kind,
      { company: job.company, title: job.title, location: job.location, term: job.term,
        description: job.description, requirements: job.requirements,
        match_reason: job.match_reason, skills: job.skills },
      messages,
      (b.master_override ?? "").trim() || undefined
    );
    return c.json({ reply });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
}

// Pro-plan money-saver: return the full self-contained prompt for a doc kind so
// the user can paste it into Claude.ai (covered by their subscription — $0 API)
// and save the result back. No API call is made here.
api.post("/jobs/:id/doc-prompt/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!GEN_KINDS.includes(kind as GenKind)) return c.json({ error: "unknown document kind" }, 400);
  const id = c.req.param("id");
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!job) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ master_override?: string }>().catch(() => ({} as { master_override?: string }));
  try {
    const prompt = await buildDocPrompt(
      c.env, c.env.DB, kind as GenKind,
      { company: job.company, title: job.title, location: job.location, term: job.term,
        description: job.description, requirements: job.requirements,
        match_reason: job.match_reason, skills: job.skills },
      (b.master_override ?? "").trim() || undefined
    );
    return c.json({ prompt });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ── Saved documents (generated text + uploaded PDFs in R2) ───────────────────
interface ArtifactRow {
  id: string; job_id: string; kind: string; format: string; title: string;
  content: string; r2_key: string; filename: string; size: number; created_at: string;
}

// Save a generated document (resume/cover letter/prep/answers chat output).
api.post("/jobs/:id/artifacts", async (c) => {
  const id = c.req.param("id");
  const job = await c.env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(id).first();
  if (!job) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ kind?: string; title?: string; content?: string }>();
  if (!GEN_KINDS.includes(b.kind as GenKind)) return c.json({ error: "unknown document kind" }, 400);
  const content = (b.content ?? "").slice(0, 100000);
  if (!content.trim()) return c.json({ error: "nothing to save" }, 400);
  const aid = crypto.randomUUID();
  await c.env.DB
    .prepare(`INSERT INTO artifacts (id, job_id, kind, format, title, content, created_at)
              VALUES (?, ?, ?, 'text', ?, ?, ?)`)
    .bind(aid, id, b.kind, (b.title ?? "").slice(0, 200), content, now())
    .run();
  return c.json({ id: aid }, 201);
});

// List a job's saved documents (metadata only — content fetched on open).
api.get("/jobs/:id/artifacts", async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT id, job_id, kind, format, title, filename, size, created_at
              FROM artifacts WHERE job_id = ? ORDER BY created_at DESC`)
    .bind(c.req.param("id"))
    .all<ArtifactRow>();
  return c.json({ artifacts: rows.results });
});

// Full artifact — text content for generated docs; metadata for PDF uploads.
api.get("/artifacts/:aid", async (c) => {
  const row = await c.env.DB
    .prepare("SELECT * FROM artifacts WHERE id = ?").bind(c.req.param("aid")).first<ArtifactRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ artifact: { ...row, r2_key: undefined } });
});

// Stream an uploaded PDF back from R2.
api.get("/artifacts/:aid/file", async (c) => {
  const row = await c.env.DB
    .prepare("SELECT * FROM artifacts WHERE id = ?").bind(c.req.param("aid")).first<ArtifactRow>();
  if (!row || !row.r2_key) return c.json({ error: "not found" }, 404);
  const obj = await c.env.DOCS.get(row.r2_key);
  if (!obj) return c.json({ error: "file missing from storage" }, 404);
  const dl = c.req.query("dl") === "1";
  const mime = row.format === "docx" ? DOCX_MIME : "application/pdf";
  const fallbackName = `document.${row.format === "docx" ? "docx" : "pdf"}`;
  return new Response(obj.body, {
    headers: {
      "Content-Type": mime,
      // docx can't render inline — always download it
      "Content-Disposition":
        `${dl || row.format === "docx" ? "attachment" : "inline"}; filename="${(row.filename || fallbackName).replace(/["\\]/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// Upload a PDF or DOCX you actually submitted → R2 (kind: upload_resume / upload_cover_letter / upload_other).
api.post("/jobs/:id/upload", async (c) => {
  const id = c.req.param("id");
  const job = await c.env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(id).first();
  if (!job) return c.json({ error: "not found" }, 404);
  const kindRaw = c.req.query("kind") ?? "upload_other";
  const kind = DOC_KINDS.includes(kindRaw as any) && kindRaw.startsWith("upload_") ? kindRaw : "upload_other";
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: "no file uploaded" }, 400);
  if (file.size > 15 * 1024 * 1024) return c.json({ error: "file too large (max 15MB)" }, 413);
  const lower = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");
  const isDocx = file.type === DOCX_MIME || lower.endsWith(".docx");
  if (!isPdf && !isDocx) return c.json({ error: "only PDF or DOCX uploads are supported" }, 415);
  const fmt = isDocx ? "docx" : "pdf";
  const aid = crypto.randomUUID();
  const key = `uploads/${id}/${aid}.${fmt}`;
  await c.env.DOCS.put(key, await file.arrayBuffer(),
    { httpMetadata: { contentType: isDocx ? DOCX_MIME : "application/pdf" } });
  await c.env.DB
    .prepare(`INSERT INTO artifacts (id, job_id, kind, format, title, r2_key, filename, size, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(aid, id, kind, fmt, (String(form.title ?? "") || file.name).slice(0, 200),
          key, file.name.slice(0, 200), file.size, now())
    .run();
  return c.json({ id: aid }, 201);
});

// Convert markdown doc content → styled .docx (Cambria resume template).
// Works on the live chat output or any saved artifact — client sends content.
api.post("/docx", async (c) => {
  const b = await c.req.json<{ content?: string; filename?: string }>();
  const content = (b.content ?? "").trim();
  if (!content) return c.json({ error: "no content" }, 400);
  if (content.length > 200000) return c.json({ error: "content too large" }, 413);
  const name = (b.filename || "document").replace(/[^\w.\- ]+/g, "").replace(/\.docx$/i, "").slice(0, 120) || "document";
  try {
    const bytes = await markdownToDocx(content);
    return new Response(bytes, {
      headers: {
        "Content-Type": DOCX_MIME,
        "Content-Disposition": `attachment; filename="${name}.docx"`,
      },
    });
  } catch (e) {
    return c.json({ error: `docx build failed: ${(e as Error).message}` }, 500);
  }
});

// Delete a saved document (and its R2 object, if any).
api.delete("/artifacts/:aid", async (c) => {
  const row = await c.env.DB
    .prepare("SELECT * FROM artifacts WHERE id = ?").bind(c.req.param("aid")).first<ArtifactRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.r2_key) await c.env.DOCS.delete(row.r2_key).catch(() => {});
  await c.env.DB.prepare("DELETE FROM artifacts WHERE id = ?").bind(row.id).run();
  return c.json({ ok: true });
});

// ── Re-match (after profile updates) ─────────────────────────────────────────
api.post("/jobs/:id/rematch", async (c) => {
  const id = c.req.param("id");
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!job) return c.json({ error: "not found" }, 404);
  const profile = await getProfile(c.env.DB);
  if (!profile) return c.json({ error: "no profile synced yet — run scripts/sync_profile.py" }, 409);
  try {
    const input = { id: job.id, company: job.company, title: job.title, location: job.location,
                    url: job.url, description: job.description, requirements: job.requirements };
    await enrichInputs(c.env.DB, [input], c.env.ANTHROPIC_API_KEY, 1, true); // user asked — always refetch
    const results = await matchJobs([input], profile, c.env.ANTHROPIC_API_KEY, c.env.DB);
    await applyMatches(c.env.DB, results);
  } catch (e) {
    return c.json({ error: `match failed: ${(e as Error).message}` }, 502);
  }
  const updated = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  return c.json({ job: updated });
});

api.post("/rematch-all", async (c) => {
  const q = c.req.query();
  const onlyMissing = q.all !== "1"; // default: only jobs without match data
  const profile = await getProfile(c.env.DB);
  if (!profile) return c.json({ error: "no profile synced yet — run scripts/sync_profile.py" }, 409);
  const rows = await c.env.DB
    .prepare(
      `SELECT id, company, title, location, url, description, requirements FROM jobs
       WHERE phase IN (${ACTIVE_PHASES.map(() => "?").join(",")})
       ${onlyMissing ? "AND match_score IS NULL" : ""}
       ORDER BY updated_at ASC
       LIMIT 45`
    )
    .bind(...ACTIVE_PHASES)
    .all<MatchInput>();
  if (rows.results.length) {
    c.executionCtx.waitUntil(matchAndApply(c.env.DB, rows.results, c.env.ANTHROPIC_API_KEY));
  }
  return c.json({ queued: rows.results.length });
});

// ── Batch rematch (Message Batches API, ~50% cheaper, async) ──────────────────
// Weekly digest calls collect (applies the prior batch) then submit (queues the
// next). Idempotent: the batch id lives in meta; the sync path stays the default.
api.post("/rematch-batch", async (c) => {
  const q = c.req.query();
  const onlyMissing = q.all !== "1";
  const cap = Math.min(500, Math.max(1, Number(q.cap) || 200));
  const profile = await getProfile(c.env.DB);
  if (!profile) return c.json({ error: "no profile synced yet — run scripts/sync_profile.py" }, 409);
  const rows = await c.env.DB
    .prepare(
      `SELECT id, company, title, location, url, description, requirements FROM jobs
       WHERE phase IN (${ACTIVE_PHASES.map(() => "?").join(",")})
       ${onlyMissing ? "AND match_score IS NULL" : ""}
       ORDER BY updated_at ASC
       LIMIT ${cap}`
    )
    .bind(...ACTIVE_PHASES)
    .all<MatchInput>();
  if (!rows.results.length) return c.json({ batch_id: "", count: 0 });
  try {
    // enrich thin descriptions first (bounded) so batch scoring has real content
    await enrichInputs(c.env.DB, rows.results, c.env.ANTHROPIC_API_KEY, 20);
    const res = await submitRematchBatch(c.env.DB, rows.results, profile, c.env.ANTHROPIC_API_KEY);
    return c.json(res);
  } catch (e) {
    return c.json({ error: `batch submit failed: ${(e as Error).message}` }, 502);
  }
});

api.post("/rematch-batch/collect", async (c) => {
  try {
    return c.json(await collectRematchBatch(c.env.DB, c.env.ANTHROPIC_API_KEY));
  } catch (e) {
    return c.json({ error: `batch collect failed: ${(e as Error).message}` }, 502);
  }
});

// ── Analytics ────────────────────────────────────────────────────────────────
const APPLIED_PLUS = ["applied", "oa", "interview", "offer", "accepted", "rejected"];

api.get("/stats", async (c) => {
  const db = c.env.DB;
  const appliedIn = APPLIED_PLUS.map(() => "?").join(",");
  const [phases, categories, weekly, companies, skillRows, matchHist,
         sources, monthly, locations, timings] = await Promise.all([
    db.prepare("SELECT phase, COUNT(*) AS n FROM jobs GROUP BY phase").all<{ phase: string; n: number }>(),
    db.prepare(`SELECT category, COUNT(*) AS n,
                       SUM(CASE WHEN phase IN (${appliedIn}) THEN 1 ELSE 0 END) AS applied
                FROM jobs GROUP BY category ORDER BY n DESC`)
      .bind(...APPLIED_PLUS)
      .all<{ category: string; n: number; applied: number }>(),
    db.prepare(`SELECT strftime('%Y-%W', applied_at) AS wk, COUNT(*) AS n
                FROM jobs WHERE applied_at IS NOT NULL
                GROUP BY wk ORDER BY wk DESC LIMIT 26`)
      .all<{ wk: string; n: number }>(),
    db.prepare(`SELECT company, COUNT(*) AS n,
                       SUM(CASE WHEN phase IN (${appliedIn}) THEN 1 ELSE 0 END) AS applied
                FROM jobs GROUP BY company ORDER BY applied DESC, n DESC LIMIT 20`)
      .bind(...APPLIED_PLUS)
      .all<{ company: string; n: number; applied: number }>(),
    db.prepare("SELECT skills, phase FROM jobs WHERE skills != '[]'")
      .all<{ skills: string; phase: string }>(),
    db.prepare(`SELECT COALESCE(match_score, -1) AS s, COUNT(*) AS n
                FROM jobs GROUP BY s ORDER BY s`)
      .all<{ s: number; n: number }>(),
    db.prepare("SELECT source, COUNT(*) AS n FROM jobs GROUP BY source ORDER BY n DESC")
      .all<{ source: string; n: number }>(),
    db.prepare(`SELECT strftime('%Y-%m', applied_at) AS mo, COUNT(*) AS n
                FROM jobs WHERE applied_at IS NOT NULL
                GROUP BY mo ORDER BY mo DESC LIMIT 12`)
      .all<{ mo: string; n: number }>(),
    db.prepare(`SELECT location, COUNT(*) AS n FROM jobs
                WHERE location != '' GROUP BY location ORDER BY n DESC LIMIT 12`)
      .all<{ location: string; n: number }>(),
    // avg days from application to first rejection / interview signal
    db.prepare(
      `SELECT
         AVG(CASE WHEN e.type = 'email_rejected' OR (e.type = 'phase_change' AND e.detail LIKE '%→ rejected')
                  THEN julianday(e.ts) - julianday(j.applied_at) END) AS days_to_rejection,
         AVG(CASE WHEN e.type IN ('email_interview', 'email_oa') OR (e.type = 'phase_change' AND (e.detail LIKE '%→ interview' OR e.detail LIKE '%→ oa'))
                  THEN julianday(e.ts) - julianday(j.applied_at) END) AS days_to_interview
       FROM events e JOIN jobs j ON j.id = e.job_id
       WHERE j.applied_at IS NOT NULL AND julianday(e.ts) >= julianday(j.applied_at)`
    ).first<{ days_to_rejection: number | null; days_to_interview: number | null }>(),
  ]);

  // Skills frequency: everywhere vs in jobs actually applied to (project-idea signal).
  const all = new Map<string, number>();
  const applied = new Map<string, number>();
  for (const row of skillRows.results) {
    let skills: string[] = [];
    try { skills = JSON.parse(row.skills); } catch { /* ignore bad rows */ }
    for (const s of skills) {
      all.set(s, (all.get(s) ?? 0) + 1);
      if (APPLIED_PLUS.includes(row.phase)) applied.set(s, (applied.get(s) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([skill, count]) => ({ skill, count }));

  // ── Claude token usage / spend / cache effectiveness ──
  type URow = {
    model: string; endpoint: string; input_tokens: number; output_tokens: number;
    cache_write_tokens: number; cache_read_tokens: number; calls: number;
  };
  const usageRows = await db
    .prepare(
      `SELECT model, endpoint,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
              COUNT(*) AS calls
       FROM usage_log GROUP BY model, endpoint`
    )
    .all<URow>();
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const cost30 = await db
    .prepare(
      `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens, SUM(cache_read_tokens) AS cache_read_tokens
       FROM usage_log WHERE ts >= ? GROUP BY model`
    )
    .bind(since30)
    .all<URow>();
  const t = { input: 0, output: 0, cache_write: 0, cache_read: 0, calls: 0, cost: 0 };
  const byEndpoint = usageRows.results.map((r) => {
    const cost = rowCost(r);
    t.input += r.input_tokens; t.output += r.output_tokens;
    t.cache_write += r.cache_write_tokens; t.cache_read += r.cache_read_tokens;
    t.calls += r.calls; t.cost += cost;
    return { endpoint: r.endpoint, model: r.model, calls: r.calls,
             input: r.input_tokens, output: r.output_tokens,
             cache_write: r.cache_write_tokens, cache_read: r.cache_read_tokens, cost };
  }).sort((a, b) => b.cost - a.cost);
  // Of the cacheable prefix tokens, how many were served from cache?
  const cacheable = t.cache_read + t.cache_write;
  const usage = {
    totals: { ...t, cache_hit_rate: cacheable ? t.cache_read / cacheable : null },
    by_endpoint: byEndpoint,
    cost_30d: cost30.results.reduce((s, r) => s + rowCost(r), 0),
  };

  return c.json({
    phases: Object.fromEntries(phases.results.map((r) => [r.phase, r.n])),
    categories: categories.results,
    weekly: weekly.results.reverse(),
    monthly: monthly.results.reverse(),
    companies: companies.results,
    sources: sources.results,
    locations: locations.results,
    skills: { all: top(all, 25), applied: top(applied, 25) },
    match_histogram: matchHist.results,
    timings: {
      days_to_rejection: timings?.days_to_rejection ?? null,
      days_to_interview: timings?.days_to_interview ?? null,
    },
    usage,
  });
});

// ── CSV export (data portability / spreadsheets) ─────────────────────────────
api.get("/export", async (c) => {
  const rows = await c.env.DB
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC")
    .all<JobRow>();
  const cols = ["id","company","title","location","url","source","category","phase",
                "importance","watchlisted","term","likeability","ai_score","match_score","match_reason","skills",
                "notes","created_at","updated_at","applied_at"] as const;
  const cell = (v: unknown) => {
    let s = String(v ?? "");
    // formula-injection guard for Excel/Sheets
    if (/^[=+\-@\t]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [cols.join(",")]
    .concat(rows.results.map((r) => cols.map((k) => cell(r[k])).join(",")))
    .join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="job-tracker-${now().slice(0, 10)}.csv"`,
    },
  });
});

// ── Email events from gmail_watch.py ─────────────────────────────────────────
// rejected → auto-flip phase. interview/offer/oa/update → event row only.
api.post("/email-event", async (c) => {
  const b = await c.req.json<{ company: string; verdict: string; subject?: string; detail?: string }>();
  const verdict = String(b.verdict ?? "").toLowerCase();
  if (!b.company || !["rejected", "interview", "offer", "oa", "update"].includes(verdict)) {
    return c.json({ error: "company and a valid verdict required" }, 400);
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(b.company);
  const active = await c.env.DB
    .prepare(`SELECT id, company, title, phase FROM jobs WHERE phase IN (${ACTIVE_PHASES.map(() => "?").join(",")})`)
    .bind(...ACTIVE_PHASES)
    .all<{ id: string; company: string; title: string; phase: string }>();

  const match =
    active.results.find((j) => norm(j.company) === target) ??
    active.results.find((j) => norm(j.company).includes(target) || target.includes(norm(j.company)));

  if (!match) return c.json({ matched: null, action: "none" });

  await logEvent(c.env.DB, match.id, `email_${verdict}`, b.detail ?? "", b.subject ?? "");
  let action = "event_logged";
  if (verdict === "rejected") {
    await c.env.DB
      .prepare("UPDATE jobs SET phase = 'rejected', updated_at = ? WHERE id = ?")
      .bind(now(), match.id)
      .run();
    action = "phase_set_rejected";
  }
  return c.json({ matched: match, action });
});

// ── Meta (gmail watcher checkpoint, profile docs) ────────────────────────────
api.get("/meta/:key", async (c) => {
  const row = await c.env.DB
    .prepare("SELECT value FROM meta WHERE key = ?")
    .bind(c.req.param("key"))
    .first<{ value: string }>();
  return c.json({ key: c.req.param("key"), value: row?.value ?? null });
});

api.put("/meta/:key", async (c) => {
  const key = c.req.param("key");
  const b = await c.req.json<{ value: string }>();
  await setMeta(c.env.DB, key, String(b.value));
  if (key.startsWith("profile_")) {
    clearProfileCache();
    await setMeta(c.env.DB, "sys_last_profile_sync",
      JSON.stringify({ ts: now(), key, chars: String(b.value).length }));
  }
  return c.json({ ok: true });
});

async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

// ── Activity feed: workflow runs + system heartbeats + recent job events ─────
api.get("/activity", async (c) => {
  const db = c.env.DB;
  const hbKeys = [
    "sys_last_monitor", "sys_last_monitor_push", "sys_last_gmail",
    "sys_last_profile_sync", "gmail_uid",
  ];
  const [hbRows, events] = await Promise.all([
    db.prepare(`SELECT key, value FROM meta WHERE key IN (${hbKeys.map(() => "?").join(",")})`)
      .bind(...hbKeys)
      .all<{ key: string; value: string }>(),
    db.prepare(
      `SELECT e.ts, e.type, e.detail, e.email_subject, j.company, j.title, j.id AS job_id
       FROM events e LEFT JOIN jobs j ON j.id = e.job_id
       ORDER BY e.ts DESC LIMIT 30`
    ).all(),
  ]);
  const heartbeats: Record<string, unknown> = {};
  for (const r of hbRows.results) {
    try { heartbeats[r.key] = JSON.parse(r.value); }
    catch { heartbeats[r.key] = r.value; }
  }

  // Workflow runs straight from GitHub Actions (needs GITHUB_TOKEN once repo is private)
  let runs: unknown[] | null = null;
  let runsError: string | null = null;
  if (c.env.GITHUB_REPO) {
    try {
      const headers: Record<string, string> = {
        "User-Agent": "job-tracker-worker",
        Accept: "application/vnd.github+json",
      };
      if (c.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${c.env.GITHUB_TOKEN}`;
      const res = await fetch(
        `https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/runs?per_page=20`,
        { headers }
      );
      if (!res.ok) {
        runsError = `GitHub API ${res.status}${res.status === 404 ? " (private repo — set the github_token terraform var)" : ""}`;
      } else {
        const body = (await res.json()) as { workflow_runs: Array<Record<string, any>> };
        runs = body.workflow_runs.map((r) => ({
          name: r.name,
          event: r.event,
          status: r.status,
          conclusion: r.conclusion,
          started_at: r.run_started_at,
          updated_at: r.updated_at,
          url: r.html_url,
          run_number: r.run_number,
        }));
      }
    } catch (e) {
      runsError = (e as Error).message;
    }
  } else {
    runsError = "GITHUB_REPO not configured";
  }

  return c.json({ heartbeats, runs, runs_error: runsError, events: events.results });
});

async function logEvent(db: D1Database, jobId: string, type: string, detail = "", subject = "") {
  await db
    .prepare("INSERT INTO events (job_id, ts, type, detail, email_subject) VALUES (?, ?, ?, ?, ?)")
    .bind(jobId, now(), type, detail, subject)
    .run();
}
