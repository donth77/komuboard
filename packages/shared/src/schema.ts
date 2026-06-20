/**
 * Coboard Yjs document schema (M1).
 *
 * One Yjs document per room is the single source of truth, shared by the 2D and
 * (later) VR renderers. Geometry is stored in **canvas coordinates** only — the
 * doc is dimension-agnostic (see docs/04 §2, §6.5).
 *
 * Layout:
 *   doc.getMap("objects")  : Y.Map<Y.Map>  — board objects keyed by id
 *   doc.getArray("order")  : Y.Array<string> — z-order (back → front)
 *
 * M1 ships the `stroke` object; sticky/shape/text are added next.
 */
import * as Y from "yjs";

// Brush (pen vs highlighter) and dash (solid vs dotted) are independent axes; `highlight-dashed`
// is the dotted highlighter. The pen panel only exposes the first three; the draw bar all four.
export type StrokeStyle = "solid" | "dashed" | "highlight" | "highlight-dashed";

export interface StrokeObject {
  id: string;
  type: "stroke";
  /** Flat polyline in canvas coords: [x0, y0, x1, y1, …]. */
  points: number[];
  color: string;
  width: number;
  style: StrokeStyle;
  /** 0–1. */
  opacity: number;
  authorId: string;
}

/** One styled span within a TextObject. Marks are optional; a plain paragraph is a single run
 *  with just `text`. We don't support concurrent editing *inside* one box, so the whole `runs`
 *  array is stored as a single last-writer-wins field (the single-editor / LWW text model). */
export interface TextRun {
  /** Run text. A newline (\n) begins a new line within the box. */
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Hex ink for this run; falls back to the object default when absent. */
  color?: string;
  /** Hex highlight (background) for this run. */
  highlight?: string;
  /** Link target — a run carrying `link` renders as an anchor. */
  link?: string;
}

export type TextAlign = "left" | "center" | "right";

/** Shape outlines the "Shapes and lines" tool can draw as text-bearing boxes (lines/arrows are a
 *  separate ConnectorObject). The box renders the outline + a centred label. */
export type ShapeKind = "rectangle" | "ellipse" | "rhombus" | "triangle" | "divider";

export interface TextObject {
  id: string;
  type: "text";
  /** Top-left in canvas coords. */
  x: number;
  y: number;
  /** Box width in canvas units. Absent = auto-width (grows to the longest line, no wrap);
   *  present = fixed width that wraps. Height always derives from the wrapped content — except a
   *  shape box (`shape` set), which is a fixed width×height the resize handles stretch freely. */
  width?: number;
  /** Fixed box height (canvas units) — only set for shape boxes. */
  height?: number;
  /** When set, the box renders as a shape outline (rectangle/ellipse/…) with a centred label and a
   *  `bg` fill. Drawn by the "Shapes and lines" tool. */
  shape?: ShapeKind;
  /** Rich content as styled runs (a single LWW field). */
  runs: TextRun[];
  fontFamily: string;
  /** Font size in canvas units (scaled by the camera at render time). */
  fontSize: number;
  align: TextAlign;
  /** Sticky-note paper colour (hex). When present the box renders as a sticky note (a coloured,
   *  padded, square card with centred text) rather than a plain text box. For a shape box this is
   *  the fill colour (default white). */
  bg?: string;
  authorId: string;
}

export type BoardObject = StrokeObject | TextObject;

/** Defaults for a freshly-created text box (shared so the renderer + schema can't drift).
 *  Size 40 = the "Large" preset in the text toolbar. */
export const DEFAULT_TEXT_FONT = "Inter, system-ui, -apple-system, sans-serif";
export const DEFAULT_TEXT_SIZE = 40;

