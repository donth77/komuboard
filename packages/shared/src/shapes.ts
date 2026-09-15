// The shape catalog — the single source of truth for every built-in shape the "Shapes and lines"
// tool can place. The 2D renderer (text-layer.ts), the VR rasterizer (vr/board-raster.ts), every
// icon (shape menu, shapes panel, text bar), search, and doc validation all read THIS table, so a
// shape can't look different in 2D and VR or exist in one picker and not another.
//
// Geometry is an SVG path in a 0..100 × 0..100 box that is stretched (non-uniformly) to the shape
// box at render time; strokes are applied non-scaling so the outline stays a crisp 1.5px like the
// CSS-border shapes. Shapes that read better with a real CSS border (rectangle, rounded rectangle,
// pill, oval) carry a `box` hint; their `path` is still used for icons + VR.

export interface ShapeDef {
  /** Catalog id. Also the i18n key suffix (`shape.<id>`) and the box's `shape-<id>` CSS class. */
  id: string;
  section: "basic" | "flowchart";
  /** Outline as an SVG path in the 0..100 box (may contain several subpaths: interior lines). */
  path: string;
  /** Icon-only override: the same shape drawn at its natural (non-square) aspect. */
  icon?: string;
  /** Draw with a CSS border / canvas roundRect instead of the path (crisp, corners stay round). */
  box?: "rect" | "round" | "pill" | "ellipse";
  /** Stroke-only shapes (braces): the fill colour is ignored. */
  noFill?: boolean;
  /** English search aliases, lowercase. The first is the English name; the localized label is
   *  always matched too (by the client). */
  aliases: readonly string[];
  /** Label-area inset as fractions of the box height/width: [top, right, bottom, left]. Keeps the
   *  text out of a tail, a point, or a cylinder cap. Omitted = the plain centred label. */
  inset?: readonly [number, number, number, number];
  /** Natural box (canvas units) when tap-placed — a page is taller than wide, a terminator is a wide
   *  pill, a circle symbol is square. Omitted = DEFAULT_SHAPE_W × DEFAULT_SHAPE_H. */
  size?: readonly [number, number];
  /** Keep the box square when resized (circle symbols: a stretched circle is a different shape). */
  lockAspect?: boolean;
}

/** The `shape` value of a user-uploaded SVG shape (its geometry lives on the object itself). */
export const CUSTOM_SHAPE = "custom";

/** Sanitized custom-shape markup cap (chars). Every placed instance embeds its markup in the doc,
 *  so this bounds per-object doc growth (≈ 16 KB is a detailed icon; a logo export is far smaller). */
export const MAX_CUSTOM_SHAPE_SVG_CHARS = 16_384;
/** Raw SVG file cap for the "Browse and upload SVG shapes" picker. */
export const MAX_SHAPE_UPLOAD_BYTES = 256 * 1024;
/** Per-device custom-shape library cap (entries). */
export const MAX_SHAPE_LIBRARY = 40;

const ELLIPSE_PATH = "M1 50A49 49 0 1 0 99 50A49 49 0 1 0 1 50Z";

