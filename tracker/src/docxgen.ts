// Markdown → styled .docx, matched to the candidate's actual Resume.docx (Cambria):
//   page 8.5×13in, 0.4in side margins; name 16pt bold; contact 9pt bold;
//   section headers 10pt regular + bottom rule (mixed case, NOT bold);
//   org names 8.5pt bold; role lines 8pt; project + tech lines 8pt bold-italic;
//   bullets = real Word list (numPr) at 8pt, single-spaced; SKILLS lines are
//   NOT bulleted (bold "Category:" label + list). Works on any doc content.

import {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink,
  AlignmentType, BorderStyle, TabStopType, LevelFormat,
} from "docx";

const FONT = "Cambria";
// content width = 12240 − 576 − 576 = 11088 twips (8.5in page, 0.4in margins)
const RIGHT_TAB = 11088;

// half-points (16 = 8pt). Exactly the sizes measured in Resume.docx.
const SZ = { name: 32, contact: 18, section: 20, org: 17, role: 16, tech: 16, body: 16, prose: 20 };

type Inline = TextRun | ExternalHyperlink;

/** Inline markdown: **bold**, *italic*, [text](url), bare urls/emails. */
function inlineRuns(text: string, size: number, italics = false, bold = false): Inline[] {
  const out: Inline[] = [];
  const pushPlain = (s: string) => {
    if (!s) return;
    const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
    let l = 0; let b: RegExpExecArray | null;
    while ((b = re.exec(s))) {
      if (b.index > l) out.push(new TextRun({ text: s.slice(l, b.index), font: FONT, size, italics, bold }));
      out.push(new TextRun({ text: b[1] ?? b[2], font: FONT, size, bold: bold || !!b[1], italics: italics || !!b[2] }));
      l = re.lastIndex;
    }
    if (l < s.length) out.push(new TextRun({ text: s.slice(l), font: FONT, size, italics, bold }));
  };
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)|(\bhttps?:\/\/[^\s|]+)|([\w.+-]+@[\w.-]+\.\w+)/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text))) {
    if (m.index > last) pushPlain(text.slice(last, m.index));
    const label = m[1] ?? m[3] ?? m[4];
    const href = m[2] ?? m[3] ?? (m[4] ? `mailto:${m[4]}` : "#");
    out.push(new ExternalHyperlink({
      link: href,
      children: [new TextRun({ text: label, font: FONT, size, style: "Hyperlink" })],
    }));
    last = linkRe.lastIndex;
  }
  if (last < text.length) pushPlain(text.slice(last));
  return out.length ? out : [new TextRun({ text, font: FONT, size, italics, bold })];
}

// A trailing date/date-range on an entry line (right-aligned in Word).
const DATE_RE =
  /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{0,4}\s*[–—-]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*)?\d{4}|(?:Summer|Fall|Spring|Winter)\s*\d{4}(?:\s*[–—-]\s*(?:Summer|Fall|Spring|Winter)?\s*\d{4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}\s*[–—-]\s*(?:Present|\d{4}))\s*$/i;

/** Split "Role | Aug – Dec 2026" (or trailing bare date) → [left, date|null]. */
function splitDate(line: string): [string, string | null] {
  const bar = line.match(/^(.*\S)\s*\|\s*(.+)$/);
  if (bar && DATE_RE.test(bar[2])) return [bar[1].trim(), bar[2].trim()];
  const m = line.match(DATE_RE);
  if (m && m.index && m.index > 0) return [line.slice(0, m.index).replace(/[|·—-]\s*$/, "").trim(), m[1].trim()];
  return [line, null];
}

/** An entry line: left text (bold / italic) + optional right-aligned date. */
function entryLine(left: string, date: string | null, size: number, bold: boolean, italics = false): Paragraph {
  const leftRuns = inlineRuns(left, size, italics, bold);
  const children = date
    ? [...leftRuns, new TextRun({ text: "\t" + date, font: FONT, size, bold, italics })]
    : leftRuns;
  return new Paragraph({
    children,
    tabStops: date ? [{ type: TabStopType.RIGHT, position: RIGHT_TAB }] : undefined,
    spacing: { before: bold ? 80 : 0, after: 0, line: 240, lineRule: "auto" },
  });
}

