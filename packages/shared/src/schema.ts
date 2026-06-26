/**
 * Komuboard Yjs document schema (M1).
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
  /** Group membership — objects sharing a `groupId` select / move / transform / delete as one unit. */
  groupId?: string;
  /** Locked objects can't be moved / resized / rotated / edited / deleted (still selectable, to unlock). */
  locked?: boolean;
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
export type ShapeKind = "rectangle" | "ellipse" | "rhombus" | "triangle";
/** A shape's border style: a solid line, a dashed line, or no border at all. */
export type BorderStyle = "solid" | "dashed" | "none";

// --- Connectors (lines / arrows between points, optionally bound to a shape's side) ---

/** The connector glyphs the "Shapes and lines" tool can draw. `line` = no head, `arrow` = single
 *  head, `elbow` = right-angled arrow, `block` = a thicker filled-head arrow. */
export type ConnectorKind = "line" | "arrow" | "elbow" | "block";
/** Which side of a shape a connector end binds to (its mid-edge is the attach point). */
export type ConnectorSide = "top" | "right" | "bottom" | "left";
export type ConnectorStyle = "solid" | "dashed";
export const CONNECTOR_SIDES: readonly ConnectorSide[] = ["top", "right", "bottom", "left"];
/** The marker drawn at a connector endpoint: nothing, an open (line) arrowhead, a filled arrowhead,
 *  an outlined white-filled arrowhead, a dot, or a diamond. Each end (start/end) chooses its own. */
export type ConnectorCap = "none" | "line" | "arrow" | "triangle" | "circle" | "diamond";
export const CONNECTOR_CAPS: readonly ConnectorCap[] = [
  "none",
  "line",
  "arrow",
  "triangle",
  "circle",
  "diamond",
];

/** One end of a connector. Always carries a world `{x, y}` (the fallback / last-resolved point); a
 *  *bound* end also carries `{shapeId, side}` and re-resolves to that shape's side mid-edge each
 *  render, so the connector re-routes when the shape moves. If the shape is gone, the stored point
 *  is used (the end gracefully becomes free). */
export interface ConnectorEnd {
  x: number;
  y: number;
  shapeId?: string;
  side?: ConnectorSide;
}

export interface ConnectorObject {
  id: string;
  type: "connector";
  /** Group membership — see {@link StrokeObject.groupId}. */
  groupId?: string;
  /** Locked — see {@link StrokeObject.locked}. */
  locked?: boolean;
  kind: ConnectorKind;
  from: ConnectorEnd;
  to: ConnectorEnd;
  color: string;
  width: number;
  style: ConnectorStyle;
  /** Endpoint markers (default: start `none`, end `arrow`). Edited via the selected-connector bar. */
  startCap: ConnectorCap;
  endCap: ConnectorCap;
  /** Optional label, anchored at the connector's midpoint. */
  label?: string;
  authorId: string;
}

/** The default caps for a freshly-drawn connector of each menu kind — so the rendered arrow matches
 *  its menu icon: `arrow`/`elbow` get an OPEN head, `block` a filled head, `line` none. */
export function defaultCapsFor(kind: ConnectorKind): {
  startCap: ConnectorCap;
  endCap: ConnectorCap;
} {
  if (kind === "line") return { startCap: "none", endCap: "none" };
  if (kind === "block") return { startCap: "none", endCap: "triangle" }; // outlined head (its icon)
  return { startCap: "none", endCap: "line" }; // arrow / elbow → open head
}

