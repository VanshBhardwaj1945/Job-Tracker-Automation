// Markdown → styled .docx — the ATS-canonical resume template:
//   US Letter, Cambria, 10pt body, 18pt name; gray metadata (roles/dates/contact),
//   black bold headings with hairline rules; right-tab dates; literal "•" bullets
//   with hanging indent; CERTIFICATIONS renders as flowing text (no bullets);
//   SKILLS lines are bold-label + list. One page by prompt contract (~46 lines).
// Works for resumes and cover letters (same header, prose body).

import {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink,
  AlignmentType, BorderStyle, TabStopType,
} from "docx";

const FONT = "Cambria";
const GRAY = "595959";
// US Letter 8.5×11in; 0.4in top/bottom, 0.5in sides → content width 7.5in
const PAGE = { width: 12240, height: 15840 };
const MARGIN = { top: 576, bottom: 576, left: 720, right: 720 };
const RIGHT_TAB = 10800;

// half-points
const SZ = { name: 36, headline: 20, contact: 17, section: 21, entry: 20, meta: 19, body: 20, prose: 21 };

type Inline = TextRun | ExternalHyperlink;

/** Inline markdown: **bold**, *italic*, [text](url), bare urls/emails. */
function inlineRuns(text: string, size: number, opts: { italics?: boolean; bold?: boolean; color?: string } = {}): Inline[] {
  const out: Inline[] = [];
  const pushPlain = (s: string) => {
    if (!s) return;
    const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
    let l = 0; let b: RegExpExecArray | null;
    while ((b = re.exec(s))) {
      if (b.index > l) out.push(new TextRun({ text: s.slice(l, b.index), font: FONT, size, ...opts }));
      out.push(new TextRun({ text: b[1] ?? b[2], font: FONT, size, color: opts.color, bold: opts.bold || !!b[1], italics: opts.italics || !!b[2] }));
      l = re.lastIndex;
    }
    if (l < s.length) out.push(new TextRun({ text: s.slice(l), font: FONT, size, ...opts }));
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
  return out.length ? out : [new TextRun({ text, font: FONT, size, ...opts })];
}

// A trailing date/date-range on an entry line (right-aligned in Word).
const DATE_RE =
  /((?:expected\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{0,4}\s*[–—-]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*)?\d{0,4}|(?:expected\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}\s*[–—-]\s*(?:Present|\d{4}))\s*$/i;

/** Split "Role | Aug 2026 - Dec 2026" (or trailing bare date) → [left, date|null].
 *  Tolerates trailing annotations like "(expected)" / "(Incoming)". */
function splitDate(line: string): [string, string | null] {
  const bar = line.match(/^(.*\S)\s*\|\s*(.+)$/);
  if (bar && DATE_RE.test(bar[2].replace(/\s*\([^)]*\)\s*$/, ""))) return [bar[1].trim(), bar[2].trim()];
  const m = line.match(DATE_RE);
  if (m && m.index && m.index > 0) return [line.slice(0, m.index).replace(/[|·—-]\s*$/, "").trim(), m[1].trim()];
  return [line, null];
}

/** Strip the meta "WHY THIS ..." trailer — it isn't part of the document. */
function stripWhy(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const i = lines.findIndex((l) => /^#{0,4}\s*(\*\*)?\s*why th(is|ese) /i.test(l.trim()));
  return (i >= 0 ? lines.slice(0, i) : lines).join("\n").trim();
}

/** Bold a leading "Category:" label (SKILLS lines). */
function labelRuns(text: string, size: number): Inline[] {
  const lab = text.match(/^\*{0,2}([A-Za-z][\w &/()+.\-]{1,60}?)\*{0,2}:\s+(.*)$/);
  return lab
    ? [new TextRun({ text: lab[1] + ": ", font: FONT, size, bold: true }), ...inlineRuns(lab[2], size)]
    : inlineRuns(text, size);
}

function bulletPara(children: Inline[]): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: "•  ", font: FONT, size: SZ.body }), ...children],
    indent: { left: 260, hanging: 190 },
    spacing: { before: 0, after: 20, line: 240, lineRule: "auto" },
  });
}

