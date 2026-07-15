// Per-job document generation — chat-style, Opus 4.8. One shared context block
// (synced resume.md + extra-context knowledge base + live GitHub repos + live
// example.com + the job posting) drives four document kinds. The context
// is identical across kinds for a given job, so cache_control on it means asking
// for a cover letter right after a resume reuses the cached prefix at ~10% cost.

import Anthropic from "@anthropic-ai/sdk";
import type { Env, GenKind } from "./types";
import { getProfile, EXTENDED_CACHE_HEADER, CACHE_1H } from "./match";
import { logUsage, costToday } from "./usage";

const MODEL = "claude-opus-4-8";
const DEFAULT_DAILY_CAP_USD = 3;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface JobCtx {
  company: string;
  title: string;
  location: string;
  term: string;
  description: string;
  requirements: string;
  match_reason: string;
  skills: string;
}

let ghCache: { text: string; at: number } | null = null;
let siteCache: { text: string; at: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000;

async function githubSummary(env: Env): Promise<string> {
  if (!env.GITHUB_USERNAME) return ""; // optional context — off unless configured
  if (ghCache && Date.now() - ghCache.at < CACHE_TTL) return ghCache.text;
  try {
    const headers: Record<string, string> = {
      "User-Agent": "job-tracker-worker",
      Accept: "application/vnd.github+json",
    };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const res = await fetch(
      `https://api.github.com/users/${env.GITHUB_USERNAME}/repos?sort=updated&per_page=20`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return "";
    const repos = (await res.json()) as Array<Record<string, any>>;
    const text = repos
      .filter((r) => !r.fork)
      .map((r) => `- ${r.name} (${r.language ?? "?"}${r.stargazers_count ? `, ${r.stargazers_count} stars` : ""}): ${r.description ?? ""}`)
      .join("\n");
    ghCache = { text, at: Date.now() };
    return text;
  } catch {
    return "";
  }
}

async function siteText(env: Env): Promise<string> {
  if (!env.PORTFOLIO_URL) return ""; // optional context — off unless configured
  if (siteCache && Date.now() - siteCache.at < CACHE_TTL) return siteCache.text;
  try {
    const res = await fetch(env.PORTFOLIO_URL, {
      headers: { "User-Agent": "job-tracker-worker" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5000);
    siteCache = { text, at: Date.now() };
    return text;
  } catch {
    return "";
  }
}

const COMMON = `Using ONLY real facts from the candidate's materials above (resume, extra profile context, live site, GitHub) — never invent experience, metrics, tools, dates, or names — produce the
document below, tailored to the specific job. Mirror the posting's exact keywords where truthful.
No fluff, no filler adjectives. After the first draft, the user may ask for tweaks — apply them and
always output the FULL updated document each time, not a diff.`;

const INSTRUCTIONS: Record<GenKind, string> = {
  resume: `You are the candidate's resume writer. Produce a FULL, one-page resume TAILORED to the job below.

Output EXACTLY this markdown structure (a downstream converter turns it into a formatted
one-page Word doc, so the structure must be precise):
- Line 1: "# Full Name"
- Line 2: the contact line, pipe-separated: "Austin, TX | email | phone | github-url | linkedin-url"
- Each section: "## SECTION NAME" — EXPERIENCE, then PROJECTS & LABS, then EDUCATION, then SKILLS.
  NO summary, objective, or profile section — start straight into EXPERIENCE.
- Each experience entry:
    "### Organization Name"
    "Role Title | Start – End Dates"          (role, then a pipe, then the dates)
    "- bullet"  ("- " bullets, one per line)
- Each project entry:
    "### Project Name | Dates"
    "Tech · Stack · Separated · By · Middots"   (the tech line — use " · " between items)
    "- bullet"
- SKILLS: a few "- **Category:** comma, separated, list" lines (bold each category label).

Rules:
- NO SUMMARY / OBJECTIVE. Never pad with a profile paragraph — fill the page with real
  accomplishment bullets instead.
- DENSITY: every experience entry gets 3-5 substantive bullets; every project gets 2-3
  substantive bullets. NEVER leave an entry with a single bullet. Each bullet is a full,
  concrete accomplishment (what you built + how + impact/scale), like:
  "Enforced Zero Trust via Cloudflare Access (email OTP) in front of an origin with no native
  auth, and rate-limited APIs to prevent abuse — least-privilege access control managed entirely
  as Terraform IaC."
- Fill exactly ONE page: include enough experience + projects (3-4 projects if needed) with
  full bullets so the page is full WITHOUT a summary. If short, add another relevant project or
  more bullets — do not shrink to fit or pad with fluff.
- TAILOR by ordering and emphasis: lead with the most relevant experience/projects and mirror
  the posting's keywords where truthful — but keep every entry substantive even if it's a
  secondary match. Quantify where the source material does.
- Keep the real contact details from the master resume.
- After the resume, add a section "## WHY THIS RESUME" — 4-6 short "- " bullets on the tailoring
  choices. (The converter drops this from the Word doc; it's just for you to review.)
${COMMON}`,

  cover_letter: `You are the candidate's cover-letter writer. Produce a cover letter TAILORED to the job below,
written in the candidate's authentic voice — infer it from their materials and any voice/style notes in
their profile (if COVER_LETTER_STYLE is provided, follow it).

Default voice: conversational, warm, genuine — NOT corporate, stiff, or generic. Simple language, short
paragraphs, no bullet points, no filler adjectives, no "I am writing to apply." Lead with real experience;
do not pad or over-explain.

Structure (3-4 short paragraphs, ~250-320 words):
1. Contact header (name + contact line from the resume), then "Dear Hiring Team," (use a real
   hiring-manager name only if the posting gives one).
2. A brief, genuine PERSONAL HOOK in first person — draw it from the candidate's own materials (what
   pulled them into this field). Keep it authentic and human; NEVER invent a story.
3. WHY THIS COMPANY specifically — tie to what the company actually does / its mission and why it
   genuinely resonates. Concrete to the company, real enthusiasm, not generic flattery.
4. WHAT THEY BRING — 2-3 of their most relevant REAL experiences/projects mapped to the role (name real
   tools/work from their materials). Confident but concise.
Then a short closing line: location/availability + a warm, forward-looking note about contributing.
End with a standard signature ("Sincerely," + the candidate's name).

After the letter, add "## WHY THIS COVER LETTER" — 3-5 short "- " bullets on the angle you took.
(The converter drops this from the Word doc; it's just for you to review.)
${COMMON}`,

  interview_prep: `You are the candidate's interview coach. Produce an interview PREP SHEET for the job below.
Structure (markdown headers):
- "## About the company & role" — 3-4 bullets on what they do and what this team likely works on.
- "## Likely questions" — 8-12 questions THIS role would ask (behavioral + technical/domain), and for
  EACH a 1-2 sentence talking point grounded in his REAL background (name the specific project/experience).
- "## Your strengths to emphasize" — 3-5 bullets mapping his background to the posting's top requirements.
- "## Gaps & how to address them" — honest 2-3 bullets where he's light, with an honest framing (never fabricate).
- "## Smart questions to ask them" — 4-6 thoughtful questions for the interviewer.
${COMMON}`,

  app_answers: `You are the candidate's application assistant. Draft answers to the common free-text application
questions for the job below. Cover at least: "Why do you want to work here?", "Why are you a good fit
for this role?", "Describe a relevant project or experience.", "What are you looking for in this
internship?" — plus any specific prompts implied by the posting.
Rules:
- For EACH: a bold question header, then a tight 60-120 word first-person answer using his REAL
  experience and this posting's language. Concrete, specific, no clichés.
- End with a section titled exactly "WHY THESE ANSWERS" — 3-4 bullets on the framing you chose.
${COMMON}`,
};

const FIRST_TURN: Record<GenKind, string> = {
  resume: "Write the tailored resume for this job.",
  cover_letter: "Write the tailored cover letter for this job.",
  interview_prep: "Write the interview prep sheet for this job.",
  app_answers: "Draft the application answers for this job.",
};

/** Assemble the two context blocks shared by the API path and the copyable
 *  Pro-plan prompt: candidate materials (cacheable) + per-job task. */
async function assembleContext(
  env: Env, db: D1Database, kind: GenKind, job: JobCtx, masterOverride?: string
): Promise<{ materials: string; task: string }> {
  const [profile, gh, site] = await Promise.all([
    masterOverride ? Promise.resolve(masterOverride) : getProfile(db),
    githubSummary(env),
    siteText(env),
  ]);
  if (!profile) {
    throw new Error("No master resume available — sync your profile (scripts/sync_profile.py) or paste one.");
  }
  const materials = [
    "<candidate_materials>",
    profile.slice(0, 90000),
    gh ? `\n<github_repos>\n${gh}\n</github_repos>` : "",
    site ? `\n<website_example_com>\n${site}\n</website_example_com>` : "",
    "</candidate_materials>",
  ].join("\n");
  const task = [
    INSTRUCTIONS[kind],
    "",
    "<target_job>",
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.location || "?"}${job.term ? ` · Term: ${job.term}` : ""}`,
    job.match_reason ? `Fit note: ${job.match_reason}` : "",
    job.skills && job.skills !== "[]" ? `Posting keywords: ${job.skills}` : "",
    job.description ? `\nDescription:\n${job.description.slice(0, 6000)}` : "",
    job.requirements ? `\nRequirements:\n${job.requirements.slice(0, 4000)}` : "",
    "</target_job>",
  ].join("\n");
  return { materials, task };
}

/** Full self-contained prompt to paste into Claude.ai (Pro plan) — no API cost.
 *  Same instructions + context as the API path, joined into one message. */
export async function buildDocPrompt(
  env: Env, db: D1Database, kind: GenKind, job: JobCtx, masterOverride?: string
): Promise<string> {
  const { materials, task } = await assembleContext(env, db, kind, job, masterOverride);
  return `${materials}\n\n${task}\n\n${FIRST_TURN[kind]}`;
}

export async function docChat(
  env: Env,
  db: D1Database,
  kind: GenKind,
  job: JobCtx,
  messages: ChatMessage[],
  masterOverride?: string
): Promise<string> {
  // Spend guardrail: Opus doc-gen is a click away, so cap daily API spend.
  // Cap lives in meta (doc_daily_cap_usd) so you can tune it without a deploy.
  const capRow = await db.prepare("SELECT value FROM meta WHERE key = 'doc_daily_cap_usd'")
    .first<{ value: string }>();
  const cap = Number(capRow?.value) || DEFAULT_DAILY_CAP_USD;
  const spentToday = await costToday(db, "doc_%");  // docs only — a big rematch shouldn't lock out resumes
  if (spentToday >= cap) {
    throw new Error(
      `Daily AI spend cap reached ($${spentToday.toFixed(2)} / $${cap.toFixed(2)}). ` +
      `Raise it in Settings, or use the "Copy prompt for Claude.ai" button to generate on your Pro plan.`
    );
  }

  const { materials, task } = await assembleContext(env, db, kind, job, masterOverride);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, defaultHeaders: EXTENDED_CACHE_HEADER });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: [
      { type: "text", text: materials, cache_control: CACHE_1H },
      { type: "text", text: task },
    ],
    messages: messages.length
      ? messages
      : [{ role: "user", content: FIRST_TURN[kind] }],
  });
  await logUsage(db, `doc_${kind}`, MODEL, response.usage);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Model returned no text — try again.");
  return text;
}