export interface TextObject {
  id: string;
  type: "text";
  /** Group membership — see {@link StrokeObject.groupId}. */
  groupId?: string;
  /** Locked — see {@link StrokeObject.locked}. */
  locked?: boolean;
  /** Top-left in canvas coords. */
  x: number;
  y: number;
  /** Box width in canvas units. Absent = auto-width (grows to the longest line, no wrap);
   *  present = fixed width that wraps. Height always derives from the wrapped content — except a
   *  shape box (`shape` set), which is a fixed width×height the resize handles stretch freely. */
  width?: number;
  /** Fixed box height (canvas units) — only set for shape boxes. */
  height?: number;
  /** Rotation in degrees (clockwise) about the box centre. Absent/0 = upright. */
  rotation?: number;
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
  /** Shape outline colour (hex) — defaults to a dark ink when absent. */
  borderColor?: string;
  /** Shape outline style (solid / dashed / none) — defaults to solid when absent. */
  borderStyle?: BorderStyle;
  authorId: string;
}

/** A FigJam-style stamp/sticker: an emoji or mark image placed on the board. `src` is `mark:<name>`
 *  (a bundled SVG in src/assets/stamps) or `emoji:<codepoint>` (a Noto SVG at /emoji/<codepoint>.svg).
 *  Square; `x,y` is its CENTRE; it rotates about that centre. */
export interface StampObject {
  id: string;
  type: "stamp";
  /** Group membership — see {@link StrokeObject.groupId}. */
  groupId?: string;
  /** Locked — see {@link StrokeObject.locked}. */
  locked?: boolean;
  x: number;
  y: number;
  /** Width = height, in canvas units. */
  size: number;
  src: string;
  /** Rotation in degrees (clockwise) about the centre. Absent/0 = upright. */
  rotation?: number;
  /** Id of the text/sticky/shape this stamp is stuck to: it rides that object's moves and is deleted
   *  with it, while staying an independent, individually selectable node. Absent = free-floating. */
  attachedTo?: string;
  authorId: string;
}
/** Default placed-stamp size in canvas units — a small sticker (smaller than a sticky's 150), close to
 *  FigJam's default sticker footprint without being oversized. */
export const DEFAULT_STAMP_SIZE = 48;

export type BoardObject = StrokeObject | TextObject | ConnectorObject | StampObject;

/** Defaults for a freshly-created text box (shared so the renderer + schema can't drift).
 *  Size 24 = the "Medium" preset in the text toolbar. */
export const DEFAULT_TEXT_FONT = "Inter, system-ui, -apple-system, sans-serif";
export const DEFAULT_TEXT_SIZE = 24;
/** Sticky notes default to smaller text than plain text/shapes — the "Small" (16) preset. */
export const DEFAULT_STICKY_TEXT_SIZE = 16;

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
/** Default colour + square size (canvas units) of a freshly-dropped sticky note (≈150 px at the 100% default zoom). */
export const DEFAULT_STICKY_COLOR = "#ffec99";
export const DEFAULT_STICKY_SIZE = 150;

/** Shape boxes: default fill (white) + default size when click-placed rather than drag-sized. */
export const DEFAULT_SHAPE_FILL = "#ffffff";
export const DEFAULT_SHAPE_W = 180;
export const DEFAULT_SHAPE_H = 130;
const SHAPE_KINDS: readonly string[] = ["rectangle", "ellipse", "rhombus", "triangle"];

/** Connectors: default ink + line width (canvas units), and the kinds the menu can draw. */
export const DEFAULT_CONNECTOR_COLOR = "#1f2933";
export const DEFAULT_CONNECTOR_WIDTH = 5; // = the "Medium" weight option in the connector bar
const CONNECTOR_KINDS: readonly string[] = ["line", "arrow", "elbow", "block"];

/** The mid-edge point of a shape's side, in canvas coords — where a connector end bound to that side
 *  attaches (and re-routes to as the shape moves/resizes). `rect` is the shape's box. */