/** Sticky-note palette (soft pastels) — mirrors the FigJam sticky colours. */
export const STICKY_COLORS: readonly string[] = [
  "#ffffff",
  "#dee2e6",
  "#ffc9c9",
  "#ffd8a8",
  "#ffec99",
  "#b2f2bb",
  "#96f2d7",
  "#a5d8ff",
  "#d0bfff",
  "#fcc2d7",
];
export const STICKY_COLOR_NAMES: Record<string, string> = {
  "#FFFFFF": "White",
  "#DEE2E6": "Gray",
  "#FFC9C9": "Red",
  "#FFD8A8": "Orange",
  "#FFEC99": "Yellow",
  "#B2F2BB": "Green",
  "#96F2D7": "Teal",
  "#A5D8FF": "Blue",
  "#D0BFFF": "Purple",
  "#FCC2D7": "Pink",
};
/** Default colour + square size (canvas units) of a freshly-dropped sticky note (FigJam-large). */
export const DEFAULT_STICKY_COLOR = "#ffec99";
export const DEFAULT_STICKY_SIZE = 300;

/** Shape boxes: default fill (white) + default size when click-placed rather than drag-sized. */
export const DEFAULT_SHAPE_FILL = "#ffffff";
export const DEFAULT_SHAPE_W = 200;
export const DEFAULT_SHAPE_H = 120;
const SHAPE_KINDS: readonly string[] = ["rectangle", "ellipse", "rhombus", "triangle", "divider"];

export function objectsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("objects");
}

export function orderArray(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>("order");
}

/** Append a stroke to the document (atomic: object + z-order in one transaction). */
export function addStroke(doc: Y.Doc, stroke: StrokeObject): void {
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("id", stroke.id);
    m.set("type", stroke.type);
    m.set("points", stroke.points);
    m.set("color", stroke.color);
    m.set("width", stroke.width);
    m.set("style", stroke.style);
    m.set("opacity", stroke.opacity);
    m.set("authorId", stroke.authorId);
    objectsMap(doc).set(stroke.id, m);
    orderArray(doc).push([stroke.id]);
  });
}

/** Append a text object to the document (atomic: object + z-order in one transaction). */
export function addText(doc: Y.Doc, t: TextObject): void {
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("id", t.id);
    m.set("type", "text");
    m.set("x", t.x);
    m.set("y", t.y);
    if (t.width != null) m.set("width", t.width);
    if (t.height != null) m.set("height", t.height);
    if (t.shape != null) m.set("shape", t.shape);
    m.set("runs", t.runs);
    m.set("fontFamily", t.fontFamily);
    m.set("fontSize", t.fontSize);
    m.set("align", t.align);
    if (t.bg != null) m.set("bg", t.bg);
    m.set("authorId", t.authorId);
    objectsMap(doc).set(t.id, m);
    orderArray(doc).push([t.id]);
  });
}

/** Replace a text object's styled runs (last-writer-wins on the whole content field). */
export function setTextRuns(doc: Y.Doc, id: string, runs: TextRun[]): void {
  doc.transact(() => {
    const m = objectsMap(doc).get(id);
    if (m && m.get("type") === "text") m.set("runs", runs);
  });
}

/** Update a text object's geometry (drag-move / resize). Omitted fields are left unchanged. */
export function setTextGeometry(
  doc: Y.Doc,
  id: string,
  geom: { x?: number; y?: number; width?: number; height?: number },
): void {
  doc.transact(() => {
    const m = objectsMap(doc).get(id);
    if (!m || m.get("type") !== "text") return;
    if (geom.x != null) m.set("x", geom.x);
    if (geom.y != null) m.set("y", geom.y);
    if (geom.width != null) m.set("width", geom.width);
    if (geom.height != null) m.set("height", geom.height);
  });
}

/** Update a text object's block-level style (font, size, alignment). Used by resize + the toolbar. */
export function setTextStyle(
  doc: Y.Doc,
  id: string,
  style: { fontFamily?: string; fontSize?: number; align?: TextAlign; bg?: string },
): void {
  doc.transact(() => {
    const m = objectsMap(doc).get(id);
    if (!m || m.get("type") !== "text") return;
    if (style.fontFamily != null) m.set("fontFamily", style.fontFamily);
    if (style.fontSize != null) m.set("fontSize", style.fontSize);
    if (style.align != null) m.set("align", style.align);
    if (style.bg != null) m.set("bg", style.bg);
  });
}

export function deleteObject(doc: Y.Doc, id: string): void {
  deleteObjects(doc, [id]); // one implementation of "delete + drop from z-order" (O(n), not O(n²))
}

