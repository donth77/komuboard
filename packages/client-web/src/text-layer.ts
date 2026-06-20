// src/text-layer.ts — the board's text objects as an HTML overlay (display boxes + the editor).
//
// Why HTML, not Konva: rich, selectable, caret-aware text is far simpler in the DOM than painted
// into a canvas scene, and a handful of text boxes cost nothing to lay out. The overlay sits above
// the Konva canvas but is `pointer-events: none`, so strokes/selection underneath keep receiving
// pointer events — only the active editor opts back into pointer events. Text is positioned in
// *screen space* (world coords × camera) and re-laid-out on every camera change, so it stays crisp
// at any zoom instead of being one big scaled (and blurry) layer.
//
// Storage is the shared TextObject (styled runs, last-writer-wins per box). While a box is being
// edited the in-progress runs are streamed to peers over the awareness channel (the same ephemeral
// pattern as live cursors/strokes) so everyone sees the text live; the doc only commits on blur.

import {
  addText,
  DEFAULT_SHAPE_FILL,
  DEFAULT_SHAPE_H,
  DEFAULT_SHAPE_W,
  DEFAULT_STICKY_SIZE,
  DEFAULT_TEXT_FONT,
  DEFAULT_TEXT_SIZE,
  deleteObject,
  deleteObjects,
  objectsMap,
  orderArray,
  randomId,
  readObject,
  setTextGeometry,
  setTextRuns,
  setTextStyle,
  translateObjects,
  type ShapeKind,
  type TextAlign,
  type TextObject,
  type TextRun,
} from "@coboard/shared";
import {
  elementToRuns,
  runsAreBulleted,
  runsToHtml,
  runsToText,
  safeHref,
  toggleBulletRuns,
} from "./text-runs";
import { TextBar, type TextBarState } from "./text-bar";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

/** The live camera transform: world→screen is `world × scale + offset`. */
export interface Camera {
  scale: number;
  x: number;
  y: number;
}

export interface TextLayerOptions {
  /** The Konva stage container; the overlay is appended here, above the canvas. */
  container: HTMLElement;
  doc: Y.Doc;
  awareness: Awareness;
  /** Reads the live camera each layout (kept a callback so the canvas stays the single owner). */
  camera: () => Camera;
  /** Notified whenever the text selection changes (lets the canvas fold it into its count). */
  onSelectionChange?: () => void;
  /** Notified after an editor commits (writes/deletes the box) — lets the canvas revert the tool. */
  onCommitted?: () => void;
}

/** A live editing session: a contenteditable box for a new (id === null) or existing text object. */
interface EditSession {
  id: string | null;
  el: HTMLDivElement;
  // World-space geometry + style of the box being edited (a new box inherits the defaults).
  x: number;
  y: number;
  width?: number;
  fontSize: number;
  fontFamily: string;
  align: TextAlign;
  /** Sticky-note paper colour, when this box is a sticky note; or the fill, when it's a shape. */
  bg?: string;
  /** Shape outline + fixed box height, when this box is a shape. */
  shape?: ShapeKind;
  height?: number;
}

/** A peer's in-progress edit, streamed over awareness (geometry travels too so a brand-new box —
 *  not yet in the doc — can be rendered before it commits). */
interface TextEditState {
  id: string | null;
  x: number;
  y: number;
  width?: number;
  fontSize: number;
  fontFamily: string;
  align: TextAlign;
  /** Sticky-note paper colour (so peers render the live edit as a coloured note). */
  bg?: string;
  shape?: ShapeKind;
  height?: number;
  runs: TextRun[];
}

type Geom = {
  x: number;
  y: number;
  width?: number;
  fontSize: number;
  fontFamily: string;
  align: TextAlign;
  bg?: string;
  shape?: ShapeKind;
  height?: number;
};

const INK = "#0e1116"; // default text ink (matches the pen default)
const SHAPE_STROKE = "#1f2933"; // shape outline colour (matches the CSS border)
// Polygon shapes drawn as an SVG-outline background (rectangle/ellipse/divider use a CSS border).
// Points are in a 0..100 viewBox, inset slightly so the stroke isn't clipped at the edges.
const SHAPE_POLYGONS: Record<string, string> = {
  triangle: "50,4 96,96 4,96",
  rhombus: "50,4 96,50 50,96 4,50",
};
/** A polygon outline + fill as an SVG data URI, stretched to the box via preserveAspectRatio=none. */
function shapeSvg(points: string, fill: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>` +
    `<polygon points='${points}' fill='${fill}' stroke='${SHAPE_STROKE}' stroke-width='2' stroke-linejoin='round'/></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}
/** A click that moves less than this (screen px) is a tap-to-place, not a drag-to-size box. */
const TAP_SLOP_PX = 6;
/** Resize floors (world units): a box can't get narrower / its font smaller than these. */
const MIN_TEXT_W = 40;
const MIN_FONT = 8;
/** Glide factor for a peer's in-progress text drag — smooths the 30 Hz stream (matches the canvas). */
const LERP = 0.3;
/** Throttle for the live in-progress-text broadcast (~30 Hz, like the cursor/stroke streams). */
const EDIT_BROADCAST_MS = 1000 / 30;

interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function sameColorMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function sameDragMap(
  a: Map<string, { dx: number; dy: number }>,
  b: Map<string, { dx: number; dy: number }>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.dx !== v.dx || o.dy !== v.dy) return false;
  }
  return true;
}
type ResizeGeom = { x: number; width: number | undefined; fontSize: number };
function sameResizeMap(a: Map<string, ResizeGeom>, b: Map<string, ResizeGeom>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.x !== v.x || o.width !== v.width || o.fontSize !== v.fontSize) return false;
  }
  return true;
}

export class TextLayer {
  private readonly root: HTMLDivElement;
  /** id → rendered display element (kept in sync with the doc). */
  private readonly els = new Map<string, HTMLDivElement>();
  /** id → measured world-space size, for hit-testing (refreshed on every layout). */
  private readonly sizes = new Map<string, { w: number; h: number }>();
  private edit: EditSession | null = null;
  private readonly objects: Y.Map<Y.Map<unknown>>;
  private readonly observer: () => void;