export function sideMidpoint(
  rect: { x: number; y: number; width: number; height: number },
  side: ConnectorSide,
): { x: number; y: number } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  switch (side) {
    case "top":
      return { x: cx, y: rect.y };
    case "bottom":
      return { x: cx, y: rect.y + rect.height };
    case "left":
      return { x: rect.x, y: cy };
    case "right":
      return { x: rect.x + rect.width, y: cy };
  }
}

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
    if (t.rotation != null) m.set("rotation", t.rotation);
    if (t.shape != null) m.set("shape", t.shape);
    m.set("runs", t.runs);
    m.set("fontFamily", t.fontFamily);
    m.set("fontSize", t.fontSize);
    m.set("align", t.align);
    if (t.bg != null) m.set("bg", t.bg);
    if (t.borderColor != null) m.set("borderColor", t.borderColor);
    if (t.borderStyle != null) m.set("borderStyle", t.borderStyle);
    m.set("authorId", t.authorId);
    objectsMap(doc).set(t.id, m);
    orderArray(doc).push([t.id]);
  });
}

/** A connector end as a plain object for the Y.Map (only stores the binding when BOTH parts exist). */
function connectorEndToPlain(e: ConnectorEnd): Record<string, unknown> {
  const o: Record<string, unknown> = { x: e.x, y: e.y };
  if (e.shapeId != null && e.side != null) {
    o.shapeId = e.shapeId;
    o.side = e.side;
  }
  return o;
}

/** Append a connector (line/arrow) to the document (atomic: object + z-order in one transaction). */
export function addConnector(doc: Y.Doc, c: ConnectorObject): void {
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("id", c.id);
    m.set("type", "connector");
    m.set("kind", c.kind);
    m.set("from", connectorEndToPlain(c.from));
    m.set("to", connectorEndToPlain(c.to));
    m.set("color", c.color);
    m.set("width", c.width);
    m.set("style", c.style);
    m.set("startCap", c.startCap);
    m.set("endCap", c.endCap);
    if (c.label != null) m.set("label", c.label);
    m.set("authorId", c.authorId);
    objectsMap(doc).set(c.id, m);
    orderArray(doc).push([c.id]);
  });
}

/** Add any board object to the doc, dispatching by type (used by paste / future import). */
export function addObject(doc: Y.Doc, obj: BoardObject): void {
  if (obj.type === "stroke") addStroke(doc, obj);
  else if (obj.type === "text") addText(doc, obj);
  else if (obj.type === "stamp") addStamp(doc, obj);
  else addConnector(doc, obj);
}

/**
 * Clone a board object for paste: assign a fresh `id` + `authorId`, offset its geometry by (dx, dy),
 * and — for a connector — remap each endpoint's shape *binding* through `idMap` so a connector copied
 * alongside its shapes attaches to the COPIES (an end bound to a shape that wasn't copied keeps its
 * original binding). Deep-copies nested arrays (stroke points, text runs) so the clone shares no state.
 */
export function cloneObject(
  obj: BoardObject,
  id: string,
  authorId: string,
  dx: number,
  dy: number,
  idMap?: ReadonlyMap<string, string>,
): BoardObject {
  if (obj.type === "stroke") {
    return {
      ...obj,
      id,
      authorId,
      points: obj.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
    };
  }
  if (obj.type === "text") {
    return {
      ...obj,
      id,
      authorId,
      x: obj.x + dx,
      y: obj.y + dy,
      runs: obj.runs.map((r) => ({ ...r })),
    };
  }
  if (obj.type === "stamp") {
    return { ...obj, id, authorId, x: obj.x + dx, y: obj.y + dy };
  }
  const remap = (e: ConnectorEnd): ConnectorEnd => {
    const out: ConnectorEnd = { ...e, x: e.x + dx, y: e.y + dy };
    const mapped = e.shapeId != null ? idMap?.get(e.shapeId) : undefined;
    if (mapped != null) out.shapeId = mapped;
    return out;
  };
  return { ...obj, id, authorId, from: remap(obj.from), to: remap(obj.to) };
}

/** Update a connector's appearance (colour / width / dash / endpoint caps / label). Omitted fields
 *  are left unchanged; pass `label: ""` to clear the label. */
