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

export type BoardObject = StrokeObject;

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
      const pts = (m.get("points") as number[] | undefined) ?? [];
      m.set(
        "points",
        pts.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
      );
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
  if (m.get("type") !== "stroke") return null;
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
