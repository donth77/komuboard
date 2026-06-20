// src/text-runs.ts — convert between styled TextRun[] (the stored model) and the contenteditable
// DOM the editor manipulates. Pure + framework-free so it's straightforward to reason about/test.
//
// The stored model is intentionally flat: each run is a span of text plus optional marks
// (bold/italic/underline/strike/color/highlight/link). Block-level props (font, size, alignment)
// live on the TextObject, not the runs. Newlines live as "\n" inside run text and render as <br>.
//
// Marks are applied in the editor with document.execCommand (with styleWithCSS), which emits inline
// <span style> / <b> / <a> etc.; elementToRuns() flattens whatever the browser produced back into
// runs by resolving each text node's effective marks from its ancestors.

import type { TextRun } from "@coboard/shared";

type Marks = Omit<TextRun, "text">;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/** Normalize a CSS colour (rgb()/rgba()/#rgb/#rrggbb) to lowercase #rrggbb, or "" if unparseable. */
export function colorToHex(c: string): string {
  const s = c.trim();
  if (!s) return "";
  if (s[0] === "#") {
    if (s.length === 4) return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    return s.slice(0, 7).toLowerCase();
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m && m[1]) {
    const [r, g, b] = m[1].split(",").map((p) => parseFloat(p.trim()));
    if (r === undefined || g === undefined || b === undefined) return "";
    if ([r, g, b].some((n) => Number.isNaN(n))) return "";
    const hex = (n: number): string =>
      Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, "0");
    return ("#" + hex(r) + hex(g) + hex(b)).toLowerCase();
  }
  return s.toLowerCase(); // a named colour — store as-is (the toolbar only emits hex)
}

/** Only allow benign link schemes — drops javascript:/data: etc. from untrusted peer data. */
export function safeHref(raw: string): string {
  const s = raw.trim();
  if (/^(https?:|mailto:)/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s)) return "https://" + s; // bare domain → assume https
  return "";
}

function runToHtml(run: TextRun): string {
  let html = escapeHtml(run.text).replace(/\n/g, "<br>");
  const styles: string[] = [];
  if (run.bold) styles.push("font-weight:700");
  if (run.italic) styles.push("font-style:italic");
  const deco: string[] = [];
  if (run.underline) deco.push("underline");
  if (run.strike) deco.push("line-through");
  if (deco.length) styles.push("text-decoration:" + deco.join(" "));
  if (run.color) styles.push("color:" + run.color);
  if (run.highlight) styles.push("background-color:" + run.highlight);
  if (styles.length) html = `<span style="${styles.join(";")}">${html}</span>`;
  if (run.link) {
    const href = safeHref(run.link);
    if (href) html = `<a href="${escapeAttr(href)}" rel="noopener noreferrer">${html}</a>`;
  }
  return html;
}

/** Render runs to an HTML string (for display + for seeding the editor). Empty → "". */
export function runsToHtml(runs: TextRun[]): string {
  return runs.map(runToHtml).join("");
}

/** Plain text of runs (newlines preserved) — for empty checks + width measuring. */
export function runsToText(runs: TextRun[]): string {
  return runs.map((r) => r.text).join("");
}

const BULLET = "• ";
/** True when every non-empty line of the runs begins with a bullet marker. */
export function runsAreBulleted(runs: TextRun[]): boolean {
  const lines = runsToText(runs)
    .split("\n")
    .filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => l.startsWith(BULLET));
}
/** Toggle a "• " prefix on every non-empty line (whole-box bullets), preserving inline formatting. */
export function toggleBulletRuns(runs: TextRun[]): TextRun[] {
  const add = !runsAreBulleted(runs);
  // Split the flat runs into per-line groups so we can prefix each line without losing marks.
  const lines: TextRun[][] = [[]];
  for (const r of runs) {
    const segs = r.text.split("\n");
    segs.forEach((seg, i) => {
      if (i > 0) lines.push([]);
      if (seg) lines[lines.length - 1]!.push({ ...r, text: seg });
    });
  }
  const lineText = (ln: TextRun[]): string => ln.map((r) => r.text).join("");
  for (const ln of lines) {
    if (!lineText(ln).trim()) continue;
    if (add) {
      if (!lineText(ln).startsWith(BULLET)) ln.unshift({ text: BULLET });
    } else {
      const first = ln[0];
      if (first?.text.startsWith(BULLET)) first.text = first.text.slice(BULLET.length);
    }
  }
  const out: TextRun[] = [];
  lines.forEach((ln, i) => {
    if (i > 0) out.push({ text: "\n" });
    out.push(...ln);
  });
  return out;
}