export function setConnectorStyle(
  doc: Y.Doc,
  id: string,
  s: {
    color?: string;
    width?: number;
    style?: ConnectorStyle;
    startCap?: ConnectorCap;
    endCap?: ConnectorCap;
    label?: string;
  },
): void {
  doc.transact(() => {
    const m = objectsMap(doc).get(id);
    if (!m || m.get("type") !== "connector") return;
    if (s.color != null) m.set("color", s.color);
    if (s.width != null) m.set("width", s.width);
    if (s.style != null) m.set("style", s.style);
    if (s.startCap != null) m.set("startCap", s.startCap);
    if (s.endCap != null) m.set("endCap", s.endCap);
    if (s.label != null) m.set("label", s.label);
  });
}

/** Re-point a connector's ends (re-bind to a shape side / move a free end). Omitted ends unchanged. */
export function setConnectorEnds(
  doc: Y.Doc,
  id: string,
  ends: { from?: ConnectorEnd; to?: ConnectorEnd },
): void {
  doc.transact(() => {
    const m = objectsMap(doc).get(id);
    if (!m || m.get("type") !== "connector" || m.get("locked") === true) return; // lock guard
    if (ends.from) m.set("from", connectorEndToPlain(ends.from));
    if (ends.to) m.set("to", connectorEndToPlain(ends.to));
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
  geom: { x?: number; y?: number; width?: number; height?: number; rotation?: number },
): void {
  doc.transact(() => {
    const m = objectsMap(doc).get(id);
    if (!m || m.get("type") !== "text" || m.get("locked") === true) return; // lock guard
    if (geom.x != null) m.set("x", geom.x);
    if (geom.y != null) m.set("y", geom.y);
    if (geom.width != null) m.set("width", geom.width);
    if (geom.height != null) m.set("height", geom.height);
    if (geom.rotation != null) m.set("rotation", geom.rotation);
  });
}

/** Update a text object's block-level style (font, size, alignment). Used by resize + the toolbar. */
export function setTextStyle(
  doc: Y.Doc,
  id: string,
  style: {
    fontFamily?: string;
    fontSize?: number;
    align?: TextAlign;
    bg?: string;
    borderColor?: string;
    borderStyle?: BorderStyle;
  },
): void {
  doc.transact(() => {
    const m = objectsMap(doc).get(id);
    if (!m || m.get("type") !== "text") return;
    if (style.fontFamily != null) m.set("fontFamily", style.fontFamily);
    if (style.fontSize != null) m.set("fontSize", style.fontSize);
    if (style.align != null) m.set("align", style.align);
    if (style.bg != null) m.set("bg", style.bg);
    if (style.borderColor != null) m.set("borderColor", style.borderColor);
    if (style.borderStyle != null) m.set("borderStyle", style.borderStyle);
  });
}

export function deleteObject(doc: Y.Doc, id: string): void {
  deleteObjects(doc, [id]); // one implementation of "delete + drop from z-order" (O(n), not O(n²))
}

/** Delete several objects atomically (e.g. a multi-selection). */
/** Ids of every stamp attached to an object already in `targets` (one level — stamps have no children). */
function attachedStampIds(objs: Y.Map<Y.Map<unknown>>, targets: Set<string>): string[] {
  const out: string[] = [];
  objs.forEach((m, id) => {
    if (targets.has(id) || m.get("type") !== "stamp") return;
    const att = m.get("attachedTo");
    if (typeof att === "string" && targets.has(att)) out.push(id);
  });
  return out;
}

// ---- grouping + locking (cross-type membership, one Y.Map field each) ----

/** Assign a fresh shared `groupId` to every given object so they select / transform / delete as one.
 *  Returns the new group id. Objects with an existing group are re-grouped into the new one. */
export function groupObjects(doc: Y.Doc, ids: Iterable<string>): string {
  const gid = randomId("grp");
  doc.transact(() => {
    const objs = objectsMap(doc);
    for (const id of ids) {
      const m = objs.get(id);
      if (m) m.set("groupId", gid);
    }
  });
  return gid;
}

/** Clear group membership from every object sharing a group with any of `ids` (ungroup the whole
 *  group, not just the clicked members). */
export function ungroupObjects(doc: Y.Doc, ids: Iterable<string>): void {
  doc.transact(() => {
    const objs = objectsMap(doc);
    const groups = new Set<string>();
    for (const id of ids) {
      const g = objs.get(id)?.get("groupId");
      if (typeof g === "string") groups.add(g);
    }
    if (!groups.size) return;
    objs.forEach((m) => {
      const g = m.get("groupId");
      if (typeof g === "string" && groups.has(g)) m.delete("groupId");
    });
  });
}

/** Lock or unlock the given objects (locked objects stay selectable so they can be unlocked). A stamp
 *  attached to a host locks/unlocks WITH its host — like the move + delete cascades — so locking a
 *  sticky/shape protects the whole unit (its stickers can't be dragged off or deleted either). */
export function setLocked(doc: Y.Doc, ids: Iterable<string>, locked: boolean): void {
  doc.transact(() => {
    const objs = objectsMap(doc);
    const set = new Set(ids);
    for (const sid of attachedStampIds(objs, set)) set.add(sid); // attached stickers follow their host
    for (const id of set) {
      const m = objs.get(id);
      if (!m) continue;
      if (locked) m.set("locked", true);
      else m.delete("locked");
    }
  });
}

/** Expand `ids` to include the UNLOCKED objects sharing a `groupId` with any of them (one level — a
 *  member's group). The input `ids` are always kept (so a directly-clicked locked object stays
 *  selectable, to unlock it); only locked *siblings* are skipped, so selecting an unlocked group member
 *  doesn't drag a locked one into the selection and immobilise the whole group. Pure read. */
export function expandGroups(doc: Y.Doc, ids: Iterable<string>): Set<string> {
  const objs = objectsMap(doc);
  const out = new Set<string>(ids);
  const groups = new Set<string>();
  for (const id of out) {
    const g = objs.get(id)?.get("groupId");
    if (typeof g === "string") groups.add(g);
  }
  if (groups.size) {
    objs.forEach((m, id) => {
      const g = m.get("groupId");
      if (typeof g === "string" && groups.has(g) && m.get("locked") !== true) out.add(id);
    });
  }
  return out;
}

/** Move `ids` to the front of the z-order — the END of the order array (rendered last = on top).
 *  Locked objects are skipped; the moved objects keep their relative order. */
export function bringToFront(doc: Y.Doc, ids: Iterable<string>): void {
  reorderZ(doc, ids, "front");
}

/** Move `ids` to the back of the z-order — the START of the order array. Locked objects skipped. */
export function sendToBack(doc: Y.Doc, ids: Iterable<string>): void {
  reorderZ(doc, ids, "back");
}

function reorderZ(doc: Y.Doc, ids: Iterable<string>, to: "front" | "back"): void {
  doc.transact(() => {
    const objs = objectsMap(doc);
    const move = new Set<string>();
    for (const id of ids) {
      const m = objs.get(id);
      if (m && m.get("locked") !== true) move.add(id); // don't reorder locked objects
    }
    if (!move.size) return;
    const order = orderArray(doc);
    const arr = order.toArray();
    const moving = arr.filter((id) => move.has(id)); // existing entries only, in their current order
    if (!moving.length) return;
    // Delete each moved entry back→front so earlier indices stay valid.
    for (let i = arr.length - 1; i >= 0; i--) {
      const id = arr[i];
      if (id !== undefined && move.has(id)) order.delete(i, 1);
    }
    if (to === "front") order.push(moving);
    else order.insert(0, moving);
  });
}

export function deleteObjects(doc: Y.Doc, ids: Iterable<string>): void {
  const idSet = new Set(ids);
  if (!idSet.size) return;
  doc.transact(() => {
    const objs = objectsMap(doc);
    const order = orderArray(doc);
    for (const id of [...idSet]) if (objs.get(id)?.get("locked") === true) idSet.delete(id); // lock blocks delete/erase
    if (!idSet.size) return;
    // A sticker dies with its host — UNLESS the sticker itself is locked (lock survives the cascade too).
    for (const sid of attachedStampIds(objs, idSet))
      if (objs.get(sid)?.get("locked") !== true) idSet.add(sid);
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
    const set = new Set(ids);
    for (const sid of attachedStampIds(objs, set)) set.add(sid); // a sticker rides its sticky/shape
    for (const id of set) {
      const m = objs.get(id);
      if (!m || m.get("locked") === true) continue; // lock guard (defence-in-depth vs the UI gates)
      if (m.get("type") === "connector") {
        // Shift both endpoints' stored points. Bound ends re-resolve to their shape at render, so a
        // fully-bound connector won't visibly move (you'd move the shapes); free ends follow.
        m.set("from", offsetConnectorEnd(m.get("from"), dx, dy));
        m.set("to", offsetConnectorEnd(m.get("to"), dx, dy));
        continue;
      }
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
      if (m && m.get("locked") !== true) m.set("points", u.points); // lock guard
    }
  });
}

/** Add a stamp/sticker to the document (atomic: object + z-order). */
export function addStamp(doc: Y.Doc, s: StampObject): void {
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("id", s.id);
    m.set("type", "stamp");
    m.set("x", s.x);
    m.set("y", s.y);
    m.set("size", s.size);
    m.set("src", s.src);
    if (s.rotation != null) m.set("rotation", s.rotation);
    if (s.attachedTo != null) m.set("attachedTo", s.attachedTo);
    m.set("authorId", s.authorId);
    objectsMap(doc).set(s.id, m);
    orderArray(doc).push([s.id]);
  });
}

