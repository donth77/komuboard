// The per-device custom-shape library ("Your shapes" in the shapes panel). Entries live in
// localStorage — no signup, no server — and follow the user across boards on this browser. A board
// never references a library entry: placing a shape EMBEDS its geometry in the text object
// (`shapeSvg` + `shapeViewBox`), so peers / reload / export / VR need nothing from here.
import { customShapeOf, MAX_SHAPE_LIBRARY, type CustomShape } from "@komuboard/shared";

import { revalidateMarkup } from "./shape-import";

export interface LibraryShape extends CustomShape {
  /** Content hash of the geometry — re-uploading the same file dedupes onto the existing entry. */
  id: string;
  /** Display name (the filename without its extension, trimmed). */
  name: string;
  addedAt: number;
}

const STORAGE_KEY = "komuboard-shapes";
const MAX_NAME = 40;

/** Thrown when an entry can't be added: the library is full, or storage refused the write. */
export class LibraryFullError extends Error {}

const listeners = new Set<() => void>();
let cache: LibraryShape[] | null = null;

/** FNV-1a 32-bit → 8 hex chars. Only for dedupe keys (not security). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function read(): LibraryShape[] {
  if (cache) return cache;
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    raw = null; // blocked storage / corrupt JSON → an empty library (nothing is lost on save: we overwrite)
  }
  const out: LibraryShape[] = [];
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      const custom = customShapeOf(r.svg, r.viewBox); // a malformed entry is skipped, the rest load
      if (!custom || typeof r.id !== "string" || typeof r.name !== "string") continue;
      // Library markup is inlined as <svg> in the panel, so it's re-sanitized on the way in: only
      // what OUR allow-list produces is trusted, never the raw storage string.
      const svg = revalidateMarkup(custom.svg);
      if (!svg) continue;
      out.push({
        id: r.id,
        name: r.name,
        svg,
        viewBox: custom.viewBox,
        addedAt: typeof r.addedAt === "number" ? r.addedAt : 0,
      });
    }
  }
  cache = out;
  return out;
}

function write(entries: LibraryShape[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); // may throw (quota / blocked)
  cache = entries;
  for (const fn of listeners) fn();
}

/** The library, newest first. */
export function loadLibrary(): readonly LibraryShape[] {
  return read();
}

export function libraryShape(id: string): LibraryShape | undefined {
  return read().find((e) => e.id === id);
}

/** Add a sanitized shape. Re-adding identical geometry returns the existing entry unchanged. */
export function addToLibrary(entry: { name: string; svg: string; viewBox: string }): LibraryShape {
  const id = hash(entry.svg + "|" + entry.viewBox);
  const existing = libraryShape(id);
  if (existing) return existing;
  const current = read();
  if (current.length >= MAX_SHAPE_LIBRARY) throw new LibraryFullError("library full");
  const name =
    entry.name
      .replace(/\.svg$/i, "")
      .trim()
      .slice(0, MAX_NAME) || "Shape";
  const shape: LibraryShape = {
    id,
    name,
    svg: entry.svg,
    viewBox: entry.viewBox,
    addedAt: Date.now(),
  };
  try {
    write([shape, ...current]);
  } catch {
    throw new LibraryFullError("storage refused the write");
  }
  return shape;
}

export function removeFromLibrary(id: string): void {
  const next = read().filter((e) => e.id !== id);
  try {
    write(next);
  } catch {
    cache = next; // storage refused, but the in-memory library still reflects the removal
    for (const fn of listeners) fn();
  }
}

/** Subscribe to library changes (add / remove, here or in another tab); returns an unsubscribe fn. */
export function onLibraryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Another tab of this origin added / removed a shape → drop the cache and re-render subscribers.
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    cache = null;
    for (const fn of listeners) fn();
  });