  // --- live peer edits (ephemeral; off the awareness channel) ---
  private lastEditSent = 0;
  private editTimer: number | null = null;
  /** clientID → ephemeral element showing that peer's in-progress text. */
  private readonly remoteEdits = new Map<number, HTMLDivElement>();
  /** clientID → that peer's broadcast geometry, so a camera change can re-lay-out it. */
  private readonly remoteGeom = new Map<number, Geom>();
  /** Object ids a *remote* peer is currently editing — their doc display copy stays hidden. */
  private remoteEditIds = new Set<string>();
  private readonly onAwareness = (): void => {
    this.renderRemoteEdits();
    this.renderRemoteSelDrag();
  };
  /** The floating rich-text toolbar (created once; shown only while an editor is open). */
  private readonly bar: TextBar;
  /** Reflect the toolbar's active states whenever the editor selection changes. */
  private readonly onSelChange = (): void => {
    if (this.edit) this.reflectBar();
  };
  /** Peers' selected text ids → their cursor colour (for the remote-selection ring). */
  private remoteSelColor = new Map<string, string>();
  /** Peers' in-progress text drag: text id → live *target* offset (mirrors their move). */
  private remoteDrag = new Map<string, { dx: number; dy: number }>();
  /** The offset actually rendered, gliding toward remoteDrag so the 30 Hz stream looks smooth. */
  private readonly remoteDragCurrent = new Map<string, { dx: number; dy: number }>();
  private glideRaf = 0;
  private lastTextDragSent = 0;
  private lastCursorSent = 0;
  /** Peers' in-progress text resize: text id → live *target* geometry, + the glided render value. */
  private remoteResize = new Map<
    string,
    { x: number; width: number | undefined; fontSize: number }
  >();
  private readonly remoteResizeCurrent = new Map<
    string,
    { x: number; width: number | undefined; fontSize: number }
  >();
  private lastResizeSent = 0;
  /** Handle box for a single text selection (created lazily), + the in-progress resize. */
  private resizeEl: HTMLDivElement | null = null;
  private resizePreview: {
    id: string;
    x: number;
    width: number | undefined;
    fontSize: number;
  } | null = null;
  private resizing: {
    id: string;
    handle: string;
    startX: number;
    ox: number;
    oy: number;
    ow: number | undefined;
    ofs: number;
    baseW: number;
  } | null = null;

  // --- selection + move (driven by the canvas's select tool; text keeps its own chrome) ---
  /** Text ids currently selected via the select tool. */
  private readonly selected = new Set<string>();
  /** In-progress drag of the text selection (world-space offset from the grab point). */
  private moveState: { startX: number; startY: number; dx: number; dy: number } | null = null;
  /** Hover card (Open / Edit) shown when the pointer is over a link — committed box or editor. */
  private linkCard: HTMLDivElement | null = null;
  private linkCardFor: HTMLAnchorElement | null = null;
  private cardHideTimer = 0;
  /** Translucent sticky-note placement preview that tracks the cursor while the sticky tool is on. */
  private stickyGhost: HTMLElement | null = null;

  constructor(private readonly opts: TextLayerOptions) {
    this.objects = objectsMap(opts.doc);
    this.root = document.createElement("div");
    this.root.className = "text-layer";
    opts.container.appendChild(this.root);
    // Links are pointer-events:none (a click must reach the canvas to select/drag the box), so link
    // hover is detected by hit-testing pointer moves over the board rather than mouseover on the link.
    opts.container.addEventListener("pointermove", this.onHoverMove, true);
    this.observer = (): void => this.render();
    this.objects.observeDeep(this.observer);
    this.opts.awareness.on("change", this.onAwareness);
    this.bar = new TextBar({
      setFontFamily: (css) => this.setEditBlock({ fontFamily: css }),
      setFontSize: (size) => this.setEditBlock({ fontSize: size }),
      toggleBullets: () => this.toggleBullets(),
      onFormat: () => {
        this.scheduleEditBroadcast(); // peers see the mark live
        this.reflectBar();
      },
    });
    this.render();
  }

  // ---- rendering ----