/** Delete several objects atomically (e.g. a multi-selection). */
export function deleteObjects(doc: Y.Doc, ids: Iterable<string>): void {
  const idSet = new Set(ids);
  if (!idSet.size) return;
  doc.transact(() => {
    const objs = objectsMap(doc);
    const order = orderArray(doc);
    for (const id of idSet) objs.delete(id);
    // One pass over the order array, deleting matching indices back-to-front so the
    // remaining indices stay valid — O(n) instead of toArray().indexOf() per id (O(n²)).
    const arr = order.toArray();
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i];
      if (v !== undefined && idSet.has(v)) order.delete(i, 1);
    }
  });
}

/** Offset the geometry of one or more strokes in canvas space (drag-to-move). */
export function translateObjects(doc: Y.Doc, ids: Iterable<string>, dx: number, dy: number): void {
  if (!dx && !dy) return;
  doc.transact(() => {
    const objs = objectsMap(doc);
    for (const id of ids) {
      const m = objs.get(id);
      if (!m) continue;
      const pts = m.get("points");
      if (Array.isArray(pts)) {
        m.set(
          "points",
          (pts as number[]).map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
        );
      } else {
        // Box geometry (text / future shapes): offset the top-left corner.
        const x = m.get("x");
        const y = m.get("y");
        if (typeof x === "number") m.set("x", x + dx);
        if (typeof y === "number") m.set("y", y + dy);
      }
    }
  });
}

/** Replace stroke geometry for several objects atomically (e.g. a resize bake). */
export function setObjectsPoints(
  doc: Y.Doc,
  updates: ReadonlyArray<{ id: string; points: number[] }>,
): void {
  doc.transact(() => {
    const objs = objectsMap(doc);
    for (const u of updates) {
      const m = objs.get(u.id);
      if (m) m.set("points", u.points);
    }
  });
}

/** Read a typed object out of its Y.Map — returns null for unknown types or malformed data. */
export function readObject(m: Y.Map<unknown>): BoardObject | null {
  const type = m.get("type");
  if (type === "text") return readText(m);
  if (type !== "stroke") return null;
  // CRDT/peer data is untrusted: points must be a flat [x0,y0,x1,y1,…] array of finite
  // numbers. Reject anything malformed rather than fabricating a default (which would
  // launder NaN/garbage into the renderer).
  const rawPoints = m.get("points");
  if (!Array.isArray(rawPoints) || rawPoints.length % 2 !== 0) return null;
  for (const n of rawPoints) {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
  }
  const style = m.get("style");
  const opacity = m.get("opacity");
  const width = m.get("width");
  return {
    id: String(m.get("id")),
    type: "stroke",
    points: rawPoints as number[],
    color: String(m.get("color") ?? "#0e1116"),
    width: typeof width === "number" && Number.isFinite(width) ? width : 4,
    style:
      style === "dashed" || style === "highlight" || style === "highlight-dashed" ? style : "solid",
    opacity: typeof opacity === "number" && Number.isFinite(opacity) ? opacity : 1,
    authorId: String(m.get("authorId") ?? ""),
  };
}

const TEXT_ALIGNS: readonly string[] = ["left", "center", "right"];

/** Validate + normalize an untrusted text object's Y.Map (peer/CRDT data is never trusted).
 *  Drops malformed runs rather than fabricating content; returns null only when the geometry
 *  or runs container is unusable. */