export function markdownToParagraphs(md: string): Paragraph[] {
  const lines = stripWhy(md).split("\n");
  const paras: Paragraph[] = [];
  let seenName = false;
  let headerLines = 0;          // headline + contact under the name
  let section = "";
  let pendingCompany: string | null = null;  // "### Company" awaiting its role line
  let afterEntryHead = false;

  const entryPara = (runs: Inline[], date: string | null, before = 80): Paragraph =>
    new Paragraph({
      children: date ? [...runs, new TextRun({ text: "\t" + date, font: FONT, size: SZ.meta, color: GRAY })] : runs,
      tabStops: date ? [{ type: TabStopType.RIGHT, position: RIGHT_TAB }] : undefined,
      spacing: { before, after: 20, line: 240, lineRule: "auto" },
    });

  const flushPending = () => {
    if (pendingCompany !== null) {
      paras.push(entryPara(inlineRuns(pendingCompany, SZ.entry, { bold: true }), null));
      pendingCompany = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { afterEntryHead = false; continue; }

    // Name (first # heading or first non-empty line)
    if (!seenName && (/^#\s+/.test(line) || paras.length === 0)) {
      paras.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 20, line: 240, lineRule: "auto" },
        children: [new TextRun({ text: line.replace(/^#\s+/, ""), font: FONT, size: SZ.name, bold: true })],
      }));
      seenName = true;
      continue;
    }

    // Up to two header lines after the name: headline (any single phrase), then
    // contact (has @/phone). No "|" required — a headline can be one plain phrase.
    if (seenName && section === "" && headerLines < 2 && !/^#/.test(line)) {
      const isContact = /@|\(\d{3}\)|\d{3}[-.\s]\d{4}/.test(line);
      paras.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: isContact ? 40 : 20, line: 240, lineRule: "auto" },
        children: inlineRuns(line.replace(/\s*\|\s*/g, "  |  "), isContact ? SZ.contact : SZ.headline, { color: GRAY }),
      }));
      headerLines++;
      continue;
    }

    // Section heading (## or #): bold, hairline rule
    if (/^#{1,2}\s+/.test(line)) {
      flushPending();
      const name = line.replace(/^#+\s+/, "");
      section = name.toLowerCase();
      paras.push(new Paragraph({
        children: [new TextRun({ text: name, font: FONT, size: SZ.section, bold: true })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "222222", space: 2 } },
        spacing: { before: 100, after: 40, line: 240, lineRule: "auto" },
      }));
      afterEntryHead = false;
      continue;
    }

    // Entry heading (### Company | ### Project | Date)
    if (/^###\s+/.test(line)) {
      flushPending();
      const [left, date] = splitDate(line.replace(/^###\s+/, ""));
      if (date) {
        paras.push(entryPara(inlineRuns(left, SZ.entry, { bold: true }), date));
        afterEntryHead = true;
      } else {
        pendingCompany = left;   // wait for the role line to merge onto one line
      }
      continue;
    }

    // Role line right after "### Company" → merge: Company — Role ......... date
    if (pendingCompany !== null) {
      const [role, date] = splitDate(line);
      paras.push(entryPara(
        [
          ...inlineRuns(pendingCompany, SZ.entry, { bold: true }),
          new TextRun({ text: " — ", font: FONT, size: SZ.entry, color: GRAY }),
          ...inlineRuns(role, SZ.entry, { color: GRAY }),
        ],
        date
      ));
      pendingCompany = null;
      afterEntryHead = true;
      continue;
    }

    // Certifications: flowing text, never bulleted
    if (/certif/.test(section)) {
      paras.push(new Paragraph({
        children: inlineRuns(line.replace(/^[-*•]\s+/, ""), SZ.body),
        spacing: { after: 20, line: 240, lineRule: "auto" },
      }));
      continue;
    }

    // Skills: bold "Category:" label + list, not bulleted
    if (/skill|tool|technolog/.test(section) && /^[-*•]?\s*\*{0,2}[A-Za-z]/.test(line)) {
      paras.push(new Paragraph({
        children: labelRuns(line.replace(/^[-*•]\s+/, ""), SZ.body),
        spacing: { after: 20, line: 240, lineRule: "auto" },
      }));
      afterEntryHead = false;
      continue;
    }

    // Bullets
    if (/^[-*•]\s+/.test(line)) {
      paras.push(bulletPara(inlineRuns(line.replace(/^[-*•]\s+/, ""), SZ.body)));
      afterEntryHead = false;
      continue;
    }

    // First non-bullet line after a project heading = tech-stack line (gray)
    if (afterEntryHead) {
      paras.push(new Paragraph({
        children: inlineRuns(line, SZ.meta, { color: GRAY }),
        spacing: { after: 20, line: 240, lineRule: "auto" },
      }));
      afterEntryHead = false;
      continue;
    }

    // Plain paragraph (cover-letter prose)
    paras.push(new Paragraph({
      children: inlineRuns(line, SZ.prose),
      spacing: { after: 120, line: 276, lineRule: "auto" },
    }));
  }
  flushPending();
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
    sections: [{
      properties: {
        page: { size: PAGE, margin: MARGIN },
      },
      children: markdownToParagraphs(md),
    }],
  });
  return b64ToBytes(await Packer.toBase64String(doc));
}
