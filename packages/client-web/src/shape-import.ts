// Custom-shape import: turn an uploaded SVG file into the sanitized geometry a custom shape carries.
//
// The output is built from scratch (never the source nodes) through an allow-list of elements and
// attributes, so no script, style, text, image, link, filter, or event handler survives — only
// outlines. Colours are stripped too: on the board the shape takes the box's fill + border like
// every built-in. The tight bounding box becomes the viewBox so the outline fills its box.
import {
  MAX_CUSTOM_SHAPE_SVG_CHARS,
  MAX_SHAPE_UPLOAD_BYTES,
  type CustomShape,
} from "@komuboard/shared";

import { t } from "./i18n";

/** A user-presentable import failure; `message` is the localized toast text. */
export class ShapeImportError extends Error {
  constructor(public readonly key: string) {
    super(t(key));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Containers we descend into (rendered as plain <g>s — a nested <svg>'s own viewport is ignored). */
const CONTAINERS = new Set(["svg", "g", "a", "switch"]);
/** Geometry elements kept, with their allowed attributes (all numeric or path/points data). */
const GEOMETRY: Readonly<Record<string, readonly string[]>> = {
  path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  polygon: ["points"],
  polyline: ["points"],
  line: ["x1", "y1", "x2", "y2"],
};
/** Attributes without which the element has no geometry (dropped when missing / invalid). */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  path: ["d"],
  rect: ["width", "height"],
  circle: ["r"],
  ellipse: ["rx", "ry"],
  polygon: ["points"],
  polyline: ["points"],
  line: [],
};
const NUMBER = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px)?\s*$/i;
const PATH_DATA = /^[\sMmLlHhVvCcSsQqTtAaZz0-9.,eE+-]*$/;
const POINTS = /^[\s0-9.,eE+-]*$/;
const TRANSFORM =
  /^\s*(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*[-+0-9.eE\s,]*\)\s*,?\s*)+$/;
const MAX_ATTR = MAX_CUSTOM_SHAPE_SVG_CHARS; // a single attribute can't exceed the whole budget

function validValue(name: string, value: string): boolean {
  if (value.length > MAX_ATTR) return false;
  if (name === "d") return PATH_DATA.test(value) && /[MmLlHhVvCcSsQqTtAa]/.test(value);
  if (name === "points") return POINTS.test(value) && /\d/.test(value);
  return NUMBER.test(value);
}

/** Elements the source hides (display / visibility / opacity, attribute or inline style) are
 *  dropped with their subtree — they'd otherwise show up as outlines. */
function isHidden(el: Element): boolean {
  if (el.getAttribute("display")?.trim() === "none") return true;
  const vis = el.getAttribute("visibility")?.trim();
  if (vis === "hidden" || vis === "collapse") return true;
  if (parseFloat(el.getAttribute("opacity") ?? "1") === 0) return true;
  const style = el.getAttribute("style") ?? "";
  return /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)/i.test(style);
}

function copyTransform(src: Element, dst: Element): void {
  const tf = src.getAttribute("transform");
  if (tf && tf.length <= MAX_ATTR && TRANSFORM.test(tf)) dst.setAttribute("transform", tf.trim());
}

