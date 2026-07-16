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
  url?: string;
}

/** Which ATS vendor the posting lives on — drives strictness rules in the
 *  resume prompt and the "upload DOCX + check parsed fields" advice. */
export function detectATS(url: string | undefined | null): string {
  const u = (url || "").toLowerCase();
  if (!u) return "unknown";
  if (u.includes("greenhouse.io")) return "greenhouse";
  if (u.includes("myworkdayjobs.com") || u.includes("workday")) return "workday";
  if (u.includes("lever.co")) return "lever";
  if (u.includes("ashbyhq.com")) return "ashby";
  if (u.includes("icims.com")) return "icims";
  if (u.includes("taleo.net")) return "taleo";
  if (u.includes("smartrecruiters.com")) return "smartrecruiters";
  if (u.includes("bamboohr.com")) return "bamboohr";
  if (u.includes("linkedin.com")) return "linkedin-easy-apply";
  return "unknown";
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
  resume: `You are the candidate's resume writer. Produce a FULL one-page resume TAILORED to the job below.
Three readers must be satisfied at once: an ATS parser (reads structure), a hiring manager skimming
for ~7 seconds (reads hierarchy), and an AI screener (reads the raw text as prose). Target scores:
ATS >= 9.5, Human >= 9, AI >= 9 — you self-score all three in the trailer.

1. ASSESS THE MATERIALS FIRST (no pre-ranked inventory — you decide):
Everything you may use is in the candidate materials above (resume, any knowledge base, GitHub,
portfolio). Before writing, build your own assessment:
- For each role/project: note its stack, its depth of real detail, and its term-overlap with THIS
  posting's requirements. Strength = evidence density x relevance to this job — not order of
  appearance, not prestige, not anything in these instructions.
- Roles that have NOT started yet (check dates against today): including them is YOUR judgment
  call, decided by lane fit. If included: "(Incoming)" in the title, strictly future tense, 2
  bullets max, never framed as completed work. State the include/omit decision in the trailer.
- Published/shipped artifacts (anything people can install or visit) are shipping proof and count
  for ANY engineering role, even off-lane.
- Certifications are inventory too: reorder so the role-relevant one leads; drop ones that buy
  nothing for this posting.
- If materials and these instructions ever disagree about what they did, THE MATERIALS WIN.
- ROLE-TITLE FRAMING: where the materials support more than one accurate title for the same real
  work (e.g. "Software Engineer" vs "Security Engineer" vs "IAM Engineer" for one role), pick the
  truthful title closest to the target posting. This reframes the SAME work — never invents a
  different job; keep the team/scope accurate.

2. STRUCTURE (exact — a converter renders the visual template):
- Line 1: "# Full Name"
- Line 2: headline — 4-7 words classifying the candidate for THIS role, built from the posting's
  own title vocabulary.
- Line 3: the contact line, verbatim from the resume, pipe-separated.
- Then EXACTLY these sections, these names, this order: "## EXPERIENCE", "## PROJECTS",
  "## CERTIFICATIONS", "## EDUCATION", "## SKILLS". Never rename, reorder, or add a summary.
- Experience entry: "### Company" then "Role Title | Mon YYYY - Mon YYYY" then "- " bullets.
- HARD RULE — CHRONOLOGY: EXPERIENCE entries in strict reverse-chronological order by START date.
  NEVER reorder by relevance — an included incoming role has the latest start date and sits on TOP.
  Tailor with bullet allocation and content, never with order. PROJECTS likewise newest-first.
- Project entry: "### Name | Mon YYYY - Mon YYYY" then one comma-separated tech-stack line then bullets.
- CERTIFICATIONS: ONE flowing line (no bullets): "Name (CODE), Mon YYYY | Name (CODE), Mon YYYY".
- EDUCATION: school line with degree and dates. Coursework line ONLY if the posting asks about coursework or GPA.
- SKILLS: "- **Category:** comma, separated, items" lines. MANDATORY and always present — under
  space pressure shrink to fewer categories or shorter lists, NEVER omit it.
- ALL FIVE sections (EXPERIENCE, PROJECTS, CERTIFICATIONS, EDUCATION, SKILLS) appear in EVERY resume.
  Dropping a whole section to fit is a failure — cut bullets or a project instead.

3. HARD FORMAT LAWS (zero exceptions):
- Dates: "Mon YYYY - Mon YYYY", "Mon YYYY - Present", "expected Mon YYYY". Three-letter month, NO
  period, plain hyphen with spaces, 4-digit year. Never day numbers, ordinals, seasons, or a bare
  month. ONE format document-wide.
- ASCII only: no arrows, no curly quotes, no em/en dashes inside text, no middots — commas and
  straight quotes. Never hidden text or keyword stuffing (AI screeners detect it; it ends the application).
- Keywords: acronym + long form once each for load-bearing terms, e.g. "Identity and Access
  Management (IAM)", "infrastructure as code (IaC)", "role-based access control (RBAC)".

4. THE LINE-BUDGET BRAIN (where you think):
The page holds ~46 rendered lines. Budget BEFORE writing. Fill the page nearly full (42-46 lines)
but NEVER exceed one page. Every line must answer: does this move THIS application? Reason like:
"cert X buys nothing for this role — drop it; project Y hits three of their requirements — 3 bullets."
- Any employer or project that appears gets >= 2 bullets. NO EXCEPTIONS. If it cannot justify 2
  bullets for this role, cut the whole entry — a starved entry reads worse than an absent one.
- The skills category matching the role gets FULL truthful depth; adjacent categories keep only
  what supports the story; irrelevant categories vanish.
- Projects chosen by stack overlap with the posting's requirements — most exact-term hits win.
- If UNDER 40 lines: expand bullets on the strongest in-lane entries or add the next most relevant
  project — never pad with fluff, never leave the page half empty.
- Cut order when over budget: coursework, least-relevant cert, weakest adjacent project, 3rd/4th
  bullets on older roles, a borderline not-yet-started role. NEVER cut: any of the five sections
  (SKILLS included — trim its lists, do not remove it), the strongest in-lane role below 3 bullets,
  contact info, the headline, or dates.

5. LANGUAGE LAWS — dry, dense, factual:
Every bullet: strongest verb + what was built + how + measurable outcome. Nothing else.
- Banned: "passionate", "results-driven", "dynamic", "responsible for", "helped with", "worked on",
  "various", "utilized", "leveraged", "cutting-edge", "spearheaded", intensifiers, and any adjective
  a skeptic could delete without losing information. If a sentence survives with a word removed, remove it.
- <= ~30 words / 2 rendered lines per bullet. No bullet restates another bullet or the skills list.
- Mirror the posting's EXACT phrases where truthful — their vocabulary, real facts. If they name a
  tool the candidate does not have, it does NOT appear.
The finished document reads like an engineering changelog written by someone confident enough not to decorate it.

6. ATS ROUTING (an "ATS:" hint accompanies the job, derived from the posting URL):
- workday / icims / taleo: strictest mode — plainest punctuation everywhere; add to the trailer:
  "Upload the DOCX to this portal, then CHECK the parsed fields it shows you and fix any mangled ones."
- greenhouse / lever / ashby: recruiters open the original document — visual polish pays; PDF is fine.
- unknown: assume strictest.

7. TRUTH LAW (above everything): only real facts from the materials. Never invent experience, tools,
metrics, dates, or credentials. When in doubt whether they did something — they did not.

8. THE TRAILER — end with "## WHY THIS RESUME" (the converter strips it):
(a) self-score ATS x/10, Human x/10, AI x/10 with one-line justifications; (b) the exact posting
phrases you mirrored, quoted; (c) the cut log; (d) the include/omit decision on any not-yet-started
role; (e) portal upload advice per section 6.
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
    `ATS: ${detectATS(job.url)}`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
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

/** Estimate rendered lines of a resume in the Cambria/Letter template
 *  (10pt, ~7.5in text width ~ 110 chars/line). Deterministic stand-in for
 *  "does this fit one page" — the model can't count rendered lines, we can. */
export function estimateResumeLines(md: string): number {
  const cut = md.search(/^#{0,4}\s*(\*\*)?\s*why this /im);
  const lines = (cut >= 0 ? md.slice(0, cut) : md).split("\n");
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#\s/.test(line)) { n += 2; continue; }
    if (/^##\s/.test(line)) { n += 2; continue; }
    if (/^###\s/.test(line)) { continue; }
    const text = line.replace(/^[-*\u2022]\s+/, "").replace(/\*\*/g, "");
    n += Math.max(1, Math.ceil(text.length / 110));
  }
  return n;
}

export async function docChat(
  env: Env,
  db: D1Database,
  kind: GenKind,
  job: JobCtx,
  messages: ChatMessage[],
  masterOverride?: string
): Promise<string> {
  const { materials, task } = await assembleContext(env, db, kind, job, masterOverride);
  const turns: ChatMessage[] = messages.length ? messages : [{ role: "user", content: FIRST_TURN[kind] }];
  const first = await runDocTurn(env, db, kind, materials, task, turns);

  // Page-fit auto-revision (resume only, first draft only): the model can't count
  // rendered lines but we can. One corrective turn when a fresh draft over/under-fills.
  if (kind === "resume" && messages.length === 0) {
    const lc = estimateResumeLines(first);
    if (lc > 48 || lc < 36) {
      const note = lc > 48
        ? `That draft is ~${lc} rendered lines — it OVERFLOWS one page. Cut to 42-46 lines using the cut order (drop the weakest project/bullets, shrink SKILLS lists). Keep ALL FIVE sections including SKILLS, every remaining entry at >= 2 bullets, and reverse-chronological order. Output the FULL corrected resume.`
        : `That draft is only ~${lc} rendered lines — it under-fills the page. Expand bullets on the strongest in-lane entries or add the next most relevant project (>= 2 bullets) until it nearly fills one page. No fluff. Output the FULL corrected resume.`;
      return await runDocTurn(env, db, kind, materials, task, [
        ...turns,
        { role: "assistant", content: first },
        { role: "user", content: note },
      ]);
    }
  }
  return first;
}

async function runDocTurn(
  env: Env, db: D1Database, kind: GenKind, materials: string, task: string, turns: ChatMessage[]
): Promise<string> {
  // Spend guardrail: cap daily API spend (docs only).
  const capRow = await db.prepare("SELECT value FROM meta WHERE key = 'doc_daily_cap_usd'")
    .first<{ value: string }>();
  const cap = Number(capRow?.value) || DEFAULT_DAILY_CAP_USD;
  const spentToday = await costToday(db, "doc_%");
  if (spentToday >= cap) {
    throw new Error(
      `Daily AI spend cap reached ($${spentToday.toFixed(2)} / $${cap.toFixed(2)}). ` +
      `Raise it in Settings, or use the "Copy prompt for Claude.ai" button to generate on your Pro plan.`
    );
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, defaultHeaders: EXTENDED_CACHE_HEADER });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: [
      { type: "text", text: materials, cache_control: CACHE_1H },
      { type: "text", text: task },
    ],
    messages: turns,
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
