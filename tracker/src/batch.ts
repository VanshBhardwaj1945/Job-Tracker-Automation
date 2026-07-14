// Message Batches API path for the weekly rematch — same scoring prompt as the
// live path (imported from match.ts, so no drift), but submitted as an async
// batch at ~50% the per-token cost. One request per job (custom_id = job id),
// which makes result mapping trivial and lets the shared cached profile prefix
// hit the prompt cache across the whole batch.
//
// Flow is intentionally stateless/idempotent across cron runs:
//   submit → store batch id in meta → a later run collects + applies + clears.
// The synchronous /rematch-all remains the default; this is opt-in.

import Anthropic from "@anthropic-ai/sdk";
import {
  applyMatches, buildMatchSystem, matchListing, normalizeMatchItem,
  parseMatchReply, MATCH_MODEL, type MatchInput, type MatchResult,
} from "./match";
import { logUsage } from "./usage";

const META_BATCH_ID = "rematch_batch_id";

async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value).run();
}

/** Submit a rematch batch. Returns the batch id (also stored in meta). */
export async function submitRematchBatch(
  db: D1Database, jobs: MatchInput[], profile: string, apiKey: string
): Promise<{ batch_id: string; count: number }> {
  if (!profile || !jobs.length) return { batch_id: "", count: 0 };
  const client = new Anthropic({ apiKey });
  const system = [{ type: "text" as const, text: buildMatchSystem(profile), cache_control: { type: "ephemeral" as const } }];
  const batch = await client.messages.batches.create({
    requests: jobs.map((j) => ({
      custom_id: j.id,
      params: {
        model: MATCH_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: "user" as const, content: `Jobs:\n${matchListing([j])}` }],
      },
    })),
  });
  await setMeta(db, META_BATCH_ID, batch.id);
  return { batch_id: batch.id, count: jobs.length };
}

/** If a submitted batch has finished, apply its results and clear the pointer.
 *  Safe to call anytime — no-op when there's no batch or it's still running. */
export async function collectRematchBatch(
  db: D1Database, apiKey: string
): Promise<{ status: string; applied: number }> {
  const id = await getMeta(db, META_BATCH_ID);
  if (!id) return { status: "none", applied: 0 };
  const client = new Anthropic({ apiKey });
  const batch = await client.messages.batches.retrieve(id);
  if (batch.processing_status !== "ended") return { status: batch.processing_status, applied: 0 };

  const results: MatchResult[] = [];
  for await (const entry of await client.messages.batches.results(id)) {
    if (entry.result.type !== "succeeded") continue;
    const msg = entry.result.message;
    await logUsage(db, "match_batch", MATCH_MODEL, msg.usage);
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      const arr = parseMatchReply(text);
      if (arr[0]) results.push(normalizeMatchItem(arr[0], { id: entry.custom_id, company: "", title: "" }));
    } catch { /* skip unparseable */ }
  }
  await applyMatches(db, results);
  await db.prepare("DELETE FROM meta WHERE key = ?").bind(META_BATCH_ID).run();
  return { status: "ended", applied: results.length };
}
