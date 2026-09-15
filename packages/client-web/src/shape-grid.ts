// Shared shape-tile grid used by the shapes panel AND the text bar's shape-kind popover: the tile
// markup, search filtering over the catalog + the device library, and arrow-key navigation (one tab
// stop per grid, roving tabindex — the same pattern as the emoji picker).
import {
  CUSTOM_SHAPE,
  customShapeIconSvg,
  normalizeQuery,
  SHAPE_CATALOG,
  shapeDef,
  shapeIconSvg,
  shapeMatches,
  type CustomShape,
} from "@komuboard/shared";

import { t } from "./i18n";
import { loadLibrary, type LibraryShape } from "./shape-library";

export interface GridTile {
  /** Stable tile key: a catalog id, or `custom:<library id>` for a device-library shape. */
  key: string;
  /** The `shape` value it arms: a catalog id or "custom". */
  kind: string;
  label: string;
  /** Icon markup (an inline <svg>). */
  icon: string;
  custom?: CustomShape;
  /** Library id (custom tiles only) — for the remove control. */
  libraryId?: string;
}

/** Tile key for an armed shape: a catalog id, or `custom:<library id>`. */
export function customKey(libraryId: string): string {
  return `custom:${libraryId}`;
}

export function catalogTile(id: string): GridTile | null {
  const def = shapeDef(id);
  if (!def) return null;
  return { key: def.id, kind: def.id, label: t(`shape.${def.id}`), icon: shapeIconSvg(def) };
}

export function libraryTile(s: LibraryShape): GridTile {
  return {
    key: customKey(s.id),
    kind: CUSTOM_SHAPE,
    label: s.name,
    icon: customShapeIconSvg({ svg: s.svg, viewBox: s.viewBox }),
    custom: { svg: s.svg, viewBox: s.viewBox },
    libraryId: s.id,
  };
}

/** Catalog tiles of one section, filtered by a (raw) query. */
export function catalogTiles(section: "basic" | "flowchart", query = ""): GridTile[] {
  const q = normalizeQuery(query);
  const out: GridTile[] = [];
  for (const def of SHAPE_CATALOG) {
    if (def.section !== section) continue;
    const label = t(`shape.${def.id}`);
    if (shapeMatches(def, q, label))
      out.push({ key: def.id, kind: def.id, label, icon: shapeIconSvg(def) });
  }
  return out;
}

/** Device-library tiles, filtered by a (raw) query on their names. */
export function libraryTiles(query = ""): GridTile[] {
  const q = normalizeQuery(query);
  return loadLibrary()
    .filter((s) => !q || normalizeQuery(s.name).includes(q))
    .map(libraryTile);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/** One tile button. `removable` adds the × control (library shapes) beside it. */
export function tileHtml(tile: GridTile, selected: boolean, removable = false): string {
  const lib = tile.libraryId ? ` data-library="${esc(tile.libraryId)}"` : "";
  const btn =
    `<button class="sp-tile${selected ? " on" : ""}" type="button" role="option" aria-selected="${selected}" ` +
    `data-key="${esc(tile.key)}" data-kind="${esc(tile.kind)}"${lib} data-tip="${esc(tile.label)}" ` +
    `aria-label="${esc(tile.label)}" tabindex="-1">${tile.icon}</button>`;
  if (!removable || !tile.libraryId) return btn;
  return (
    `<span class="sp-tilewrap">${btn}` +
    `<button class="sp-remove" type="button" data-remove="${esc(tile.libraryId)}" ` +
    `aria-label="${esc(t("shapes.remove", { name: tile.label }))}" tabindex="-1">✕</button></span>`
  );
}

/** A whole grid (`role="listbox"`); the first tile is the tab stop, the rest roam via arrow keys. */
export function gridHtml(
  tiles: readonly GridTile[],
  selectedKey: string | null,
  opts: { removable?: boolean; label?: string; cls?: string } = {},
): string {
  const inner = tiles.map((tl) => tileHtml(tl, tl.key === selectedKey, opts.removable)).join("");
  const label = opts.label ? ` aria-label="${esc(opts.label)}"` : "";
  return `<div class="sp-grid${opts.cls ? ` ${opts.cls}` : ""}" role="listbox"${label}>${inner}</div>`;
}

/** Make the grid's first tile (or the selected one) the tab stop. Call after (re)rendering. */
export function initGridTabStops(root: ParentNode): void {
  for (const grid of root.querySelectorAll<HTMLElement>(".sp-grid")) {
    const tiles = [...grid.querySelectorAll<HTMLElement>(".sp-tile")];
    const stop = tiles.find((b) => b.classList.contains("on")) ?? tiles[0];
    for (const b of tiles) b.tabIndex = b === stop ? 0 : -1;
  }
}

/** Arrow / Home / End navigation between tiles within a grid (delegated on `root`). */
export function wireGridKeys(root: HTMLElement): void {
  root.addEventListener("keydown", (e) => {
    const cur = e.target as HTMLElement | null;
    if (!cur?.classList.contains("sp-tile")) return;
    const grid = cur.closest<HTMLElement>(".sp-grid");
    if (!grid) return;
    const tiles = [...grid.querySelectorAll<HTMLElement>(".sp-tile")];
    const i = tiles.indexOf(cur);
    if (i < 0) return;
    const top0 = tiles[0]?.offsetTop ?? 0;
    let cols = 1;
    while (cols < tiles.length && tiles[cols]?.offsetTop === top0) cols++;
    let next = i;
    if (e.key === "ArrowRight") next = Math.min(i + 1, tiles.length - 1);
    else if (e.key === "ArrowLeft") next = Math.max(i - 1, 0);
    else if (e.key === "ArrowDown") next = Math.min(i + cols, tiles.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(i - cols, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tiles.length - 1;
    else return;
    e.preventDefault();
    const target = tiles[next];
    if (!target || target === cur) return;
    cur.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
  });
}
