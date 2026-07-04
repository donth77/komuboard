// Canvas2D board rasterizer — draws a world-rect of the Yjs doc onto a 2D canvas.
//
// This exists because ADR-0009 made the 2D renderer DOM-based, which can't be rasterized per-frame:
// the VR panel (M4) needs a live texture of the board, drawn straight from the doc. Fidelity target
// is "recognisably the same board" (colors, geometry, text), not pixel-parity with the DOM renderer.
// Also reusable for a future minimap.

import {
  DEFAULT_TEXT_FONT,
  objectsMap,
  orderArray,
  readObject,
  sideMidpoint,
  type BoardObject,
  type ConnectorEnd,
  type ConnectorObject,
  type DragState,
  type DrawState,
  type GroupResizeState,
  type LiveResizeState,
  type LiveRotateState,
  type StrokeObject,
  type TextEditState,
  type TextObject,
  type TextRun,
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

/** A peer's ephemeral state, projected onto the texture (cursor + live gestures + selection). The
 *  field SHAPES are the shared awareness contract (schema.ts) — reused, not re-declared, so the VR
 *  renderer can't drift from 2D (docs/09 Q1). Property names are the VR-normalized view: `resize`
 *  ← wire `textresize`, `rotate` ← `textrotate`, `groupResize` ← `groupresize` (mapped in
 *  presence-3d.ts). */
export interface PeerPresence {
  name: string;
  color: string;
  cursor?: { x: number; y: number } | null;
  /** Live pen stroke mid-draw (the "draw" awareness field). */
  draw?: DrawState | null;
  /** Live move offsets (the "drag" awareness field) — dragged objects render displaced. */
  drag?: DragState | null;
  /** Selected object ids (the "selection" awareness field) — outlined in the peer's colour. */
  selection?: string[] | null;
  /** Live text edit (the "textedit" field): a full snapshot of the box being typed — rendered in
   *  place of the committed copy so keystrokes appear live. */
  textedit?: TextEditState | null;
  /** Live resize (the "textresize" field) — absolute geometry override (fontSize 0 = unchanged). */
  resize?: LiveResizeState | null;
  /** Live rotate (the "textrotate" field). */
  rotate?: LiveRotateState | null;
  /** Live group transform (the "groupresize" field) — absolute per-node preview geometry. */
  groupResize?: GroupResizeState | null;
}

export interface RasterOptions {
  background?: string;
  /** Draw the board's dot/line grid under the objects (the VR panel mirrors the 2D theme). */
  grid?: { mode: "dots" | "lines"; color: string };
  /** Called (once per asset) when an image/stamp bitmap finishes loading — redraw to show it. */
  onAssetLoad?: () => void;
  /** Remote peers: labelled cursors on top, live strokes, and in-flight drag offsets. */
  presence?: PeerPresence[];
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

  // Live-gesture overrides: peers' in-flight resize/rotate/group transforms replace the committed
  // geometry, and a box being TYPED IN renders from its ephemeral snapshot instead of the doc copy.
  const override = new Map<
    string,
    Partial<{
      x: number;
      y: number;
      width: number;
      height: number;
      fontSize: number;
      rotation: number;
    }>
  >();
  const edits: TextObject[] = [];
  const editedIds = new Set<string>();
  for (const p of opts.presence ?? []) {
    if (p.resize)
      override.set(p.resize.id, { ...p.resize, fontSize: p.resize.fontSize || undefined });
    if (p.rotate)
      override.set(p.rotate.id, {
        ...(override.get(p.rotate.id) ?? {}),
        rotation: p.rotate.rotation,
      });
    for (const n of p.groupResize?.nodes ?? [])
      override.set(n.id, { ...n, fontSize: n.fontSize || undefined });
    if (p.textedit) {
      editedIds.add(p.textedit.id);
      edits.push({ type: "text", authorId: "", ...p.textedit });
    }
  }

  const objs = objectsMap(doc);
  const geomById = new Map<string, TextObject>();
  const all: BoardObject[] = [];
  for (const id of orderArray(doc).toArray()) {
    const m = objs.get(id);
    let o = m ? readObject(m) : null;
    if (!o) continue;
    const ov = override.get(id);
    if (ov) {
      if (o.type === "text") o = { ...o, ...ov } as BoardObject;
      else if (o.type === "stamp")
        o = {
          ...o,
          x: ov.x ?? o.x,
          y: ov.y ?? o.y,
          size: ov.width ?? o.size,
          rotation: ov.rotation ?? o.rotation,
        } as BoardObject;
    }
    all.push(o);
    if (o.type === "text") geomById.set(o.id, o);
  }
  // Live drag offsets: an object a peer is mid-move renders displaced by their broadcast delta.
  const dragOffset = new Map<string, { dx: number; dy: number }>();
  for (const p of opts.presence ?? []) {
    if (!p.drag) continue;
    for (const id of p.drag.ids) dragOffset.set(id, { dx: p.drag.dx, dy: p.drag.dy });
  }
  for (const o of all) {
    if (editedIds.has(o.id)) continue; // a peer is typing in it — the ephemeral snapshot renders below
    const off = dragOffset.get(o.id);
    if (off) {
      ctx.save();
      ctx.translate(off.dx, off.dy);
    }
    if (o.type === "text") drawBox(ctx, o);
    else if (o.type === "stroke") drawStroke(ctx, o);
    else if (o.type === "connector") drawConnector(ctx, o, geomById);
    else if (o.type === "stamp") drawStamp(ctx, o.x, o.y, o.size, o.src, o.rotation);
    else if (o.type === "image")
      drawUploadedImage(ctx, o.x, o.y, o.width, o.height, o.src, o.rotation);
    if (off) ctx.restore();
  }

  // Peers' in-progress text edits (live keystrokes; replaces the committed copy hidden above).
  for (const e of edits) drawBox(ctx, e);

  // Locked objects carry the same 🔒 badge as the 2D renderer (top-right corner, subtle).
  ctx.textBaseline = "top";
  for (const o of all) {
    if (o.locked !== true) continue;
    const bb = objectAABB(o, geomById);
    if (!bb) continue;
    const off = dragOffset.get(o.id);
    const rot = o.type === "text" || o.type === "stamp" || o.type === "image" ? o.rotation : 0;
    ctx.save();
    if (off) ctx.translate(off.dx, off.dy);
    withRotation(ctx, bb.x + bb.w / 2, bb.y + bb.h / 2, rot, () => {
      ctx.font = `${26 / scale}px system-ui, sans-serif`;
      ctx.globalAlpha = 0.8;
      ctx.textAlign = "right";
      ctx.fillText("🔒", bb.x + bb.w - 3 / scale, bb.y + 3 / scale);
    });
    ctx.restore();
  }
  ctx.textAlign = "left";
  ctx.globalAlpha = 1;

  // Peers' selections: identity-coloured dashed outlines per object (displaced when mid-drag),
  // plus the UNION box around a multi-selection — the "outer" group box the 2D renderer shows.
  for (const p of opts.presence ?? []) {
    if (!p.selection?.length) continue;
    let ux0 = Infinity;
    let uy0 = Infinity;
    let ux1 = -Infinity;
    let uy1 = -Infinity;
    let selected = 0;
    for (const id of p.selection) {
      const o = all.find((x) => x.id === id);
      if (!o) continue;
      const bb = objectAABB(o, geomById);
      if (!bb) continue;
      const off = dragOffset.get(id) ?? { dx: 0, dy: 0 };
      selected++;
      ux0 = Math.min(ux0, bb.x + off.dx);
      uy0 = Math.min(uy0, bb.y + off.dy);
      ux1 = Math.max(ux1, bb.x + bb.w + off.dx);
      uy1 = Math.max(uy1, bb.y + bb.h + off.dy);
      const pad = 4 / scale;
      const rot = o.type === "text" || o.type === "stamp" || o.type === "image" ? o.rotation : 0;
      ctx.save();
      ctx.translate(off.dx, off.dy);
      withRotation(ctx, bb.x + bb.w / 2, bb.y + bb.h / 2, rot, () => {
        ctx.beginPath();
        ctx.roundRect(bb.x - pad, bb.y - pad, bb.w + 2 * pad, bb.h + 2 * pad, 6 / scale);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 3.5 / scale;
        ctx.setLineDash([8 / scale, 5 / scale]);
        ctx.stroke();
        ctx.setLineDash([]);
      });
      ctx.restore();
    }
    if (selected >= 2) {
      const pad = 12 / scale;
      ctx.beginPath();
      ctx.roundRect(ux0 - pad, uy0 - pad, ux1 - ux0 + 2 * pad, uy1 - uy0 + 2 * pad, 8 / scale);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.5 / scale;
      ctx.stroke();
      // The "Group" pill (2D parity): shown when the peer's selection is one persistent group —
      // every selected object sharing the same groupId. Blue pill + two-squares glyph above the
      // union box's top-left corner, like .komu-group-ungroup.
      const gids = new Set(p.selection.map((id) => all.find((x) => x.id === id)?.groupId ?? null));
      const gid = gids.size === 1 ? [...gids][0] : null;
      if (gid) {
        const fs = 11 / scale;
        const ph = 22 / scale;
        ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
        const label = "Group";
        const iconW = 11 / scale;
        const gapW = 4 / scale;
        const padX = 8 / scale;
        const pw = padX * 2 + iconW + gapW + ctx.measureText(label).width;
        const px = ux0 - pad;
        const py = uy0 - pad - 5 / scale - ph;
        ctx.beginPath();
        ctx.roundRect(px, py, pw, ph, ph / 2);
        ctx.fillStyle = "#4a9eff";
        ctx.fill();
        // two overlapping squares glyph
        const ix = px + padX;
        const iy = py + (ph - iconW) / 2;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2 / scale;
        const sq = iconW * 0.55;
        ctx.strokeRect(ix, iy, sq, sq);
        ctx.strokeRect(ix + iconW - sq, iy + iconW - sq, sq, sq);
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.fillText(label, ix + iconW + gapW, py + ph / 2 + 0.5 / scale);
        ctx.textBaseline = "top";
      }
    }
  }

  // Peers' live pen strokes (mid-draw, not yet committed), then their cursors on top of everything.
  for (const p of opts.presence ?? []) {
    if (p.draw && p.draw.points.length >= 4) {
      drawStroke(ctx, {
        id: "live",
        type: "stroke",
        points: p.draw.points,
        color: p.draw.color,
        width: p.draw.width,
        style: (p.draw.style as StrokeObject["style"]) || "solid",
        opacity: 1,
        authorId: "",
      });
    }
  }
  for (const p of opts.presence ?? []) {
    if (p.cursor) drawCursor(ctx, scale, p.cursor, p.name, p.color);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Union AABB of every object — the VR zoom-to-fit target. */
export function docContentBounds(doc: Y.Doc): WorldRect | null {
  const objs = objectsMap(doc);
  const geom = new Map<string, TextObject>();
  const list: BoardObject[] = [];
  for (const id of orderArray(doc).toArray()) {
    const m = objs.get(id);
    const o = m ? readObject(m) : null;
    if (!o) continue;
    list.push(o);
    if (o.type === "text") geom.set(o.id, o);
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const o of list) {
    const bb = objectAABB(o, geom);
    if (!bb) continue;
    x0 = Math.min(x0, bb.x);
    y0 = Math.min(y0, bb.y);
    x1 = Math.max(x1, bb.x + bb.w);
    y1 = Math.max(y1, bb.y + bb.h);
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Topmost object whose AABB (padded a little for thin ink) contains the world point — the VR
 *  select/erase hit-test. Coarser than the 2D polyline-precise test; fine at laser distance. */
export function hitTestWorld(doc: Y.Doc, pt: { x: number; y: number }): string | null {
  const objs = objectsMap(doc);
  const order = orderArray(doc).toArray();
  const geom = new Map<string, TextObject>();
  const byId = new Map<string, BoardObject>();
  for (const id of order) {
    const m = objs.get(id);
    const o = m ? readObject(m) : null;
    if (!o) continue;
    byId.set(id, o);
    if (o.type === "text") geom.set(o.id, o);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const o = byId.get(order[i] as string);
    if (!o) continue;
    const bb = objectAABB(o, geom);
    if (!bb) continue;
    const pad = o.type === "stroke" || o.type === "connector" ? 8 : 0;
    if (
      pt.x >= bb.x - pad &&
      pt.x <= bb.x + bb.w + pad &&
      pt.y >= bb.y - pad &&
      pt.y <= bb.y + bb.h + pad
    )
      return o.id;
  }
  return null;
}

/** Quick world AABB for the selection outline (defaults mirror drawBox's fallbacks). */
function objectAABB(
  o: BoardObject,
  geom: Map<string, TextObject>,
): { x: number; y: number; w: number; h: number } | null {
  if (o.type === "text") {
    const w = o.width ?? 160;
    return { x: o.x, y: o.y, w, h: o.height ?? (o.bg ? w : 40) };
  }
  if (o.type === "image") return { x: o.x, y: o.y, w: o.width, h: o.height };
  if (o.type === "stamp") return { x: o.x - o.size / 2, y: o.y - o.size / 2, w: o.size, h: o.size };
  if (o.type === "stroke" || o.type === "connector") {
    const pts =
      o.type === "stroke"
        ? o.points
        : (() => {
            const a = endPoint(o.from, geom);
            const b = endPoint(o.to, geom);
            return [a.x, a.y, b.x, b.y];
          })();
    if (pts.length < 4) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i] as number);
      x1 = Math.max(x1, pts[i] as number);
      y0 = Math.min(y0, pts[i + 1] as number);
      y1 = Math.max(y1, pts[i + 1] as number);
    }
    const pad = o.width / 2;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + o.width, h: y1 - y0 + o.width };
  }
  return null;
}

/** A labelled peer cursor: the pointer triangle + a name pill, sized in screen-ish units so it reads
 *  the same at any panel zoom. */
function drawCursor(
  ctx: CanvasRenderingContext2D,
  scale: number,
  c: { x: number; y: number },
  name: string,
  color: string,
): void {
  const s = 18 / scale;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x + 0.38 * s, c.y + 1.05 * s);
  ctx.lineTo(c.x + 0.55 * s, c.y + 0.62 * s);
  ctx.lineTo(c.x + 1.05 * s, c.y + 0.4 * s);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();
  const label = name || "Guest";
  const fs = 12 / scale;
  ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  const tw = ctx.measureText(label).width;
  const px = c.x + s * 0.9;
  const py = c.y + s * 1.15;
  const padX = 6 / scale;
  const ph = fs * 1.7;
  ctx.beginPath();
  ctx.roundRect(px, py, tw + padX * 2, ph, ph / 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, px + padX, py + ph / 2);
  ctx.textBaseline = "top";
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
      } else ctx.roundRect(o.x, o.y, w, h, o.shape ? 4 : 0); // stickies are square-cornered in 2D
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
    drawObjectText(ctx, o, w, h);
  });
}