/** Strip the meta "WHY THIS ..." trailer — it isn't part of the document. */
function stripWhy(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const i = lines.findIndex((l) => /^#{0,4}\s*(\*\*)?\s*why this /i.test(l.trim()));
  return (i >= 0 ? lines.slice(0, i) : lines).join("\n").trim();
}

/** Bold a leading "Category:" label (used by SKILLS lines and label bullets). */
function labelRuns(text: string, size: number): Inline[] {
  const lab = text.match(/^\*{0,2}([A-Za-z][\w &/+.\-]{1,30})\*{0,2}:\s+(.*)$/);
  return lab
    ? [new TextRun({ text: lab[1] + ": ", font: FONT, size, bold: true }), ...inlineRuns(lab[2], size)]
    : inlineRuns(text, size);
}

const BULLET_REF = "rbul";

export function markdownToParagraphs(md: string): Paragraph[] {
  const lines = stripWhy(md).split("\n");
  const paras: Paragraph[] = [];
  let seenName = false;
  let afterEntryHead = false;
  let section = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { afterEntryHead = false; continue; }

    // Name (first # heading or first non-empty line) + contact line under it
    if (!seenName && (/^#\s+/.test(line) || paras.length === 0)) {
      paras.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 140, line: 240, lineRule: "auto" },
        children: [new TextRun({ text: line.replace(/^#\s+/, ""), font: FONT, size: SZ.name, bold: true })],
      }));
      seenName = true;
      const next = (lines[i + 1] ?? "").trim();
      if (next && /[|@]|https?:\/\//.test(next) && !/^#/.test(next)) {
        paras.push(new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 240, line: 240, lineRule: "auto" },
          children: inlineRuns(next.replace(/\s*\|\s*/g, " | "), SZ.contact, false, true),
        }));
        i++;
      }
      continue;
    }

    // Section header (## or #): 10pt regular, mixed case, bottom rule
    if (/^#{1,2}\s+/.test(line)) {
      const name = line.replace(/^#+\s+/, "");
      section = name.toLowerCase();
      paras.push(new Paragraph({
        children: [new TextRun({ text: name, font: FONT, size: SZ.section })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000", space: 1 } },
        spacing: { before: 120, after: 40, line: 240, lineRule: "auto" },
      }));
      afterEntryHead = false;
      continue;
    }

    // Entry heading (### Org  |  ### Project | Dates)
    if (/^###\s+/.test(line)) {
      const [left, date] = splitDate(line.replace(/^###\s+/, ""));
      // projects put the date on the title line → 8pt bold-italic; orgs → 8.5pt bold
      if (date) paras.push(entryLine(left, date, SZ.tech, true, true));
      else paras.push(entryLine(left, null, SZ.org, true, false));
      afterEntryHead = true;
      continue;
    }

    // Skills/tools section: NOT bulleted — bold "Category:" label + list
    const inSkills = /skill|tool|technolog/.test(section);
    if (inSkills && /^[-*•]\s+/.test(line)) {
      paras.push(new Paragraph({
        children: labelRuns(line.replace(/^[-*•]\s+/, ""), SZ.body),
        spacing: { after: 0, line: 240, lineRule: "auto" },
      }));
      afterEntryHead = false;
      continue;
    }

    // Bullets — real Word list (numPr)
    if (/^[-*•]\s+/.test(line)) {
      paras.push(new Paragraph({
        numbering: { reference: BULLET_REF, level: 0 },
        children: labelRuns(line.replace(/^[-*•]\s+/, ""), SZ.body),
        spacing: { after: 0, line: 240, lineRule: "auto" },
      }));
      afterEntryHead = false;
      continue;
    }

    // First non-bullet line after an entry heading:
    // role line ("Role | Dates") or italic tech line ("Tech · Stack")
    if (afterEntryHead) {
      const isTech = /·/.test(line) || /^\*.*\*$/.test(line);
      const [left, date] = splitDate(line.replace(/^\*|\*$/g, ""));
      // tech → 8pt bold-italic; role → 8pt regular
      paras.push(entryLine(left, date, isTech ? SZ.tech : SZ.role, isTech, isTech));
      afterEntryHead = false;
      continue;
    }

    // Plain paragraph (cover-letter prose) — 10pt for readability
    paras.push(new Paragraph({
      children: inlineRuns(line, SZ.prose),
      spacing: { after: 120, line: 264, lineRule: "auto" },
    }));
  }
  return paras;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function markdownToDocx(md: string): Promise<Uint8Array> {
  const doc = new Document({
    styles: {
      default: { document: { run: { font: FONT, size: SZ.body } } },
      characterStyles: [{
        id: "Hyperlink", name: "Hyperlink", basedOn: "DefaultParagraphFont",
        run: { color: "0563C1", underline: {} },
      }],
    },
    numbering: {
      config: [{
        reference: BULLET_REF,
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { run: { font: FONT, size: SZ.body }, paragraph: { indent: { left: 216, hanging: 180 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 18720 },              // 8.5 × 13 in
          margin: { top: 720, bottom: 720, left: 576, right: 576 }, // 0.5 / 0.4 in
        },
      },
      children: markdownToParagraphs(md),
    }],
  });
  return b64ToBytes(await Packer.toBase64String(doc));
}