  /** Reconcile display elements with the doc's text objects (z-ordered), then lay them out. */
  private render(): void {
    const order = orderArray(this.opts.doc).toArray();
    const seen = new Set<string>();
    for (const id of order) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "text") continue;
      seen.add(id);
      let el = this.els.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "co-text";
        el.dataset.id = id;
        this.els.set(id, el);
      }
      this.paint(el, obj);
      this.root.appendChild(el); // (re)append in z-order — cheap for a handful of boxes
      const g = this.effectiveGeom(id, obj);
      this.layout(el, g.x, g.y, g.width, g.fontSize, obj.fontFamily, obj.align, obj.height);
    }
    for (const [id, el] of this.els) {
      if (seen.has(id)) continue;
      el.remove();
      this.els.delete(id);
      this.sizes.delete(id);
    }
    if (this.linkCardFor && !this.linkCardFor.isConnected) this.removeLinkCard(); // repaint detached it
    this.updateDisplayVisibility();
    this.refreshSelectionChrome();
    if (this.edit) this.root.appendChild(this.edit.el); // keep the editor on top of the re-stacked boxes
    if (this.stickyGhost) this.root.appendChild(this.stickyGhost); // …and the placement ghost above all
  }

  /** Hide the doc display copy of any box currently being edited (locally or by a peer). */
  private updateDisplayVisibility(): void {
    for (const [id, el] of this.els) {
      el.style.display = this.edit?.id === id || this.remoteEditIds.has(id) ? "none" : "";
    }
  }

  /** Render a text object's runs into its display element. */
  private paint(el: HTMLElement, obj: TextObject): void {
    el.innerHTML = runsToHtml(obj.runs);
    el.style.color = INK; // default ink; per-run colours override via the rendered spans
    if (obj.shape) this.applyShape(el, obj.shape, obj.bg);
    else this.applySticky(el, obj.bg);
  }

  /** Toggle the sticky-note look (coloured padded card) on a box element. */
  private applySticky(el: HTMLElement, bg: string | undefined): void {
    if (bg) {
      el.classList.add("sticky");
      el.style.background = bg;
    } else {
      el.classList.remove("sticky");
      el.style.background = "";
      el.style.minHeight = "";
    }
  }

  /** Toggle the shape look (outline + fill + centred "Add text" label) on a box element. Rectangle/
   *  ellipse/divider are drawn with a crisp CSS border (their `shape-<kind>` class); polygon shapes
   *  (triangle/rhombus) use an SVG-outline background so they actually look like the shape. */
  private applyShape(el: HTMLElement, kind: string | undefined, fill: string | undefined): void {
    for (const c of [...el.classList]) if (c.startsWith("shape")) el.classList.remove(c);
    el.style.backgroundImage = "";
    if (!kind) {
      el.style.removeProperty("height");
      return;
    }
    el.classList.add("shape", `shape-${kind}`);
    const f = fill || "#ffffff";
    const poly = SHAPE_POLYGONS[kind];
    if (poly) {
      // SVG polygon outline + fill, stretched to the box (preserveAspectRatio none).
      el.style.background = "transparent";
      el.style.backgroundImage = `url("${shapeSvg(poly, f)}")`;
    } else {
      el.style.background = f; // rectangle / ellipse / divider use the CSS border
    }
  }

  /** Position + size an element in screen space from its world geometry and the camera. A shape box
   *  passes an explicit `height` (it's a fixed width×height card, not auto-grown like text). */
  private layout(
    el: HTMLElement,
    x: number,
    y: number,
    width: number | undefined,
    fontSize: number,
    fontFamily: string,
    align: TextAlign,
    height?: number,
  ): void {
    const cam = this.opts.camera();
    el.style.left = `${x * cam.scale + cam.x}px`;
    el.style.top = `${y * cam.scale + cam.y}px`;
    el.style.fontSize = `${fontSize * cam.scale}px`;
    el.style.fontFamily = fontFamily;
    el.style.textAlign = align;
    if (width != null) {
      el.style.width = `${width * cam.scale}px`;
      el.style.whiteSpace = "pre-wrap";
    } else {
      el.style.width = "";
      el.style.whiteSpace = "pre";
    }
    // A shape is a fixed width×height card; a sticky is a square (min-height tracks its width).
    el.style.height = height != null ? `${height * cam.scale}px` : "";
    el.style.minHeight =
      el.classList.contains("sticky") && width != null ? `${width * cam.scale}px` : "";
    // Record world-space size for hit-testing (offset* are screen px → divide by scale).
    const id = el.dataset.id;
    const ow = el.offsetWidth;
    const oh = el.offsetHeight;
    // A display:none box (a peer is mid-edit on it → its copy is hidden) measures 0×0; skip the
    // write so its last good size survives. Caching a zero makes it un-hittable (unselectable) once
    // un-hidden — setRemoteEditIds re-measures it for accuracy when the peer's edit ends.
    if (id && (ow > 0 || oh > 0)) {
      this.sizes.set(id, { w: width ?? ow / cam.scale, h: oh / cam.scale });
    }
  }

  /** Re-lay-out + re-measure a single box — used when it's un-hidden after a peer's edit ends, so
   *  its size cache refreshes now that it's visible again (a render while hidden would have cached 0). */
  private relayoutBox(id: string): void {
    const el = this.els.get(id);
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (!el || obj?.type !== "text") return;
    const g = this.effectiveGeom(id, obj);
    this.layout(el, g.x, g.y, g.width, g.fontSize, obj.fontFamily, obj.align, obj.height);
  }

  /** Swap in a new set of peer-edited ids: hide/un-hide the affected copies, then re-measure any
   *  box that was just un-hidden (it may have cached a 0 size while it was display:none). */
  private setRemoteEditIds(next: Set<string>): void {
    const unhidden: string[] = [];
    for (const id of this.remoteEditIds) if (!next.has(id)) unhidden.push(id);
    this.remoteEditIds = next;
    this.updateDisplayVisibility();
    for (const id of unhidden) this.relayoutBox(id);
  }

  /** Re-run layout for every box + the editor + peers' live edits after a camera change. */
  syncTransform(): void {
    for (const [id, el] of this.els) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "text") continue;
      const g = this.effectiveGeom(id, obj);
      this.layout(el, g.x, g.y, g.width, g.fontSize, obj.fontFamily, obj.align, obj.height);
    }
    if (this.edit) {
      const e = this.edit;
      this.layout(e.el, e.x, e.y, e.width, e.fontSize, e.fontFamily, e.align, e.height);
      this.positionBar();
    }
    for (const [cid, el] of this.remoteEdits) {
      const g = this.remoteGeom.get(cid);
      if (g) this.layout(el, g.x, g.y, g.width, g.fontSize, g.fontFamily, g.align, g.height);
    }
    this.updateResizeChrome();
  }

  // ---- hit-testing ----

  /** The topmost text object whose world bbox contains the point, or null. */
  hitTest(world: { x: number; y: number }): string | null {
    const order = orderArray(this.opts.doc).toArray();
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      if (!id) continue;
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "text") continue;
      const size = this.sizes.get(id);
      if (!size) continue;
      if (
        world.x >= obj.x &&
        world.x <= obj.x + size.w &&
        world.y >= obj.y &&
        world.y <= obj.y + size.h
      ) {
        return id;
      }
    }
    return null;
  }

  // ---- editing ----

  isEditing(): boolean {
    return this.edit !== null;
  }

  /** Distance (world units) under which a text-tool drag counts as a tap. */
  tapSlop(): number {
    return TAP_SLOP_PX / Math.max(this.opts.camera().scale, 1e-6);
  }

  /** Enter edit mode on an existing text under the point, or create a new box there. */
  editOrCreate(
    world: { x: number; y: number },
    selectAll = false,
    caretAt?: { x: number; y: number },
  ): void {
    if (this.edit) this.commit();
    const hit = this.hitTest(world);
    if (hit) {
      if (this.remoteEditIds.has(hit)) return; // a peer is editing this box — leave it to them
      this.beginEdit(hit, selectAll, caretAt);
    } else {
      this.beginCreate(world.x, world.y);
    }
  }

  private beginCreate(x: number, y: number): void {
    this.openEditor({
      id: null,
      x,
      y,
      fontSize: DEFAULT_TEXT_SIZE,
      fontFamily: DEFAULT_TEXT_FONT,
      align: "left",
    });
  }

  /** Recolour the sticky note currently being edited (the palette drives this live). */
  setStickyColor(color: string): void {
    const e = this.edit;
    if (!e || e.bg == null) return; // only affects a sticky being edited
    e.bg = color;
    this.applySticky(e.el, color);
    this.scheduleEditBroadcast(); // peers see the recolour live
  }

  // ---- placement ghost (a translucent sticky that tracks the cursor before you drop it) ----
  /** Show/move a translucent placement preview of a sticky note, centred on the world point. */
  showStickyGhost(world: { x: number; y: number }, color: string): void {
    if (this.edit) return this.hideStickyGhost(); // a note is open → no ghost
    let g = this.stickyGhost;
    if (!g) {
      g = document.createElement("div");
      g.className = "co-text sticky co-text-ghost";
      this.root.appendChild(g);
      this.stickyGhost = g;
    }
    g.style.background = color;
    this.layout(
      g,
      world.x - DEFAULT_STICKY_SIZE / 2,
      world.y - DEFAULT_STICKY_SIZE / 2,
      DEFAULT_STICKY_SIZE,
      DEFAULT_TEXT_SIZE,
      DEFAULT_TEXT_FONT,
      "center",
    );
  }
  hideStickyGhost(): void {
    this.stickyGhost?.remove();
    this.stickyGhost = null;
  }

  private beginEdit(id: string, selectAll = false, caretAt?: { x: number; y: number }): void {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (obj?.type !== "text") return;
    const session: Omit<EditSession, "el"> = {
      id,
      x: obj.x,
      y: obj.y,
      fontSize: obj.fontSize,
      fontFamily: obj.fontFamily,
      align: obj.align,
    };
    if (obj.width != null) session.width = obj.width;
    if (obj.height != null) session.height = obj.height;
    if (obj.bg != null) session.bg = obj.bg;
    if (obj.shape != null) session.shape = obj.shape;
    this.openEditor(session, runsToHtml(obj.runs), selectAll, caretAt);
  }

  /** Sticky tool: drop a new sticky note at the point (or edit the box already there). */
  stickyAt(world: { x: number; y: number }, color: string): void {
    if (this.edit) this.commit();
    const hit = this.hitTest(world);
    if (hit) {
      if (this.remoteEditIds.has(hit)) return; // a peer owns this box
      this.beginEdit(hit);
    } else {
      // The square note is dropped centred on the cursor (matching the placement ghost).
      this.openEditor({
        id: null,
        x: world.x - DEFAULT_STICKY_SIZE / 2,
        y: world.y - DEFAULT_STICKY_SIZE / 2,
        width: DEFAULT_STICKY_SIZE,
        fontSize: DEFAULT_TEXT_SIZE,
        fontFamily: DEFAULT_TEXT_FONT,
        align: "left",
        bg: color,
      });
    }
  }

  /** Shapes tool: drop a new shape box (fixed width×height) centred on the point + open for a label. */
  shapeAt(world: { x: number; y: number }, kind: ShapeKind, fill: string): void {
    if (this.edit) this.commit();
    const hit = this.hitTest(world);
    if (hit) {
      if (this.remoteEditIds.has(hit)) return; // a peer owns this box
      this.beginEdit(hit);
      return;
    }
    const w = DEFAULT_SHAPE_W;
    const h = kind === "divider" ? 8 : DEFAULT_SHAPE_H;
    this.openEditor({
      id: null,
      x: world.x - w / 2,
      y: world.y - h / 2,
      width: w,
      height: h,
      fontSize: DEFAULT_TEXT_SIZE,
      fontFamily: DEFAULT_TEXT_FONT,
      align: "center",
      bg: fill || DEFAULT_SHAPE_FILL,
      shape: kind,
    });
  }

  private openEditor(
    session: Omit<EditSession, "el">,
    seedHtml = "",
    selectAll = false,
    caretAt?: { x: number; y: number },
  ): void {
    const el = document.createElement("div");
    el.className = "co-text co-text-editor";
    el.contentEditable = "true";
    el.spellcheck = false;
    el.innerHTML = seedHtml;
    el.style.color = INK;
    // Shape (outline + fixed height) or sticky (coloured square) styling on the editor itself.
    if (session.shape) this.applyShape(el, session.shape, session.bg);
    else this.applySticky(el, session.bg);
    this.hideStickyGhost(); // the real note replaces the placement preview
    this.root.appendChild(el);
    this.edit = { ...session, el };
    this.updateDisplayVisibility(); // hide the existing box's display copy while the editor stands in
    this.updateResizeChrome(); // hide the resize handles while editing
    this.layout(
      el,
      session.x,
      session.y,
      session.width,
      session.fontSize,
      session.fontFamily,
      session.align,
      session.height,
    );

    el.addEventListener("pointerdown", (e) => e.stopPropagation()); // don't reach Konva (marquee/draw)
    el.addEventListener("input", () => this.scheduleEditBroadcast());
    el.addEventListener("keydown", (e) => {
      // Esc or ⌘/Ctrl+Enter commits.
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.commit();
        return;
      }
      // In a bulleted box, a plain Enter continues the list — start the new line with a bullet.
      if (e.key === "Enter" && !e.shiftKey && runsAreBulleted(elementToRuns(el))) {
        e.preventDefault();
        document.execCommand("insertHTML", false, "<br>• ");
        this.scheduleEditBroadcast();
      }
    });
    el.addEventListener("blur", (e) => {
      // Focus moving into the toolbar / a popover (e.g. the size input) must not commit the box.
      const next = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (next?.closest(".co-text-bar, .ctb-pop, co-color-picker")) return;
      this.commit();
    });

    el.focus();
    if (caretAt) this.caretToPoint(el, caretAt.x, caretAt.y);
    else if (selectAll) this.selectAllEditor(el);
    else this.caretToEnd(el);
    document.execCommand("styleWithCSS", false, "true"); // marks emit inline-style spans (serialisable)
    this.bar.show(el, this.barState());
    this.positionBar();
    document.addEventListener("selectionchange", this.onSelChange);
    this.broadcastEdit(); // announce the session so peers hide the stale copy / show it live
  }

  private caretToEnd(el: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Place the caret at a viewport point — the character the user clicked (falls back to the end). */
  private caretToPoint(el: HTMLElement, clientX: number, clientY: number): void {
    const sel = window.getSelection();
    if (!sel) return this.caretToEnd(el);
    let range: Range | null = null;
    if (typeof document.caretRangeFromPoint === "function") {
      range = document.caretRangeFromPoint(clientX, clientY); // WebKit/Blink
    } else if (typeof document.caretPositionFromPoint === "function") {
      const pos = document.caretPositionFromPoint(clientX, clientY); // Firefox
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (range && el.contains(range.startContainer)) {
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      this.caretToEnd(el);
    }
  }

  /** Select all the editor's text — double-click-to-edit replaces on type (FigJam-style). */
  private selectAllEditor(el: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---- link hover card (Open / Edit) — works on committed boxes and the active editor ----
  // Links don't receive pointer events (a click must reach the canvas to select/drag the box), so
  // hover is detected by hit-testing pointer moves against the rendered links, not link mouseover.
  private readonly onHoverMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return; // hover is a mouse/pen affordance
    const link = this.linkAtPoint(e.clientX, e.clientY);
    if (link) this.showLinkCard(link);
    else if (this.linkCardFor) this.scheduleCardHide();
  };
  /** The rendered link under a screen point (per-line rects), or null. */
  private linkAtPoint(x: number, y: number): HTMLAnchorElement | null {
    const links = this.root.querySelectorAll<HTMLAnchorElement>(".co-text a");
    for (let i = 0; i < links.length; i++) {
      const a = links[i]!;
      const rects = a.getClientRects();
      for (let j = 0; j < rects.length; j++) {
        const r = rects[j]!;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return a;
      }
    }
    return null;
  }
  private cancelCardHide(): void {
    clearTimeout(this.cardHideTimer);
    this.cardHideTimer = 0;
  }
  private scheduleCardHide(): void {
    if (this.cardHideTimer) return; // a hide is already pending — don't keep pushing it back
    this.cardHideTimer = window.setTimeout(() => {
      this.cardHideTimer = 0;
      this.removeLinkCard();
    }, 180);
  }
  private removeLinkCard(): void {
    this.cancelCardHide();
    this.linkCard?.remove();
    this.linkCard = null;
    this.linkCardFor = null;
  }
  /** Show the Open/Edit card centred under a hovered link (no "create" preview — existing links). */
  private showLinkCard(link: HTMLAnchorElement): void {
    this.cancelCardHide();
    if (this.linkCardFor === link && this.linkCard) return; // already showing for this link
    this.removeLinkCard();
    const href = link.getAttribute("href") ?? "";
    const card = document.createElement("div");
    card.className = "ctb-link-card";
    card.addEventListener("mousedown", (e) => e.preventDefault()); // don't blur/commit the editor
    card.addEventListener("mouseenter", () => this.cancelCardHide());
    card.addEventListener("mouseleave", () => this.scheduleCardHide());
    const urlText = document.createElement("span");
    urlText.className = "ctb-link-card-url";
    urlText.textContent = href;
    const sep = document.createElement("span");
    sep.className = "ctb-link-card-sep";
    const open = document.createElement("a");
    open.className = "ctb-link-card-btn";
    open.textContent = "Open";
    open.href = safeHref(href) || "#";
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.addEventListener("click", () => this.removeLinkCard());
    const edit = document.createElement("button");
    edit.className = "ctb-link-card-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      this.removeLinkCard();
      this.editLink(link);
    });
    card.append(urlText, sep, open, edit);
    document.body.appendChild(card);
    const lr = link.getBoundingClientRect();
    const cw = card.offsetWidth || 220;
    // centre the card under the link, clamped to the viewport
    const left = lr.left + lr.width / 2 - cw / 2;
    card.style.left = `${Math.max(8, Math.min(left, window.innerWidth - cw - 8))}px`;
    card.style.top = `${lr.bottom + 6}px`;
    this.linkCard = card;
    this.linkCardFor = link;
  }
  /** Edit a hovered link's URL — if it's only a committed box, begin editing it first. */
  private editLink(link: HTMLAnchorElement): void {
    if (this.edit && this.edit.el.contains(link)) {
      this.bar.editLink(link);
      return;
    }
    const host = link.closest(".co-text") as HTMLElement | null;
    const id = host?.dataset.id;
    if (!id) return;
    const href = link.getAttribute("href") ?? "";
    this.beginEdit(id);
    const links = [...(this.edit?.el.querySelectorAll("a") ?? [])];
    const match = links.find((a) => a.getAttribute("href") === href) ?? links[0];
    if (match) this.bar.editLink(match);
  }

  // ---- toolbar (the floating <co-text-bar> above the active editor) ----

  /** Apply a block-level change (font / size / alignment), re-lay-out + reposition + broadcast. */
  private setEditBlock(p: { fontFamily?: string; fontSize?: number; align?: TextAlign }): void {
    const e = this.edit;
    if (!e) return;
    const cam = this.opts.camera();
    const centerX = e.x + e.el.offsetWidth / cam.scale / 2; // keep the box centred horizontally on this
    if (p.fontFamily != null) e.fontFamily = p.fontFamily;
    if (p.fontSize != null) e.fontSize = p.fontSize;
    if (p.align != null) e.align = p.align;
    this.layout(e.el, e.x, e.y, e.width, e.fontSize, e.fontFamily, e.align);
    // Re-centre on the same point (top y unchanged) so the box grows symmetrically and the toolbar —
    // positioned from the box's top + centre — stays put while you click through sizes.
    e.x = centerX - e.el.offsetWidth / cam.scale / 2;
    this.layout(e.el, e.x, e.y, e.width, e.fontSize, e.fontFamily, e.align);
    this.positionBar();
    this.scheduleEditBroadcast(); // peers see the block change live
    this.reflectBar();
  }

  /** Toggle a "• " prefix on every line of the box (whole-box bulleted list). */
  private toggleBullets(): void {
    const e = this.edit;
    if (!e) return;
    const runs = toggleBulletRuns(elementToRuns(e.el));
    e.el.innerHTML = runsToHtml(runs);
    this.caretToEnd(e.el);
    this.scheduleEditBroadcast();
    this.reflectBar();
  }

  private positionBar(): void {
    if (this.edit) this.bar.positionOver(this.edit.el.getBoundingClientRect());
  }
  private reflectBar(): void {
    this.bar.reflect(this.barState());
  }
  private barState(): TextBarState {
    const e = this.edit;
    return {
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      strike: document.queryCommandState("strikeThrough"),
      bullet: e ? runsAreBulleted(elementToRuns(e.el)) : false,
      fontFamily: e?.fontFamily ?? DEFAULT_TEXT_FONT,
      fontSize: e?.fontSize ?? DEFAULT_TEXT_SIZE,
      color: document.queryCommandValue("foreColor") || INK,
    };
  }

  // ---- selection + move (the select tool drives these; text has its own chrome, not the
  //      Konva transformer, since text boxes aren't Konva nodes) ----

  hasSelection(): boolean {
    return this.selected.size > 0;
  }
  selectedCount(): number {
    return this.selected.size;
  }
  selectedIds(): string[] {
    return [...this.selected];
  }
  isSelected(id: string): boolean {
    return this.selected.has(id);
  }
  isMoving(): boolean {
    return this.moveState !== null;
  }
  isResizing(): boolean {
    return this.resizing !== null;
  }

  /** Select a text box (additive toggles it within the current selection). */
  selectText(id: string, additive = false): void {
    if (!additive) this.selected.clear();
    if (additive && this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.refreshSelectionChrome();
    this.opts.onSelectionChange?.();
  }
  clearSelection(): void {
    if (!this.selected.size) return;
    this.selected.clear();
    this.refreshSelectionChrome();
    this.opts.onSelectionChange?.();
  }
  selectAll(): void {
    const before = this.selected.size;
    for (const id of this.els.keys()) this.selected.add(id);
    if (this.selected.size !== before) {
      this.refreshSelectionChrome();
      this.opts.onSelectionChange?.();
    }
  }
  /** Add every text box intersecting a world-space marquee box to the selection. */
  selectInBox(box: WorldRect, additive: boolean): void {
    if (!additive) this.selected.clear();
    for (const [id, size] of this.sizes) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "text") continue;
      if (rectsIntersect(box, { x: obj.x, y: obj.y, width: size.w, height: size.h })) {
        this.selected.add(id);
      }
    }
    this.refreshSelectionChrome();
    this.opts.onSelectionChange?.();
  }
  deleteSelected(): void {
    if (!this.selected.size) return;
    const ids = [...this.selected];
    this.selected.clear();
    deleteObjects(this.opts.doc, ids); // observer re-renders without them
    this.opts.onSelectionChange?.();
  }

  private refreshSelectionChrome(): void {
    for (const [id, el] of this.els) {
      const local = this.selected.has(id);
      el.classList.toggle("selected", local); // local ring via the .co-text.selected CSS rule
      if (local) {
        el.style.boxShadow = "";
        el.style.borderRadius = "";
      } else {
        const rc = this.remoteSelColor.get(id); // a peer's selection → ring in their colour
        el.style.boxShadow = rc ? `0 0 0 1.5px ${rc}` : "";
        el.style.borderRadius = rc ? "2px" : "";
      }
    }
    this.updateResizeChrome();
  }

  /** Begin dragging the current text selection from a world point. */
  beginMove(world: { x: number; y: number }): void {
    if (!this.selected.size) return;
    this.moveState = { startX: world.x, startY: world.y, dx: 0, dy: 0 };
  }
  /** Live drag: offset the selected boxes in the overlay (committed to the doc on release). */
  moveTo(world: { x: number; y: number }): void {
    const mv = this.moveState;
    if (!mv) return;
    mv.dx = world.x - mv.startX;
    mv.dy = world.y - mv.startY;
    for (const id of this.selected) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      const el = this.els.get(id);
      if (obj?.type !== "text" || !el) continue;
      this.layout(
        el,
        obj.x + mv.dx,
        obj.y + mv.dy,
        obj.width,
        obj.fontSize,
        obj.fontFamily,
        obj.align,
      );
    }
    this.updateResizeChrome(); // keep the handles glued to the box while it moves
    // Stream the live drag to peers (throttled) — ephemeral, the doc commits on release.
    const now = Date.now();
    if (now - this.lastTextDragSent >= EDIT_BROADCAST_MS) {
      this.lastTextDragSent = now;
      this.opts.awareness.setLocalStateField("drag", {
        ids: [...this.selected],
        dx: mv.dx,
        dy: mv.dy,
      });
    }
  }
  /** Commit the drag to the doc (a no-movement click is a no-op), then end the live preview. */
  endMove(): void {
    const mv = this.moveState;
    this.moveState = null;
    if (mv && (Math.abs(mv.dx) >= 0.01 || Math.abs(mv.dy) >= 0.01)) {
      translateObjects(this.opts.doc, [...this.selected], mv.dx, mv.dy); // observer re-lays-out at baked coords
    }
    this.opts.awareness.setLocalStateField("drag", null);
  }

  /** Apply the effective drag offset to a box during render/sync — the local drag if I'm moving
   *  it, else a peer's in-progress drag (so their move streams here), else none. */
  private moveOffset(id: string): { dx: number; dy: number } {
    if (this.moveState && this.selected.has(id)) {
      return { dx: this.moveState.dx, dy: this.moveState.dy };
    }
    return this.remoteDragCurrent.get(id) ?? { dx: 0, dy: 0 };
  }

  /** Geometry to render a box at — the live resize preview if active, else doc + drag offset. */
  private effectiveGeom(
    id: string,
    obj: TextObject,
  ): { x: number; y: number; width: number | undefined; fontSize: number } {
    if (this.resizePreview?.id === id) {
      return {
        x: this.resizePreview.x,
        y: obj.y,
        width: this.resizePreview.width,
        fontSize: this.resizePreview.fontSize,
      };
    }
    const rr = this.remoteResizeCurrent.get(id); // a peer's in-progress resize (glided)
    if (rr) return { x: rr.x, y: obj.y, width: rr.width, fontSize: rr.fontSize };
    const off = this.moveOffset(id);
    return { x: obj.x + off.dx, y: obj.y + off.dy, width: obj.width, fontSize: obj.fontSize };
  }

  // ---- resize (a handle box around a single selected box — text isn't a Konva node, so the
  //      Konva transformer can't bound it; side handles change width, corners scale the font) ----

  private ensureResizeEl(): HTMLDivElement {
    if (this.resizeEl) return this.resizeEl;
    const box = document.createElement("div");
    box.className = "co-text-resize";
    for (const h of ["nw", "ne", "sw", "se", "w", "e"]) {
      const hd = document.createElement("div");
      hd.className = `co-text-handle h-${h}`;
      hd.addEventListener("pointerdown", (e) => this.beginResize(e, h));
      box.appendChild(hd);
    }
    this.root.appendChild(box);
    this.resizeEl = box;
    return box;
  }

  /** Show + position the handle box over the single selected box (hidden for 0 / many / editing). */
  private updateResizeChrome(): void {
    const ids = [...this.selected];
    const id = ids.length === 1 ? ids[0] : undefined;
    const el = id ? this.els.get(id) : undefined;
    if (!id || !el || this.edit || this.remoteEditIds.has(id)) {
      if (this.resizeEl) this.resizeEl.style.display = "none";
      return;
    }
    const box = this.ensureResizeEl();
    box.style.display = "";
    box.dataset.id = id;
    box.style.left = el.style.left;
    box.style.top = el.style.top;
    box.style.width = `${el.offsetWidth}px`;
    box.style.height = `${el.offsetHeight}px`;
  }

  private beginResize(e: PointerEvent, handle: string): void {
    e.preventDefault();
    e.stopPropagation(); // a handle drag is not a canvas marquee/move
    const id = this.resizeEl?.dataset.id;
    if (!id) return;
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    const size = this.sizes.get(id);
    if (obj?.type !== "text" || !size) return;
    this.resizing = {
      id,
      handle,
      startX: e.clientX,
      ox: obj.x,
      oy: obj.y,
      ow: obj.width,
      ofs: obj.fontSize,
      baseW: obj.width ?? size.w, // auto-width boxes scale from their measured width
    };
    window.addEventListener("pointermove", this.onResizeMove);
    window.addEventListener("pointerup", this.onResizeUp);
  }

  private readonly onResizeMove = (e: PointerEvent): void => {
    const rs = this.resizing;
    if (!rs) return;
    this.publishCursorAt(e.clientX, e.clientY); // keep peers' view of my cursor on the handle
    const wdx = (e.clientX - rs.startX) / Math.max(this.opts.camera().scale, 1e-6);
    let x = rs.ox;
    let width = rs.ow;
    let fontSize = rs.ofs;
    if (rs.handle === "e") {
      width = Math.max(MIN_TEXT_W, rs.baseW + wdx); // grow/shrink width (auto-width → fixed)
    } else if (rs.handle === "w") {
      width = Math.max(MIN_TEXT_W, rs.baseW - wdx);
      x = rs.ox + (rs.baseW - width); // keep the right edge fixed
    } else {
      // corner → scale the font by the horizontal drag ratio (and width too, if it's fixed)
      const rightSide = rs.handle === "se" || rs.handle === "ne";
      const targetW = Math.max(MIN_TEXT_W, rs.baseW + (rightSide ? wdx : -wdx));
      const ratio = targetW / rs.baseW;
      fontSize = Math.max(MIN_FONT, rs.ofs * ratio);
      if (rs.ow != null) {
        width = Math.max(MIN_TEXT_W, rs.ow * ratio);
        if (!rightSide) x = rs.ox + (rs.ow - width);
      } else if (!rightSide) {
        x = rs.ox + rs.baseW * (1 - ratio); // auto-width left corner: anchor the right edge
      }
    }
    const m = this.objects.get(rs.id);
    const obj = m ? readObject(m) : null;
    const el = this.els.get(rs.id);
    if (!el || obj?.type !== "text") return;
    this.resizePreview = { id: rs.id, x, width, fontSize };
    this.layout(el, x, obj.y, width, fontSize, obj.fontFamily, obj.align);
    this.updateResizeChrome();
    // Stream the live resize to peers (throttled) — ephemeral; the doc commits on release.
    const now = Date.now();
    if (now - this.lastResizeSent >= EDIT_BROADCAST_MS) {
      this.lastResizeSent = now;
      this.opts.awareness.setLocalStateField(
        "textresize",
        width != null ? { id: rs.id, x, width, fontSize } : { id: rs.id, x, fontSize },
      );
    }
  };

  private readonly onResizeUp = (): void => {
    const rs = this.resizing;
    this.resizing = null;
    window.removeEventListener("pointermove", this.onResizeMove);
    window.removeEventListener("pointerup", this.onResizeUp);
    const pv = this.resizePreview;
    this.resizePreview = null;
    if (rs && pv) {
      // One transaction (Yjs merges the nested transacts) → a single undo step.
      this.opts.doc.transact(() => {
        setTextGeometry(
          this.opts.doc,
          pv.id,
          pv.width != null ? { x: pv.x, width: pv.width } : { x: pv.x },
        );
        setTextStyle(this.opts.doc, pv.id, { fontSize: pv.fontSize });
      });
    }
    // Stop the live preview last, so the committed render overlaps the cleared preview on peers.
    this.opts.awareness.setLocalStateField("textresize", null);
  };

  // ---- remote selection + drag (peers' presence on committed text boxes) ----

  /** Mirror peers' text selection (colour rings) + in-progress text drags (offsets), read from the
   *  same awareness fields the canvas uses for strokes — the canvas ignores ids it has no node for. */
  private renderRemoteSelDrag(): void {
    const states = this.opts.awareness.getStates();
    const local = this.opts.awareness.clientID;
    const sel = new Map<string, string>();
    const drag = new Map<string, { dx: number; dy: number }>();
    const resize = new Map<string, ResizeGeom>();
    for (const [cid, raw] of states) {
      if (cid === local) continue;
      const st = raw as {
        selection?: unknown;
        drag?: unknown;
        textresize?: unknown;
        color?: unknown;
      };
      const color = typeof st.color === "string" ? st.color : "#2563eb";
      if (Array.isArray(st.selection)) {
        for (const id of st.selection) {
          if (typeof id === "string" && this.els.has(id)) sel.set(id, color);
        }
      }
      const d = st.drag as { ids?: unknown; dx?: unknown; dy?: unknown } | undefined;
      if (d && Array.isArray(d.ids)) {
        const dx = typeof d.dx === "number" ? d.dx : 0;
        const dy = typeof d.dy === "number" ? d.dy : 0;
        for (const id of d.ids) {
          if (typeof id === "string" && this.els.has(id)) drag.set(id, { dx, dy });
        }
      }
      const tr = st.textresize as
        | { id?: unknown; x?: unknown; width?: unknown; fontSize?: unknown }
        | undefined;
      if (
        tr &&
        typeof tr.id === "string" &&
        this.els.has(tr.id) &&
        typeof tr.x === "number" &&
        typeof tr.fontSize === "number"
      ) {
        resize.set(tr.id, {
          x: tr.x,
          width: typeof tr.width === "number" ? tr.width : undefined,
          fontSize: tr.fontSize,
        });
      }
    }
    // Idle fast-path: nothing remote now or before → skip the chrome/layout passes.
    if (
      !sel.size &&
      !drag.size &&
      !resize.size &&
      !this.remoteSelColor.size &&
      !this.remoteDrag.size &&
      !this.remoteResize.size
    ) {
      return;
    }
    const selChanged = !sameColorMap(sel, this.remoteSelColor);
    const dragChanged = !sameDragMap(drag, this.remoteDrag);
    const resizeChanged = !sameResizeMap(resize, this.remoteResize);
    this.remoteSelColor = sel;
    this.remoteDrag = drag;
    this.remoteResize = resize;
    if (selChanged) this.refreshSelectionChrome();
    if (dragChanged || resizeChanged) this.ensureGlide(); // glide toward the new target
  }

  /** Re-lay-out every committed box at its effective (local or remote) drag offset. */
  private relayoutCommitted(): void {
    for (const [id, el] of this.els) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "text") continue;
      const g = this.effectiveGeom(id, obj);
      this.layout(el, g.x, g.y, g.width, g.fontSize, obj.fontFamily, obj.align);
    }
  }

  private ensureGlide(): void {
    if (!this.glideRaf) this.glideRaf = requestAnimationFrame(this.glideStep);
  }

  /** Glide each rendered drag offset toward its target (LERP), so a peer's move streams smoothly
   *  instead of snapping at the 30 Hz broadcast rate — the same trick the canvas uses for strokes. */
  private readonly glideStep = (): void => {
    this.glideRaf = 0;
    let active = false;
    let changed = false;
    for (const [id, target] of this.remoteDrag) {
      const cur = this.remoteDragCurrent.get(id) ?? { dx: 0, dy: 0 };
      const ndx = cur.dx + (target.dx - cur.dx) * LERP;
      const ndy = cur.dy + (target.dy - cur.dy) * LERP;
      if (Math.abs(target.dx - ndx) < 0.05 && Math.abs(target.dy - ndy) < 0.05) {
        this.remoteDragCurrent.set(id, { dx: target.dx, dy: target.dy });
      } else {
        this.remoteDragCurrent.set(id, { dx: ndx, dy: ndy });
        active = true;
      }
      changed = true;
    }
    // A drag that ended (target gone) snaps to the committed position (offset 0).
    for (const id of [...this.remoteDragCurrent.keys()]) {
      if (this.remoteDrag.has(id)) continue;
      this.remoteDragCurrent.delete(id);
      changed = true;
    }
    // glide resize geometry (x / width / fontSize) toward each peer's target
    for (const [id, target] of this.remoteResize) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "text") {
        this.remoteResizeCurrent.delete(id);
        continue;
      }
      const cur = this.remoteResizeCurrent.get(id) ?? {
        x: obj.x,
        width: obj.width,
        fontSize: obj.fontSize,
      };
      const nx = cur.x + (target.x - cur.x) * LERP;
      const nfs = cur.fontSize + (target.fontSize - cur.fontSize) * LERP;
      let nw = target.width;
      if (typeof cur.width === "number" && typeof target.width === "number") {
        nw = cur.width + (target.width - cur.width) * LERP;
      }
      const settled =
        Math.abs(target.x - nx) < 0.05 &&
        Math.abs(target.fontSize - nfs) < 0.05 &&
        (typeof target.width !== "number" ||
          typeof nw !== "number" ||
          Math.abs(target.width - nw) < 0.5);
      this.remoteResizeCurrent.set(
        id,
        settled
          ? { x: target.x, width: target.width, fontSize: target.fontSize }
          : { x: nx, width: nw, fontSize: nfs },
      );
      if (!settled) active = true;
      changed = true;
    }
    for (const id of [...this.remoteResizeCurrent.keys()]) {
      if (this.remoteResize.has(id)) continue;
      this.remoteResizeCurrent.delete(id);
      changed = true;
    }
    if (changed) this.relayoutCommitted();
    if (active) this.ensureGlide();
  };

  /** Publish my cursor in world coords while resizing — the stage's pointermove doesn't fire when
   *  the pointer is captured by an HTML handle, so peers' view of my cursor would otherwise freeze. */
  private publishCursorAt(clientX: number, clientY: number): void {
    const now = Date.now();
    if (now - this.lastCursorSent < EDIT_BROADCAST_MS) return;
    this.lastCursorSent = now;
    const rect = this.opts.container.getBoundingClientRect();
    const cam = this.opts.camera();
    this.opts.awareness.setLocalStateField("cursor", {
      x: (clientX - rect.left - cam.x) / cam.scale,
      y: (clientY - rect.top - cam.y) / cam.scale,
    });
  }

  // ---- live broadcast of the in-progress edit ----

  /** Push the editor's current runs onto awareness, throttled with a trailing flush. */
  private scheduleEditBroadcast(): void {
    const now = Date.now();
    const since = now - this.lastEditSent;
    if (since >= EDIT_BROADCAST_MS) {
      this.lastEditSent = now;
      this.broadcastEdit();
      return;
    }
    if (this.editTimer !== null) clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => {
      this.editTimer = null;
      this.lastEditSent = Date.now();
      this.broadcastEdit();
    }, EDIT_BROADCAST_MS - since);
  }

  private broadcastEdit(): void {
    const e = this.edit;
    if (!e) return;
    const state: TextEditState = {
      id: e.id,
      x: e.x,
      y: e.y,
      fontSize: e.fontSize,
      fontFamily: e.fontFamily,
      align: e.align,
      runs: elementToRuns(e.el),
    };
    if (e.width != null) state.width = e.width;
    if (e.bg != null) state.bg = e.bg;
    if (e.shape != null) state.shape = e.shape;
    if (e.height != null) state.height = e.height;
    this.opts.awareness.setLocalStateField("textedit", state);
  }

  /** Render peers' in-progress edits as ephemeral boxes (and hide the doc copy they're editing). */
  private renderRemoteEdits(): void {
    const states = this.opts.awareness.getStates();
    const local = this.opts.awareness.clientID;
    const active = new Set<number>();
    const editingIds = new Set<string>();
    let any = false;
    for (const [cid, raw] of states) {
      if (cid === local) continue;
      const st = raw as { textedit?: unknown; color?: unknown };
      const te = st.textedit as TextEditState | undefined;
      if (!te || typeof te !== "object" || !Array.isArray(te.runs)) continue;
      if (typeof te.x !== "number" || typeof te.y !== "number") continue;
      any = true;
      active.add(cid);
      if (typeof te.id === "string") editingIds.add(te.id);
      const g: Geom = {
        x: te.x,
        y: te.y,
        fontSize:
          typeof te.fontSize === "number" && isFinite(te.fontSize)
            ? te.fontSize
            : DEFAULT_TEXT_SIZE,
        fontFamily:
          typeof te.fontFamily === "string" && te.fontFamily ? te.fontFamily : DEFAULT_TEXT_FONT,
        align: te.align === "center" || te.align === "right" ? te.align : "left",
      };
      if (typeof te.width === "number" && isFinite(te.width)) g.width = te.width;
      if (typeof te.height === "number" && isFinite(te.height)) g.height = te.height;
      if (typeof te.bg === "string" && te.bg) g.bg = te.bg;
      if (typeof te.shape === "string") g.shape = te.shape;
      let el = this.remoteEdits.get(cid);
      if (!el) {
        el = document.createElement("div");
        el.className = "co-text co-text-remote";
        this.root.appendChild(el);
        this.remoteEdits.set(cid, el);
      }
      el.innerHTML = runsToHtml(te.runs);
      el.style.color = INK;
      el.style.setProperty("--remote", typeof st.color === "string" ? st.color : "#4a9eff");
      // a peer's live shape/sticky shows its outline + fill (or paper colour + square)
      if (g.shape) this.applyShape(el, g.shape, g.bg);
      else this.applySticky(el, g.bg);
      this.remoteGeom.set(cid, g);
      this.layout(el, g.x, g.y, g.width, g.fontSize, g.fontFamily, g.align, g.height);
    }
    // Idle fast-path: nothing remote now, nothing left over → only touch visibility if it changed.
    if (!any && this.remoteEdits.size === 0) {
      if (this.remoteEditIds.size) this.setRemoteEditIds(editingIds);
      return;
    }
    for (const [cid, el] of this.remoteEdits) {
      if (active.has(cid)) continue;
      el.remove();
      this.remoteEdits.delete(cid);
      this.remoteGeom.delete(cid);
    }
    this.setRemoteEditIds(editingIds);
  }

  /** Serialize the editor to runs and write it back to the doc (or discard/delete if empty). */
  commit(): void {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    this.bar.hide();
    document.removeEventListener("selectionchange", this.onSelChange);
    if (this.editTimer !== null) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    const runs = elementToRuns(e.el); // read the DOM before detaching it
    const hasText = runsToText(runs).trim().length > 0;
    const keep = hasText || e.bg != null || e.shape != null; // a sticky/shape persists when empty
    if (e.id) {
      const disp = this.els.get(e.id);
      if (disp) disp.style.display = ""; // unhide the display copy
    }
    e.el.remove();

    if (e.id) {
      const id = e.id;
      // Existing box: an empty (non-sticky) result deletes it; otherwise replace runs + block style.
      if (keep) {
        this.opts.doc.transact(() => {
          setTextRuns(this.opts.doc, id, runs);
          setTextStyle(this.opts.doc, id, {
            fontFamily: e.fontFamily,
            fontSize: e.fontSize,
            align: e.align,
            ...(e.bg != null ? { bg: e.bg } : {}),
          });
          if (e.height != null) setTextGeometry(this.opts.doc, id, { height: e.height });
        });
      } else {
        deleteObject(this.opts.doc, id);
      }
    } else if (keep) {
      const obj: TextObject = {
        id: randomId("tx"),
        type: "text",
        x: e.x,
        y: e.y,
        runs,
        fontFamily: e.fontFamily,
        fontSize: e.fontSize,
        align: e.align,
        authorId: String(this.opts.awareness.clientID),
      };
      if (e.width != null) obj.width = e.width;
      if (e.height != null) obj.height = e.height;
      if (e.bg != null) obj.bg = e.bg;
      if (e.shape != null) obj.shape = e.shape;
      addText(this.opts.doc, obj);
    }
    // Stop the live broadcast last, so peers' ephemeral copy overlaps the freshly-committed doc
    // render (identical text/position) rather than briefly vanishing between the two.
    this.opts.awareness.setLocalStateField("textedit", null);
    // A finished edit leaves its box DESELECTED, so a later single click selects it (first click)
    // rather than immediately re-editing it (which made "single click activates the text").
    if (e.id && this.selected.delete(e.id)) this.opts.onSelectionChange?.();
    this.updateResizeChrome(); // edit ended → restore handles if the box is still selected
    this.refreshSelectionChrome();
    // The doc observer fires render(), which (re)paints / removes the display element.
    this.opts.onCommitted?.(); // let the canvas revert the text/sticky tool to select
  }

  destroy(): void {
    if (this.edit) this.commit();
    this.opts.awareness.off("change", this.onAwareness);
    this.objects.unobserveDeep(this.observer);
    window.removeEventListener("pointermove", this.onResizeMove);
    window.removeEventListener("pointerup", this.onResizeUp);
    if (this.glideRaf) cancelAnimationFrame(this.glideRaf);
    for (const el of this.remoteEdits.values()) el.remove();
    this.remoteEdits.clear();
    this.remoteGeom.clear();
    this.bar.destroy();
    this.removeLinkCard();
    this.opts.container.removeEventListener("pointermove", this.onHoverMove, true);
    document.removeEventListener("selectionchange", this.onSelChange);
    this.root.remove();
    this.els.clear();
    this.sizes.clear();
  }
}