/** Boolean marks that can be toggled across a whole box (the selection-toolbar use). */
export type BoolMark = "bold" | "italic" | "underline" | "strike";
/** True when every non-empty run carries the boolean mark (so the toolbar shows it "on"). */
export function allRunsHaveMark(runs: TextRun[], mark: BoolMark): boolean {
  const real = runs.filter((r) => r.text.length > 0);
  return real.length > 0 && real.every((r) => !!r[mark]);
}
/** Toggle a boolean mark across every run (whole-box): if all have it, clear it; else set it. */
export function toggleBoolMarkAllRuns(runs: TextRun[], mark: BoolMark): TextRun[] {
  const turnOff = allRunsHaveMark(runs, mark);
  return runs.map((r) => {
    const next = { ...r };
    if (turnOff) delete next[mark];
    else next[mark] = true;
    return next;
  });
}
/** Set (or clear, when value is "") a colour/highlight/link mark across every run (whole-box). */
export function setMarkAllRuns(
  runs: TextRun[],
  key: "color" | "highlight" | "link",
  value: string,
): TextRun[] {
  return runs.map((r) => {
    const next = { ...r };
    if (value) next[key] = value;
    else delete next[key];
    return next;
  });
}

function sameMarks(a: Marks, b: Marks): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    (a.color ?? "") === (b.color ?? "") &&
    (a.highlight ?? "") === (b.highlight ?? "") &&
    (a.link ?? "") === (b.link ?? "")
  );
}

/** Append text under the given marks, merging into the previous run when the marks match. */
function pushText(runs: TextRun[], text: string, marks: Marks): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && sameMarks(last, marks)) last.text += text;
  else runs.push({ ...marks, text });
}

function hasDecoration(el: HTMLElement, kind: string): boolean {
  const d = el.style.textDecorationLine || el.style.textDecoration || "";
  return d.includes(kind);
}

function walk(node: Node, marks: Marks, runs: TextRun[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      pushText(runs, child.nodeValue ?? "", marks);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR") {
      pushText(runs, "\n", marks);
      continue;
    }
    // The browser wraps lines in <div>/<p> on Enter → newline before a block's content (but not
    // before the very first line).
    if (tag === "DIV" || tag === "P") {
      const last = runs[runs.length - 1];
      if (last && !last.text.endsWith("\n")) pushText(runs, "\n", marks);
    }
    const m: Marks = { ...marks };
    const fw = el.style.fontWeight;
    if (tag === "B" || tag === "STRONG" || fw === "bold" || (parseInt(fw, 10) || 0) >= 600)
      m.bold = true;
    if (tag === "I" || tag === "EM" || el.style.fontStyle === "italic") m.italic = true;
    if (tag === "U" || hasDecoration(el, "underline")) m.underline = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL" || hasDecoration(el, "line-through"))
      m.strike = true;
    if (el.style.color) m.color = colorToHex(el.style.color);
    if (el.style.backgroundColor) m.highlight = colorToHex(el.style.backgroundColor);
    if (tag === "FONT" && el.getAttribute("color")) m.color = colorToHex(el.getAttribute("color")!);
    if (tag === "A") {
      const href = el.getAttribute("href");
      if (href) m.link = href;
    }
    walk(el, m, runs);
  }
}

/** Serialize a contenteditable element's content into flat styled runs. */
export function elementToRuns(root: HTMLElement): TextRun[] {
  const runs: TextRun[] = [];
  walk(root, {}, runs);
  // Trim a single trailing newline the browser often leaves (e.g. a final empty <div>).
  const last = runs[runs.length - 1];
  if (last && last.text.endsWith("\n")) {
    last.text = last.text.slice(0, -1);
    if (!last.text) runs.pop();
  }
  return runs;
}