export const SHAPE_CATALOG: readonly ShapeDef[] = [
  // ---- Basic ----------------------------------------------------------------------------------
  {
    id: "rectangle",
    section: "basic",
    box: "rect",
    path: "M1 1H99V99H1Z",
    icon: "M4 20H96V80H4Z",
    aliases: ["rectangle", "process", "square", "box"],
  },
  {
    id: "rounded",
    section: "basic",
    box: "round",
    path: "M13 1H87Q99 1 99 13V87Q99 99 87 99H13Q1 99 1 87V13Q1 1 13 1Z",
    icon: "M16 20H84Q96 20 96 32V68Q96 80 84 80H16Q4 80 4 68V32Q4 20 16 20Z",
    aliases: ["rounded rectangle", "alternate process", "rounded"],
  },
  {
    id: "ellipse",
    section: "basic",
    box: "ellipse",
    path: ELLIPSE_PATH,
    icon: "M4 50A46 30 0 1 0 96 50A46 30 0 1 0 4 50Z",
    aliases: ["oval", "ellipse", "circle", "connector", "start", "end"],
  },
  {
    id: "pill",
    section: "basic",
    box: "pill",
    path: "M50 1A49 49 0 1 0 50 99A49 49 0 1 0 50 1Z",
    icon: "M30 25H70A25 25 0 0 1 70 75H30A25 25 0 0 1 30 25Z",
    aliases: ["pill", "terminator", "stadium", "capsule", "start", "end"],
    size: [180, 90],
  },
  {
    id: "triangle",
    section: "basic",
    path: "M50 1L99 99H1Z",
    aliases: ["triangle", "extract"],
    inset: [0.3, 0, 0, 0],
  },
  {
    id: "triangleDown",
    section: "basic",
    path: "M1 1H99L50 99Z",
    aliases: ["inverted triangle", "merge", "funnel"],
    size: [150, 130],
    inset: [0, 0, 0.3, 0],
  },
  {
    id: "rhombus",
    section: "basic",
    path: "M50 1L99 50L50 99L1 50Z",
    aliases: ["rhombus", "diamond", "decision"],
  },
  {
    id: "parallelogram",
    section: "basic",
    path: "M25 1H99L75 99H1Z",
    aliases: ["parallelogram", "data", "input", "output"],
    size: [180, 120],
  },
  {
    id: "trapezoid",
    section: "basic",
    path: "M25 1H75L99 99H1Z",
    aliases: ["trapezoid", "manual"],
    size: [180, 120],
  },
  {
    id: "pentagon",
    section: "basic",
    path: "M50 1L99 38L80 99H20L1 38Z",
    aliases: ["pentagon"],
    size: [150, 150],
  },
  {
    id: "hexagon",
    section: "basic",
    path: "M25 1H75L99 50L75 99H25L1 50Z",
    aliases: ["hexagon", "preparation"],
  },
  {
    id: "octagon",
    section: "basic",
    path: "M30 1H70L99 30V70L70 99H30L1 70V30Z",
    aliases: ["octagon", "stop"],
    size: [150, 150],
  },
  {
    id: "star",
    section: "basic",
    path: "M50 2L61.8 35.8L97.6 36.6L69 58.2L79.4 92.5L50 72L20.6 92.5L31 58.2L2.4 36.6L38.2 35.8Z",
    aliases: ["star", "favorite", "rating"],
    size: [150, 150],
  },
  {
    id: "cross",
    section: "basic",
    path: "M33 1H67V33H99V67H67V99H33V67H1V33H33Z",
    aliases: ["cross", "plus", "add"],
    size: [140, 140],
  },
  {
    id: "arrowRight",
    section: "basic",
    path: "M1 30H60V1L99 50L60 99V70H1Z",
    aliases: ["right arrow", "block arrow", "next"],
    size: [180, 110],
  },
  {
    id: "arrowLeft",
    section: "basic",
    path: "M99 30H40V1L1 50L40 99V70H99Z",
    aliases: ["left arrow", "block arrow", "back", "previous"],
    size: [180, 110],
  },
  {
    id: "arrowLeftRight",
    section: "basic",
    path: "M1 50L30 1V30H70V1L99 50L70 99V70H30V99Z",
    aliases: ["double arrow", "bidirectional", "both"],
    size: [200, 110],
  },
  {
    id: "chevron",
    section: "basic",
    path: "M1 1H75L99 50L75 99H1L25 50Z",
    aliases: ["chevron", "step"],
    size: [180, 120],
  },
  {
    id: "signpost",
    section: "basic",
    path: "M1 1H75L99 50L75 99H1Z",
    aliases: ["pentagon arrow", "tag", "label", "step", "signpost"],
    size: [180, 120],
  },
  {
    id: "speech",
    section: "basic",
    path: "M12 1H88Q99 1 99 12V64Q99 75 88 75H40L18 99L22 75H12Q1 75 1 64V12Q1 1 12 1Z",
    aliases: ["speech bubble", "callout", "comment", "chat"],
    size: [180, 140],
    inset: [0, 0, 0.25, 0],
  },
  {
    id: "cloud",
    section: "basic",
    path: "M22 90A18 18 0 0 1 8 62A20 20 0 0 1 22 30A22 22 0 0 1 56 16A20 20 0 0 1 84 34A20 20 0 0 1 92 68A16 16 0 0 1 76 90A60 60 0 0 1 22 90Z",
    aliases: ["cloud", "internet", "network", "service"],
    size: [190, 140],
    inset: [0.1, 0.05, 0.08, 0.05],
  },
  {
    id: "cylinder",
    section: "basic",
    // The front rim is a second subpath traced in the SAME (clockwise) direction as the body: an
    // opposite winding would cancel the body's fill under it (a hole) under the nonzero rule.
    path: "M1 13A49 12 0 0 1 99 13V87A49 12 0 0 1 1 87Z M99 13A49 12 0 0 1 1 13",
    aliases: ["cylinder", "database", "storage", "data store"],
    inset: [0.15, 0, 0, 0],
    size: [140, 160],
  },
  // Braces hug one edge of the box and leave the rest for their label (`{ label` / `label }`).
  {
    id: "braceLeft",
    section: "basic",
    noFill: true,
    path: "M38 1H26Q16 1 16 12V39Q16 50 2 50Q16 50 16 61V88Q16 99 26 99H38",
    icon: "M70 1H60Q45 1 45 16V38Q45 50 20 50Q45 50 45 62V84Q45 99 60 99H70",
    aliases: ["left brace", "bracket", "curly"],
    size: [180, 160],
    inset: [0, 0, 0, 0.4],
  },
  {
    id: "braceRight",
    section: "basic",
    noFill: true,
    path: "M62 1H74Q84 1 84 12V39Q84 50 98 50Q84 50 84 61V88Q84 99 74 99H62",
    icon: "M30 1H40Q55 1 55 16V38Q55 50 80 50Q55 50 55 62V84Q55 99 40 99H30",
    aliases: ["right brace", "bracket", "curly"],
    size: [180, 160],
    inset: [0, 0.4, 0, 0],
  },
  // ---- Flowchart ------------------------------------------------------------------------------
  {
    id: "predefined",
    section: "flowchart",
    path: "M1 1H99V99H1Z M12 1V99 M88 1V99",
    aliases: ["predefined process", "subroutine", "subprocess"],
    size: [180, 120],
    inset: [0, 0.1, 0, 0.1],
  },
  {
    id: "document",
    section: "flowchart",
    path: "M1 1H99V82Q75 62 50 82T1 82Z",
    aliases: ["document", "report", "page"],
    size: [150, 160],
    inset: [0, 0, 0.15, 0],
  },
  {
    id: "documents",
    section: "flowchart",
    path: "M21 1H99V73H90V11H21Z M11 11H90V83H80V21H11Z M1 21H80V86Q60 71 40 86T1 86Z",
    aliases: ["multiple documents", "files", "pages"],
    size: [160, 170],
    inset: [0.2, 0.2, 0.15, 0],
  },
  {
    id: "manualInput",
    section: "flowchart",
    path: "M1 30L99 1V99H1Z",
    aliases: ["manual input", "keyboard", "entry"],
    size: [180, 130],
    inset: [0.15, 0, 0, 0],
  },
  {
    id: "manualOperation",
    section: "flowchart",
    path: "M1 1H99L75 99H25Z",
    aliases: ["manual operation"],
    size: [180, 130],
  },
  {
    id: "delay",
    section: "flowchart",
    path: "M1 1H60A39 49 0 0 1 60 99H1Z",
    aliases: ["delay", "wait"],
    size: [180, 120],
  },
  {
    id: "display",
    section: "flowchart",
    path: "M1 50L25 1H80A19 49 0 0 1 80 99H25Z",
    aliases: ["display", "screen", "monitor", "output"],
    size: [180, 120],
    inset: [0, 0.1, 0, 0.15],
  },
  {
    id: "storedData",
    section: "flowchart",
    path: "M25 1H99A24 49 0 0 0 99 99H25A24 49 0 0 1 25 1Z",
    aliases: ["stored data", "storage"],
    size: [180, 130],
    inset: [0, 0.2, 0, 0],
  },
  {
    id: "internalStorage",
    section: "flowchart",
    path: "M1 1H99V99H1Z M1 20H99 M20 1V99",
    aliases: ["internal storage", "memory"],
    size: [180, 130],
    inset: [0.2, 0, 0, 0.2],
  },
  {
    id: "offPage",
    section: "flowchart",
    path: "M1 1H99V70L50 99L1 70Z",
    aliases: ["off-page connector", "link", "page", "reference"],
    size: [150, 160],
    inset: [0, 0, 0.2, 0],
  },
  {
    id: "or",
    section: "flowchart",
    path: `${ELLIPSE_PATH} M50 1V99 M1 50H99`,
    aliases: ["or", "junction"],
    size: [130, 130],
    lockAspect: true,
  },
  {
    id: "summing",
    section: "flowchart",
    path: `${ELLIPSE_PATH} M15.4 15.4L84.6 84.6 M84.6 15.4L15.4 84.6`,
    aliases: ["summing junction", "sum", "junction"],
    size: [130, 130],
    lockAspect: true,
  },
  {
    id: "collate",
    section: "flowchart",
    path: "M1 1H99L1 99H99Z",
    aliases: ["collate", "hourglass"],
    size: [130, 150],
  },
  {
    id: "sort",
    section: "flowchart",
    path: "M50 1L99 50L50 99L1 50Z M1 50H99",
    aliases: ["sort", "order"],
    size: [150, 150],
  },
  {
    id: "card",
    section: "flowchart",
    path: "M25 1H99V99H1V25Z",
    aliases: ["card", "punched card"],
    size: [160, 130],
  },
  {
    id: "tape",
    section: "flowchart",
    path: "M1 12Q25 -8 50 12T99 12V88Q75 108 50 88T1 88Z",
    aliases: ["punched tape", "paper tape"],
    size: [180, 130],
    inset: [0.1, 0, 0.1, 0],
  },
  {
    id: "loopLimit",
    section: "flowchart",
    path: "M20 1H80L99 20V99H1V20Z",
    aliases: ["loop limit", "loop", "for"],
    size: [180, 120],
  },
  {
    id: "directAccess",
    section: "flowchart",
    // Same winding rule as the cylinder: the inner rim runs clockwise like the body.
    path: "M13 1H87A12 49 0 0 1 87 99H13A12 49 0 0 1 13 1Z M87 99A12 49 0 0 1 87 1",
    aliases: ["direct access storage", "disk", "drum"],
    inset: [0, 0.2, 0, 0.1],
    size: [180, 110],
  },
  {
    id: "sequentialData",
    section: "flowchart",
    path: `${ELLIPSE_PATH} M50 99H99`,
    aliases: ["sequential data", "magnetic tape", "tape"],
    size: [130, 130],
    lockAspect: true,
  },
  {
    id: "note",
    section: "flowchart",
    path: "M1 1H75L99 25V99H1Z M75 1V25H99",
    aliases: ["note", "comment", "annotation", "folded corner"],
    size: [150, 160],
  },
];

