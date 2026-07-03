// Canvas2D board rasterizer — draws a world-rect of the Yjs doc onto a 2D canvas.
//
// This exists because ADR-0009 made the 2D renderer DOM-based, which can't be rasterized per-frame:
// the VR panel (M4) needs a live texture of the board, drawn straight from the doc. Fidelity target
// is "recognisably the same board" (colors, geometry, text), not pixel-parity with the DOM renderer.
// Also reusable for a future minimap.

import {
  objectsMap,
  orderArray,
  readObject,
  sideMidpoint,
  type BoardObject,
  type ConnectorEnd,
  type ConnectorObject,
  type StrokeObject,
  type TextObject,
} from "@komuboard/shared";
import type * as Y from "yjs";

import { imageSrcUrl } from "../uploads";

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---- async asset cache (uploaded images + stamp art) -------------------------------------------
// drawBoardRegion is synchronous; bitmaps load in the background and the caller redraws when one
// arrives (onAssetLoad). crossOrigin keeps the canvas untainted so WebGL can upload it (the /img
// route sends Access-Control-Allow-Origin).
const assetCache = new Map<string, HTMLImageElement | null>();
let notifyAssetLoaded: (() => void) | null = null;

function assetImage(url: string): HTMLImageElement | null {
  const hit = assetCache.get(url);
  if (hit !== undefined) return hit;
  assetCache.set(url, null); // loading (or failed — either way the placeholder shows)
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    assetCache.set(url, img);
    notifyAssetLoaded?.();
  };
  img.src = url;
  return null;
}

/** Resolve a stamp's `src` to drawable art (mirrors the 2D paintStamp routing). */
function stampUrl(src: string): string | null {
  const i = src.indexOf(":");
  if (i < 0) return null;
  const kind = src.slice(0, i);
  const val = src.slice(i + 1);
  if (kind === "emoji") return `/emoji/${val}.svg`;
  if (kind === "mark") return `/stamps/${val}.svg`;
  if (kind === "img") return val; // avatar data-URL
  return null;
}

export interface RasterOptions {
  background?: string;
  /** Draw the board's dot/line grid under the objects (the VR panel mirrors the 2D theme). */
  grid?: { mode: "dots" | "lines"; color: string };
  /** Called (once per asset) when an image/stamp bitmap finishes loading — redraw to show it. */
  onAssetLoad?: () => void;
}

/** Draw every object intersecting `rect` onto `ctx`, mapping the rect to the canvas's full pixel
 *  size. The caller owns the canvas (and calls this again on doc/viewport changes). */
