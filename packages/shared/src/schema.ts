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

export interface StrokeObject {
  id: string;
  type: "stroke";
  /** Flat polyline in canvas coords: [x0, y0, x1, y1, …]. */
  points: number[];
  color: string;
  width: number;
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
    m.set("authorId", stroke.authorId);
    objectsMap(doc).set(stroke.id, m);
    orderArray(doc).push([stroke.id]);
  });
}

export function deleteObject(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    objectsMap(doc).delete(id);
    const order = orderArray(doc);
    const idx = order.toArray().indexOf(id);
    if (idx >= 0) order.delete(idx, 1);
  });
}

/** Read a typed object out of its Y.Map (returns null for unknown types). */
export function readObject(m: Y.Map<unknown>): BoardObject | null {
  if (m.get("type") !== "stroke") return null;
  return {
    id: String(m.get("id")),
    type: "stroke",
    points: (m.get("points") as number[] | undefined) ?? [],
    color: String(m.get("color") ?? "#0e1116"),
    width: Number(m.get("width") ?? 4),
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