const BY_ID: ReadonlyMap<string, ShapeDef> = new Map(SHAPE_CATALOG.map((d) => [d.id, d]));

/** Look a catalog shape up by id (undefined for `custom` or an unknown id). */
export function shapeDef(id: string): ShapeDef | undefined {
  return BY_ID.get(id);
}

/** Every value `TextObject.shape` may take: the catalog ids + "custom". */
export const SHAPE_KINDS: readonly string[] = [...SHAPE_CATALOG.map((d) => d.id), CUSTOM_SHAPE];

/** A custom shape's geometry as stored on a text object / in the device library. `svg` is the
 *  sanitized inner markup (children of <svg>), `viewBox` the "minX minY width height" it's drawn in. */
export interface CustomShape {
  svg: string;
  viewBox: string;
}

/** Parse a viewBox string into [minX, minY, width, height]; null unless it's four finite numbers
 *  with a positive size. */
export function parseViewBox(vb: unknown): [number, number, number, number] | null {
  if (typeof vb !== "string") return null;
  const parts = vb.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const n = parts.map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  const [x, y, w, h] = n as [number, number, number, number];
  if (w <= 0 || h <= 0) return null;
  return [x, y, w, h];
}

/** Validate a custom shape as it arrives from the doc / awareness / a library file: non-empty
 *  markup within the size cap + a parseable viewBox. Returns the typed pair or null. */