/** Rebuild one geometry element from its allow-listed attributes; null if it has none usable. */
function buildGeometry(src: Element, name: string): Element | null {
  const el = document.createElementNS(SVG_NS, name);
  for (const attr of GEOMETRY[name]!) {
    const v = src.getAttribute(attr);
    if (v == null) continue;
    if (!validValue(attr, v)) {
      if (REQUIRED[name]!.includes(attr)) return null;
      continue;
    }
    el.setAttribute(attr, v.trim().replace(/px$/i, ""));
  }
  for (const attr of REQUIRED[name]!) if (!el.hasAttribute(attr)) return null;
  copyTransform(src, el);
  const rule = src.getAttribute("fill-rule");
  if (rule === "evenodd" || rule === "nonzero") el.setAttribute("fill-rule", rule);
  // An unfilled source path (an open stroke) stays unfilled; every other fill/stroke/style is dropped
  // so the box's own colours apply.
  if (src.getAttribute("fill")?.trim().toLowerCase() === "none") el.setAttribute("fill", "none");
  el.setAttribute("vector-effect", "non-scaling-stroke"); // the outline stays 1.5px at any box size
  return el;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Parse SVG text and rebuild only its allow-listed geometry into a fresh <g>. null when the text
 *  isn't an SVG document; `kept` counts the geometry elements that survived. */
function rebuildGeometry(text: string): { out: SVGGElement; kept: number } | null {
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length)
    return null;
  const out = document.createElementNS(SVG_NS, "g");
  let kept = 0;
  const walk = (src: Element, dst: Element): void => {
    for (const child of Array.from(src.children)) {
      const name = child.localName;
      if (isHidden(child)) continue;
      if (CONTAINERS.has(name)) {
        const g = document.createElementNS(SVG_NS, "g");
        copyTransform(child, g);
        walk(child, g);
        if (g.childElementCount) dst.appendChild(g);
      } else if (name in GEOMETRY) {
        const el = buildGeometry(child, name);
        if (el) {
          dst.appendChild(el);
          kept++;
        }
      }
      // anything else (defs/use/text/image/style/script/filters/…) is dropped with its subtree
    }
  };
  walk(root, out);
  return { out, kept };
}

/** Re-run the allow-list over stored markup (the device library, read back from localStorage) so
 *  nothing that didn't come through the sanitizer is ever inlined into the chrome. Returns the
 *  (identical, for clean input) markup, or null if nothing usable survives. */
export function revalidateMarkup(svg: string): string | null {
  const built = rebuildGeometry(`<svg xmlns="${SVG_NS}">${svg}</svg>`);
  if (!built?.kept) return null;
  const clean = built.out.innerHTML;
  return clean.length <= MAX_CUSTOM_SHAPE_SVG_CHARS ? clean : null;
}

/** Sanitize + measure SVG markup. Throws ShapeImportError with a toast key on any problem. Exported
 *  for tests; `importShapeSvg` is the file-facing entry point. */
export function sanitizeSvgText(text: string): CustomShape {
  const built = rebuildGeometry(text);
  if (!built) throw new ShapeImportError("toast.svgInvalid");
  const { out, kept } = built;
  if (!kept) throw new ShapeImportError("toast.svgEmpty");

  // Measure the tight bounds by rendering off-screen (getBBox needs a live render tree).
  const host = document.createElementNS(SVG_NS, "svg");
  host.setAttribute("width", "100");
  host.setAttribute("height", "100");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:absolute;left:-9999px;top:-9999px;width:100px;height:100px;visibility:hidden;pointer-events:none";
  host.appendChild(out);
  document.body.appendChild(host);
  let box: DOMRect;
  try {
    box = out.getBBox();
  } finally {
    host.remove();
  }
  if (!(box.width > 0) || !(box.height > 0)) throw new ShapeImportError("toast.svgEmpty");
  const pad = Math.max(box.width, box.height) * 0.02; // room for the (non-scaling) stroke at the edges
  const viewBox = [box.x - pad, box.y - pad, box.width + 2 * pad, box.height + 2 * pad]
    .map(round3)
    .join(" ");
  const svg = out.innerHTML;
  if (svg.length > MAX_CUSTOM_SHAPE_SVG_CHARS) throw new ShapeImportError("toast.svgTooComplex");
  return { svg, viewBox };
}

/** Validate + sanitize an uploaded SVG file into custom-shape geometry. */
export async function importShapeSvg(file: File): Promise<CustomShape> {
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  if (!isSvg) throw new ShapeImportError("toast.svgTypeUnsupported");
  if (file.size > MAX_SHAPE_UPLOAD_BYTES) throw new ShapeImportError("toast.svgTooLarge");
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new ShapeImportError("toast.svgInvalid");
  }
  return sanitizeSvgText(text);
}
