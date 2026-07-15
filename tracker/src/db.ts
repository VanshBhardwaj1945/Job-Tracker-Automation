// D1 schema, self-migrating. Terraform can't run SQL, so the worker applies
// versioned migrations on cold start (once per isolate).

import { normalizeCategory, catPath } from "./types";

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      category TEXT NOT NULL DEFAULT 'other_swe',
      ai_score INTEGER,
      ai_reason TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      requirements TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT 'todo',
      importance INTEGER NOT NULL DEFAULT 3,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      email_subject TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_phase ON jobs(phase)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company)`,
    `CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id)`,
  ],
  // v2: profile-aware matching + Found phase + 9-category taxonomy
  [
    `ALTER TABLE jobs ADD COLUMN match_score INTEGER`,
    `ALTER TABLE jobs ADD COLUMN match_reason TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN skills TEXT NOT NULL DEFAULT '[]'`,
    `UPDATE jobs SET phase = 'found' WHERE phase = 'todo'`,
    `UPDATE jobs SET category = 'swe_infra' WHERE category = 'relevant_swe'`,
    `UPDATE jobs SET category = 'swe_other' WHERE category = 'other_swe'`,
  ],
  // v3: watchlist flag — jobs from companies outside companies_master.json
  // (Simplify covers everyone) are kept but labeled + filterable
  [
    `ALTER TABLE jobs ADD COLUMN watchlisted INTEGER NOT NULL DEFAULT 1`,
  ],
  // v4: internship term/season ("Summer 2027", "Fall 2026, Spring 2027", …)
  [
    `ALTER TABLE jobs ADD COLUMN term TEXT NOT NULL DEFAULT ''`,
  ],
  // v5: company desirability (pay/prestige/brand) + what-the-company-is blurb
  [
    `ALTER TABLE jobs ADD COLUMN likeability INTEGER`,
    `ALTER TABLE jobs ADD COLUMN company_blurb TEXT NOT NULL DEFAULT ''`,
  ],
  // v6: saved documents (generated + uploaded PDFs) and Claude token usage log.
  // Text docs (resume/cover/prep/answers) store `content` inline; uploaded
  // PDFs store `r2_key` (bytes live in the DOCS R2 bucket).
  [
    `CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'text',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      r2_key TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id)`,
    `CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts)`,
  ],
  // v7: hierarchical multi-category. `categories` = JSON array of leaf ids;
  // `cat_path` = space-delimited ancestor closure for SQL-LIKE rollup filtering.
  [
    `ALTER TABLE jobs ADD COLUMN categories TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE jobs ADD COLUMN cat_path TEXT NOT NULL DEFAULT ''`,
  ],
  // v8: user-defined favorite buckets ("Dream jobs" …). Empty string = unstarred.
  // match_score moves to a 0-100 scale (no column change — already INTEGER; old
  // 0-10 rows are re-scored by the next rematch).
  [
    `ALTER TABLE jobs ADD COLUMN bucket TEXT NOT NULL DEFAULT ''`,
  ],
];

let migrated = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (migrated) return;
  await db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const row = await db
    .prepare("SELECT MAX(version) AS v FROM _migrations")
    .first<{ v: number | null }>();
  const current = row?.v ?? 0;
  for (let v = current + 1; v <= MIGRATIONS.length; v++) {
    for (const stmt of MIGRATIONS[v - 1]) {
      await db.exec(stmt.replace(/\n\s*/g, " "));
    }
    await db
      .prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)")
      .bind(v, new Date().toISOString())
      .run();
  }
  await backfillCategories(db);
  migrated = true;
}

/** One-time: seed categories/cat_path from the legacy single `category` for rows
 *  the AI hasn't re-tagged yet. Cheap (guarded by cat_path = ''). */
async function backfillCategories(db: D1Database): Promise<void> {
  const rows = await db
    .prepare("SELECT id, category FROM jobs WHERE cat_path = '' LIMIT 500")
    .all<{ id: string; category: string }>();
  if (!rows.results.length) return;
  const stmt = db.prepare("UPDATE jobs SET categories = ?, cat_path = ? WHERE id = ?");
  await db.batch(rows.results.map((r) => {
    const node = normalizeCategory(r.category);
    return stmt.bind(JSON.stringify([node]), catPath([node]), r.id);
  }));
}