export function customShapeOf(svg: unknown, viewBox: unknown): CustomShape | null {
  if (typeof svg !== "string" || !svg || svg.length > MAX_CUSTOM_SHAPE_SVG_CHARS) return null;
  if (!parseViewBox(viewBox)) return null;
  return { svg, viewBox: viewBox as string };
}

/** Lower-case, trim, and strip diacritics — so "Décision" matches "decision" and vice versa. */
export function normalizeQuery(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Whether a catalog shape matches a (normalized) query: its localized label, id, or any alias. */
export function shapeMatches(def: ShapeDef, query: string, label: string): boolean {
  if (!query) return true;
  if (normalizeQuery(label).includes(query)) return true;
  if (def.id.toLowerCase().includes(query)) return true;
  return def.aliases.some((a) => a.includes(query));
}

/** Escape the few characters that would break an attribute value. */
function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** An outline icon (24px-style, strokes in currentColor) for a catalog shape. Uniform scaling, so a
 *  wide shape's `icon` override keeps its aspect. */
export function shapeIconSvg(def: ShapeDef, cls = "sp-ico"): string {
  const d = def.icon ?? def.path;
  return (
    `<svg class="${cls}" viewBox="-3 -3 106 106" fill="none" stroke="currentColor" stroke-width="1.6" ` +
    `stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">` +
    `<path d="${attr(d)}" vector-effect="non-scaling-stroke"/></svg>`
  );
}

/** An outline icon for a custom shape (markup sanitized by the client's importer). Only ever fed
 *  markup that passed THIS device's sanitizer (the library) — never doc-sourced markup. */
export function customShapeIconSvg(shape: CustomShape, cls = "sp-ico"): string {
  const vb = parseViewBox(shape.viewBox);
  const [x, y, w, h] = vb ?? [0, 0, 100, 100];
  const pad = Math.max(w, h) * 0.03;
  return (
    `<svg class="${cls}" viewBox="${x - pad} ${y - pad} ${w + 2 * pad} ${h + 2 * pad}" fill="none" ` +
    `stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">` +
    `<g>${shape.svg}</g></svg>`
  );
}

/** The dash pattern a dashed shape outline uses (screen px, matches the CSS `dashed` border look). */
export const SHAPE_DASH = "6 5";

/** Build the stretched-outline SVG markup a shape box paints as its background (2D) or rasterizes
 *  (VR): the path/markup in its own viewBox with `preserveAspectRatio="none"`, a non-scaling stroke
 *  so the outline stays 1.5px at any size, and the box's fill + border colours applied. `stroke`
 *  "transparent" draws no outline (border style "none"). */
export function shapeOutlineSvg(
  geometry: { path: string; noFill?: boolean } | CustomShape,
  fill: string,
  stroke: string,
  dashed: boolean,
): string {
  const dash = dashed ? ` stroke-dasharray="${SHAPE_DASH}"` : "";
  if ("path" in geometry) {
    const f = geometry.noFill ? "none" : attr(fill);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">` +
      `<path d="${attr(geometry.path)}" fill="${f}" stroke="${attr(stroke)}" stroke-width="1.5" ` +
      `vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"${dash}/></svg>`
    );
  }
  const vb = parseViewBox(geometry.viewBox) ?? [0, 0, 100, 100];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" preserveAspectRatio="none">` +
    `<g fill="${attr(fill)}" stroke="${attr(stroke)}" stroke-width="1.5" stroke-linejoin="round" ` +
    `stroke-linecap="round"${dash}>${geometry.svg}</g></svg>`
  );
}