function readText(m: Y.Map<unknown>): TextObject | null {
  const x = m.get("x");
  const y = m.get("y");
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  const rawRuns = m.get("runs");
  if (!Array.isArray(rawRuns)) return null;
  const runs: TextRun[] = [];
  for (const r of rawRuns) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.text !== "string") continue;
    const run: TextRun = { text: rec.text };
    if (rec.bold === true) run.bold = true;
    if (rec.italic === true) run.italic = true;
    if (rec.underline === true) run.underline = true;
    if (rec.strike === true) run.strike = true;
    if (typeof rec.color === "string") run.color = rec.color;
    if (typeof rec.highlight === "string") run.highlight = rec.highlight;
    if (typeof rec.link === "string") run.link = rec.link;
    runs.push(run);
  }
  const width = m.get("width");
  const fontSize = m.get("fontSize");
  const align = m.get("align");
  const fontFamily = m.get("fontFamily");
  const text: TextObject = {
    id: String(m.get("id")),
    type: "text",
    x,
    y,
    runs,
    fontFamily: typeof fontFamily === "string" && fontFamily ? fontFamily : DEFAULT_TEXT_FONT,
    fontSize:
      typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0
        ? fontSize
        : DEFAULT_TEXT_SIZE,
    align: typeof align === "string" && TEXT_ALIGNS.includes(align) ? (align as TextAlign) : "left",
    authorId: String(m.get("authorId") ?? ""),
  };
  // exactOptionalPropertyTypes: only attach width when it's a usable number (never `undefined`).
  if (typeof width === "number" && Number.isFinite(width) && width > 0) text.width = width;
  const height = m.get("height");
  if (typeof height === "number" && Number.isFinite(height) && height > 0) text.height = height;
  const bg = m.get("bg");
  if (typeof bg === "string" && bg) text.bg = bg;
  const shape = m.get("shape");
  if (typeof shape === "string" && SHAPE_KINDS.includes(shape)) text.shape = shape as ShapeKind;
  return text;
}

// --- Presence (ephemeral; carried on the Yjs awareness channel, never persisted) ---

export interface CursorState {
  x: number;
  y: number;
}

export interface PresenceState {
  name: string;
  color: string;
  cursor?: CursorState;
  /** Object ids this peer currently has selected (rendered as outlines in their color). */
  selection?: string[];
}

/** Colorblind-aware identity palette; each cursor is also labeled with a name. */
export const USER_COLORS: readonly string[] = [
  "#2563eb",
  "#db2777",
  "#16a34a",
  "#f59e0b",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#0d9488",
  "#c026d3",
  "#ea580c",
  "#65a30d",
  "#4f46e5",
];

export function pickUserColor(seed: number): string {
  const i = ((seed % USER_COLORS.length) + USER_COLORS.length) % USER_COLORS.length;
  return USER_COLORS[i] ?? "#2563eb";
}

export function randomId(prefix = "o"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const ADJECTIVES = [
  "lunar",
  "brisk",
  "calm",
  "amber",
  "violet",
  "swift",
  "cobalt",
  "verdant",
  "sunny",
  "mellow",
  "brave",
  "clever",
  "cosmic",
  "gentle",
  "lucky",
  "nimble",
];
const ANIMALS = [
  "otter",
  "heron",
  "lynx",
  "tapir",
  "koala",
  "falcon",
  "panda",
  "fox",
  "ibis",
  "newt",
  "yak",
  "wren",
  "orca",
  "gecko",
  "moth",
  "bison",
];
function pickWord(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0]!;
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A fresh, shareable, human-friendly room id, e.g. "lunar-otter-42". */
export function randomRoomId(): string {
  return `${pickWord(ADJECTIVES)}-${pickWord(ANIMALS)}-${Math.floor(Math.random() * 90) + 10}`;
}

/** A friendly anonymous display name, e.g. "Swift Otter". */
export function randomGuestName(): string {
  return `${capitalize(pickWord(ADJECTIVES))} ${capitalize(pickWord(ANIMALS))}`;
}

// --- Persistent user profiles ----------------------------------------------
// Profiles live in the Yjs document (synced once via the CRDT, persisted), NOT
// in awareness — awareness is re-broadcast on every cursor move, so a photo
// there would wreck the cost model. Full R2-backed photo uploads land in M3.

export interface UserProfile {
  name: string;
  color: string;
  /** Small data-URL avatar (M1 local thumbnail); R2 uploads come in M3. */
  photo?: string;
}

export function usersMap(doc: Y.Doc): Y.Map<UserProfile> {
  return doc.getMap<UserProfile>("users");
}

export function setUserProfile(doc: Y.Doc, id: string, profile: UserProfile): void {
  usersMap(doc).set(id, profile);
}

export function readUserProfile(doc: Y.Doc, id: string): UserProfile | undefined {
  return usersMap(doc).get(id);
}