export function drawBoardRegion(
  ctx: CanvasRenderingContext2D,
  doc: Y.Doc,
  rect: WorldRect,
  opts: RasterOptions = {},
): void {
  if (opts.onAssetLoad) notifyAssetLoaded = opts.onAssetLoad;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const scale = Math.min(W / rect.width, H / rect.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = opts.background ?? "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);
  if (opts.grid) drawGrid(ctx, rect, scale, opts.grid);

  const objs = objectsMap(doc);
  const geomById = new Map<string, TextObject>();
  const all: BoardObject[] = [];
  for (const id of orderArray(doc).toArray()) {
    const m = objs.get(id);
    const o = m ? readObject(m) : null;
    if (!o) continue;
    all.push(o);
    if (o.type === "text") geomById.set(o.id, o);
  }
  for (const o of all) {
    if (o.type === "text") drawBox(ctx, o);
    else if (o.type === "stroke") drawStroke(ctx, o);
    else if (o.type === "connector") drawConnector(ctx, o, geomById);
    else if (o.type === "stamp") drawStamp(ctx, o.x, o.y, o.size, o.src, o.rotation);
    else if (o.type === "image")
      drawUploadedImage(ctx, o.x, o.y, o.width, o.height, o.src, o.rotation);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** The 2D board's grid, in world space: 24-unit spacing at 100%, doubled (LOD) while a spacing
 *  would land under ~8 texture px so a zoomed-out panel never crowds into a solid fill. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  rect: WorldRect,
  scale: number,
  grid: { mode: "dots" | "lines"; color: string },
): void {
  let sp = 24;
  while (sp * scale < 8) sp *= 2;
  const x0 = Math.floor(rect.x / sp) * sp;
  const y0 = Math.floor(rect.y / sp) * sp;
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  ctx.fillStyle = grid.color;
  ctx.strokeStyle = grid.color;
  if (grid.mode === "lines") {
    ctx.lineWidth = Math.max(0.5, 0.75 / scale);
    ctx.beginPath();
    for (let x = x0; x <= x1; x += sp) {
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, y1);
    }
    for (let y = y0; y <= y1; y += sp) {
      ctx.moveTo(rect.x, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
    return;
  }
  const r = Math.max(0.8, 1.6 / scale);
  for (let x = x0; x <= x1; x += sp) {
    for (let y = y0; y <= y1; y += sp) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 7);
      ctx.fill();
    }
  }
}

function withRotation(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  deg: number | undefined,
  draw: () => void,
): void {
  if (!deg) {
    draw();
    return;
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  draw();
  ctx.restore();
}

/** Sticky / shape / plain text box. Heights follow the stored geometry (auto-grown text may render
 *  slightly shorter than the DOM — fine for the texture's fidelity target). */
function drawBox(ctx: CanvasRenderingContext2D, o: TextObject): void {
  const w = o.width ?? 160;
  const h = o.height ?? (o.bg ? w : 40);
  withRotation(ctx, o.x + w / 2, o.y + h / 2, o.rotation, () => {
    if (o.bg || o.shape) {
      ctx.beginPath();
      if (o.shape === "ellipse") ctx.ellipse(o.x + w / 2, o.y + h / 2, w / 2, h / 2, 0, 0, 7);
      else if (o.shape === "rhombus") {
        ctx.moveTo(o.x + w / 2, o.y);
        ctx.lineTo(o.x + w, o.y + h / 2);
        ctx.lineTo(o.x + w / 2, o.y + h);
        ctx.lineTo(o.x, o.y + h / 2);
        ctx.closePath();
      } else if (o.shape === "triangle") {
        ctx.moveTo(o.x + w / 2, o.y);
        ctx.lineTo(o.x + w, o.y + h);
        ctx.lineTo(o.x, o.y + h);
        ctx.closePath();
      } else ctx.roundRect(o.x, o.y, w, h, 4);
      ctx.fillStyle = o.bg ?? "#ffffff";
      ctx.fill();
      // Shapes carry a border by DEFAULT in 2D (1.5px solid #1f2933; borderStyle "none" opts out).
      // Stickies/plain text have none unless explicitly set.
      const bStyle = o.borderStyle ?? "solid";
      const bColor = o.borderColor ?? (o.shape ? "#1f2933" : undefined);
      if (bColor && bStyle !== "none") {
        ctx.strokeStyle = bColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(bStyle === "dashed" ? [6, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Text: run lines split on \n; no wrapping (fidelity target, not parity). Shape labels centre
    // vertically like the 2D renderer; sticky/plain text flows from the top.
    const text = (o.runs ?? [])
      .map((r) => r.text)
      .join("")
      .trim();
    if (text) {
      ctx.fillStyle = "#111827";
      ctx.font = `${o.fontSize || 16}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      const pad = 10;
      const lh = (o.fontSize || 16) * 1.3;
      const lines = text.split("\n");
      const top = o.shape ? Math.max(o.y + pad, o.y + (h - lines.length * lh) / 2) : o.y + pad;
      lines.forEach((line, i) => {
        if (top - o.y + (i + 1) * lh > h) return; // clip to the box
        const tw = ctx.measureText(line).width;
        const tx =
          o.align === "center"
            ? o.x + (w - tw) / 2
            : o.align === "right"
              ? o.x + w - pad - tw
              : o.x + pad;
        ctx.fillText(line, tx, top + i * lh);
      });
    }
  });
}

function drawStroke(ctx: CanvasRenderingContext2D, o: StrokeObject): void {
  const pts = o.points;
  if (pts.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(pts[0] as number, pts[1] as number);
  for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] as number, pts[i + 1] as number);
  const highlight = o.style.includes("highlight");
  ctx.strokeStyle = o.color;
  ctx.globalAlpha = highlight ? Math.min(o.opacity, 0.45) : o.opacity;
  ctx.lineWidth = highlight ? o.width * 1.6 : o.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(o.style === "dashed" ? [o.width * 2.5, o.width * 2] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** Resolve a connector end: bound ends re-derive the shape's side midpoint (like the live renderer);
 *  free ends use their stored point. */
function endPoint(e: ConnectorEnd, geom: Map<string, TextObject>): { x: number; y: number } {
  if (e.shapeId) {
    const s = geom.get(e.shapeId);
    if (s && e.side) {
      const w = s.width ?? 160;
      const h = s.height ?? w;
      return sideMidpoint({ x: s.x, y: s.y, width: w, height: h }, e.side);
    }
  }
  return { x: e.x, y: e.y };
}

/** How far a solid cap's body extends back from the tip (the shaft trims by this) — mirrors 2D. */
function capInset(cap: string | undefined, w: number): number {
  if (cap === "arrow" || cap === "triangle") return w * 3.2;
  if (cap === "circle") return w * 1.6;
  if (cap === "diamond") return w * 1.9;
  return 0;
}

/** One endpoint cap, mirroring the 2D capSvg exactly: "line" = open-V head (the DEFAULT for
 *  arrow/elbow kinds), "arrow" = filled triangle, "triangle" = white-filled outline, and
 *  circle/diamond = white-filled outlines centred AT the tip (the diamond axis-aligned, like 2D). */
function drawCap(
  ctx: CanvasRenderingContext2D,
  cap: string,
  tip: { x: number; y: number },
  angle: number,
  color: string,
  w: number,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  if (cap === "arrow" || cap === "triangle" || cap === "line") {
    const len = w * 3.2;
    const half = w * 2;
    const bx = tip.x - cos * len;
    const by = tip.y - sin * len;
    const b1 = { x: bx - sin * half, y: by + cos * half };
    const b2 = { x: bx + sin * half, y: by - cos * half };
    ctx.beginPath();
    if (cap === "line") {
      ctx.moveTo(b1.x, b1.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      return;
    }
    const outline = cap === "triangle";
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(b1.x, b1.y);
    ctx.lineTo(b2.x, b2.y);
    ctx.closePath();
    ctx.fillStyle = outline ? "#ffffff" : color;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = outline ? w * 0.8 : w * 0.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  if (cap === "circle") {
    ctx.arc(tip.x, tip.y, w * 1.6, 0, 7);
  } else {
    const rd = w * 1.9; // diamond
    ctx.moveTo(tip.x, tip.y - rd);
    ctx.lineTo(tip.x + rd, tip.y);
    ctx.lineTo(tip.x, tip.y + rd);
    ctx.lineTo(tip.x - rd, tip.y);
    ctx.closePath();
  }
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = w * 0.8;
  ctx.lineJoin = "round";
  ctx.stroke();
}

function drawConnector(
  ctx: CanvasRenderingContext2D,
  o: ConnectorObject,
  geom: Map<string, TextObject>,
): void {
  const a = endPoint(o.from, geom);
  const b = endPoint(o.to, geom);
  // Elbow: the same single-bend L-route as the live renderer (side-bound ends pick the axis).
  const pts: { x: number; y: number }[] = [a];
  if (o.kind === "elbow" && Math.abs(b.x - a.x) > 1 && Math.abs(b.y - a.y) > 1) {
    const horizontalFirst =
      o.from.side === "left" || o.from.side === "right"
        ? true
        : o.from.side === "top" || o.from.side === "bottom"
          ? false
          : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    pts.push(horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
  }
  pts.push(b);

  // Trim the shaft where a solid cap's body sits, so the line doesn't poke through it.
  const first = pts[0] as { x: number; y: number };
  const second = pts[1] as { x: number; y: number };
  const last = pts[pts.length - 1] as { x: number; y: number };
  const prev = pts[pts.length - 2] as { x: number; y: number };
  const startAng = Math.atan2(first.y - second.y, first.x - second.x);
  const endAng = Math.atan2(last.y - prev.y, last.x - prev.x);
  const startTrim = capInset(o.startCap, o.width);
  const endTrim = capInset(o.endCap, o.width);
  const shaftStart = {
    x: first.x - startTrim * Math.cos(startAng),
    y: first.y - startTrim * Math.sin(startAng),
  };
  const shaftEnd = {
    x: last.x - endTrim * Math.cos(endAng),
    y: last.y - endTrim * Math.sin(endAng),
  };

  ctx.beginPath();
  ctx.moveTo(shaftStart.x, shaftStart.y);
  for (let i = 1; i < pts.length - 1; i++)
    ctx.lineTo((pts[i] as { x: number }).x, (pts[i] as { y: number }).y);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.strokeStyle = o.color;
  ctx.lineWidth = o.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(o.style === "dashed" ? [o.width * 2.5, o.width * 2] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  if (o.startCap && o.startCap !== "none")
    drawCap(ctx, o.startCap, first, startAng, o.color, o.width);
  if (o.endCap && o.endCap !== "none") drawCap(ctx, o.endCap, last, endAng, o.color, o.width);
}

/** Stamps: the same art as 2D (emoji/mark SVGs, avatar data-URLs) via the async asset cache; a
 *  soft disc placeholder shows for the frame or two before the bitmap arrives. */
function drawStamp(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  src: string,
  rotation?: number,
): void {
  withRotation(ctx, cx, cy, rotation, () => {
    const url = stampUrl(src);
    const img = url ? assetImage(url) : null;
    if (img) {
      ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
      return;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, 7);
    ctx.fillStyle = "#cbd5e1";
    ctx.fill();
  });
}

/** Uploaded images: the real bitmap once loaded (the box is aspect-locked, so a plain fill draw is
 *  exact); a placeholder frame while it loads or if it can't. */
function drawUploadedImage(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  key: string,
  rotation?: number,
): void {
  withRotation(ctx, x + w / 2, y + h / 2, rotation, () => {
    const img = assetImage(imageSrcUrl(key));
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 6);
      ctx.clip();
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
      return;
    }
    ctx.fillStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fill();
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.25, y + h * 0.7);
    ctx.lineTo(x + w * 0.45, y + h * 0.45);
    ctx.lineTo(x + w * 0.6, y + h * 0.6);
    ctx.lineTo(x + w * 0.75, y + h * 0.4);
    ctx.stroke();
  });
}
