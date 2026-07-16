// AI extraction for the "paste a link / paste a description" import flow.
// Same model as the monitor's ai_score.py (cheap, plenty for extraction).

import Anthropic from "@anthropic-ai/sdk";
import { logUsage } from "./usage";

const MODEL = "claude-haiku-4-5-20251001";

export interface ParsedJob {
  company: string;
  title: string;
  location: string;
  description: string;
  requirements: string;
  term: string;
  category: "security" | "relevant_swe" | "other_swe";
}

const PROMPT = `You are extracting structured data from a job posting for a personal job tracker.

The tracker owner is a cybersecurity student (IAM/security engineering focus, also cloud/DevOps/SRE/infra).

From the posting below, extract:
- company: employer name (not the job board)
- title: job title
- location: location(s), short (e.g. "Austin, TX" or "Remote, USA")
- description: the role description — responsibilities, team, what you'd do. Keep the original wording, trimmed of boilerplate (EEO statements, benefits blurbs, "about us" fluff). Preserve list/bullet structure as markdown "- " bullets. Markdown allowed.
- requirements: the qualifications/requirements. Capture EVERY qualifications-style section — "Requirements", "Qualifications", "Basic/Minimum/Preferred Qualifications", "What we're looking for", "You have", "Must have", "Nice to have", "Skills". Keep original wording as "- " bullets. This should almost NEVER be empty for a real posting — if the posting lists any skills/experience/education expectations, they belong here.
- category: "security" (security/cyber/IAM/identity/detection roles), "relevant_swe" (cloud/DevOps/SRE/infra/platform/backend), or "other_swe" (everything else)
- term: the internship term/season if stated, formatted "Summer 2027" (comma-separate if several, e.g. "Fall 2026, Spring 2027"; "" if not stated)

If the text is an APPLICATION FORM or a listing page rather than an actual job posting
(form fields, "Submit application", resume upload prompts, EEO questionnaires), return
empty strings for description and requirements — NEVER include form/boilerplate text.

If a field is genuinely absent, use an empty string. Never invent content.

Posting:
<posting>
{TEXT}
</posting>

Return ONLY a JSON object with keys company, title, location, description, requirements, term, category. No markdown fences, no explanation.`;

export async function parseJobText(text: string, apiKey: string, db?: D1Database): Promise<ParsedJob> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: PROMPT.replace("{TEXT}", text.slice(0, 60000)) }],
  });
  if (db) await logUsage(db, "parse", MODEL, response.usage);
  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```(?:json)?/g, "")
    .trim();
  const parsed = JSON.parse(raw) as ParsedJob;
  if (!parsed.company || !parsed.title) {
    throw new Error("Could not identify a company/title in that text");
  }
  if (!["security", "relevant_swe", "other_swe"].includes(parsed.category)) {
    parsed.category = "other_swe";
  }
  parsed.term = String(parsed.term ?? "").slice(0, 80);
  return parsed;
}

const LIST_PROMPT = `The text below is a copy-paste of a jobs list page (e.g. LinkedIn "My Jobs → Applied",
an ATS dashboard, or a spreadsheet). Extract EVERY distinct job in it.

For each job: company (employer, not the job board), title, location (short, "" if absent),
and url ("" unless a real posting URL appears in the text).

Ignore navigation chrome, ads, "people also viewed", and anything that isn't one of the
user's jobs. Deduplicate exact repeats.

Text:
<pasted>
{TEXT}
</pasted>

Return ONLY a JSON array: [{{"company": "...", "title": "...", "location": "...", "url": ""}}]
No markdown, no explanation.`;

export interface ParsedListJob {
  company: string;
  title: string;
  location: string;
  url: string;
}

/** Parse a pasted jobs-list page (LinkedIn Applied etc.) into individual jobs. */
export async function parseJobList(text: string, apiKey: string, db?: D1Database): Promise<ParsedListJob[]> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: LIST_PROMPT.replace("{TEXT}", text.slice(0, 80000)) }],
  });
  if (db) await logUsage(db, "parse_list", MODEL, response.usage);
  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```(?:json)?/g, "")
    .trim();
  const items = JSON.parse(raw) as Array<Record<string, unknown>>;
  return items
    .map((j) => ({
      company: String(j.company ?? "").trim(),
      title: String(j.title ?? "").trim(),
      location: String(j.location ?? "").trim(),
      url: String(j.url ?? "").trim(),
    }))
    .filter((j) => j.company && j.title);
}

export const FORM_JUNK_RE =
  /(submit (your )?application|attach resume|resume\/cv|autofill with (greenhouse|linkedin)|drop files here)/i;

/** Application-form URLs → posting URLs (the form page has no description). */
function normalizePostingUrl(url: string): string {
  return url
    .replace(/^(https:\/\/jobs\.lever\.co\/[^/]+\/[0-9a-f-]+)\/apply\b.*/i, "$1")
    .replace(/^(https:\/\/jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]+)\/application\b.*/i, "$1")
    .replace(/^(https:\/\/boards\.greenhouse\.io\/[^/]+\/jobs\/\d+)\/.*$/i, "$1");
}

