// Token-usage accounting. Every Claude call returns a `usage` block; we persist
// it (per endpoint + model) so the Analytics page can show spend and — crucially
// — the prompt-cache hit rate, which is the whole point of the match.ts caching.

const USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  // base input / output $ per million tokens. Cache write = 1.25× input,
  // cache read = 0.10× input (Anthropic's standard ephemeral-cache multipliers).
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 15, out: 75 },
};

export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Fire-and-forget: never let accounting break a user request. */
export async function logUsage(
  db: D1Database, endpoint: string, model: string, usage?: AnthropicUsage
): Promise<void> {
  if (!usage) return;
  try {
    await db
      .prepare(
        `INSERT INTO usage_log
           (ts, endpoint, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        new Date().toISOString(), endpoint, model,
        usage.input_tokens || 0, usage.output_tokens || 0,
        usage.cache_creation_input_tokens || 0, usage.cache_read_input_tokens || 0
      )
      .run();
  } catch (e) {
    console.error("logUsage failed:", e);
  }
}

/** Total estimated $ spent since an ISO timestamp (for the spend guardrail). */
export async function costSince(db: D1Database, iso: string): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens, SUM(cache_read_tokens) AS cache_read_tokens
       FROM usage_log WHERE ts >= ? GROUP BY model`
    )
    .bind(iso)
    .all<{ model: string; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number }>();
  return rows.results.reduce((s, r) => s + rowCost(r), 0);
}

/** Spend since UTC midnight today. */
export function costToday(db: D1Database): Promise<number> {
  const midnight = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  return costSince(db, midnight);
}

/** Dollar cost of one usage row, using the model's price and cache multipliers. */
export function rowCost(r: {
  model: string; input_tokens: number; output_tokens: number;
  cache_write_tokens: number; cache_read_tokens: number;
}): number {
  const p = USD_PER_MTOK[r.model] ?? { in: 1, out: 5 };
  return (
    r.input_tokens * p.in +
    r.output_tokens * p.out +
    r.cache_write_tokens * p.in * 1.25 +
    r.cache_read_tokens * p.in * 0.1
  ) / 1_000_000;
}