/** Update a stamp's geometry (centre / size / rotation). Used by drag + resize + rotate. */
export function setStampGeom(
  doc: Y.Doc,
  id: string,
  geom: { x?: number; y?: number; size?: number; rotation?: number },
): void {
  doc.transact(() => {
    const m = objectsMap(doc).get(id);
    if (!m || m.get("type") !== "stamp" || m.get("locked") === true) return; // lock guard
    if (geom.x != null) m.set("x", geom.x);
    if (geom.y != null) m.set("y", geom.y);
    if (geom.size != null) m.set("size", geom.size);
    if (geom.rotation != null) m.set("rotation", geom.rotation);
  });
}

function readStamp(m: Y.Map<unknown>): StampObject | null {
  const x = m.get("x");
  const y = m.get("y");
  const size = m.get("size");
  const src = m.get("src");
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
  if (typeof src !== "string" || !src) return null;
  const stamp: StampObject = {
    id: String(m.get("id")),
    type: "stamp",
    x,
    y,
    size,
    src,
    authorId: String(m.get("authorId") ?? ""),
  };
  const rotation = m.get("rotation");
  if (typeof rotation === "number" && Number.isFinite(rotation)) stamp.rotation = rotation;
  const attachedTo = m.get("attachedTo");
  if (typeof attachedTo === "string" && attachedTo) stamp.attachedTo = attachedTo;
  return stamp;
}