const DEFAULT_INK = "#0e1116"; // matches the 2D renderer's INK (text-layer.ts)

/**
 * Draw a text / sticky / shape's rich text with full parity to the 2D DOM renderer: the object's
 * font FAMILY (incl. the handwriting webfont) + size, per-run bold / italic / underline / strike /
 * colour / highlight, alignment, and word-wrapping to the box's inner width. Bullets are literal
 * "• " text in the runs, so lists render for free. Shapes centre vertically; sticky/plain text
 * flows from the top. (The VR panel used to hardcode Inter with no wrapping — this brings it in
 * line with web.)
 */
function drawObjectText(ctx: CanvasRenderingContext2D, o: TextObject, w: number, h: number): void {
  const runs = o.runs ?? [];
  if (!runs.some((r) => r.text)) return;
  const fs = o.fontSize || 16;
  const family = o.fontFamily || DEFAULT_TEXT_FONT;
  const lh = fs * 1.3;
  // Padding parity with 2D: .sticky 1.2em, .shape 0.7em, bare text none.
  const pad = (o.shape ? 0.7 : o.bg ? 1.2 : 0) * fs;
  const innerW = Math.max(1, w - 2 * pad);
  const fontFor = (r: TextRun): string =>
    `${r.italic ? "italic " : ""}${r.bold ? "700" : "400"} ${fs}px ${family}`;

  // Tokenize the runs into styled words (whitespace preserved), splitting on \n (hard breaks), then
  // word-wrap into visual lines that fit innerW — each carrying its originating run's style.
  type Word = { text: string; run: TextRun; width: number };
  const lines: Word[][] = [[]];
  for (const run of runs) {
    ctx.font = fontFor(run);
    run.text.split("\n").forEach((part, pi) => {
      if (pi > 0) lines.push([]);
      for (const tok of part.match(/\s+|\S+/g) ?? []) {
        const width = ctx.measureText(tok).width;
        const line = lines[lines.length - 1]!;
        const lineW = line.reduce((s, x) => s + x.width, 0);
        if (tok.trim() && line.length > 0 && lineW + width > innerW)
          lines.push([{ text: tok, run, width }]);
        else line.push({ text: tok, run, width });
      }
    });
  }

  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const totalH = lines.length * lh;
  const top = o.shape ? Math.max(o.y + pad, o.y + (h - totalH) / 2) : o.y + pad;
  // Trailing whitespace on a line doesn't count toward centre/right alignment.
  const displayWidth = (line: Word[]): number => {
    let end = line.length;
    while (end > 0 && !line[end - 1]!.text.trim()) end--;
    let s = 0;
    for (let i = 0; i < end; i++) s += line[i]!.width;
    return s;
  };

  lines.forEach((line, i) => {
    const y = top + i * lh;
    if (y + lh > o.y + h + 1) return; // clip to the box
    const dispW = displayWidth(line);
    let x =
      o.align === "center"
        ? o.x + (w - dispW) / 2
        : o.align === "right"
          ? o.x + w - pad - dispW
          : o.x + pad;
    for (const word of line) {
      ctx.font = fontFor(word.run);
      if (word.run.highlight) {
        ctx.fillStyle = word.run.highlight;
        ctx.fillRect(x, y + lh * 0.08, word.width, lh * 0.92);
      }
      ctx.fillStyle = word.run.color || DEFAULT_INK;
      ctx.fillText(word.text, x, y);
      if (word.run.underline || word.run.strike) {
        const tw = ctx.measureText(word.text.replace(/\s+$/, "")).width;
        if (tw > 0) {
          ctx.strokeStyle = word.run.color || DEFAULT_INK;
          ctx.lineWidth = Math.max(1, fs / 14);
          const uy = word.run.underline ? y + fs * 1.02 : y + fs * 0.62;
          ctx.beginPath();
          ctx.moveTo(x, uy);
          ctx.lineTo(x + tw, uy);
          ctx.stroke();
        }
      }
      x += word.width;
    }
  });
}

function drawStroke(ctx: CanvasRenderingContext2D, o: StrokeObject): void {
  const pts = o.points;
  if (pts.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(pts[0] as number, pts[1] as number);
  for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] as number, pts[i + 1] as number);
  // Brush (highlight) and dash are INDEPENDENT axes — "highlight-dashed" carries both. Values
  // mirror the 2D renderer (text-layer.ts): 1.6× width + 0.4 alpha + multiply blend for the
  // highlighter, dash pattern max(2, w·2.5)/max(2, w·2) off the BASE width.
  const highlight = o.style.includes("highlight");
  const dashed = o.style.includes("dashed");
  ctx.strokeStyle = o.color;
  ctx.globalAlpha = highlight ? Math.min(o.opacity, 0.4) : o.opacity;
  ctx.lineWidth = highlight ? o.width * 1.6 : o.width;
  if (highlight) ctx.globalCompositeOperation = "multiply";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dashed ? [Math.max(2, o.width * 2.5), Math.max(2, o.width * 2)] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
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