/** Workday postings are JS-rendered, but the CXS JSON API behind them isn't. */
async function fetchWorkdayJson(url: string): Promise<string | null> {
  const m = url.match(
    /^https:\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[\w-]+\/)?([^/]+)\/job\/(.+?)(?:\?.*)?$/i);
  if (!m) return null;
  const [, tenant, wd, board, path] = m;
  const api = `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${board}/job/${path}`;
  const res = await fetch(api, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { jobPostingInfo?: { jobDescription?: string } };
  const html = body.jobPostingInfo?.jobDescription ?? "";
  if (!html) return null;
  return htmlToMarkdown(html);
}

/** Ashby postings are JS-rendered, but the public job-board API isn't. */
async function fetchAshbyJson(url: string): Promise<string | null> {
  const m = url.match(/^https:\/\/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{20,})/i);
  if (!m) return null;
  const [, org, jobId] = m;
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${org}`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { jobs?: Array<{ id: string; descriptionHtml?: string; description?: string }> };
  const job = (body.jobs ?? []).find((j) => j.id === jobId);
  const html = job?.descriptionHtml || job?.description || "";
  if (!html) return null;
  return htmlToMarkdown(html);
}

/** Greenhouse: board API returns the FULL posting as escaped HTML. */
async function fetchGreenhouseJson(url: string): Promise<string | null> {
  const m = url.match(/^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)\/jobs\/(\d+)/i)
    || url.match(/greenhouse\.io\/([\w-]+)[^?]*[?&]gh_jid=(\d+)/i);
  if (!m) return null;
  const [, org, id] = m;
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${id}?questions=false`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { content?: string };
  if (!body.content) return null;
  return htmlToMarkdown(decodeEntities(body.content));
}

/** Lever: postings API returns description text + structured lists. */
async function fetchLeverJson(url: string): Promise<string | null> {
  const m = url.match(/^https?:\/\/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{20,})/i);
  if (!m) return null;
  const [, org, id] = m;
  const res = await fetch(`https://api.lever.co/v0/postings/${org}/${id}`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { description?: string; lists?: Array<{ text?: string; content?: string }>; additional?: string };
  const parts = [
    j.description,
    ...(j.lists ?? []).map((l) => (l.text ? `\n${l.text}\n` : "") + (l.content ?? "")),
    j.additional,
  ].filter(Boolean).join("\n");
  const md = htmlToMarkdown(parts);
  return md.length >= 200 ? md : null;
}

/** Decode common HTML entities (named + numeric). */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&mdash;|&ndash;|&bull;/gi, "-")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/** HTML → structure-preserving markdown: <li> → "- " bullets, block elements →
 *  line breaks, headings → blank lines. Lets the AI find the Requirements
 *  section and makes stored text render as real lists (not a flattened wall). */
export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h[1-6][^>]*>/gi, "\n\n").replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|ul|ol|tr|section|article)>/gi, "\n")
    .replace(/<(p|div|ul|ol|table|section|article)[^>]*>/gi, "\n");
  s = decodeEntities(s.replace(/<[^>]+>/g, " "));
  s = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n");
  return s.replace(/\n{3,}/g, "\n\n").replace(/(?:^|\n)- (?=\n|$)/g, "").trim();
}

/** Pull a JobPosting from a page's JSON-LD (schema.org). Most boards embed the
 *  FULL, clean description here even when the visible page is JS-rendered. */
export function extractJsonLd(html: string): string | null {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const b of blocks) {
    let data: any;
    try { data = JSON.parse(b[1].trim()); } catch { continue; }
    const candidates: any[] = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
    for (const c of candidates) {
      const type = c && c["@type"];
      const isJob = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
      if (!isJob) continue;
      const parts = [c.description, c.responsibilities, c.qualifications, c.skills, c.experienceRequirements]
        .filter((x) => typeof x === "string" && x.length > 20);
      if (!parts.length) continue;
      const md = htmlToMarkdown(parts.join("\n\n"));
      if (md.length >= 200) return md;
    }
  }
  return null;
}

/** Fetch a job posting URL and reduce it to STRUCTURED markdown. Order: board
 *  JSON APIs (clean + complete) → JSON-LD in the page → structured HTML parse. */
export async function fetchUrlText(rawUrl: string): Promise<string> {
  if (!/^https?:\/\//i.test(rawUrl)) throw new Error("only http(s) URLs are supported");
  const url = normalizePostingUrl(rawUrl);
  // 1) Boards with a clean JSON API behind the JS page — best source.
  for (const fetcher of [fetchWorkdayJson, fetchAshbyJson, fetchGreenhouseJson, fetchLeverJson]) {
    try {
      const out = await fetcher(url);
      if (out && out.length >= 250) return out;
    } catch { /* try next */ }
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Fetch failed with HTTP ${res.status}`);
  const html = await res.text();
  // 2) JSON-LD first (complete), then structure-preserving HTML.
  const ld = extractJsonLd(html);
  if (ld && ld.length >= 250) return ld;
  const text = htmlToMarkdown(html);
  if (text.length < 250) {
    throw new Error("Page returned too little text (likely bot-blocked)");
  }
  return text;
}