/** Read a typed object out of its Y.Map — returns null for unknown types or malformed data. */
export function readObject(m: Y.Map<unknown>): BoardObject | null {
  const obj = readObjectByType(m);
  if (!obj) return null;
  // Cross-type fields read once here so every object type carries them uniformly.
  const groupId = m.get("groupId");
  if (typeof groupId === "string" && groupId) obj.groupId = groupId;
  if (m.get("locked") === true) obj.locked = true;
  return obj;
}

function readObjectByType(m: Y.Map<unknown>): BoardObject | null {
  const type = m.get("type");
  if (type === "text") return readText(m);
  if (type === "connector") return readConnector(m);
  if (type === "stamp") return readStamp(m);
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

/** Validate an untrusted connector end. Returns null when x/y aren't finite; only keeps a binding
 *  when BOTH shapeId and a valid side are present. */
function readConnectorEnd(raw: unknown): ConnectorEnd | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = r.x;
  const y = r.y;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  const end: ConnectorEnd = { x, y };
  const side = r.side;
  if (
    typeof r.shapeId === "string" &&
    r.shapeId &&
    (side === "top" || side === "right" || side === "bottom" || side === "left")
  ) {
    end.shapeId = r.shapeId;
    end.side = side;
  }
  return end;
}

/** Offset a connector end's stored point by (dx, dy), preserving any binding. */
function offsetConnectorEnd(raw: unknown, dx: number, dy: number): Record<string, unknown> {
  const e = readConnectorEnd(raw) ?? { x: 0, y: 0 };
  return connectorEndToPlain({ ...e, x: e.x + dx, y: e.y + dy });
}

/** Validate + normalize an untrusted connector's Y.Map (peer/CRDT data is never trusted). */
function readConnector(m: Y.Map<unknown>): ConnectorObject | null {
  const from = readConnectorEnd(m.get("from"));
  const to = readConnectorEnd(m.get("to"));
  if (!from || !to) return null;
  const kind = m.get("kind");
  const width = m.get("width");
  const style = m.get("style");
  const cap = (v: unknown, fallback: ConnectorCap): ConnectorCap =>
    typeof v === "string" && CONNECTOR_CAPS.includes(v as ConnectorCap)
      ? (v as ConnectorCap)
      : fallback;
  const label = m.get("label");
  const conn: ConnectorObject = {
    id: String(m.get("id")),
    type: "connector",
    kind:
      typeof kind === "string" && CONNECTOR_KINDS.includes(kind)
        ? (kind as ConnectorKind)
        : "arrow",
    from,
    to,
    color: String(m.get("color") ?? DEFAULT_CONNECTOR_COLOR),
    width:
      typeof width === "number" && Number.isFinite(width) && width > 0
        ? width
        : DEFAULT_CONNECTOR_WIDTH,
    style: style === "dashed" ? "dashed" : "solid",
    startCap: cap(m.get("startCap"), "none"),
    endCap: cap(m.get("endCap"), "arrow"),
    authorId: String(m.get("authorId") ?? ""),
  };
  if (typeof label === "string" && label) conn.label = label;
  return conn;
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
  const rotation = m.get("rotation");
  if (typeof rotation === "number" && Number.isFinite(rotation)) text.rotation = rotation;
  const bg = m.get("bg");
  if (typeof bg === "string" && bg) text.bg = bg;
  const shape = m.get("shape");
  if (typeof shape === "string" && SHAPE_KINDS.includes(shape)) text.shape = shape as ShapeKind;
  const borderColor = m.get("borderColor");
  if (typeof borderColor === "string" && borderColor) text.borderColor = borderColor;
  const borderStyle = m.get("borderStyle");
  if (borderStyle === "solid" || borderStyle === "dashed" || borderStyle === "none")
    text.borderStyle = borderStyle;
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

/** Friendly names for the identity palette (keyed by the exact USER_COLORS hex) — shown as the
 *  avatar colour-swatch tooltips in the profile dialog. */
export const USER_COLOR_NAMES: Readonly<Record<string, string>> = {
  "#2563eb": "Blue",
  "#db2777": "Pink",
  "#16a34a": "Green",
  "#f59e0b": "Amber",
  "#7c3aed": "Violet",
  "#0891b2": "Cyan",
  "#dc2626": "Red",
  "#0d9488": "Teal",
  "#c026d3": "Fuchsia",
  "#ea580c": "Orange",
  "#65a30d": "Lime",
  "#4f46e5": "Indigo",
};

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
