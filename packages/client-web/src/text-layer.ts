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
  DEFAULT_STICKY_TEXT_SIZE,
  DEFAULT_TEXT_FONT,
  DEFAULT_TEXT_SIZE,
  deleteObject,
  deleteObjects,
  expandGroups,
  objectsMap,
  orderArray,
  randomId,
  readObject,
  type BoardObject,
  setConnectorEnds,
  setImageGeom,
  setObjectsPoints,
  setStampGeom,
  setTextGeometry,
  setTextRuns,
  setTextStyle,
  sideMidpoint,
  translateObjects,
  type BorderStyle,
  type ConnectorCap,
  type ConnectorEnd,
  type ConnectorKind,
  type ConnectorObject,
  type ConnectorSide,
  type ImageObject,
  type ShapeKind,
  type StampObject,
  type StrokeObject,
  type TextAlign,
  type TextObject,
  type TextRun,
} from "@komuboard/shared";
import {
  allRunsHaveMark,
  type BoolMark,
  elementToRuns,
  runsAreBulleted,
  runsToHtml,
  runsToText,
  safeHref,
  setMarkAllRuns,
  toggleBoolMarkAllRuns,
  toggleBulletRuns,
} from "./text-runs";
import { TextBar, type TextBarState } from "./text-bar";
import { ROTATE_CURSORS } from "./cursors";
import { cachedEmojiSticker, emojiStickerUrl } from "./emoji-sticker";
import { imageSrcUrl } from "./uploads";
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
  /** Notified after an editor commits (writes/deletes the box) — lets the canvas revert the tool.
   *  `keepTool` is true when the commit was triggered by focus moving into a tool picker (the shape
   *  menu / place bars): the box still bakes, but the tool must NOT revert to select (the user is
   *  picking what to draw next). */
  onCommitted?: (keepTool?: boolean) => void;
  /** Fired each frame a shape's geometry changes visually (local drag/resize, peer glide) so the
   *  canvas can re-route connectors bound to it live (not just on the doc commit). */
  onShapesMoved?: () => void;
  /** Ungroup the current selection — fired by the group box's "Ungroup" chip. The canvas owns the
   *  ungroup (it spans both selection subsystems). */
  onUngroup?: () => void;
}

/** A live editing session: a contenteditable box for a new (id === null) or existing text object. */
interface EditSession {
  id: string | null;
  /** The positioned box element (geometry, shape outline, fill). */
  el: HTMLDivElement;
  /** The contenteditable that actually holds the text. For shapes this is an INNER element (so its
   *  empty caret centres within the box); for plain text/sticky it's `el` itself. */
  editable: HTMLElement;
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
  /** Shape border colour + style (solid/dashed/none). */
  borderColor?: string;
  borderStyle?: BorderStyle;
  /** World rotation (deg) of the box being edited — the editor must render at the SAME angle, or
   *  opening a rotated sticky visibly flips it upright for the duration of the edit. */
  rotation?: number;
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
  borderColor?: string;
  borderStyle?: BorderStyle;
  rotation?: number;
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
  borderColor?: string;
  borderStyle?: BorderStyle;
  rotation?: number;
};

const INK = "#0e1116"; // default text ink (matches the pen default)
const SHAPE_STROKE = "#1f2933"; // shape outline colour (matches the CSS border)
// Polygon shapes drawn as an SVG-outline background (rectangle/ellipse use a CSS border).
// Points are in a 0..100 viewBox, inset slightly so the stroke isn't clipped at the edges.
const SHAPE_POLYGONS: Record<string, string> = {
  triangle: "50,4 96,96 4,96",
  rhombus: "50,4 96,50 50,96 4,50",
};
/** A polygon outline + fill as an SVG data URI, stretched to the box via preserveAspectRatio=none. */
function shapeSvg(points: string, fill: string, stroke: string, dashed: boolean): string {
  const dash = dashed ? ` stroke-dasharray='6 5'` : "";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>` +
    `<polygon points='${points}' fill='${fill}' stroke='${stroke}' stroke-width='2'${dash} stroke-linejoin='round'/></svg>`;
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
// Viewport culling (ADR-0009 Phase 4): only objects whose world AABB intersects the viewport inflated
// by this fraction per side are mounted, so on-screen DOM-node count tracks visible — not total —
// board size. 0.5 = a half-viewport pre-mount margin in every direction (smooth panning).
const CULL_MARGIN = 0.5;

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
// y/height are only present for shape resizes (free-box); undefined for text (width + font scale).
type ResizeGeom = {
  x: number;
  y?: number;
  width: number | undefined;
  height?: number;
  fontSize: number;
};
function sameResizeMap(a: Map<string, ResizeGeom>, b: Map<string, ResizeGeom>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.x !== v.x || o.width !== v.width || o.fontSize !== v.fontSize) return false;
    if (o.y !== v.y || o.height !== v.height) return false;
  }
  return true;
}
function sameNumMap(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export class TextLayer {
  private readonly root: HTMLDivElement;
  /** Export mode: culling is suspended so EVERY object mounts — a whole-board export must include the
   *  off-screen ones the viewport would normally leave unrendered. */
  private exportMode = false;
  /** The overlay node holding all rendered objects (boxes + ink SVGs) — the export capture target. */
  get node(): HTMLDivElement {
    return this.root;
  }
  /** Suspend/restore viewport culling (mount all objects / cull again) and re-render. */
  setExportMode(on: boolean): void {
    this.exportMode = on;
    this.render();
  }
  /** id → rendered display element (kept in sync with the doc). */
  private readonly els = new Map<string, HTMLDivElement>();
  /** Strokes + connectors rendered as SVG (ADR-0009 Phase 3), keyed by id — z-order siblings of the
   *  text/stamp boxes in `this.root`. Separate map: SVG elements aren't HTMLDivElement. */
  private readonly inkEls = new Map<string, SVGSVGElement>();
  /** World-space AABB of each stroke (origin + size), for hit-testing + the selection box. */
  private readonly inkBBox = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  /** id → the 🔒 badge element over a LOCKED stroke's box (ink is <svg>, so CSS ::after can't draw it). */
  private readonly inkLockBadges = new Map<string, HTMLElement>();
  /** id → measured world-space size, for hit-testing (refreshed on every layout). */
  private readonly sizes = new Map<string, { w: number; h: number }>();
  private edit: EditSession | null = null;
  private readonly objects: Y.Map<Y.Map<unknown>>;
  private readonly observer: (events: Y.YEvent<Y.Map<unknown>>[]) => void;
  private readonly orderObserver: () => void;
  /** id → materialized object. readObject() walks every Y.Map field and allocates — far too hot to
   *  run per object per frame (recull + camera sync walk the whole board). Entries are invalidated
   *  from the doc observer's events, so cached reads always match the doc. */
  private readonly objCache = new Map<string, BoardObject | null>();
  /** How layout() records an element's world size (see layout()):
   *  - "inline": measure immediately (single-object paths — one reflow is fine).
   *  - "defer":  bulk passes (render/recull) queue elements and measure once after ALL style writes —
   *              interleaving writes with offsetWidth reads forces a reflow PER ELEMENT (thousands of
   *              reflows per pass on a dense board).
   *  - "skip":   camera-only relayouts (syncTransform) — the recorded sizes are WORLD-space, which a
   *              camera change cannot alter, so measuring is pure reflow waste. */
  private measureMode: "inline" | "defer" | "skip" = "inline";
  private readonly measureQueue: { el: HTMLElement; width: number | undefined }[] = [];

  // --- live peer edits (ephemeral; off the awareness channel) ---
  private lastEditSent = 0;
  private editTimer: number | null = null;
  /** clientID → ephemeral element showing that peer's in-progress text. */
  private readonly remoteEdits = new Map<number, HTMLDivElement>();
  /** clientID → that peer's broadcast geometry, so a camera change can re-lay-out it. */
  private readonly remoteGeom = new Map<number, Geom>();
  /** Object ids a *remote* peer is currently editing — their doc display copy stays hidden. */
  private remoteEditIds = new Set<string>();
  /** Committed connector ids a *remote* peer is live-editing (draw/move/endpoint) — the committed
   *  <svg> hides while the peer's glide draft (`remote:<id>`) shows, so there's no double-draw. */
  private remoteInkHidden = new Set<string>();
  private readonly onAwareness = (): void => {
    this.renderRemoteEdits();
    this.renderRemoteSelDrag();
  };
  /** The floating rich-text toolbar (created once; shown while editing OR while a single box is
   *  selected — in the latter "selection mode" its controls apply to the whole box via the doc). */
  private readonly bar: TextBar;
  /** The box the toolbar is showing for in selection mode (no active editor), or null. */
  private barSelId: string | null = null;
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
  private remoteResize = new Map<string, ResizeGeom>();
  private readonly remoteResizeCurrent = new Map<string, ResizeGeom>();
  /** Ink (stroke/connector) ids glided for a peer's move/resize last tick — to reset when it ends. */
  private prevInkRemote = new Set<string>();
  private lastResizeSent = 0;
  /** Peers' in-progress rotation (box id → degrees), applied straight to the render; cleared on release. */
  private remoteRotate = new Map<string, number>();
  private lastRotateSent = 0;
  /** Throttle for streaming a host's attached-stamp glide (groupresize) during its rotate/resize. */
  private lastAttachSent = 0;
  /** Handle box for a single text selection (created lazily), + the in-progress resize. */
  private resizeEl: HTMLDivElement | null = null;
  /** Transform box for a MULTI-node group (ADR-0009 Phase 3: replaces the Konva proxy + Transformer).
   *  Resizes/rotates every selected object as one unit via setGroupPreview/commitGroupTransform. */
  private groupEl: HTMLDivElement | null = null;
  /** "Grouped — Ungroup" chip on the group box; shown only when the selection is one persistent group. */
  private groupChip: HTMLButtonElement | null = null;
  private groupGeom: Map<
    string,
    { cx: number; cy: number; w: number; h: number; rot: number; font: number }
  > | null = null;
  private groupResize: {
    handle: string;
    startX: number;
    startY: number;
    ux: number;
    uy: number;
    uw: number;
    uh: number;
  } | null = null;
  private groupRotate: {
    cx: number;
    cy: number;
    wcx: number;
    wcy: number;
    startAngle: number;
  } | null = null;
  /** Container for connector "dots" (the 4 side attach points) drawn on shapes; created lazily. */
  private dotsEl: HTMLDivElement | null = null;
  /** True while the connector (line/arrow) tool is active → show every shape's dots, not just the
   *  selected one's. */
  private connectorMode = false;
  /** The shape point a connector being drawn is currently snapped to — its dots collapse to just
   *  this locked point (the snap feedback). */
  private snapTarget: { shapeId: string; side: ConnectorSide } | null = null;
  private resizePreview: {
    id: string;
    x: number;
    y: number;
    width: number | undefined;
    height: number | undefined;
    fontSize: number;
  } | null = null;
  private resizing: {
    id: string;
    handle: string;
    startX: number;
    startY: number;
    ox: number;
    oy: number;
    ow: number | undefined;
    oh: number | undefined;
    ofs: number;
    baseW: number;
    isShape: boolean;
    /** A stamp resizes uniformly (square), anchoring the opposite corner; commits via setStampGeom. */
    isStamp: boolean;
    /** A stroke resizes free-aspect on its world AABB; commits by baking the affine into its points. */
    isStroke?: boolean;
    /** An image resizes free-aspect like a shape box, but commits via setImageGeom (not setTextGeometry). */
    isImage?: boolean;
    /** Aspect ratio frozen the instant Shift goes down mid-resize (so the lock starts from the
     *  current in-progress shape, not the box's original proportions). Cleared when Shift lifts. */
    lock?: { w: number; h: number };
  } | null = null;
  /** Live rotation drag preview (degrees) for one box; effectiveGeom prefers it over the doc value. */
  private rotatePreview: { id: string; rotation: number } | null = null;
  /** Live geometry preview while the canvas resizes/rotates a multi-node GROUP that includes this box.
   *  Keyed by id; effectiveGeom prefers it over everything (it's my own in-progress group gesture). */
  private groupPreview: Map<
    string,
    { x: number; y: number; width: number; height: number; fontSize: number; rotation: number }
  > | null = null;
  private rotating: {
    id: string;
    cx: number; // box centre in screen px
    cy: number;
    startAngle: number; // pointer angle (rad) from the centre at drag start
    startRotation: number; // the box's committed rotation when the drag began
  } | null = null;

  // --- selection + move (driven by the canvas's select tool; text keeps its own chrome) ---
  /** Text ids currently selected via the select tool. */
  private readonly selected = new Set<string>();
  /** In-progress drag of the text selection (world-space offset from the grab point). */
  private moveState: { startX: number; startY: number; dx: number; dy: number } | null = null;
  /** Stamps stuck to a host that's being dragged — they glide along live (committed via the schema). */
  private movingAttached = new Set<string>();
  /** Stamps stuck to a host being rotated/resized — they glide live (committed by transformAttachedStamps). */
  private transformAttached = new Set<string>();
  /** Hover card (Open / Edit) shown when the pointer is over a link — committed box or editor. */
  private linkCard: HTMLDivElement | null = null;
  private linkCardFor: HTMLAnchorElement | null = null;
  private cardHideTimer = 0;
  /** Translucent sticky-note placement preview that tracks the cursor while the sticky tool is on. */
  private stickyGhost: HTMLElement | null = null;
  /** Translucent stamp placement preview — a DOM `.komu-stamp` in the overlay so it stacks ABOVE
   *  committed objects (the old Konva ghost sat under the DOM layer → previewed beneath stickies). */
  private stampGhost: HTMLElement | null = null;

  constructor(private readonly opts: TextLayerOptions) {
    this.objects = objectsMap(opts.doc);
    this.root = document.createElement("div");
    this.root.className = "text-layer";
    opts.container.appendChild(this.root);
    // Links are pointer-events:none (a click must reach the canvas to select/drag the box), so link
    // hover is detected by hit-testing pointer moves over the board rather than mouseover on the link.
    opts.container.addEventListener("pointermove", this.onHoverMove, true);
    this.observer = (events): void => {
      this.invalidate(events);
      this.render();
    };
    this.objects.observeDeep(this.observer);
    // Z-order lives in the `order` array, which can change WITHOUT touching the objects map (a
    // bring-to-front / send-to-back, local or from a peer). Observe it too so the restack renders.
    this.orderObserver = (): void => this.render();
    orderArray(this.opts.doc).observe(this.orderObserver);
    this.opts.awareness.on("change", this.onAwareness);
    this.bar = new TextBar({
      setFontFamily: (css) => this.applyBlock({ fontFamily: css }),
      setFontSize: (size) => this.applyBlock({ fontSize: size }),
      toggleBullets: () => this.applyBullets(),
      onFormat: () => {
        this.scheduleEditBroadcast(); // peers see the mark live
        this.reflectBar();
      },
      setShapeKind: (kind) => this.applyShapeKind(kind),
      setFill: (color) => this.applyFill(color),
      setBorder: (p) => this.applyBorder(p),
      setAlign: (align) => this.applyBlock({ align }),
      // Selection-mode marks (no editor) — applied to the whole selected box via the doc.
      applyMark: (mark) => this.applyBoxMark(mark),
      setColor: (hex) => this.applyBoxRunMark("color", hex),
      setHighlight: (hex) => this.applyBoxRunMark("highlight", hex),
      setLink: (url) => this.applyBoxRunMark("link", url),
      linkSelection: () => this.linkSelectionForBar(),
    });
    this.render();
  }

  // ---- rendering ----

  /** Drop cached materializations for every object an incoming transaction touched. Nested events
   *  (field / points edits) carry the object id as path[0]; top-level events on the objects map
   *  (object add / remove) list the touched ids in changes.keys. */
  private invalidate(events: Y.YEvent<Y.Map<unknown>>[]): void {
    for (const e of events) {
      if (e.path.length > 0) this.objCache.delete(String(e.path[0]));
      else for (const k of e.changes.keys.keys()) this.objCache.delete(k);
    }
  }

  /** Materialize object `id` through the cache (see objCache). */
  private readObj(id: string): BoardObject | null {
    let obj = this.objCache.get(id);
    if (obj === undefined) {
      const m = this.objects.get(id);
      obj = m ? readObject(m) : null;
      this.objCache.set(id, obj);
    }
    return obj;
  }

  /** Reconcile display elements with the doc's text objects (z-ordered), then lay them out. */
  private render(): void {
    const order = orderArray(this.opts.doc).toArray();
    const cull = this.cullRect();
    const seen = new Set<string>();
    this.withDeferredMeasures(() => {
      for (const id of order) {
        const obj = this.readObj(id);
        if (
          obj?.type !== "text" &&
          obj?.type !== "stamp" &&
          obj?.type !== "image" &&
          obj?.type !== "stroke" &&
          obj?.type !== "connector"
        )
          continue;
        // Viewport culling (ADR-0009 Phase 4): an off-screen object is left unmounted (the sweep below
        // removes it if it was mounted), so on-screen DOM-node count tracks visible, not total, board size.
        if (!this.shouldMount(id, obj, cull)) continue;
        seen.add(id);
        this.mountObject(id, obj); // create (if needed) + paint + layout + (re)append in z-order
      }
    });
    for (const [id, el] of this.els) {
      if (seen.has(id)) continue;
      el.remove();
      this.els.delete(id);
      this.sizes.delete(id);
    }
    for (const [id, el] of this.inkEls) {
      if (seen.has(id)) continue;
      el.remove();
      this.inkEls.delete(id);
      this.sizes.delete(id);
      this.inkBBox.delete(id);
      this.inkLockBadges.get(id)?.remove(); // drop its lock badge, if any
      this.inkLockBadges.delete(id);
    }
    if (this.linkCardFor && !this.linkCardFor.isConnected) this.removeLinkCard(); // repaint detached it
    this.updateDisplayVisibility();
    this.refreshSelectionChrome();
    if (this.edit) this.root.appendChild(this.edit.el); // keep the editor on top of the re-stacked boxes
    if (this.stickyGhost) this.root.appendChild(this.stickyGhost); // …and the placement ghost above all
    if (this.stampGhost) this.root.appendChild(this.stampGhost); // stamp preview stays above objects too
  }

  /** Create (if absent) + paint + lay out one object's element and (re)append it in z-order. Shared by
   *  the doc-render pass and the camera-driven cull reconcile (`recull`). */
  private mountObject(id: string, obj: BoardObject): void {
    // Stamps: a `.komu-stamp` <img> box, z-ordered with text/shapes by `orderArray` (FigJam parity).
    if (obj.type === "stamp") {
      let el = this.els.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "komu-stamp";
        el.dataset.id = id;
        this.els.set(id, el);
      }
      this.paintStamp(el, obj.src);
      el.toggleAttribute("data-locked", obj.locked === true);
      this.root.appendChild(el);
      const g = this.effectiveGeom(id, obj);
      this.layout(el, g.x, g.y, g.width, g.fontSize, "", "left", g.height);
      this.applyRotation(el, g.rotation);
      return;
    }
    // Uploaded images: a `.komu-image` <img> box, sized to width/height (not square like a stamp).
    if (obj.type === "image") {
      let el = this.els.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "komu-image";
        el.dataset.id = id;
        this.els.set(id, el);
      }
      this.paintImage(el, obj.src);
      el.toggleAttribute("data-locked", obj.locked === true);
      this.root.appendChild(el);
      const g = this.effectiveGeom(id, obj);
      this.layout(el, g.x, g.y, g.width, g.fontSize, "", "left", g.height);
      this.applyRotation(el, g.rotation);
      return;
    }
    // Strokes + connectors: each its own <svg>, a z-order sibling of the text/stamp boxes.
    if (obj.type === "stroke") {
      let el = this.inkEls.get(id);
      if (!el) {
        el = this.makeInkSvg(id, "stroke");
        this.inkEls.set(id, el);
      }
      this.root.appendChild(el);
      this.paintStroke(el, obj);
      return;
    }
    if (obj.type === "connector") {
      let el = this.inkEls.get(id);
      if (!el) {
        el = this.makeInkSvg(id, "connector");
        this.inkEls.set(id, el);
      }
      this.root.appendChild(el);
      this.paintConnector(el, obj);
      el.style.display = this.remoteInkHidden.has(id) ? "none" : ""; // hidden while a peer edits it
      return;
    }
    // Text / sticky / shape.
    let el = this.els.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = "komu-text";
      el.dataset.id = id;
      this.els.set(id, el);
    }
    this.paint(el, obj);
    el.toggleAttribute("data-locked", obj.locked === true);
    this.root.appendChild(el);
    const g = this.effectiveGeom(id, obj);
    this.layout(el, g.x, g.y, g.width, g.fontSize, obj.fontFamily, obj.align, g.height);
    this.applyRotation(el, g.rotation);
  }

  /** Visible world rect (viewport AABB) inflated by `CULL_MARGIN` per side, or null when culling can't
   *  run yet (container has no measured size → mount everything). */
  private cullRect(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.exportMode) return null; // export: mount everything, cull nothing
    const cam = this.opts.camera();
    const W = this.opts.container.clientWidth;
    const H = this.opts.container.clientHeight;
    if (!W || !H || !cam.scale) return null;
    const x0 = -cam.x / cam.scale; // screen (0,0) and (W,H) → world
    const y0 = -cam.y / cam.scale;
    const x1 = (W - cam.x) / cam.scale;
    const y1 = (H - cam.y) / cam.scale;
    const mx = (x1 - x0) * CULL_MARGIN;
    const my = (y1 - y0) * CULL_MARGIN;
    return { x0: x0 - mx, y0: y0 - my, x1: x1 + mx, y1: y1 + my };
  }

  /** An object that must stay mounted regardless of viewport — the locally-edited box, or any object in
   *  a live local/remote gesture — so its preview/glide never breaks at the viewport edge. */
  private isExempt(id: string): boolean {
    return (
      this.edit?.id === id ||
      this.remoteEditIds.has(id) ||
      this.remoteDrag.has(id) ||
      this.remoteResize.has(id) ||
      this.remoteRotate.has(id) ||
      this.resizing?.id === id ||
      this.rotating?.id === id ||
      this.movingAttached.has(id) ||
      this.transformAttached.has(id) ||
      (this.moveState !== null && this.selected.has(id)) || // a selected box mid local drag
      (this.groupGeom?.has(id) ?? false)
    );
  }

  /** Cheap world AABB for the cull test, from an ALREADY-READ obj (no second readObject) — reusing the
   *  `inkBBox` cache for mounted ink. Returns null for auto-sized text with no known size (→ never cull). */
  private cullAABB(
    id: string,
    obj: BoardObject,
  ): { x: number; y: number; w: number; h: number } | null {
    if (obj.type === "stroke" || obj.type === "connector") {
      const bb =
        this.inkBBox.get(id) ??
        (obj.type === "stroke" ? this.strokeWorldBBox(obj) : this.connectorWorldBBox(obj));
      return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
    }
    if (obj.type === "stamp") {
      return { x: obj.x - obj.size / 2, y: obj.y - obj.size / 2, w: obj.size, h: obj.size };
    }
    const w = obj.width ?? this.sizes.get(id)?.w ?? 0;
    const h = obj.height ?? this.sizes.get(id)?.h ?? 0;
    if (w === 0 || h === 0) return null; // auto-sized text with unknown bounds → don't cull
    return { x: obj.x, y: obj.y, w, h };
  }

  /** Whether object `id` should be mounted: always when culling is off or it's exempt; otherwise only
   *  when its world AABB intersects the cull rect. Auto-sized text (unknown w/h) is never culled. */
  private shouldMount(
    id: string,
    obj: BoardObject,
    cull: { x0: number; y0: number; x1: number; y1: number } | null,
  ): boolean {
    if (!cull || this.isExempt(id)) return true;
    const r = this.cullAABB(id, obj);
    if (!r) return true;
    return r.x <= cull.x1 && r.x + r.w >= cull.x0 && r.y <= cull.y1 && r.y + r.h >= cull.y0;
  }

  /** Camera-driven mount reconcile: mount objects that scrolled into the (margin-inflated) viewport,
   *  unmount those that left it, then fix z-order if the mounted set changed. Cheap per frame — an O(n)
   *  AABB walk with DOM work bounded by the on-screen delta. */
  private recull(): void {
    const cull = this.cullRect();
    if (!cull) return;
    const want = new Set<string>();
    let changed = false;
    this.withDeferredMeasures(() => {
      for (const id of orderArray(this.opts.doc).toArray()) {
        const obj = this.readObj(id);
        if (
          obj?.type !== "text" &&
          obj?.type !== "stamp" &&
          obj?.type !== "image" &&
          obj?.type !== "stroke" &&
          obj?.type !== "connector"
        )
          continue;
        if (!this.shouldMount(id, obj, cull)) continue;
        want.add(id);
        if (!this.els.has(id) && !this.inkEls.has(id)) {
          this.mountObject(id, obj);
          changed = true;
        }
      }
    });
    for (const [id, el] of this.els) {
      if (want.has(id)) continue;
      el.remove();
      this.els.delete(id);
      this.sizes.delete(id);
      changed = true;
    }
    for (const [id, el] of this.inkEls) {
      if (want.has(id)) continue;
      el.remove();
      this.inkEls.delete(id);
      this.sizes.delete(id);
      this.inkBBox.delete(id);
      changed = true;
    }
    if (changed) this.reorderZ();
  }

  /** Reorder mounted objects into `orderArray` z-order after an incremental mount. Objects are inserted
   *  BEFORE the topmost-chrome anchor (the open editor or a placement ghost) so that chrome NEVER moves
   *  in the DOM — re-appending a focused contenteditable can collapse its selection / abort IME, and
   *  recull() runs at ~30 Hz during a peer's gesture. With no chrome, this is a plain append. */
  private reorderZ(): void {
    const anchor = this.edit?.el ?? this.stickyGhost ?? this.stampGhost ?? null;
    for (const id of orderArray(this.opts.doc).toArray()) {
      const el = this.els.get(id) ?? this.inkEls.get(id);
      if (el) this.root.insertBefore(el, anchor); // anchor=null → append (same as before)
    }
  }

  /** Hide the doc display copy of any box currently being edited (locally or by a peer). */
  private updateDisplayVisibility(): void {
    for (const [id, el] of this.els) {
      el.style.display = this.edit?.id === id || this.remoteEditIds.has(id) ? "none" : "";
    }
  }

  /** Render a text object's runs into its display element. */
  private paint(el: HTMLElement, obj: TextObject): void {
    // A shape wraps its label in an inner `.komu-text-body` (matching the editor) so the centred
    // empty-state placeholder lines up with where the caret/text sits when you edit it.
    el.innerHTML = obj.shape
      ? `<div class="komu-text-body">${runsToHtml(obj.runs)}</div>`
      : runsToHtml(obj.runs);
    el.style.color = INK; // default ink; per-run colours override via the rendered spans
    if (obj.shape) this.applyShape(el, obj.shape, obj.bg, obj.borderColor, obj.borderStyle);
    else this.applySticky(el, obj.bg);
  }

  /** Paint a stamp's image into its `.komu-stamp` box. Emoji srcs are white-outlined (shared sticker
   *  renderer, cached); marks carry a baked border; an `img:` avatar is its data URL. The outline +
   *  CSS drop-shadow give the placed sticker look. Cheap-guarded so a repaint reuses the same <img>. */
  private paintStamp(el: HTMLDivElement, src: string): void {
    let img = el.querySelector<HTMLImageElement>("img");
    if (!img) {
      img = document.createElement("img");
      img.draggable = false;
      img.alt = "";
      el.appendChild(img);
    }
    if (el.dataset.src === src) return; // already showing this sticker
    el.dataset.src = src;
    const image = img;
    const i = src.indexOf(":");
    const kind = src.slice(0, i);
    const val = src.slice(i + 1);
    if (kind === "emoji") {
      const cached = cachedEmojiSticker(val);
      if (cached) {
        image.src = cached;
      } else {
        image.src = `/emoji/${val}.svg`; // instant raw paint; upgrade to the outlined sticker when ready
        void emojiStickerUrl(val).then((url) => {
          if (el.dataset.src === src) image.src = url; // still the same stamp
        });
      }
    } else if (kind === "img") {
      image.src = val; // a data URL (the placed avatar)
    } else {
      image.src = `/stamps/${val}.svg`; // a colour mark — border baked into the svg
    }
  }

  /** Paint an uploaded image: resolve its R2 key → the worker serve URL into an <img> filling the box. */
  private paintImage(el: HTMLDivElement, key: string): void {
    if (el.dataset.src === key) return; // already showing this image
    el.dataset.src = key;
    let img = el.querySelector<HTMLImageElement>("img");
    if (!img) {
      img = document.createElement("img");
      img.draggable = false;
      img.alt = "";
      el.appendChild(img);
    }
    // A faint placeholder until the bytes decode, and a clear "unavailable" state if they're gone (a
    // deleted R2 object / offline) — better than a blank box or the browser's broken-image glyph. The
    // handlers are attached BEFORE src so a cached (immutable) image still clears the loading state.
    el.classList.add("loading");
    el.classList.remove("broken");
    img.onload = () => el.classList.remove("loading");
    img.onerror = () => {
      el.classList.remove("loading");
      el.classList.add("broken");
    };
    img.src = imageSrcUrl(key);
  }

  // ---- ink (strokes + connectors) as SVG, ADR-0009 Phase 3 ----
  // Each stroke/connector is its OWN <svg> (in this.inkEls), a direct child of this.root appended in
  // orderArray order — so ink is a true z-order sibling of the text/stamp boxes (DOM source order =
  // z-order). The <svg> is positioned in screen space (its world AABB × camera) + a single scale();
  // the <path> coords live in a stable local box, so a pan/zoom never rewrites `d`.

  private makeInkSvg(id: string, kind: "stroke" | "connector"): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `komu-ink komu-${kind}`);
    svg.dataset.id = id;
    svg.dataset.type = kind;
    return svg;
  }

  /** World-space AABB of a stroke straight from its points (+ half stroke-width for caps). */
  private strokeWorldBBox(obj: StrokeObject): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const p = obj.points;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = p[i] as number;
      const y = p[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX) return { x: 0, y: 0, width: 0, height: 0 };
    const pad = (obj.style.includes("highlight") ? obj.width * 1.6 : obj.width) / 2 + 1;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }

  /** Paint a stroke into its <svg>: one <path> in local coords. The `d` rebuild is guarded by a
   *  cheap signature, so a camera change only re-runs layoutInk (move/scale), never rebuilds `d`. */
  private paintStroke(el: SVGSVGElement, obj: StrokeObject): void {
    const bbox = this.strokeWorldBBox(obj);
    this.sizes.set(obj.id, { w: bbox.width, h: bbox.height }); // AABB for hit-test + selection box
    this.inkBBox.set(obj.id, bbox);
    el.toggleAttribute("data-locked", obj.locked === true); // drives the lock badge (synced in layoutInk)
    this.drawStrokePath(el, obj, bbox);
  }

  /** Transient in-progress stroke previews (local pen draft + peers' live `draw`), keyed; on TOP of
   *  every committed object and NOT in the hit-test/orderArray. ADR-0009 Phase 3 Step 6. */
  private readonly draftEls = new Map<string, SVGSVGElement>();
  /** Upsert a draft preview <svg> and paint it. `key` = "local" for the pen, or a peer's id. */
  upsertInkDraft(key: string, obj: StrokeObject): void {
    let el = this.draftEls.get(key);
    if (!el) {
      el = this.makeInkSvg(key, "stroke");
      el.classList.add("komu-draft");
      this.draftEls.set(key, el);
    }
    this.root.appendChild(el); // last child of root = above all committed boxes
    this.drawStrokePath(el, obj, this.strokeWorldBBox(obj));
  }
  /** Remove a draft preview (pen finished, or a peer's draw committed / cleared). */
  removeInkDraft(key: string): void {
    const el = this.draftEls.get(key);
    if (el) {
      el.remove();
      this.draftEls.delete(key);
    }
  }

  /** Upsert a transient CONNECTOR draft <svg> (local arrow-tool draw, or a peer's live connector
   *  edit) — on TOP of every committed object, NOT hit-tested. The doc commit re-renders it. */
  upsertConnectorDraft(key: string, conn: ConnectorObject): void {
    let el = this.draftEls.get(key);
    if (!el) {
      el = this.makeInkSvg(key, "connector");
      el.classList.add("komu-draft");
      this.draftEls.set(key, el);
    }
    this.root.appendChild(el); // last child of root = above all committed boxes
    this.paintConnector(el, conn, true); // draft: don't touch sizes/inkBBox
  }

  /** Draw a stroke's <path> into its <svg> in local-box coords + position it. The `d` rebuild is
   *  signature-guarded so a camera change only re-runs layoutInk. Shared by committed strokes
   *  (paintStroke) and the transient drafts (which skip the sizes/inkBBox hit-test entries). */
  private drawStrokePath(
    el: SVGSVGElement,
    obj: StrokeObject,
    bbox: { x: number; y: number; width: number; height: number },
  ): void {
    const p = obj.points;
    let sum = 0;
    for (let i = 0; i < p.length; i++) sum += (p[i] as number) * (i + 1);
    const sig = `${p.length}_${Math.round(sum)}_${obj.color}_${obj.width}_${obj.style}_${obj.opacity}`;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      const highlight = obj.style.includes("highlight");
      const dashed = obj.style.includes("dashed");
      const w = highlight ? obj.width * 1.6 : obj.width;
      const lx = (p[0] as number) - bbox.x;
      const ly = (p[1] as number) - bbox.y;
      let d = `M ${lx.toFixed(2)} ${ly.toFixed(2)}`;
      for (let i = 2; i + 1 < p.length; i += 2)
        d += ` L ${((p[i] as number) - bbox.x).toFixed(2)} ${((p[i + 1] as number) - bbox.y).toFixed(2)}`;
      if (p.length <= 2) d += ` L ${lx.toFixed(2)} ${ly.toFixed(2)}`; // single point → a round dot
      let path = el.firstElementChild as SVGPathElement | null;
      if (!path) {
        path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        el.appendChild(path);
      }
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", obj.color);
      path.setAttribute("stroke-width", String(w));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute(
        "stroke-dasharray",
        dashed ? `${Math.max(2, obj.width * 2.5)} ${Math.max(2, obj.width * 2)}` : "",
      );
      path.style.opacity = String(highlight ? Math.min(obj.opacity, 0.4) : obj.opacity);
      el.style.mixBlendMode = highlight ? "multiply" : "";
      el.setAttribute("width", String(Math.max(bbox.width, 1)));
      el.setAttribute("height", String(Math.max(bbox.height, 1)));
    }
    this.layoutInk(el, bbox);
  }

  /** Resolve a connector end to a world point (a bound end re-routes to its shape's side mid-edge). */
  private resolveConnectorEnd(end: ConnectorEnd): { x: number; y: number } {
    if (end.shapeId && end.side) {
      const rect = this.shapeWorldRect(end.shapeId);
      if (rect) return sideMidpoint(rect, end.side);
    }
    return { x: end.x, y: end.y };
  }

  /** World polyline for a connector (single-bend L-route for elbows, else a straight segment). */
  private connectorPolyline(kind: ConnectorKind, from: ConnectorEnd, to: ConnectorEnd): number[] {
    const a = this.resolveConnectorEnd(from);
    const b = this.resolveConnectorEnd(to);
    if (kind === "elbow" && Math.abs(b.x - a.x) > 1 && Math.abs(b.y - a.y) > 1) {
      const horizontalFirst =
        from.side === "left" || from.side === "right"
          ? true
          : from.side === "top" || from.side === "bottom"
            ? false
            : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      const corner = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
      return [a.x, a.y, corner.x, corner.y, b.x, b.y];
    }
    return [a.x, a.y, b.x, b.y];
  }

  /** How far a solid cap's body extends back from the tip (the shaft is trimmed by this). */
  private capInset(cap: ConnectorCap, w: number): number {
    if (cap === "arrow" || cap === "triangle") return w * 3.2;
    if (cap === "circle") return w * 1.6;
    if (cap === "diamond") return w * 1.9;
    return 0;
  }

  /** SVG markup for one endpoint cap, oriented along `angle`, in the svg's local coords (via lx/ly). */
  private capSvg(
    p: { x: number; y: number },
    angle: number,
    cap: ConnectorCap,
    color: string,
    w: number,
    lx: (x: number) => string,
    ly: (y: number) => string,
  ): string {
    if (cap === "none") return "";
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const px = -sin;
    const py = cos;
    if (cap === "arrow" || cap === "triangle" || cap === "line") {
      const len = w * 3.2;
      const half = w * 2;
      const bx = p.x - cos * len;
      const by = p.y - sin * len;
      const b1x = bx + px * half;
      const b1y = by + py * half;
      const b2x = bx - px * half;
      const b2y = by - py * half;
      if (cap === "line")
        return `<path d="M ${lx(b1x)} ${ly(b1y)} L ${lx(p.x)} ${ly(p.y)} L ${lx(b2x)} ${ly(b2y)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
      const outline = cap === "triangle";
      return `<path d="M ${lx(p.x)} ${ly(p.y)} L ${lx(b1x)} ${ly(b1y)} L ${lx(b2x)} ${ly(b2y)} Z" fill="${outline ? "#ffffff" : color}" stroke="${color}" stroke-width="${outline ? w * 0.8 : w * 0.5}" stroke-linejoin="round"/>`;
    }
    if (cap === "circle")
      return `<circle cx="${lx(p.x)}" cy="${ly(p.y)}" r="${w * 1.6}" fill="#ffffff" stroke="${color}" stroke-width="${w * 0.8}"/>`;
    const rd = w * 1.9;
    return `<path d="M ${lx(p.x)} ${ly(p.y - rd)} L ${lx(p.x + rd)} ${ly(p.y)} L ${lx(p.x)} ${ly(p.y + rd)} L ${lx(p.x - rd)} ${ly(p.y)} Z" fill="#ffffff" stroke="${color}" stroke-width="${w * 0.8}" stroke-linejoin="round"/>`;
  }

  /** World-space AABB of a connector's resolved polyline (+ half-width pad) — the selection/hit box. */
  private connectorWorldBBox(obj: ConnectorObject): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const pts = this.connectorPolyline(obj.kind, obj.from, obj.to);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i] as number,
        y = pts[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX) return { x: 0, y: 0, width: 0, height: 0 };
    const pad = obj.width / 2 + 4;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }

  /** Paint a connector into its <svg>: shaft <path> + endpoint caps in local coords. Rebuilt each
   *  call (connectors are few; a bound end's pull-in margin is camera-scale dependent). */
  private paintConnector(el: SVGSVGElement, obj: ConnectorObject, isDraft = false): void {
    const scale = Math.max(this.opts.camera().scale, 1e-6);
    const w = obj.width;
    const selBox = this.connectorWorldBBox(obj); // AABB for hit-test + selection (NOT the cap-padded svg box)
    if (!isDraft) {
      // Drafts (local connector draw + peers' live edits) are transient, on top, NOT hit-tested.
      this.sizes.set(obj.id, { w: selBox.width, h: selBox.height });
      this.inkBBox.set(obj.id, selBox);
    }
    const pts = this.connectorPolyline(obj.kind, obj.from, obj.to);
    const n = pts.length;
    const pull = (tipI: number, prevI: number, bound: boolean): void => {
      if (!bound) return;
      const tx = pts[tipI] as number,
        ty = pts[tipI + 1] as number,
        qx = pts[prevI] as number,
        qy = pts[prevI + 1] as number;
      const seg = Math.hypot(tx - qx, ty - qy) || 1;
      const t = Math.min((w / 2 + 2.5 / scale) / seg, 0.45);
      pts[tipI] = tx - (tx - qx) * t;
      pts[tipI + 1] = ty - (ty - qy) * t;
    };
    pull(n - 2, n - 4, !!obj.to.shapeId);
    pull(0, 2, !!obj.from.shapeId);
    const end = { x: pts[n - 2] as number, y: pts[n - 1] as number };
    const endPrev = { x: pts[n - 4] as number, y: pts[n - 3] as number };
    const start = { x: pts[0] as number, y: pts[1] as number };
    const startNext = { x: pts[2] as number, y: pts[3] as number };
    const endAngle = Math.atan2(end.y - endPrev.y, end.x - endPrev.x);
    const startAngle = Math.atan2(start.y - startNext.y, start.x - startNext.x);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i] as number,
        y = pts[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const capPad = w * 3.2 + w * 2 + 2; // arrow length + half-width + a hair
    const bbox = {
      x: minX - capPad,
      y: minY - capPad,
      width: maxX - minX + capPad * 2,
      height: maxY - minY + capPad * 2,
    };
    const shaft = pts.slice();
    const trim = (tipI: number, prevI: number, inset: number): void => {
      if (inset <= 0) return;
      const tx = pts[tipI] as number,
        ty = pts[tipI + 1] as number,
        qx = pts[prevI] as number,
        qy = pts[prevI + 1] as number;
      const seg = Math.hypot(tx - qx, ty - qy) || 1;
      const t = Math.min(inset / seg, 0.95);
      shaft[tipI] = tx - (tx - qx) * t;
      shaft[tipI + 1] = ty - (ty - qy) * t;
    };
    trim(n - 2, n - 4, this.capInset(obj.endCap, w));
    trim(0, 2, this.capInset(obj.startCap, w));
    const lx = (x: number): string => (x - bbox.x).toFixed(2);
    const ly = (y: number): string => (y - bbox.y).toFixed(2);
    let d = `M ${lx(shaft[0] as number)} ${ly(shaft[1] as number)}`;
    for (let i = 2; i + 1 < shaft.length; i += 2)
      d += ` L ${lx(shaft[i] as number)} ${ly(shaft[i + 1] as number)}`;
    const dash = obj.style === "dashed" ? ` stroke-dasharray="${w * 2.5} ${w * 2}"` : "";
    let markup = `<path d="${d}" fill="none" stroke="${obj.color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
    markup += this.capSvg(end, endAngle, obj.endCap, obj.color, w, lx, ly);
    markup += this.capSvg(start, startAngle, obj.startCap, obj.color, w, lx, ly);
    el.innerHTML = markup;
    el.setAttribute("width", String(Math.max(bbox.width, 1)));
    el.setAttribute("height", String(Math.max(bbox.height, 1)));
    this.layoutInk(el, bbox);
  }

  /** Position an ink <svg> in screen space: left/top = its world-AABB origin × camera + one scale()
   *  for zoom. The path coords are local, so only these two writes happen on a camera change. */
  private layoutInk(
    el: SVGSVGElement,
    bbox: { x: number; y: number; width: number; height: number },
  ): void {
    const cam = this.opts.camera();
    el.style.left = `${bbox.x * cam.scale + cam.x}px`;
    el.style.top = `${bbox.y * cam.scale + cam.y}px`;
    el.style.transform = `scale(${cam.scale})`;
    this.syncInkLockBadge(el, bbox, cam);
  }

  /** Keep a 🔒 badge glued to the top-right of a LOCKED stroke's box (ink is an <svg>, where the CSS
   *  ::after badge used by text/stamp/image can't render). Created/removed with the lock state; re-runs
   *  here on every ink layout (paint + camera move) so it stays put and screen-constant. */
  private syncInkLockBadge(
    el: SVGSVGElement,
    bbox: { x: number; y: number; width: number; height: number },
    cam: { scale: number; x: number; y: number },
  ): void {
    const id = el.dataset.id;
    if (!id) return;
    if (!el.hasAttribute("data-locked")) {
      this.inkLockBadges.get(id)?.remove();
      this.inkLockBadges.delete(id);
      return;
    }
    let badge = this.inkLockBadges.get(id);
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "komu-ink-lock";
      badge.textContent = "🔒";
      badge.setAttribute("aria-hidden", "true");
      this.root.appendChild(badge);
      this.inkLockBadges.set(id, badge);
    }
    badge.style.left = `${(bbox.x + bbox.width) * cam.scale + cam.x}px`;
    badge.style.top = `${bbox.y * cam.scale + cam.y}px`;
  }

  /** Live resize preview for a stroke svg: map its local box [0,ow]×[0,oh] (the committed `d`) onto
   *  the previewed world box (nx,ny,nw,nh) via one CSS matrix — no `d` rewrite. */
  private previewInkResize(
    id: string,
    ow: number,
    oh: number,
    nx: number,
    ny: number,
    nw: number,
    nh: number,
  ): void {
    const svg = this.inkEls.get(id);
    if (!svg || !ow || !oh) return;
    const cam = this.opts.camera();
    const sx = (cam.scale * nw) / ow;
    const sy = (cam.scale * nh) / oh;
    svg.style.left = "0px";
    svg.style.top = "0px";
    svg.style.transform = `matrix(${sx}, 0, 0, ${sy}, ${nx * cam.scale + cam.x}, ${ny * cam.scale + cam.y})`;
  }

  /** Live rotate preview for a stroke svg: rotate its local box about the AABB world centre by `deg`
   *  via one CSS matrix (camera scale folded in) — matches the chrome box's CSS rotate-about-centre. */
  private previewInkRotate(id: string, deg: number): void {
    const svg = this.inkEls.get(id);
    const bb = this.inkBBox.get(id);
    if (!svg || !bb) return;
    const cam = this.opts.camera();
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const wcx = bb.x + bb.width / 2;
    const wcy = bb.y + bb.height / 2;
    const dx0 = bb.x - wcx;
    const dy0 = bb.y - wcy;
    const tx = cam.scale * (cos * dx0 - sin * dy0 + wcx) + cam.x;
    const ty = cam.scale * (sin * dx0 + cos * dy0 + wcy) + cam.y;
    svg.style.left = "0px";
    svg.style.top = "0px";
    svg.style.transform = `matrix(${cam.scale * cos}, ${cam.scale * sin}, ${-cam.scale * sin}, ${cam.scale * cos}, ${tx}, ${ty})`;
  }

  /** Re-paint every DOM connector with a bound end so the VISIBLE svg tracks its shape live during a
   *  drag/resize/peer-glide. paintConnector resolves bound ends via shapeWorldRect → effectiveGeom, so
   *  it follows the shape's in-progress position. Called alongside onShapesMoved (which keeps the
   *  opacity-0 Konva connectors — still the click hit-surface until Step 6 — in sync). ADR-0009 P3. */
  private rerouteBoundConnectors(): void {
    for (const [id, el] of this.inkEls) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "connector") continue;
      if (!obj.from.shapeId && !obj.to.shapeId) continue; // only bound connectors follow a shape
      if (this.moveState && this.selected.has(id)) continue; // itself being moved → keep its CSS translate
      this.paintConnector(el, obj);
    }
  }

  /** Repaint a connector's SVG with one end overridden — the live LOCAL preview while a canvas-driven
   *  endpoint handle is being dragged. The doc commit (setConnectorEnds) re-renders authoritatively. */
  previewConnector(id: string, override: { from?: ConnectorEnd; to?: ConnectorEnd }): void {
    const el = this.inkEls.get(id);
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (!el || obj?.type !== "connector") return;
    this.paintConnector(el, { ...obj, ...override });
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
   *  ellipse are drawn with a crisp CSS border (their `shape-<kind>` class); polygon shapes
   *  (triangle/rhombus) use an SVG-outline background so they actually look like the shape. The
   *  border colour/style override the defaults (`none` removes the outline entirely). */
  private applyShape(
    el: HTMLElement,
    kind: string | undefined,
    fill: string | undefined,
    borderColor?: string,
    borderStyle?: BorderStyle,
  ): void {
    for (const c of [...el.classList]) if (c.startsWith("shape")) el.classList.remove(c);
    el.style.backgroundImage = "";
    el.style.removeProperty("border-color");
    el.style.removeProperty("border-style");
    if (!kind) {
      el.style.removeProperty("height");
      return;
    }
    el.classList.add("shape", `shape-${kind}`);
    const f = fill || "#ffffff";
    const bColor = borderColor || SHAPE_STROKE;
    const bStyle = borderStyle ?? "solid";
    const poly = SHAPE_POLYGONS[kind];
    if (poly) {
      // SVG polygon outline + fill, stretched to the box (preserveAspectRatio none).
      el.style.background = "transparent";
      const stroke = bStyle === "none" ? "transparent" : bColor;
      el.style.backgroundImage = `url("${shapeSvg(poly, f, stroke, bStyle === "dashed")}")`;
    } else {
      el.style.background = f; // rectangle / ellipse use the CSS border
      el.style.borderColor = bColor;
      el.style.borderStyle = bStyle; // solid / dashed / none
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
    // Height as a *minimum* that grows to fit text (so extra lines never overflow the box):
    //   shape  → min-height is its set box height; a sticky → its square (min-height = width);
    //   plain text → no height constraint.
    const isSticky = el.classList.contains("sticky");
    const isShape = el.classList.contains("shape");
    const isImage = el.classList.contains("komu-image");
    el.style.height = "";
    if (isImage && height != null) {
      // An image is a fixed box (the <img> fills it via object-fit) — it needs a DEFINITE height,
      // not a content-growing min-height, or the box collapses and it's invisible + un-hittable.
      el.style.height = `${height * cam.scale}px`;
      el.style.minHeight = "";
    } else if (isShape && height != null) {
      el.style.minHeight = `${height * cam.scale}px`;
    } else if (isSticky && width != null) {
      el.style.minHeight = `${width * cam.scale}px`;
    } else {
      el.style.minHeight = "";
    }
    // Record world-space size for hit-testing (offset* are screen px → divide by scale). Bulk callers
    // defer this into one post-write pass, and camera-only relayouts skip it — see measureMode.
    if (this.measureMode === "skip") return;
    if (this.measureMode === "defer") {
      this.measureQueue.push({ el, width });
      return;
    }
    this.recordSize(el, width, cam.scale);
  }

  /** Measure one element's world size into `sizes` (offset* are screen px → divide by scale). */
  private recordSize(el: HTMLElement, width: number | undefined, scale: number): void {
    const id = el.dataset.id;
    if (!id) return;
    const ow = el.offsetWidth;
    const oh = el.offsetHeight;
    // A display:none box (a peer is mid-edit on it → its copy is hidden) measures 0×0; skip the
    // write so its last good size survives. Caching a zero makes it un-hittable (unselectable) once
    // un-hidden — setRemoteEditIds re-measures it for accuracy when the peer's edit ends.
    if (ow > 0 || oh > 0) {
      this.sizes.set(id, { w: width ?? ow / scale, h: oh / scale });
    }
  }

  /** Run a bulk layout pass with all measurements deferred, then take them in ONE read phase. */
  private withDeferredMeasures(pass: () => void): void {
    const prev = this.measureMode;
    this.measureMode = "defer";
    try {
      pass();
    } finally {
      this.measureMode = prev;
      if (this.measureQueue.length) {
        const scale = this.opts.camera().scale;
        for (const q of this.measureQueue) this.recordSize(q.el, q.width, scale);
        this.measureQueue.length = 0;
      }
    }
  }

  /** Apply (or clear) a CSS rotation about the centre — used on a box and on its resize chrome so the
   *  two stay aligned. transform-origin centre keeps the box's centre fixed as it spins. */
  private applyRotation(el: HTMLElement, deg: number): void {
    el.style.transformOrigin = "center";
    el.style.transform = deg ? `rotate(${deg}deg)` : "";
  }

  /** Rotate every selected box by `delta`° about its own centre (keyboard nudge); one transaction.
   *  Returns true when it rotated at least one box. */
  rotateSelected(delta: number): boolean {
    if (this.hasLockedSelection()) return false; // a locked member anchors the selection
    let any = false;
    this.opts.doc.transact(() => {
      for (const id of this.selected) {
        const m = this.objects.get(id);
        const obj = m ? readObject(m) : null;
        if (obj?.type === "image") {
          setImageGeom(this.opts.doc, id, {
            rotation: ((((obj.rotation ?? 0) + delta) % 360) + 360) % 360,
          });
          any = true;
          continue;
        }
        if (obj?.type === "stroke") {
          // Ink carries no `rotation` field — bake the spin into the points, rotating each about the
          // stroke's bbox centre (same maths as commitGroupTransform, with scale = 1).
          const box = this.strokeWorldBBox(obj);
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          const rad = (delta * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const pts = obj.points.slice();
          for (let i = 0; i + 1 < pts.length; i += 2) {
            const dx = (pts[i] as number) - cx;
            const dy = (pts[i + 1] as number) - cy;
            pts[i] = cx + cos * dx - sin * dy;
            pts[i + 1] = cy + sin * dx + cos * dy;
          }
          setObjectsPoints(this.opts.doc, [{ id, points: pts }]);
          any = true;
          continue;
        }
        if (obj?.type !== "text") continue;
        setTextGeometry(this.opts.doc, id, {
          rotation: ((((obj.rotation ?? 0) + delta) % 360) + 360) % 360,
        });
        any = true;
      }
    });
    return any;
  }

  /** Re-lay-out + re-measure a single box — used when it's un-hidden after a peer's edit ends, so
   *  its size cache refreshes now that it's visible again (a render while hidden would have cached 0). */
  private relayoutBox(id: string): void {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    const inkEl = this.inkEls.get(id);
    if (inkEl && (obj?.type === "stroke" || obj?.type === "connector")) {
      const deg = this.remoteRotate.get(id); // a peer's in-progress rotate of a stroke/connector
      if (typeof deg === "number") this.previewInkRotate(id, deg);
      else if (obj.type === "stroke") this.paintStroke(inkEl, obj);
      else this.paintConnector(inkEl, obj);
      return;
    }
    const el = this.els.get(id);
    if (!el) return;
    if (obj?.type === "stamp" || obj?.type === "image") {
      // A peer's live stamp/image rotation: effectiveGeom folds in remoteRotate; apply it to the box
      // so the spin shows in realtime (not just on the release-commit render). Mirrors the text arm.
      const g = this.effectiveGeom(id, obj);
      this.layout(el, g.x, g.y, g.width, g.fontSize, "", "left", g.height);
      this.applyRotation(el, g.rotation);
      return;
    }
    if (obj?.type !== "text") return;
    const g = this.effectiveGeom(id, obj);
    this.layout(el, g.x, g.y, g.width, g.fontSize, obj.fontFamily, obj.align, g.height);
    this.applyRotation(el, g.rotation);
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

  /** Hide the committed connector <svg>s a peer is live-editing (their glide draft shows instead),
   *  and re-show any that are no longer being edited. Mirrors setRemoteEditIds for ink. */
  setRemoteInkHidden(next: Set<string>): void {
    for (const id of this.remoteInkHidden) {
      if (next.has(id)) continue;
      const el = this.inkEls.get(id);
      if (el) el.style.display = "";
    }
    this.remoteInkHidden = next;
    for (const id of next) {
      const el = this.inkEls.get(id);
      if (el) el.style.display = "none";
    }
  }

  /** Re-run layout for every box + the editor + peers' live edits after a camera change. */
  syncTransform(): void {
    this.recull(); // the camera moved → mount what scrolled in, unmount what left, before repositioning
    // Camera-only relayout: recorded sizes are WORLD-space, which a camera change can't alter, so
    // skip layout()'s measurement — interleaved offset reads would force a reflow per element, and
    // this loop covers every mounted box every frame of a pan/zoom.
    const prevMode = this.measureMode;
    this.measureMode = "skip";
    try {
      for (const [id, el] of this.els) {
        const obj = this.readObj(id);
        if (obj?.type === "stamp") {
          const g = this.effectiveGeom(id, obj);
          this.layout(el, g.x, g.y, g.width, g.fontSize, "", "left", g.height);
          continue;
        }
        if (obj?.type !== "text") continue;
        const g = this.effectiveGeom(id, obj);
        this.layout(el, g.x, g.y, g.width, g.fontSize, obj.fontFamily, obj.align, g.height);
      }
      // Re-position ink on a camera change. paintStroke's signature guard skips the `d` rebuild, so a
      // pan/zoom is just a left/top + scale() write per stroke; connectors rebuild (scale-dependent).
      for (const [id, el] of this.inkEls) {
        const obj = this.readObj(id);
        if (obj?.type === "stroke") this.paintStroke(el, obj);
        else if (obj?.type === "connector") this.paintConnector(el, obj);
      }
      if (this.edit) {
        const e = this.edit;
        this.layout(e.el, e.x, e.y, e.width, e.fontSize, e.fontFamily, e.align, e.height);
      }
      for (const [cid, el] of this.remoteEdits) {
        const g = this.remoteGeom.get(cid);
        if (g) this.layout(el, g.x, g.y, g.width, g.fontSize, g.fontFamily, g.align, g.height);
      }
    } finally {
      this.measureMode = prevMode;
    }
    this.positionBar(); // follows the editor OR the selection-mode box as the camera moves
    this.updateResizeChrome();
  }

  // ---- hit-testing ----

  /** Topmost LOCKED stroke whose padded AABB contains the point. A locked stroke's thin line is
   *  nearly impossible to tap (and marquee/⌘A skip locked), so the canvas lets a tap anywhere in its
   *  box select it — so you can unlock it. Bbox (not polyline) on purpose. Strokes only for now. */
  hitLockedInk(world: { x: number; y: number }): string | null {
    const order = orderArray(this.opts.doc).toArray();
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      if (!id) continue;
      const obj = this.readObj(id);
      if (obj?.type !== "stroke" || !obj.locked) continue;
      const bb = this.inkBBox.get(id);
      if (
        bb &&
        world.x >= bb.x &&
        world.x <= bb.x + bb.width &&
        world.y >= bb.y &&
        world.y <= bb.y + bb.height
      )
        return id;
    }
    return null;
  }

  /** The topmost text object whose world bbox contains the point, or null. */
  hitTest(world: { x: number; y: number }): string | null {
    const order = orderArray(this.opts.doc).toArray();
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      if (!id) continue;
      const obj = this.readObj(id);
      // Strokes hit-test precisely (their AABB is mostly empty): broad-phase the padded AABB, then
      // the true distance to the polyline ≤ half the stroke width (matches Konva's hitStrokeWidth).
      if (obj?.type === "stroke") {
        const bbox = this.inkBBox.get(id);
        if (!bbox) continue;
        const w = obj.style.includes("highlight") ? obj.width * 1.6 : obj.width;
        const tol = Math.max(w / 2, 7);
        if (
          world.x < bbox.x - tol ||
          world.x > bbox.x + bbox.width + tol ||
          world.y < bbox.y - tol ||
          world.y > bbox.y + bbox.height + tol
        )
          continue;
        if (this.pointToPolylineDist(world, obj.points) <= tol) return id;
        continue;
      }
      // Connectors hit-test on their resolved polyline (broad-phase the AABB first), same as strokes.
      if (obj?.type === "connector") {
        const bbox = this.inkBBox.get(id);
        if (!bbox) continue;
        // ≥10 px on screen at any zoom (matches the retired Konva hitStrokeWidth of 20/scale) so a
        // thin connector stays easy to grab when zoomed out — the DOM hit-test is now the only one.
        const tol = Math.max(obj.width / 2, 10 / (this.opts.camera().scale || 1));
        if (
          world.x < bbox.x - tol ||
          world.x > bbox.x + bbox.width + tol ||
          world.y < bbox.y - tol ||
          world.y > bbox.y + bbox.height + tol
        )
          continue;
        const poly = this.connectorPolyline(obj.kind, obj.from, obj.to);
        if (this.pointToPolylineDist(world, poly) <= tol) return id;
        continue;
      }
      if (obj?.type !== "text" && obj?.type !== "stamp" && obj?.type !== "image") continue;
      const size = this.sizes.get(id);
      if (!size) continue;
      // Stamps are centre-anchored (obj.x/y = centre); text/shapes are top-left anchored.
      const left = obj.type === "stamp" ? obj.x - size.w / 2 : obj.x;
      const top = obj.type === "stamp" ? obj.y - size.h / 2 : obj.y;
      if (
        world.x >= left &&
        world.x <= left + size.w &&
        world.y >= top &&
        world.y <= top + size.h
      ) {
        return id;
      }
    }
    return null;
  }

  /** Min distance (world units) from a point to a polyline `[x0,y0,x1,y1,…]` (nearest segment). */
  private pointToPolylineDist(pt: { x: number; y: number }, points: number[]): number {
    if (points.length < 2) return Infinity;
    if (points.length === 2)
      return Math.hypot(pt.x - (points[0] as number), pt.y - (points[1] as number));
    let best = Infinity;
    for (let i = 0; i + 3 < points.length; i += 2) {
      const ax = points[i] as number,
        ay = points[i + 1] as number;
      const bx = points[i + 2] as number,
        by = points[i + 3] as number;
      const dx = bx - ax,
        dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((pt.x - ax) * dx + (pt.y - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx,
        cy = ay + t * dy;
      const d = Math.hypot(pt.x - cx, pt.y - cy);
      if (d < best) best = d;
    }
    return best;
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
    if (hit && this.objects.get(hit)?.get("locked") === true) return; // locked → no edit, no create-on-top
    if (hit && !this.isStampId(hit) && !this.isInkId(hit) && !this.isImageId(hit)) {
      if (this.remoteEditIds.has(hit)) return; // a peer is editing this box — leave it to them
      this.beginEdit(hit, selectAll, caretAt);
    } else {
      this.beginCreate(world.x, world.y); // empty space (or a non-editable stamp/stroke/image) → new box
    }
  }

  /** True if `id` is a stamp object (not text). Stamps render in this layer but aren't text-editable. */
  isStampId(id: string): boolean {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    return obj?.type === "stamp";
  }

  /** True if `id` is a stroke or connector (SVG ink, never text-editable). */
  isInkId(id: string): boolean {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    return obj?.type === "stroke" || obj?.type === "connector";
  }

  /** True if `id` is an uploaded image (renders in this layer, but isn't text-editable). */
  isImageId(id: string): boolean {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    return obj?.type === "image";
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

  // ---- placement ghost (a translucent preview that tracks the cursor before you drop a box) ----
  private ensureGhost(): HTMLElement {
    let g = this.stickyGhost;
    if (!g) {
      g = document.createElement("div");
      this.root.appendChild(g);
      this.stickyGhost = g;
    }
    return g;
  }
  /** Show/move a translucent placement preview of a sticky note, centred on the world point. */
  showStickyGhost(world: { x: number; y: number }, color: string): void {
    if (this.edit) return this.hideStickyGhost(); // a note is open → no ghost
    const g = this.ensureGhost();
    g.className = "komu-text sticky komu-text-ghost";
    g.style.background = color;
    g.style.backgroundImage = "";
    this.layout(
      g,
      world.x - DEFAULT_STICKY_SIZE / 2,
      world.y - DEFAULT_STICKY_SIZE / 2,
      DEFAULT_STICKY_SIZE,
      DEFAULT_STICKY_TEXT_SIZE,
      DEFAULT_TEXT_FONT,
      "center",
    );
  }
  /** Show/move a translucent placement preview of a shape, centred on the world point. */
  showShapeGhost(world: { x: number; y: number }, kind: ShapeKind, fill: string): void {
    if (this.edit) return this.hideStickyGhost();
    const g = this.ensureGhost();
    g.className = "komu-text komu-text-ghost";
    g.textContent = "";
    this.applyShape(g, kind, fill);
    const w = DEFAULT_SHAPE_W;
    const h = DEFAULT_SHAPE_H;
    this.layout(
      g,
      world.x - w / 2,
      world.y - h / 2,
      w,
      DEFAULT_TEXT_SIZE,
      DEFAULT_TEXT_FONT,
      "center",
      h,
    );
  }
  hideStickyGhost(): void {
    this.stickyGhost?.remove();
    this.stickyGhost = null;
  }
  /** Show/move a translucent stamp preview centred on the world point. Renders as a `.komu-stamp` in
   *  this.root (re-appended last by render() → above every committed object), painted + laid out
   *  with the SAME path the placed stamp uses, so the preview is pixel-identical to the result. */
  showStampGhost(
    world: { x: number; y: number },
    src: string,
    size: number,
    rotation: number,
  ): void {
    let g = this.stampGhost;
    if (!g) {
      g = document.createElement("div");
      g.className = "komu-stamp komu-text-ghost";
      this.root.appendChild(g);
      this.stampGhost = g;
    }
    this.paintStamp(g as HTMLDivElement, src);
    // Centre-anchored square box (x/y = top-left), mirroring effectiveGeom's stamp branch + render.
    this.layout(g, world.x - size / 2, world.y - size / 2, size, size, "", "left", size);
    this.applyRotation(g, rotation);
  }
  hideStampGhost(): void {
    this.stampGhost?.remove();
    this.stampGhost = null;
  }

  private beginEdit(id: string, selectAll = false, caretAt?: { x: number; y: number }): void {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (obj?.type !== "text" || obj.locked) return; // locked boxes aren't editable
    const session: Omit<EditSession, "el" | "editable"> = {
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
    if (obj.borderColor != null) session.borderColor = obj.borderColor;
    if (obj.borderStyle != null) session.borderStyle = obj.borderStyle;
    const rot = this.effectiveGeom(id, obj).rotation;
    if (rot) session.rotation = rot;
    this.openEditor(session, runsToHtml(obj.runs), selectAll, caretAt);
  }

  /** Sticky tool: drop a new sticky note at the point (or edit the box already there). */
  stickyAt(world: { x: number; y: number }, color: string): void {
    if (this.edit) this.commit();
    // Always CREATE (FigJam-style): a tap drops a NEW note centred on the cursor (matching the ghost),
    // stacking on top even over an existing object — it must never drop into another box's text.
    this.openEditor({
      id: null,
      x: world.x - DEFAULT_STICKY_SIZE / 2,
      y: world.y - DEFAULT_STICKY_SIZE / 2,
      width: DEFAULT_STICKY_SIZE,
      fontSize: DEFAULT_STICKY_TEXT_SIZE,
      fontFamily: DEFAULT_TEXT_FONT,
      align: "left",
      bg: color,
    });
  }

  /** Shapes tool: drop a new shape box (fixed width×height) centred on the point + open for a label.
   *  Always CREATES (FigJam-style) — placing over an existing object stacks a new shape on top rather
   *  than dropping into that object's text (or no-op'ing over a non-editable stamp/stroke). */
  shapeAt(world: { x: number; y: number }, kind: ShapeKind, fill: string): void {
    if (this.edit) this.commit();
    const w = DEFAULT_SHAPE_W;
    const h = DEFAULT_SHAPE_H;
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
    session: Omit<EditSession, "el" | "editable">,
    seedHtml = "",
    selectAll = false,
    caretAt?: { x: number; y: number },
  ): void {
    const el = document.createElement("div");
    el.className = "komu-text komu-text-editor";
    el.style.color = INK;
    this.applyRotation(el, session.rotation ?? 0);
    // Shape (outline + fixed height) or sticky (coloured square) styling on the box itself.
    if (session.shape)
      this.applyShape(el, session.shape, session.bg, session.borderColor, session.borderStyle);
    else this.applySticky(el, session.bg);
    // A shape's text lives in an INNER contenteditable so its empty caret centres within the box
    // (the box is full-height, so an editable === box would strand the caret at the top). Plain
    // text/sticky put contenteditable on the box itself.
    let editable: HTMLElement;
    if (session.shape) {
      el.contentEditable = "false";
      editable = document.createElement("div");
      editable.className = "komu-text-body";
      editable.contentEditable = "true";
      editable.spellcheck = false;
      editable.innerHTML = seedHtml;
      el.appendChild(editable);
    } else {
      el.contentEditable = "true";
      el.spellcheck = false;
      el.innerHTML = seedHtml;
      editable = el;
    }
    this.hideStickyGhost(); // the real note replaces the placement preview
    this.root.appendChild(el);
    this.edit = { ...session, el, editable };
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
    editable.addEventListener("input", () => this.scheduleEditBroadcast());
    editable.addEventListener("keydown", (e) => {
      // Esc or ⌘/Ctrl+Enter commits.
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.commit();
        return;
      }
      // In a bulleted box, a plain Enter continues the list — start the new line with a bullet.
      if (e.key === "Enter" && !e.shiftKey && runsAreBulleted(elementToRuns(editable))) {
        e.preventDefault();
        document.execCommand("insertHTML", false, "<br>• ");
        this.scheduleEditBroadcast();
      }
    });
    editable.addEventListener("blur", (e) => {
      // Focus moving into the toolbar / a popover (e.g. the size input) must not commit the box.
      const next = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (next?.closest(".komu-text-bar, .ctb-pop, komu-color-picker")) return;
      // Focus moving into a tool picker (shape menu / place bars) DOES commit the box, but must not
      // also revert the tool to select: the revert would synchronously hide the menu before the
      // picked item's click registers, so e.g. picking the arrow after placing a shape silently
      // dropped you on the select tool. Commit with keepTool so the menu stays and the pick lands.
      const keepTool = !!next?.closest("komu-shape-menu, komu-sticky-bar, komu-draw-bar");
      this.commit(keepTool);
    });

    editable.focus();
    if (caretAt) this.caretToPoint(editable, caretAt.x, caretAt.y);
    else if (selectAll) this.selectAllEditor(editable);
    else this.caretToEnd(editable);
    document.execCommand("styleWithCSS", false, "true"); // marks emit inline-style spans (serialisable)
    this.barSelId = null; // editing takes over the bar from any selection-mode display
    this.bar.show(editable, this.barState());
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

  /** Select all the editor's text — double-click-to-edit replaces on type. */
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
    const links = this.root.querySelectorAll<HTMLAnchorElement>(".komu-text a");
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
    const host = link.closest(".komu-text") as HTMLElement | null;
    const id = host?.dataset.id;
    if (!id) return;
    const href = link.getAttribute("href") ?? "";
    this.beginEdit(id);
    const links = [...(this.edit?.el.querySelectorAll("a") ?? [])];
    const match = links.find((a) => a.getAttribute("href") === href) ?? links[0];
    if (match) this.bar.editLink(match);
  }

  // ---- toolbar (the floating <komu-text-bar> above the active editor) ----

  /** Apply a block-level change (font / size / alignment), re-lay-out + reposition + broadcast. */
  private setEditBlock(p: { fontFamily?: string; fontSize?: number; align?: TextAlign }): void {
    const e = this.edit;
    if (!e) return;
    const cam = this.opts.camera();
    const centerX = e.x + e.el.offsetWidth / cam.scale / 2; // keep the box centred horizontally on this
    if (p.fontFamily != null) e.fontFamily = p.fontFamily;
    if (p.fontSize != null) e.fontSize = p.fontSize;
    if (p.align != null) e.align = p.align;
    this.layout(e.el, e.x, e.y, e.width, e.fontSize, e.fontFamily, e.align, e.height);
    // A shape is a fixed width×height card — don't re-centre it (only auto-grown text needs that).
    if (e.shape == null) {
      // Re-centre on the same point (top y unchanged) so the box grows symmetrically and the toolbar —
      // positioned from the box's top + centre — stays put while you click through sizes.
      e.x = centerX - e.el.offsetWidth / cam.scale / 2;
      this.layout(e.el, e.x, e.y, e.width, e.fontSize, e.fontFamily, e.align);
    }
    this.positionBar();
    this.scheduleEditBroadcast(); // peers see the block change live
    this.reflectBar();
  }

  /** Shape mode: change the kind of the shape being edited (re-paints its outline live). */
  private setEditShape(kind: ShapeKind): void {
    const e = this.edit;
    if (!e || e.shape == null) return;
    e.shape = kind;
    this.applyShape(e.el, kind, e.bg, e.borderColor, e.borderStyle);
    this.layout(e.el, e.x, e.y, e.width, e.fontSize, e.fontFamily, e.align, e.height);
    this.positionBar();
    this.scheduleEditBroadcast();
    this.reflectBar();
  }

  /** Shape mode: change the fill colour of the shape being edited. */
  private setEditFill(color: string): void {
    const e = this.edit;
    if (!e || e.shape == null) return;
    e.bg = color;
    this.applyShape(e.el, e.shape, color, e.borderColor, e.borderStyle);
    this.scheduleEditBroadcast();
    this.reflectBar();
  }

  /** Shape mode: change the border colour and/or style of the shape being edited. */
  private setEditBorder(p: { color?: string; style?: BorderStyle }): void {
    const e = this.edit;
    if (!e || e.shape == null) return;
    if (p.color != null) e.borderColor = p.color;
    if (p.style != null) e.borderStyle = p.style;
    this.applyShape(e.el, e.shape, e.bg, e.borderColor, e.borderStyle);
    this.scheduleEditBroadcast();
    this.reflectBar();
  }

  /** Toggle a "• " prefix on every line of the box (whole-box bulleted list). */
  private toggleBullets(): void {
    const e = this.edit;
    if (!e) return;
    const runs = toggleBulletRuns(elementToRuns(e.editable));
    e.editable.innerHTML = runsToHtml(runs);
    this.caretToEnd(e.editable);
    this.scheduleEditBroadcast();
    this.reflectBar();
  }

  // ---- toolbar dispatch: edit-mode acts on the live editor; selection-mode writes to the doc ----
  private boxObj(id: string): TextObject | null {
    const m = this.objects.get(id);
    const o = m ? readObject(m) : null;
    return o?.type === "text" ? o : null;
  }
  private applyBlock(p: { fontFamily?: string; fontSize?: number; align?: TextAlign }): void {
    if (this.edit) return this.setEditBlock(p);
    if (this.barSelId) setTextStyle(this.opts.doc, this.barSelId, p); // observer re-reflects the bar
  }
  private applyShapeKind(kind: ShapeKind): void {
    if (this.edit) return this.setEditShape(kind);
    const id = this.barSelId;
    if (!id) return;
    this.opts.doc.transact(() => {
      const m = this.objects.get(id);
      if (!m || m.get("type") !== "text") return;
      m.set("shape", kind);
    });
  }
  private applyFill(color: string): void {
    if (this.edit) return this.setEditFill(color);
    if (this.barSelId) setTextStyle(this.opts.doc, this.barSelId, { bg: color });
  }
  private applyBorder(p: { color?: string; style?: BorderStyle }): void {
    if (this.edit) return this.setEditBorder(p);
    if (this.barSelId) {
      const patch: { borderColor?: string; borderStyle?: BorderStyle } = {};
      if (p.color != null) patch.borderColor = p.color;
      if (p.style != null) patch.borderStyle = p.style;
      setTextStyle(this.opts.doc, this.barSelId, patch);
    }
  }
  private applyBullets(): void {
    if (this.edit) return this.toggleBullets();
    const obj = this.barSelId ? this.boxObj(this.barSelId) : null;
    if (obj && this.barSelId) setTextRuns(this.opts.doc, this.barSelId, toggleBulletRuns(obj.runs));
  }
  /** Toggle a boolean mark (bold/italic/…) across the whole selected box (selection mode only). */
  private applyBoxMark(mark: string): void {
    const obj = this.barSelId ? this.boxObj(this.barSelId) : null;
    if (obj && this.barSelId)
      setTextRuns(this.opts.doc, this.barSelId, toggleBoolMarkAllRuns(obj.runs, mark as BoolMark));
  }
  /** Set a colour/highlight/link across the whole selected box (selection mode only). */
  private applyBoxRunMark(key: "color" | "highlight" | "link", value: string): void {
    const obj = this.barSelId ? this.boxObj(this.barSelId) : null;
    if (obj && this.barSelId)
      setTextRuns(this.opts.doc, this.barSelId, setMarkAllRuns(obj.runs, key, value));
  }
  /** Selection-mode Link click: open the selected box's text editor with all text selected, then
   *  bring up the link input (now editing) so the URL links the whole label. From there the user can
   *  reselect a span to link only part of it — same as any text node. */
  private linkSelectionForBar(): void {
    const id = this.barSelId;
    if (!id || this.remoteEditIds.has(id)) return;
    this.beginEdit(id, true); // edit + select-all → bar.show() flips the bar into edit mode
    this.bar.openLink();
  }

  private positionBar(): void {
    if (this.edit) this.bar.positionOver(this.edit.el.getBoundingClientRect());
    else if (this.barSelId) {
      const el = this.els.get(this.barSelId);
      if (el) this.bar.positionOver(el.getBoundingClientRect());
    }
  }
  private reflectBar(): void {
    this.bar.reflect(this.barState());
  }

  /** Show/hide the toolbar in *selection mode* — when exactly one committed box is selected and we
   *  aren't editing/moving/resizing, the bar floats over it and its controls apply to the whole box. */
  private updateSelectionBar(): void {
    if (this.edit) return; // an open editor owns the bar
    const ids = [...this.selected];
    const id = ids.length === 1 ? ids[0]! : null;
    const obj = id ? this.boxObj(id) : null;
    const show =
      !!obj &&
      !this.moveState &&
      !this.resizing &&
      !this.groupSelected && // in a multi-node group the box has no individual toolbar
      id != null &&
      !this.remoteEditIds.has(id);
    if (!show) {
      if (this.barSelId !== null) {
        this.barSelId = null;
        this.bar.hide();
      }
      return;
    }
    this.barSelId = id;
    this.bar.showForSelection(this.barStateForObject(obj));
    this.positionBar();
  }

  /** Toolbar state derived from a committed box (selection mode) rather than the editor's selection. */
  private barStateForObject(obj: TextObject): TextBarState {
    const colors = new Set(obj.runs.filter((r) => r.text).map((r) => r.color ?? ""));
    const state: TextBarState = {
      bold: allRunsHaveMark(obj.runs, "bold"),
      italic: allRunsHaveMark(obj.runs, "italic"),
      underline: allRunsHaveMark(obj.runs, "underline"),
      strike: allRunsHaveMark(obj.runs, "strike"),
      bullet: runsAreBulleted(obj.runs),
      fontFamily: obj.fontFamily,
      fontSize: obj.fontSize,
      color: (colors.size === 1 ? [...colors][0] : "") || INK,
    };
    if (obj.shape != null) {
      state.shape = obj.shape;
      state.fill = obj.bg ?? "#ffffff";
      state.borderColor = obj.borderColor ?? SHAPE_STROKE;
      state.borderStyle = obj.borderStyle ?? "solid";
      state.align = obj.align;
    }
    return state;
  }
  private barState(): TextBarState {
    const e = this.edit;
    const state: TextBarState = {
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      strike: document.queryCommandState("strikeThrough"),
      bullet: e ? runsAreBulleted(elementToRuns(e.editable)) : false,
      fontFamily: e?.fontFamily ?? DEFAULT_TEXT_FONT,
      fontSize: e?.fontSize ?? DEFAULT_TEXT_SIZE,
      color: document.queryCommandValue("foreColor") || INK,
    };
    // Shape mode adds the shape kind / fill / border / alignment so the bar can show its extra controls.
    if (e?.shape != null) {
      state.shape = e.shape;
      state.fill = e.bg ?? "#ffffff";
      state.borderColor = e.borderColor ?? SHAPE_STROKE;
      state.borderStyle = e.borderStyle ?? "solid";
      state.align = e.align;
    }
    return state;
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

  /** Select a text box (additive toggles it within the current selection). Selecting any grouped
   *  object selects its whole group; toggling a member off removes the whole group. */
  selectText(id: string, additive = false): void {
    if (!additive) this.selected.clear();
    const group = expandGroups(this.opts.doc, [id]);
    if (additive && this.selected.has(id)) {
      for (const g of group) this.selected.delete(g);
    } else {
      for (const g of group) this.selected.add(g);
    }
    this.refreshSelectionChrome();
    this.opts.onSelectionChange?.();
  }

  /** True if any selected object is locked — blocks moving / resizing / rotating the whole selection. */
  hasLockedSelection(): boolean {
    for (const id of this.selected) if (this.objects.get(id)?.get("locked") === true) return true;
    return false;
  }
  clearSelection(): void {
    if (!this.selected.size) return;
    this.selected.clear();
    this.refreshSelectionChrome();
    this.opts.onSelectionChange?.();
  }
  /** Drop specific ids from the selection (last-writer-wins: a peer just took them over). */
  deselectIds(ids: string[]): void {
    let changed = false;
    for (const id of ids) if (this.selected.delete(id)) changed = true;
    if (changed) {
      this.refreshSelectionChrome();
      this.opts.onSelectionChange?.();
    }
  }
  selectAll(): void {
    const before = this.selected.size;
    // Walk the doc, not the mounted maps — viewport culling means off-screen objects have no element
    // yet, but ⌘A must still select every object on the board.
    for (const id of orderArray(this.opts.doc).toArray()) {
      const m = this.objects.get(id);
      const t = m?.get("type");
      if (m?.get("locked") === true) continue; // ⌘A selects the actionable (unlocked) objects
      if (t === "text" || t === "stamp" || t === "image" || t === "stroke" || t === "connector")
        this.selected.add(id);
    }
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
      if (
        obj?.type !== "text" &&
        obj?.type !== "stamp" &&
        obj?.type !== "image" &&
        obj?.type !== "stroke" &&
        obj?.type !== "connector"
      )
        continue;
      if (obj.locked) continue; // a marquee never grabs locked objects
      // stamps are centre-anchored; ink uses its AABB origin; text/shape/sticky use top-left.
      let left: number, top: number;
      if (obj.type === "stamp") {
        left = obj.x - size.w / 2;
        top = obj.y - size.h / 2;
      } else if (obj.type === "stroke" || obj.type === "connector") {
        const bb = this.inkBBox.get(id);
        if (!bb) continue;
        left = bb.x;
        top = bb.y;
      } else {
        left = obj.x;
        top = obj.y;
      }
      if (rectsIntersect(box, { x: left, y: top, width: size.w, height: size.h })) {
        this.selected.add(id);
      }
    }
    for (const id of expandGroups(this.opts.doc, this.selected)) this.selected.add(id); // whole groups
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
      el.classList.toggle("selected", local); // local ring via the .komu-text.selected CSS rule
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
    this.updateSelectionBar(); // show/hide the floating toolbar for a single selection
  }

  /** Begin dragging the current text selection from a world point. */
  beginMove(world: { x: number; y: number }): void {
    if (!this.selected.size || this.hasLockedSelection()) return; // a locked member anchors the selection
    this.moveState = { startX: world.x, startY: world.y, dx: 0, dy: 0 };
    this.movingAttached = this.attachedStampsOf(this.selected); // stickers ride their host live
    this.updateSelectionBar(); // hide the floating toolbar while dragging (re-shows on release)
  }

  /** Stamps stuck to any object in `hosts` (and not themselves a host) — they ride a host's drag. */
  private attachedStampsOf(hosts: Set<string>): Set<string> {
    const out = new Set<string>();
    if (!hosts.size) return out;
    this.objects.forEach((m, id) => {
      if (hosts.has(id) || m.get("type") !== "stamp") return;
      const att = m.get("attachedTo");
      if (typeof att === "string" && hosts.has(att)) out.add(id);
    });
    return out;
  }

  /** Map a stamp's centre / size / rotation through a host box transform (old → new): un-rotate by
   *  old, scale per axis, rotate by new; size by the geometric mean of the axis scales; add the
   *  rotation delta. Shared by the commit + live-preview paths. Boxes are {cx, cy, w, h, rot°}. */
  private mapAttachedStamp(
    obj: StampObject,
    old: { cx: number; cy: number; w: number; h: number; rot: number },
    neu: { cx: number; cy: number; w: number; h: number; rot: number },
  ): { cx: number; cy: number; size: number; rot: number } {
    const oldRad = (old.rot * Math.PI) / 180;
    const newRad = (neu.rot * Math.PI) / 180;
    const sx = neu.w / (old.w || 1);
    const sy = neu.h / (old.h || 1);
    const cu = Math.cos(-oldRad);
    const su = Math.sin(-oldRad);
    const cr = Math.cos(newRad);
    const sr = Math.sin(newRad);
    const dx = obj.x - old.cx;
    const dy = obj.y - old.cy;
    const lx = (cu * dx - su * dy) * sx; // un-rotate by old, then scale per axis
    const ly = (su * dx + cu * dy) * sy;
    return {
      cx: neu.cx + (cr * lx - sr * ly), // …then rotate by new about the new centre
      cy: neu.cy + (sr * lx + cr * ly),
      size: obj.size * (Math.sqrt(Math.abs(sx * sy)) || 1),
      rot: ((((obj.rotation ?? 0) + (neu.rot - old.rot)) % 360) + 360) % 360,
    };
  }

  /** Commit a host's attached stamps through its box transform — sticky/shape rotate + resize. Call
   *  inside the host's commit transaction so it is one undo step. */
  private transformAttachedStamps(
    hostId: string,
    old: { cx: number; cy: number; w: number; h: number; rot: number },
    neu: { cx: number; cy: number; w: number; h: number; rot: number },
  ): void {
    for (const id of this.attachedStampsOf(new Set([hostId]))) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "stamp") continue;
      const t = this.mapAttachedStamp(obj, old, neu);
      setStampGeom(this.opts.doc, id, { x: t.cx, y: t.cy, size: t.size, rotation: t.rot });
    }
  }

  /** Live-preview the cached attached stamps (`transformAttached`) through a host box transform during
   *  its single-object rotate/resize: apply each to its element (local glide) + return groupresize
   *  nodes for the peer broadcast. The doc commit is written by transformAttachedStamps on release. */
  private previewAttachedStamps(
    old: { cx: number; cy: number; w: number; h: number; rot: number },
    neu: { cx: number; cy: number; w: number; h: number; rot: number },
  ): Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
    rotation: number;
  }> {
    const nodes = [];
    for (const id of this.transformAttached) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      const el = this.els.get(id);
      if (obj?.type !== "stamp" || !el) continue;
      const t = this.mapAttachedStamp(obj, old, neu);
      const x = t.cx - t.size / 2; // centre → top-left box
      const y = t.cy - t.size / 2;
      this.layout(el, x, y, t.size, t.size, "", "left", t.size);
      this.applyRotation(el, t.rot);
      nodes.push({ id, x, y, width: t.size, height: t.size, fontSize: t.size, rotation: t.rot });
    }
    return nodes;
  }
  /** Live drag: offset the selected boxes in the overlay (committed to the doc on release).
   *  `broadcast` is false during a canvas-driven group move — the canvas sends ONE unified "drag"
   *  awareness field for all stroke + text ids, so the per-layer broadcast must not overwrite it. */
  moveTo(world: { x: number; y: number }, broadcast = true): void {
    const mv = this.moveState;
    if (!mv) return;
    mv.dx = world.x - mv.startX;
    mv.dy = world.y - mv.startY;
    for (const id of this.selected) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type === "stroke" || obj?.type === "connector") {
        // The svg's `d`/position stay at the doc points; the live drag is a CSS translate on top of
        // the camera scale() (no `d` rewrite). endMove bakes it (stroke → points; connector → ends).
        const inkEl = this.inkEls.get(id);
        if (inkEl) {
          const cam = this.opts.camera();
          inkEl.style.transform = `translate(${mv.dx * cam.scale}px, ${mv.dy * cam.scale}px) scale(${cam.scale})`;
        }
        continue;
      }
      const el = this.els.get(id);
      if (!el) continue;
      if (obj?.type === "stamp" || obj?.type === "image") {
        // effectiveGeom folds in the live moveState offset (+ a stamp's centre→top-left conversion),
        // so the dragged stamp/image glides under the cursor instead of jumping on release.
        const g = this.effectiveGeom(id, obj);
        this.layout(el, g.x, g.y, g.width, g.fontSize, "", "left", g.height);
        continue;
      }
      if (obj?.type !== "text") continue;
      this.layout(
        el,
        obj.x + mv.dx,
        obj.y + mv.dy,
        obj.width,
        obj.fontSize,
        obj.fontFamily,
        obj.align,
        obj.height, // keep a shape's fixed height while moving (else it collapses then snaps back)
      );
    }
    for (const id of this.movingAttached) {
      // A stamp stuck to a dragged host glides with it (effectiveGeom folds in the host's offset).
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "stamp") continue;
      const el = this.els.get(id);
      if (!el) continue;
      const g = this.effectiveGeom(id, obj);
      this.layout(el, g.x, g.y, g.width, g.fontSize, "", "left", g.height);
      this.applyRotation(el, g.rotation);
    }
    this.updateResizeChrome(); // keep the handles glued to the box while it moves
    this.opts.onShapesMoved?.(); // re-route connectors bound to the moving shapes (live)
    this.rerouteBoundConnectors(); // …and re-paint the visible DOM connectors so they follow too
    // Stream the live drag to peers (throttled) — ephemeral, the doc commits on release.
    const now = Date.now();
    if (broadcast && now - this.lastTextDragSent >= EDIT_BROADCAST_MS) {
      this.lastTextDragSent = now;
      this.opts.awareness.setLocalStateField("drag", {
        ids: [...this.selected, ...this.movingAttached], // peers glide the riding stamps too
        dx: mv.dx,
        dy: mv.dy,
      });
    }
  }
  /** Commit the drag to the doc (a no-movement click is a no-op), then end the live preview. */
  endMove(): void {
    const mv = this.moveState;
    this.moveState = null;
    this.movingAttached = new Set(); // the commit (translateObjects) carries the stamps in the doc
    if (mv && (Math.abs(mv.dx) >= 0.01 || Math.abs(mv.dy) >= 0.01)) {
      // One transaction → one undo step for a mixed move. Connectors commit specially (a bound end
      // detaches to a free point unless its shape moves too); everything else offsets via translateObjects.
      this.opts.doc.transact(() => {
        const others: string[] = [];
        for (const id of this.selected) {
          if (this.objects.get(id)?.get("type") === "connector")
            this.commitConnectorMove(id, mv.dx, mv.dy);
          else others.push(id);
        }
        if (others.length) translateObjects(this.opts.doc, others, mv.dx, mv.dy);
      });
    }
    this.opts.awareness.setLocalStateField("drag", null);
    this.updateSelectionBar(); // moveState cleared → re-show the toolbar for the (still-selected) box
  }
  /** Commit a connector body-move: each end becomes a free point at its resolved start + the drag
   *  delta, EXCEPT an end bound to a shape that's ALSO selected — that stays bound and re-routes with
   *  the shape (matching the old canvas connector-move's skipBoundTo rule). */
  private commitConnectorMove(id: string, dx: number, dy: number): void {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (obj?.type !== "connector") return;
    const mk = (end: ConnectorEnd): ConnectorEnd => {
      if (end.shapeId && this.selected.has(end.shapeId)) return end; // shape moves too → stay bound
      const r = this.resolveConnectorEnd(end);
      return { x: r.x + dx, y: r.y + dy }; // free point (detached if it was bound)
    };
    setConnectorEnds(this.opts.doc, id, { from: mk(obj.from), to: mk(obj.to) });
  }

  /** Apply the effective drag offset to a box during render/sync — the local drag if I'm moving
   *  it, else a peer's in-progress drag (so their move streams here), else none. */
  private moveOffset(id: string): { dx: number; dy: number } {
    if (this.moveState && (this.selected.has(id) || this.movingAttached.has(id))) {
      return { dx: this.moveState.dx, dy: this.moveState.dy };
    }
    return this.remoteDragCurrent.get(id) ?? { dx: 0, dy: 0 };
  }

  /** Geometry to render a box at — the live resize preview if active, else doc + drag offset.
   *  `height` is only meaningful for shapes (fixed-height boxes); undefined = auto-height. */
  private effectiveGeom(
    id: string,
    obj: TextObject | StampObject | StrokeObject | ConnectorObject | ImageObject,
  ): {
    x: number;
    y: number;
    width: number | undefined;
    height: number | undefined;
    fontSize: number;
    rotation: number;
  } {
    // A stroke/connector "box" is its world AABB (no stored x/y/size); fold in move/resize/rotate
    // previews exactly like a stamp so the selection chrome + group transform stay type-agnostic.
    if (obj.type === "stroke" || obj.type === "connector") {
      const bbox = obj.type === "stroke" ? this.strokeWorldBBox(obj) : this.connectorWorldBBox(obj);
      const rotation =
        this.rotatePreview?.id === id
          ? this.rotatePreview.rotation
          : (this.remoteRotate.get(id) ?? 0);
      const gp = this.groupPreview?.get(id);
      if (gp)
        return {
          x: gp.x,
          y: gp.y,
          width: gp.width,
          height: gp.height,
          fontSize: gp.fontSize,
          rotation: gp.rotation,
        };
      const pv = this.resizePreview;
      if (pv?.id === id)
        return {
          x: pv.x,
          y: pv.y,
          width: pv.width ?? bbox.width,
          height: pv.height ?? bbox.height,
          fontSize: pv.fontSize,
          rotation,
        };
      const rr = this.remoteResizeCurrent.get(id);
      if (rr)
        return {
          x: rr.x,
          y: rr.y ?? bbox.y,
          width: rr.width ?? bbox.width,
          height: rr.height ?? bbox.height,
          fontSize: rr.fontSize,
          rotation,
        };
      const off = this.moveOffset(id);
      return {
        x: bbox.x + off.dx,
        y: bbox.y + off.dy,
        width: bbox.width,
        height: bbox.height,
        fontSize: 0,
        rotation,
      };
    }
    // A stamp is stored centre-anchored (x/y = centre, square `size`); normalise it into the same
    // top-left box model as text/shapes so every downstream consumer (render/hit-test/chrome/resize)
    // is type-agnostic. The previews below carry box geometry directly, matching text.
    if (obj.type === "stamp") {
      const size = obj.size;
      const rotation =
        this.rotatePreview?.id === id
          ? this.rotatePreview.rotation
          : (this.remoteRotate.get(id) ?? obj.rotation ?? 0);
      const gp = this.groupPreview?.get(id);
      if (gp)
        return {
          x: gp.x,
          y: gp.y,
          width: gp.width,
          height: gp.height,
          fontSize: gp.fontSize,
          rotation: gp.rotation,
        };
      const pv = this.resizePreview;
      if (pv?.id === id) {
        const w = pv.width ?? size;
        return { x: pv.x, y: pv.y, width: w, height: pv.height ?? w, fontSize: w, rotation };
      }
      const rr = this.remoteResizeCurrent.get(id); // a peer's in-progress resize (glided)
      if (rr) {
        const w = rr.width ?? size;
        return {
          x: rr.x,
          y: rr.y ?? obj.y - size / 2,
          width: w,
          height: rr.height ?? w,
          fontSize: w,
          rotation,
        };
      }
      const off = this.moveOffset(id);
      return {
        x: obj.x - size / 2 + off.dx,
        y: obj.y - size / 2 + off.dy,
        width: size,
        height: size,
        fontSize: size,
        rotation,
      };
    }
    // A local group transform (canvas-driven resize/rotate of the whole selection) wins over all.
    const gp = this.groupPreview?.get(id);
    if (gp) {
      return {
        x: gp.x,
        y: gp.y,
        width: gp.width,
        height: gp.height,
        fontSize: gp.fontSize,
        rotation: gp.rotation,
      };
    }
    // My live drag wins, then a peer's live rotation, else the committed doc value.
    const rotation =
      this.rotatePreview?.id === id
        ? this.rotatePreview.rotation
        : (this.remoteRotate.get(id) ?? obj.rotation ?? 0);
    const pv = this.resizePreview;
    if (pv?.id === id) {
      return {
        x: pv.x,
        y: pv.y,
        width: pv.width,
        height: pv.height ?? obj.height,
        fontSize: pv.fontSize,
        rotation,
      };
    }
    const rr = this.remoteResizeCurrent.get(id); // a peer's in-progress resize (glided)
    if (rr) {
      return {
        x: rr.x,
        y: rr.y ?? obj.y,
        width: rr.width,
        height: rr.height ?? obj.height,
        fontSize: rr.fontSize,
        rotation,
      };
    }
    const off = this.moveOffset(id);
    return {
      x: obj.x + off.dx,
      y: obj.y + off.dy,
      width: obj.width,
      height: obj.height,
      fontSize: obj.type === "image" ? 0 : obj.fontSize, // images have no font; layout ignores it
      rotation,
    };
  }

  /** The ids of every shape box (a TextObject with `shape` set) — connector snap targets. */
  shapeIds(): string[] {
    const out: string[] = [];
    this.objects.forEach((m, id) => {
      if (m.get("type") === "text" && m.get("shape") != null) out.push(id);
    });
    return out;
  }

  /** A shape's CURRENT live world rect (accounts for an in-progress local/peer drag or resize), or
   *  null if `id` isn't a shape. Connectors resolve their bound ends against this. */
  shapeWorldRect(id: string): { x: number; y: number; width: number; height: number } | null {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (obj?.type !== "text" || obj.shape == null) return null;
    const g = this.effectiveGeom(id, obj);
    const sz = this.sizes.get(id);
    const width = g.width ?? obj.width ?? sz?.w ?? 0;
    const height = g.height ?? obj.height ?? sz?.h ?? 0;
    return { x: g.x, y: g.y, width, height };
  }

  /** Live world AABBs of every currently-selected text/sticky/shape box, so the canvas can fold
   *  them into one union selection box spanning all node types (strokes + text + connectors).
   *  Tracks in-progress moves/resizes via effectiveGeom. */
  selectedWorldRects(): { x: number; y: number; width: number; height: number }[] {
    const out: { x: number; y: number; width: number; height: number }[] = [];
    for (const id of this.selected) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (
        obj?.type !== "text" &&
        obj?.type !== "stamp" &&
        obj?.type !== "image" &&
        obj?.type !== "stroke" &&
        obj?.type !== "connector"
      )
        continue;
      const g = this.effectiveGeom(id, obj);
      const sz = this.sizes.get(id);
      const width = g.width ?? (obj.type === "text" ? obj.width : undefined) ?? sz?.w ?? 0;
      const height = g.height ?? (obj.type === "text" ? obj.height : undefined) ?? sz?.h ?? 0;
      out.push({ x: g.x, y: g.y, width, height });
    }
    return out;
  }

  /** Live world rect of ANY text / sticky / shape box by id (regardless of local selection) — for
   *  the canvas to fold a *peer's* selection into a group box. null if `id` isn't a text box. */
  worldRectOf(id: string): { x: number; y: number; width: number; height: number } | null {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (
      obj?.type !== "text" &&
      obj?.type !== "stamp" &&
      obj?.type !== "image" &&
      obj?.type !== "stroke" &&
      obj?.type !== "connector"
    )
      return null;
    const g = this.effectiveGeom(id, obj);
    const sz = this.sizes.get(id);
    const width = g.width ?? (obj.type === "text" ? obj.width : undefined) ?? sz?.w ?? 0;
    const height = g.height ?? (obj.type === "text" ? obj.height : undefined) ?? sz?.h ?? 0;
    return { x: g.x, y: g.y, width, height };
  }

  // ---- group transform: the canvas resizes/rotates a whole multi-node selection as one unit and
  //      drives each text/sticky/shape box's geometry through here (live preview + doc commit) ----

  /** Full live geometry of a box (x/y top-left, w/h, rotation°, fontSize) — start state for a group
   *  transform. Includes any in-progress preview. null if `id` isn't a text box. */
  boxGeomOf(id: string): {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    fontSize: number;
  } | null {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (
      obj?.type !== "text" &&
      obj?.type !== "stamp" &&
      obj?.type !== "image" &&
      obj?.type !== "stroke" &&
      obj?.type !== "connector"
    )
      return null;
    const g = this.effectiveGeom(id, obj);
    const sz = this.sizes.get(id);
    return {
      x: g.x,
      y: g.y,
      width: g.width ?? (obj.type === "text" ? obj.width : undefined) ?? sz?.w ?? 0,
      height: g.height ?? (obj.type === "text" ? obj.height : undefined) ?? sz?.h ?? 0,
      rotation: g.rotation,
      fontSize: g.fontSize,
    };
  }

  /** Live-preview the boxes under a group transform (re-lays them out at the previewed geometry). */
  setGroupPreview(
    preview: Map<
      string,
      { x: number; y: number; width: number; height: number; fontSize: number; rotation: number }
    >,
  ): void {
    this.groupPreview = preview;
    for (const id of preview.keys()) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type === "stroke" || obj?.type === "connector") {
        this.relayoutBox(id); // re-lay-out the ink svg from its previewed (group) geom
        continue;
      }
      const el = this.els.get(id);
      if (!el || (obj?.type !== "text" && obj?.type !== "stamp" && obj?.type !== "image")) continue;
      const g = this.effectiveGeom(id, obj);
      const fontFamily = obj.type === "text" ? obj.fontFamily : "";
      const align = obj.type === "text" ? obj.align : "left";
      this.layout(el, g.x, g.y, g.width, g.fontSize, fontFamily, align, g.height);
      this.applyRotation(el, g.rotation);
    }
  }
  clearGroupPreview(): void {
    this.groupPreview = null;
  }
  /** Commit one box's group-transformed geometry to the doc (call inside the canvas's transaction). */
  commitGroupTransform(
    id: string,
    geom: {
      x: number;
      y: number;
      width: number;
      height: number;
      rotation: number;
      fontSize: number;
    },
  ): void {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (obj?.type === "stamp") {
      // Box → centre+size: a stamp stays square, so average the (usually-uniform) group scale.
      setStampGeom(this.opts.doc, id, {
        x: geom.x + geom.width / 2,
        y: geom.y + geom.height / 2,
        size: (geom.width + geom.height) / 2,
        rotation: geom.rotation,
      });
      return;
    }
    if (obj?.type === "stroke" || obj?.type === "connector") {
      // Ink carries no box geometry — bake the group's box affine into the points / free endpoints:
      // scale the old AABB into the new box, then rotate about the new centre (mirrors onResizeUp +
      // onRotateUp, combined). A connector's bound end is left alone — it reroutes with its shape.
      const oldBox =
        this.inkBBox.get(id) ?? (obj.type === "stroke" ? this.strokeWorldBBox(obj) : null);
      if (oldBox) {
        const sx = geom.width / (oldBox.width || 1);
        const sy = geom.height / (oldBox.height || 1);
        const rad = (geom.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const ncx = geom.x + geom.width / 2;
        const ncy = geom.y + geom.height / 2;
        const map = (px: number, py: number): { x: number; y: number } => {
          const mx = geom.x + (px - oldBox.x) * sx;
          const my = geom.y + (py - oldBox.y) * sy;
          const dx = mx - ncx;
          const dy = my - ncy;
          return { x: ncx + cos * dx - sin * dy, y: ncy + sin * dx + cos * dy };
        };
        if (obj.type === "stroke") {
          const pts = obj.points.slice();
          for (let i = 0; i + 1 < pts.length; i += 2) {
            const q = map(pts[i] as number, pts[i + 1] as number);
            pts[i] = q.x;
            pts[i + 1] = q.y;
          }
          setObjectsPoints(this.opts.doc, [{ id, points: pts }]);
        } else {
          const mapEnd = (e: typeof obj.from): typeof obj.from =>
            e.shapeId ? e : { ...e, ...map(e.x, e.y) };
          setConnectorEnds(this.opts.doc, id, { from: mapEnd(obj.from), to: mapEnd(obj.to) });
        }
      }
      return;
    }
    setTextGeometry(this.opts.doc, id, {
      x: geom.x,
      y: geom.y,
      width: geom.width,
      height: geom.height,
      rotation: geom.rotation,
    });
    setTextStyle(this.opts.doc, id, { fontSize: geom.fontSize });
  }

  // ---- group transform: a DOM box over the selection union resizes/rotates every selected object as
  //      one unit (ADR-0009 Phase 3 Step 4 — replaces the Konva group proxy + Konva.Transformer) ----

  /** World-space bounding box of the whole selection (union of every selected object's rect). */
  groupUnionRect(): { x: number; y: number; width: number; height: number } | null {
    const rects = this.selectedWorldRects();
    if (!rects.length) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const r of rects) {
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.width > maxX) maxX = r.x + r.width;
      if (r.y + r.height > maxY) maxY = r.y + r.height;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private ensureGroupEl(): HTMLDivElement {
    if (this.groupEl) return this.groupEl;
    const box = document.createElement("div");
    box.className = "komu-group-box";
    for (const h of ["nw", "ne", "sw", "se", "w", "e", "n", "s"]) {
      const hd = document.createElement("div");
      hd.className = `komu-group-handle g-${h}`;
      hd.addEventListener("pointerdown", (e) => this.beginGroupResize(e, h));
      box.appendChild(hd);
    }
    // "Grouped" chip + Ungroup action (shown only for a real group — see updateGroupChrome). Surfaces
    // that the selection IS a group (vs a loose multi-select) and makes ⌘⇧G discoverable.
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "komu-group-ungroup";
    chip.title = "Ungroup (⌘⇧G)";
    chip.setAttribute("aria-label", "Ungroup");
    chip.innerHTML =
      '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="2.5" width="6" height="6" rx="1"/><rect x="7.5" y="7.5" width="6" height="6" rx="1"/></svg><span>Group</span>';
    chip.addEventListener("pointerdown", (e) => e.stopPropagation()); // don't start a group drag
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onUngroup?.();
    });
    box.appendChild(chip);
    this.groupChip = chip;
    this.root.appendChild(box);
    this.groupEl = box;
    return box;
  }

  /** The shared groupId if the selection is exactly one persistent group (≥2 objects, all sharing one
   *  non-empty groupId), else null — i.e. a real group vs a loose multi-select. */
  private selectionGroupId(): string | null {
    if (this.selected.size < 2) return null;
    let gid: string | null = null;
    for (const id of this.selected) {
      const g = this.objects.get(id)?.get("groupId");
      if (typeof g !== "string" || !g) return null; // an ungrouped member → not a group
      if (gid === null) gid = g;
      else if (gid !== g) return null; // members from different groups → not one group
    }
    return gid;
  }

  /** Show/position the group transform box over the selection union (2+ objects), else hide it. */
  private updateGroupChrome(): void {
    // No group transform box when a locked object is in the selection (it would move/scale the locked one).
    const u =
      this.selected.size >= 2 && !this.edit && !this.hasLockedSelection()
        ? this.groupUnionRect()
        : null;
    if (!u) {
      if (this.groupEl) this.groupEl.style.display = "none";
      return;
    }
    const box = this.ensureGroupEl();
    box.style.display = "";
    const cam = this.opts.camera();
    box.style.left = `${u.x * cam.scale + cam.x}px`;
    box.style.top = `${u.y * cam.scale + cam.y}px`;
    box.style.width = `${u.width * cam.scale}px`;
    box.style.height = `${u.height * cam.scale}px`;
    // Mark a real group distinctly (solid accent outline) + show the Ungroup chip; a loose multi-select
    // keeps the plain handle box and hides the chip.
    const grouped = this.selectionGroupId() !== null;
    box.classList.toggle("is-group", grouped);
    if (this.groupChip) this.groupChip.style.display = grouped ? "" : "none";
  }

  /** Snapshot each selected box's centre+size+rotation+font — the start state for a group gesture. */
  private captureGroupGeom(): void {
    const g = new Map<
      string,
      { cx: number; cy: number; w: number; h: number; rot: number; font: number }
    >();
    // The selected objects + any stamps stuck to a selected host (so a group rotate/resize carries the
    // attached stamps through the SAME transform fn — preview, broadcast, and commit all for free).
    const ids = new Set(this.selected);
    for (const sid of this.attachedStampsOf(this.selected)) ids.add(sid);
    for (const id of ids) {
      const box = this.boxGeomOf(id);
      if (box)
        g.set(id, {
          cx: box.x + box.width / 2,
          cy: box.y + box.height / 2,
          w: box.width,
          h: box.height,
          rot: box.rotation,
          font: box.fontSize,
        });
    }
    this.groupGeom = g;
  }

  /** Transform the captured group geom by `fn`, preview it live (all types) + broadcast to peers. */
  private applyGroupPreview(
    fn: (g: { cx: number; cy: number; w: number; h: number; rot: number; font: number }) => {
      x: number;
      y: number;
      width: number;
      height: number;
      fontSize: number;
      rotation: number;
    },
  ): void {
    if (!this.groupGeom) return;
    const preview = new Map<
      string,
      { x: number; y: number; width: number; height: number; fontSize: number; rotation: number }
    >();
    for (const [id, g0] of this.groupGeom) preview.set(id, fn(g0));
    this.setGroupPreview(preview);
    this.updateGroupChrome();
    const now = Date.now();
    if (now - this.lastResizeSent >= EDIT_BROADCAST_MS) {
      this.lastResizeSent = now;
      const nodes = [...preview.entries()].map(([id, p]) => ({ id, ...p }));
      this.opts.awareness.setLocalStateField("groupresize", { nodes });
    }
  }

  private commitGroupPreview(): void {
    const gp = this.groupPreview;
    this.opts.doc.transact(() => {
      if (gp) for (const [id, geom] of gp) this.commitGroupTransform(id, geom);
    });
    this.clearGroupPreview();
    this.opts.awareness.setLocalStateField("groupresize", null);
    this.refreshSelectionChrome();
  }

  private beginGroupResize(e: PointerEvent, handle: string): void {
    e.preventDefault();
    e.stopPropagation();
    const u = this.groupUnionRect();
    if (!u || this.selected.size < 2) return;
    this.captureGroupGeom();
    this.groupResize = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      ux: u.x,
      uy: u.y,
      uw: u.width,
      uh: u.height,
    };
    window.addEventListener("pointermove", this.onGroupResizeMove);
    window.addEventListener("pointerup", this.onGroupResizeUp);
  }

  private readonly onGroupResizeMove = (e: PointerEvent): void => {
    const gr = this.groupResize;
    if (!gr) return;
    this.publishCursorAt(e.clientX, e.clientY);
    const scale = Math.max(this.opts.camera().scale, 1e-6);
    const wdx = (e.clientX - gr.startX) / scale;
    const wdy = (e.clientY - gr.startY) / scale;
    const MIN = 8;
    const h = gr.handle;
    let nw = gr.uw;
    let nh = gr.uh;
    if (h.includes("e")) nw = Math.max(MIN, gr.uw + wdx);
    if (h.includes("w")) nw = Math.max(MIN, gr.uw - wdx);
    if (h.includes("s")) nh = Math.max(MIN, gr.uh + wdy);
    if (h.includes("n")) nh = Math.max(MIN, gr.uh - wdy);
    const sx = nw / (gr.uw || 1);
    const sy = nh / (gr.uh || 1);
    const anchorX = h.includes("w") ? gr.ux + gr.uw : gr.ux; // the corner/edge opposite the handle is fixed
    const anchorY = h.includes("n") ? gr.uy + gr.uh : gr.uy;
    const s = (sx + sy) / 2;
    this.applyGroupPreview((g0) => {
      const cx = anchorX + (g0.cx - anchorX) * sx;
      const cy = anchorY + (g0.cy - anchorY) * sy;
      const w = g0.w * sx;
      const hh = g0.h * sy;
      return {
        x: cx - w / 2,
        y: cy - hh / 2,
        width: w,
        height: hh,
        fontSize: g0.font * s,
        rotation: g0.rot,
      };
    });
  };

  private readonly onGroupResizeUp = (): void => {
    window.removeEventListener("pointermove", this.onGroupResizeMove);
    window.removeEventListener("pointerup", this.onGroupResizeUp);
    if (this.groupResize) this.commitGroupPreview();
    this.groupResize = null;
    this.groupGeom = null;
  };

  /** Begin a group rotation — called by the canvas when a pointerdown lands in the rotate band just
   *  outside the group's corners (canvas keeps owning that band detection via rotationCornerOf). */
  beginGroupRotate(e: PointerEvent): void {
    if (this.selected.size < 2 || this.hasLockedSelection()) return; // a locked member anchors the group
    const u = this.groupUnionRect();
    if (!u) return;
    const cam = this.opts.camera();
    const wcx = u.x + u.width / 2;
    const wcy = u.y + u.height / 2;
    const cx = wcx * cam.scale + cam.x;
    const cy = wcy * cam.scale + cam.y;
    this.captureGroupGeom();
    this.groupRotate = { cx, cy, wcx, wcy, startAngle: Math.atan2(e.clientY - cy, e.clientX - cx) };
    window.addEventListener("pointermove", this.onGroupRotateMove);
    window.addEventListener("pointerup", this.onGroupRotateUp);
  }

  private readonly onGroupRotateMove = (e: PointerEvent): void => {
    const gr = this.groupRotate;
    if (!gr) return;
    this.publishCursorAt(e.clientX, e.clientY);
    const angle = Math.atan2(e.clientY - gr.cy, e.clientX - gr.cx);
    let deg = ((angle - gr.startAngle) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    this.applyGroupPreview((g0) => {
      const dx = g0.cx - gr.wcx;
      const dy = g0.cy - gr.wcy;
      const cx = gr.wcx + cos * dx - sin * dy;
      const cy = gr.wcy + sin * dx + cos * dy;
      return {
        x: cx - g0.w / 2,
        y: cy - g0.h / 2,
        width: g0.w,
        height: g0.h,
        fontSize: g0.font,
        rotation: g0.rot + deg,
      };
    });
  };

  private readonly onGroupRotateUp = (): void => {
    window.removeEventListener("pointermove", this.onGroupRotateMove);
    window.removeEventListener("pointerup", this.onGroupRotateUp);
    if (this.groupRotate) this.commitGroupPreview();
    this.groupRotate = null;
    this.groupGeom = null;
  };

  // ---- resize (a handle box around a single selected box — text isn't a Konva node, so the
  //      Konva transformer can't bound it; side handles change width, corners scale the font) ----

  private ensureResizeEl(): HTMLDivElement {
    if (this.resizeEl) return this.resizeEl;
    const box = document.createElement("div");
    box.className = "komu-text-resize";
    // Rotation zones just OUTSIDE each corner (appended first → under the resize handles, so the
    // corner itself still resizes while the area just beyond it rotates). Hover → rotate cursor.
    for (const c of ["nw", "ne", "sw", "se"] as const) {
      const rd = document.createElement("div");
      rd.className = `komu-text-rotate r-${c}`;
      rd.style.cursor = ROTATE_CURSORS[c]; // shared rotate cursor (same one strokes/stamps use)
      rd.addEventListener("pointerdown", (e) => this.beginRotate(e));
      box.appendChild(rd);
    }
    // n/s handles only matter for shapes (free height); they're hidden for text/sticky (auto-height).
    for (const h of ["nw", "ne", "sw", "se", "w", "e", "n", "s"]) {
      const hd = document.createElement("div");
      hd.className = `komu-text-handle h-${h}`;
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
    const m = id ? this.objects.get(id) : null;
    const obj = m ? readObject(m) : null;
    const el = id ? this.els.get(id) : undefined;
    const inkEl = id && obj?.type === "stroke" ? this.inkEls.get(id) : undefined;
    // Hidden for 0 / many / editing, or a locked box (can't resize/rotate it), AND when this box is one
    // node inside a multi-node group — the group's own transform box owns resize/rotate there. EXCEPT a
    // locked STROKE still shows its box (outline only, no handles) so you can see it's selected → unlock.
    const lockedStroke = !!inkEl && obj?.type === "stroke" && obj?.locked === true;
    if (
      !id ||
      (!el && !inkEl) ||
      this.edit ||
      this.remoteEditIds.has(id) ||
      this.groupSelected ||
      (obj?.locked && !lockedStroke)
    ) {
      if (this.resizeEl) this.resizeEl.style.display = "none";
    } else if (inkEl && obj?.type === "stroke") {
      // A stroke's selection box is its world AABB (effectiveGeom) mapped to screen. It resizes
      // free-aspect (8 handles) and rotates — so it uses the same chrome as a shape.
      const box = this.ensureResizeEl();
      box.style.display = "";
      box.dataset.id = id;
      const g = this.effectiveGeom(id, obj);
      const cam = this.opts.camera();
      box.style.left = `${g.x * cam.scale + cam.x}px`;
      box.style.top = `${g.y * cam.scale + cam.y}px`;
      box.style.width = `${(g.width ?? 0) * cam.scale}px`;
      box.style.height = `${(g.height ?? 0) * cam.scale}px`;
      box.classList.toggle("komu-text-resize-shape", true); // free-aspect 8-handle chrome + rotate
      box.classList.toggle("komu-text-resize-stamp", false);
      box.classList.toggle("komu-text-resize-stroke", false);
      box.classList.toggle("komu-text-resize-locked", obj?.locked === true); // locked → outline, no handles
      this.applyRotation(box, g.rotation);
    } else if (el) {
      const box = this.ensureResizeEl();
      box.style.display = "";
      box.dataset.id = id;
      box.style.left = el.style.left;
      box.style.top = el.style.top;
      box.style.width = `${el.offsetWidth}px`;
      box.style.height = `${el.offsetHeight}px`;
      // A shape has free width×height → show the n/s (vertical) handles; text/sticky/image don't.
      box.classList.toggle("komu-text-resize-shape", el.classList.contains("shape"));
      // A stamp resizes uniformly (square) → corner handles only (hide the w/e side handles too).
      box.classList.toggle("komu-text-resize-stamp", obj?.type === "stamp");
      // An image resizes aspect-locked → corner handles only too (a side handle would distort it).
      box.classList.toggle("komu-text-resize-image", obj?.type === "image");
      box.classList.toggle("komu-text-resize-stroke", false);
      box.classList.toggle("komu-text-resize-locked", false);
      const rotatable = obj?.type === "text" || obj?.type === "stamp" || obj?.type === "image";
      this.applyRotation(box, rotatable ? this.effectiveGeom(id, obj).rotation : 0);
    }
    this.updateGroupChrome(); // the multi-node group's own transform box (2+ selected)
    this.updateConnectorDots(); // dots also show in connector mode with no/multi selection
  }

  /** True while the board-wide selection spans 2+ nodes (a group). The canvas drives this; in a group
   *  a selected shape hides its connector snap dots (you're moving the group, not drawing connectors). */
  private groupSelected = false;
  setGroupSelected(on: boolean): void {
    if (this.groupSelected === on) return;
    this.groupSelected = on;
    this.refreshSelectionChrome(); // re-evaluate resize handles + toolbar + snap dots for the new state
  }

  /** Show every shape's connector dots while the line/arrow tool is active (not just the selected
   *  one's), so any shape is a visible snap target. */
  setConnectorMode(on: boolean): void {
    if (this.connectorMode === on) return;
    this.connectorMode = on;
    if (!on) this.snapTarget = null;
    this.updateConnectorDots();
  }

  /** While drawing a connector, mark the shape point its end is snapped to (or null). The snapped
   *  shape then shows only that one (highlighted) dot — the lock indicator. */
  setSnapTarget(t: { shapeId: string; side: ConnectorSide } | null): void {
    const same = this.snapTarget?.shapeId === t?.shapeId && this.snapTarget?.side === t?.side;
    if (same) return;
    this.snapTarget = t;
    this.updateConnectorDots();
  }

  /** Draw the 4 connector dots (side mid-edges, nudged a little outside the box) on the shapes that
   *  should show them: the selected shape, plus every shape while the connector tool is active. */
  private updateConnectorDots(): void {
    const ids = new Set<string>();
    if (this.connectorMode) for (const id of this.shapeIds()) ids.add(id);
    // A selected shape shows its snap dots only when it's the SOLE selection — in a multi-node group
    // you're dragging the group, so the dots are just clutter overlapping the union box.
    if (!this.groupSelected)
      for (const id of this.selected) {
        const m = this.objects.get(id);
        if (m?.get("type") === "text" && m.get("shape") != null) ids.add(id);
      }
    if (this.edit?.id) ids.delete(this.edit.id); // not while editing the box's text
    if (!this.dotsEl) {
      this.dotsEl = document.createElement("div");
      this.dotsEl.className = "komu-connector-dots";
      this.root.appendChild(this.dotsEl);
    }
    if (!ids.size) {
      this.dotsEl.replaceChildren();
      return;
    }
    const cam = this.opts.camera();
    const GAP = 16; // screen px outside the edge (matches the reference's floating dots)
    const SIDES: ConnectorSide[] = ["top", "right", "bottom", "left"];
    const dots: HTMLElement[] = [];
    for (const id of ids) {
      const rect = this.shapeWorldRect(id);
      if (!rect) continue;
      const sx = rect.x * cam.scale + cam.x;
      const sy = rect.y * cam.scale + cam.y;
      const sw = rect.width * cam.scale;
      const sh = rect.height * cam.scale;
      const at: Record<ConnectorSide, [number, number]> = {
        top: [sx + sw / 2, sy - GAP],
        bottom: [sx + sw / 2, sy + sh + GAP],
        left: [sx - GAP, sy + sh / 2],
        right: [sx + sw + GAP, sy + sh / 2],
      };
      // When a connector is snapped to this shape, collapse to just the locked dot (highlighted).
      const locked = this.snapTarget?.shapeId === id ? this.snapTarget.side : null;
      for (const side of SIDES) {
        if (locked && side !== locked) continue;
        const dot = document.createElement("div");
        dot.className = locked ? "komu-connector-dot is-snapped" : "komu-connector-dot";
        dot.style.left = `${at[side][0]}px`;
        dot.style.top = `${at[side][1]}px`;
        dots.push(dot);
      }
    }
    this.dotsEl.replaceChildren(...dots);
  }

  private beginResize(e: PointerEvent, handle: string): void {
    e.preventDefault();
    e.stopPropagation(); // a handle drag is not a canvas marquee/move
    const id = this.resizeEl?.dataset.id;
    if (!id) return;
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    const size = this.sizes.get(id);
    if (!size) return;
    this.transformAttached = this.attachedStampsOf(new Set([id])); // stamps that glide with the host
    if (obj?.type === "stamp") {
      // Anchor the resize math on the box TOP-LEFT (centre − half-size), square, opposite-corner-fixed.
      this.resizing = {
        id,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        ox: obj.x - size.w / 2,
        oy: obj.y - size.h / 2,
        ow: size.w,
        oh: size.h,
        ofs: size.w,
        baseW: size.w,
        isShape: false,
        isStamp: true,
      };
      this.updateSelectionBar();
      window.addEventListener("pointermove", this.onResizeMove);
      window.addEventListener("pointerup", this.onResizeUp);
      return;
    }
    if (obj?.type === "stroke") {
      // A stroke resizes free-aspect on its world AABB (no stored box); the affine is baked into its
      // points on release. Anchor the box top-left; the opposite corner stays fixed during the drag.
      const bb = this.inkBBox.get(id) ?? this.strokeWorldBBox(obj);
      this.resizing = {
        id,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        ox: bb.x,
        oy: bb.y,
        ow: bb.width,
        oh: bb.height,
        ofs: 0,
        baseW: bb.width,
        isShape: false,
        isStamp: false,
        isStroke: true,
      };
      this.updateSelectionBar();
      window.addEventListener("pointermove", this.onResizeMove);
      window.addEventListener("pointerup", this.onResizeUp);
      return;
    }
    if (obj?.type === "image") {
      // An image is a top-left box with explicit width/height — resize it free-aspect like a shape.
      this.resizing = {
        id,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        ox: obj.x,
        oy: obj.y,
        ow: obj.width,
        oh: obj.height,
        ofs: 0,
        baseW: obj.width,
        isShape: false,
        isStamp: false,
        isImage: true,
      };
      this.updateSelectionBar();
      window.addEventListener("pointermove", this.onResizeMove);
      window.addEventListener("pointerup", this.onResizeUp);
      return;
    }
    if (obj?.type !== "text") return;
    this.resizing = {
      id,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      ox: obj.x,
      oy: obj.y,
      ow: obj.width,
      oh: obj.height ?? size.h, // shapes carry an explicit height; fall back to measured
      ofs: obj.fontSize,
      baseW: obj.width ?? size.w, // auto-width boxes scale from their measured width
      isShape: obj.shape != null,
      isStamp: false,
    };
    this.updateSelectionBar(); // hide the floating toolbar while resizing (re-shows on release)
    window.addEventListener("pointermove", this.onResizeMove);
    window.addEventListener("pointerup", this.onResizeUp);
  }

  private readonly onResizeMove = (e: PointerEvent): void => {
    const rs = this.resizing;
    if (!rs) return;
    this.publishCursorAt(e.clientX, e.clientY); // keep peers' view of my cursor on the handle
    const scale = Math.max(this.opts.camera().scale, 1e-6);
    const wdx = (e.clientX - rs.startX) / scale;
    const wdy = (e.clientY - rs.startY) / scale;
    const m = this.objects.get(rs.id);
    const obj = m ? readObject(m) : null;
    if (rs.isStroke) {
      // Free-aspect AABB resize: each edge in the handle name moves, the opposite edge anchors. The
      // svg previews via a CSS matrix (no `d` rewrite); endMove bakes the affine into the points.
      const MIN_INK = 4;
      const h = rs.handle;
      const ow = rs.ow ?? rs.baseW;
      const oh = rs.oh ?? MIN_INK;
      let nw = ow;
      let nh = oh;
      let nx = rs.ox;
      let ny = rs.oy;
      if (h.includes("e")) nw = Math.max(MIN_INK, ow + wdx);
      if (h.includes("w")) {
        nw = Math.max(MIN_INK, ow - wdx);
        nx = rs.ox + (ow - nw); // anchor the right edge
      }
      if (h.includes("s")) nh = Math.max(MIN_INK, oh + wdy);
      if (h.includes("n")) {
        nh = Math.max(MIN_INK, oh - wdy);
        ny = rs.oy + (oh - nh); // anchor the bottom edge
      }
      this.resizePreview = { id: rs.id, x: nx, y: ny, width: nw, height: nh, fontSize: 0 };
      this.previewInkResize(rs.id, ow, oh, nx, ny, nw, nh);
      this.updateResizeChrome();
      const now = Date.now();
      if (now - this.lastResizeSent >= EDIT_BROADCAST_MS) {
        this.lastResizeSent = now;
        this.opts.awareness.setLocalStateField("textresize", {
          id: rs.id,
          x: nx,
          y: ny,
          width: nw,
          height: nh,
          fontSize: 0,
        });
      }
      return;
    }
    const el = this.els.get(rs.id);
    if (!el) return;
    if (rs.isStamp) {
      // Uniform square resize: derive the new side from the corner drag, anchor the opposite corner.
      const MIN_STAMP = 16;
      const h = rs.handle;
      const s0 = rs.ow ?? rs.baseW;
      const gx = h.includes("e") ? wdx : h.includes("w") ? -wdx : 0; // east/south grow +, west/north −
      const gy = h.includes("s") ? wdy : h.includes("n") ? -wdy : 0;
      const size = Math.max(MIN_STAMP, s0 + (gx + gy) / 2);
      const nx = h.includes("w") ? rs.ox + (s0 - size) : rs.ox; // anchor the corner NOT being dragged
      const ny = h.includes("n") ? rs.oy + (s0 - size) : rs.oy;
      this.resizePreview = { id: rs.id, x: nx, y: ny, width: size, height: size, fontSize: size };
      this.layout(el, nx, ny, size, size, "", "left", size);
      this.updateResizeChrome();
      const now = Date.now();
      if (now - this.lastResizeSent >= EDIT_BROADCAST_MS) {
        this.lastResizeSent = now;
        this.opts.awareness.setLocalStateField("textresize", {
          id: rs.id,
          x: nx,
          y: ny,
          width: size,
          height: size,
          fontSize: size,
        });
      }
      return;
    }
    if (rs.isImage) {
      // Aspect-locked resize: scale the box uniformly, preserving the image's natural ratio, so it
      // never distorts and object-fit never crops. The corner drag drives the scale (the larger of the
      // two axes); the opposite corner stays anchored. Side handles are hidden by the chrome.
      const MIN_IMG = 24;
      const MAX_IMG = 8000; // guard: an image can't be scaled to an absurd, board-dominating size
      const h = rs.handle;
      const ow = rs.ow ?? rs.baseW;
      const oh = rs.oh ?? ow;
      let fw = ow;
      let fh = oh;
      if (h.includes("e")) fw = ow + wdx;
      if (h.includes("w")) fw = ow - wdx;
      if (h.includes("s")) fh = oh + wdy;
      if (h.includes("n")) fh = oh - wdy;
      const sMin = Math.max(MIN_IMG / ow, MIN_IMG / oh, fw / ow, fh / oh);
      const s = Math.min(sMin, MAX_IMG / ow, MAX_IMG / oh); // floor at MIN_IMG, cap the longer side at MAX_IMG
      const nw = ow * s;
      const nh = oh * s;
      const nx = h.includes("w") ? rs.ox + (ow - nw) : rs.ox;
      const ny = h.includes("n") ? rs.oy + (oh - nh) : rs.oy;
      this.resizePreview = { id: rs.id, x: nx, y: ny, width: nw, height: nh, fontSize: 0 };
      this.layout(el, nx, ny, nw, 0, "", "left", nh);
      this.updateResizeChrome();
      const now = Date.now();
      if (now - this.lastResizeSent >= EDIT_BROADCAST_MS) {
        this.lastResizeSent = now;
        this.opts.awareness.setLocalStateField("textresize", {
          id: rs.id,
          x: nx,
          y: ny,
          width: nw,
          height: nh,
          fontSize: 0,
        });
      }
      return;
    }
    if (obj?.type !== "text") return;

    let x = rs.ox;
    let y = rs.oy;
    let width = rs.ow;
    let height = rs.oh;
    let fontSize = rs.ofs;

    if (rs.isShape) {
      // A shape resizes its box freely (width×height), font fixed. Each edge in the handle name
      // moves; the opposite edge stays anchored. Holding Shift locks the original aspect ratio.
      const h = rs.handle;
      const ow = rs.ow ?? rs.baseW;
      const oh = rs.oh ?? MIN_TEXT_W;
      let nw = ow;
      let nh = oh;
      let nx = rs.ox;
      let ny = rs.oy;
      if (h.includes("e")) nw = Math.max(MIN_TEXT_W, ow + wdx);
      if (h.includes("w")) {
        nw = Math.max(MIN_TEXT_W, ow - wdx);
        nx = rs.ox + (ow - nw); // anchor the right edge
      }
      if (h.includes("s")) nh = Math.max(MIN_TEXT_W, oh + wdy);
      if (h.includes("n")) {
        nh = Math.max(MIN_TEXT_W, oh - wdy);
        ny = rs.oy + (oh - nh); // anchor the bottom edge
      }
      if (e.shiftKey && nh > 0 && nw > 0) {
        // Freeze the aspect ratio at the instant Shift goes down — using the CURRENT (in-progress)
        // dimensions, not the box's original ones — so the shape doesn't jump when you grab Shift.
        if (!rs.lock) rs.lock = { w: nw, h: nh };
        const lw = rs.lock.w;
        const lh = rs.lock.h;
        const ratio = lw / lh;
        if (h.length === 2) {
          // corner → scale the frozen box uniformly to follow the drag, anchoring the opposite corner
          const s = Math.max(nw / lw, nh / lh);
          nw = Math.max(MIN_TEXT_W, lw * s);
          nh = Math.max(MIN_TEXT_W, lh * s);
          nx = h.includes("w") ? rs.ox + (ow - nw) : rs.ox;
          ny = h.includes("n") ? rs.oy + (oh - nh) : rs.oy;
        } else if (h === "e" || h === "w") {
          nh = Math.max(MIN_TEXT_W, nw / ratio); // width drives; height follows, centred vertically
          ny = rs.oy + (oh - nh) / 2;
        } else {
          nw = Math.max(MIN_TEXT_W, nh * ratio); // height drives; width follows, centred horizontally
          nx = rs.ox + (ow - nw) / 2;
        }
      } else if (rs.lock) {
        rs.lock = undefined; // Shift released → resume free resize; a re-press freezes a fresh ratio
      }
      x = nx;
      y = ny;
      width = nw;
      height = nh;
    } else if (rs.handle === "e") {
      width = Math.max(MIN_TEXT_W, rs.baseW + wdx); // grow/shrink width (auto-width → fixed)
    } else if (rs.handle === "w") {
      width = Math.max(MIN_TEXT_W, rs.baseW - wdx);
      x = rs.ox + (rs.baseW - width); // keep the right edge fixed
    } else {
      // text/sticky corner → scale the font by the horizontal drag ratio (and width too, if fixed)
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
    const boxHeight = rs.isShape ? height : undefined; // free-aspect shape box vs auto-height text
    this.resizePreview = {
      id: rs.id,
      x,
      y,
      width,
      height: boxHeight,
      fontSize,
    };
    this.layout(el, x, y, width, fontSize, obj.fontFamily, obj.align, boxHeight);
    this.updateResizeChrome();
    this.opts.onShapesMoved?.(); // re-route connectors bound to the resizing shape (live)
    this.rerouteBoundConnectors(); // …and re-paint the visible DOM connectors so they follow too
    // Stream the live resize to peers (throttled) — ephemeral; the doc commits on release.
    const now = Date.now();
    if (now - this.lastResizeSent >= EDIT_BROADCAST_MS) {
      this.lastResizeSent = now;
      const payload: Record<string, unknown> = { id: rs.id, x, fontSize };
      if (width != null) payload.width = width;
      if (rs.isShape) {
        payload.y = y;
        payload.height = height;
      }
      this.opts.awareness.setLocalStateField("textresize", payload);
    }
    // Glide any attached stamps with the host's resized box (rotation unchanged); stream throttled.
    if (this.transformAttached.size) {
      const ho = this.objects.get(rs.id);
      const hobj = ho ? readObject(ho) : null;
      const rot = hobj?.type === "text" ? (hobj.rotation ?? 0) : 0;
      const ow = rs.ow ?? rs.baseW;
      const oh = rs.oh ?? ow;
      const nW = width ?? ow;
      const nH = height ?? nW;
      const nodes = this.previewAttachedStamps(
        { cx: rs.ox + ow / 2, cy: rs.oy + oh / 2, w: ow, h: oh, rot },
        { cx: x + nW / 2, cy: y + nH / 2, w: nW, h: nH, rot },
      );
      if (nodes.length && now - this.lastAttachSent >= EDIT_BROADCAST_MS) {
        this.lastAttachSent = now;
        this.opts.awareness.setLocalStateField("groupresize", { nodes });
      }
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
        if (rs.isStamp) {
          // Box top-left → centre + square size.
          const size = pv.width ?? rs.baseW;
          setStampGeom(this.opts.doc, pv.id, {
            x: pv.x + size / 2,
            y: pv.y + size / 2,
            size,
          });
        } else if (rs.isStroke) {
          // Bake the box affine into the points: map the original AABB → the previewed AABB (this
          // anchors the opposite corner and applies the free-aspect x/y scale).
          const m2 = this.objects.get(pv.id);
          const o2 = m2 ? readObject(m2) : null;
          if (o2?.type === "stroke") {
            const ow = rs.ow ?? rs.baseW;
            const oh = rs.oh ?? 1;
            const sx = (pv.width ?? ow) / (ow || 1);
            const sy = (pv.height ?? oh) / (oh || 1);
            const pts = o2.points.slice();
            for (let i = 0; i + 1 < pts.length; i += 2) {
              pts[i] = pv.x + ((pts[i] as number) - rs.ox) * sx;
              pts[i + 1] = pv.y + ((pts[i + 1] as number) - rs.oy) * sy;
            }
            setObjectsPoints(this.opts.doc, [{ id: pv.id, points: pts }]);
          }
        } else if (rs.isImage) {
          // An image bakes its full box geometry too, but via setImageGeom (setTextGeometry's guard
          // rejects the `image` type). Free-aspect: both width and height persist.
          const geom: { x: number; y: number; width?: number; height?: number } = {
            x: pv.x,
            y: pv.y,
          };
          if (pv.width != null) geom.width = pv.width;
          if (pv.height != null) geom.height = pv.height;
          setImageGeom(this.opts.doc, pv.id, geom);
        } else if (rs.isShape) {
          // A shape bakes its full box geometry (font unchanged).
          const geom: { x: number; y: number; width?: number; height?: number } = {
            x: pv.x,
            y: pv.y,
          };
          if (pv.width != null) geom.width = pv.width;
          if (pv.height != null) geom.height = pv.height;
          setTextGeometry(this.opts.doc, pv.id, geom);
        } else {
          setTextGeometry(
            this.opts.doc,
            pv.id,
            pv.width != null ? { x: pv.x, width: pv.width } : { x: pv.x },
          );
          setTextStyle(this.opts.doc, pv.id, { fontSize: pv.fontSize });
        }
        // Carry attached stamps through a host (shape/sticky/text) resize — scale + reposition them.
        if (!rs.isStamp && !rs.isStroke && rs.ow && rs.oh && pv.width != null) {
          const ho = this.objects.get(pv.id);
          const hobj = ho ? readObject(ho) : null;
          const rot = hobj?.type === "text" ? (hobj.rotation ?? 0) : 0;
          const nW = pv.width;
          const nH = pv.height ?? pv.width; // a sticky/text box stays square — height tracks width
          this.transformAttachedStamps(
            pv.id,
            { cx: rs.ox + rs.ow / 2, cy: rs.oy + rs.oh / 2, w: rs.ow, h: rs.oh, rot },
            { cx: pv.x + nW / 2, cy: pv.y + nH / 2, w: nW, h: nH, rot },
          );
        }
      });
    }
    // Stop the live preview last, so the committed render overlaps the cleared preview on peers.
    this.opts.awareness.setLocalStateField("textresize", null);
    if (this.transformAttached.size) this.opts.awareness.setLocalStateField("groupresize", null);
    this.transformAttached = new Set();
    this.updateSelectionBar(); // resizing cleared → re-show the toolbar for the selected box
  };

  // ---- rotation (drag a corner rotate-zone to spin the box about its centre) ----
  private beginRotate(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation(); // a rotate drag is not a canvas marquee/move
    const id = this.resizeEl?.dataset.id;
    const m = id ? this.objects.get(id) : undefined;
    const obj = m ? readObject(m) : null;
    const el =
      id && obj?.type === "stroke" ? this.inkEls.get(id) : id ? this.els.get(id) : undefined;
    if (
      !id ||
      !el ||
      (obj?.type !== "text" &&
        obj?.type !== "stamp" &&
        obj?.type !== "stroke" &&
        obj?.type !== "image")
    )
      return;
    // Rotation centre: a stroke uses its world-AABB centre (mapped to screen); a div box uses its
    // rendered rect centre (rotation-invariant under CSS rotate-about-centre).
    let cx: number, cy: number;
    if (obj.type === "stroke") {
      const bb = this.inkBBox.get(id) ?? this.strokeWorldBBox(obj);
      const cam = this.opts.camera();
      cx = (bb.x + bb.width / 2) * cam.scale + cam.x;
      cy = (bb.y + bb.height / 2) * cam.scale + cam.y;
    } else {
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    }
    this.rotating = {
      id,
      cx,
      cy,
      startAngle: Math.atan2(e.clientY - cy, e.clientX - cx),
      startRotation: obj.type === "stroke" ? 0 : (obj.rotation ?? 0),
    };
    this.transformAttached = this.attachedStampsOf(new Set([id])); // stamps that glide with the host
    this.updateSelectionBar(); // hide the floating toolbar while rotating
    window.addEventListener("pointermove", this.onRotateMove);
    window.addEventListener("pointerup", this.onRotateUp);
  }

  private readonly onRotateMove = (e: PointerEvent): void => {
    const rs = this.rotating;
    if (!rs) return;
    this.publishCursorAt(e.clientX, e.clientY); // keep peers' view of my cursor on the handle
    const angle = Math.atan2(e.clientY - rs.cy, e.clientX - rs.cx);
    let deg = rs.startRotation + ((angle - rs.startAngle) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15; // Shift snaps to 15°
    deg = ((deg % 360) + 360) % 360;
    this.rotatePreview = { id: rs.id, rotation: deg };
    if (this.inkEls.has(rs.id)) {
      this.previewInkRotate(rs.id, deg); // a stroke svg rotates via a CSS matrix about its AABB centre
    } else {
      const el = this.els.get(rs.id);
      if (el) this.applyRotation(el, deg); // live: spin the box without a full re-render
    }
    if (this.resizeEl) this.applyRotation(this.resizeEl, deg); // the chrome box spins with it
    // Glide any attached stamps live about the host centre (rotation-invariant, so old/new share it).
    let stampNodes: ReturnType<typeof this.previewAttachedStamps> = [];
    if (this.transformAttached.size) {
      const box = this.boxGeomOf(rs.id);
      if (box) {
        const c = {
          cx: box.x + box.width / 2,
          cy: box.y + box.height / 2,
          w: box.width,
          h: box.height,
        };
        stampNodes = this.previewAttachedStamps(
          { ...c, rot: rs.startRotation },
          { ...c, rot: deg },
        );
      }
    }
    // Stream the live rotation to peers (throttled) — ephemeral; the doc commits on release.
    const now = Date.now();
    if (now - this.lastRotateSent >= EDIT_BROADCAST_MS) {
      this.lastRotateSent = now;
      this.opts.awareness.setLocalStateField("textrotate", { id: rs.id, rotation: deg });
      if (stampNodes.length)
        this.opts.awareness.setLocalStateField("groupresize", { nodes: stampNodes });
    }
  };

  private readonly onRotateUp = (): void => {
    const rs = this.rotating;
    this.rotating = null;
    window.removeEventListener("pointermove", this.onRotateMove);
    window.removeEventListener("pointerup", this.onRotateUp);
    if (!rs) return;
    const deg = this.rotatePreview?.rotation ?? rs.startRotation;
    this.rotatePreview = null;
    const m = this.objects.get(rs.id);
    const obj = m ? readObject(m) : null;
    if (obj?.type === "stroke") {
      // Strokes carry no rotation field — bake the angle into the points about the AABB centre.
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const bb = this.inkBBox.get(rs.id) ?? this.strokeWorldBBox(obj);
      const wcx = bb.x + bb.width / 2;
      const wcy = bb.y + bb.height / 2;
      const pts = obj.points.slice();
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const x = (pts[i] as number) - wcx;
        const y = (pts[i + 1] as number) - wcy;
        pts[i] = wcx + cos * x - sin * y;
        pts[i + 1] = wcy + sin * x + cos * y;
      }
      setObjectsPoints(this.opts.doc, [{ id: rs.id, points: pts }]);
    } else if (obj?.type === "stamp") setStampGeom(this.opts.doc, rs.id, { rotation: deg });
    else if (obj?.type === "image") {
      // An image spins about its centre like a text box, orbiting any attached stamps with it.
      const g = this.effectiveGeom(rs.id, obj);
      const sz = this.sizes.get(rs.id);
      const w = g.width ?? sz?.w ?? 0;
      const h = g.height ?? sz?.h ?? 0;
      const box = { cx: g.x + w / 2, cy: g.y + h / 2, w, h };
      this.opts.doc.transact(() => {
        setImageGeom(this.opts.doc, rs.id, { rotation: deg });
        this.transformAttachedStamps(
          rs.id,
          { ...box, rot: rs.startRotation },
          { ...box, rot: deg },
        );
      });
    } else if (obj?.type === "text") {
      // A text/sticky/shape host: commit its rotation AND orbit any attached stamps about its centre
      // (one transaction → one undo step). The centre is rotation-invariant, so old/new share it.
      const g = this.effectiveGeom(rs.id, obj);
      const sz = this.sizes.get(rs.id);
      const w = g.width ?? sz?.w ?? 0;
      const h = g.height ?? sz?.h ?? 0;
      const box = { cx: g.x + w / 2, cy: g.y + h / 2, w, h };
      this.opts.doc.transact(() => {
        setTextGeometry(this.opts.doc, rs.id, { rotation: deg }); // commit (syncs the final angle)…
        this.transformAttachedStamps(
          rs.id,
          { ...box, rot: rs.startRotation },
          { ...box, rot: deg },
        );
      });
    } else if (obj) setTextGeometry(this.opts.doc, rs.id, { rotation: deg }); // e.g. a connector
    this.opts.awareness.setLocalStateField("textrotate", null); // …then drop the live preview
    if (this.transformAttached.size) this.opts.awareness.setLocalStateField("groupresize", null);
    this.transformAttached = new Set();
    this.updateSelectionBar();
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
    const rotate = new Map<string, number>();
    for (const [cid, raw] of states) {
      if (cid === local) continue;
      const st = raw as {
        selection?: unknown;
        drag?: unknown;
        textresize?: unknown;
        textrotate?: unknown;
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
          // ink (strokes/connectors) live in inkEls, not els — include them so a peer's in-progress
          // move/resize/rotate of a stroke or connector glides live too (ADR-0009 Phase 3 Step 5).
          if (typeof id === "string" && this.objects.has(id)) drag.set(id, { dx, dy });
        }
      }
      const tr = st.textresize as
        | {
            id?: unknown;
            x?: unknown;
            y?: unknown;
            width?: unknown;
            height?: unknown;
            fontSize?: unknown;
          }
        | undefined;
      if (
        tr &&
        typeof tr.id === "string" &&
        this.objects.has(tr.id) &&
        typeof tr.x === "number" &&
        typeof tr.fontSize === "number"
      ) {
        const g: ResizeGeom = {
          x: tr.x,
          width: typeof tr.width === "number" ? tr.width : undefined,
          fontSize: tr.fontSize,
        };
        if (typeof tr.y === "number") g.y = tr.y; // shape resize carries y/height
        if (typeof tr.height === "number") g.height = tr.height;
        resize.set(tr.id, g);
      }
      const trot = st.textrotate as { id?: unknown; rotation?: unknown } | undefined;
      if (
        trot &&
        typeof trot.id === "string" &&
        this.objects.has(trot.id) &&
        typeof trot.rotation === "number"
      ) {
        rotate.set(trot.id, trot.rotation);
      }
      // A peer's in-progress GROUP transform (ADR-0009 P3 Step 4): one node per selected object,
      // each carrying its previewed box geom + rotation — fed into the same resize/rotate glide maps.
      const grp = (st as { groupresize?: { nodes?: unknown } }).groupresize;
      if (grp && Array.isArray(grp.nodes)) {
        for (const n of grp.nodes as Array<Record<string, unknown>>) {
          if (typeof n.id !== "string" || !this.objects.has(n.id)) continue;
          if (typeof n.x === "number" && typeof n.fontSize === "number") {
            const g: ResizeGeom = {
              x: n.x,
              width: typeof n.width === "number" ? n.width : undefined,
              fontSize: n.fontSize,
            };
            if (typeof n.y === "number") g.y = n.y;
            if (typeof n.height === "number") g.height = n.height;
            resize.set(n.id, g);
          }
          if (typeof n.rotation === "number") rotate.set(n.id, n.rotation);
        }
      }
    }
    // Idle fast-path: nothing remote now or before → skip the chrome/layout passes.
    if (
      !sel.size &&
      !drag.size &&
      !resize.size &&
      !rotate.size &&
      !this.remoteSelColor.size &&
      !this.remoteDrag.size &&
      !this.remoteResize.size &&
      !this.remoteRotate.size
    ) {
      return;
    }
    const selChanged = !sameColorMap(sel, this.remoteSelColor);
    const dragChanged = !sameDragMap(drag, this.remoteDrag);
    const resizeChanged = !sameResizeMap(resize, this.remoteResize);
    const rotateChanged = !sameNumMap(rotate, this.remoteRotate);
    // Boxes that gained or lost a remote rotation (computed from old+new before committing).
    const rotateAffected = rotateChanged
      ? new Set([...rotate.keys(), ...this.remoteRotate.keys()])
      : null;
    this.remoteSelColor = sel;
    this.remoteDrag = drag;
    this.remoteResize = resize;
    this.remoteRotate = rotate;
    // A peer's gesture can bring an object into a static viewport (my camera didn't move, so no
    // syncTransform): mount exempt objects now — after the gesture maps commit so `isExempt` sees them —
    // before the glide/relayout below reads their elements.
    if (dragChanged || resizeChanged || rotateChanged) this.recull();
    if (selChanged) this.refreshSelectionChrome();
    if (dragChanged || resizeChanged) this.ensureGlide(); // glide toward the new target
    // Peers' live rotation is applied straight to the box (no glide — 30 Hz is smooth enough).
    if (rotateAffected) {
      for (const id of rotateAffected) this.relayoutBox(id);
      this.updateResizeChrome();
    }
  }

  /** Re-lay-out every committed box at its effective (local or remote) drag offset. */
  private relayoutCommitted(): void {
    for (const [id, el] of this.els) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type === "stamp" || obj?.type === "image") {
        // A peer's in-progress move/resize of a stamp or image — effectiveGeom folds in the gliding
        // remoteDrag/remoteResize offset, so it tracks live on this screen too (not just on commit).
        const g = this.effectiveGeom(id, obj);
        this.layout(el, g.x, g.y, g.width, g.fontSize, "", "left", g.height);
        continue;
      }
      if (obj?.type !== "text") continue;
      const g = this.effectiveGeom(id, obj);
      // g.height must be passed, else a shape collapses to its text bounds during a peer's
      // drag/resize glide (the box loses its fixed height on the other user's screen).
      this.layout(el, g.x, g.y, g.width, g.fontSize, obj.fontFamily, obj.align, g.height);
    }
    // Glide ink (strokes/connectors) for a peer's in-progress move/resize — mirrors the local-move
    // CSS translate / previewInkResize. (A peer's rotate is applied via relayoutBox.) ADR-0009 P3 S5.
    const inkTouched = new Set<string>();
    const cam = this.opts.camera();
    for (const [id, dc] of this.remoteDragCurrent) {
      const svg = this.inkEls.get(id);
      const bb = this.inkBBox.get(id);
      if (!svg || !bb) continue;
      svg.style.left = `${bb.x * cam.scale + cam.x}px`;
      svg.style.top = `${bb.y * cam.scale + cam.y}px`;
      svg.style.transform = `translate(${dc.dx * cam.scale}px, ${dc.dy * cam.scale}px) scale(${cam.scale})`;
      inkTouched.add(id);
    }
    for (const [id, g] of this.remoteResizeCurrent) {
      if (inkTouched.has(id) || !this.inkEls.has(id)) continue;
      const bb = this.inkBBox.get(id);
      if (!bb) continue;
      this.previewInkResize(
        id,
        bb.width,
        bb.height,
        g.x,
        g.y ?? bb.y,
        g.width ?? bb.width,
        g.height ?? bb.height,
      );
      inkTouched.add(id);
    }
    // an ink object whose remote move/resize just ended → repaint at its committed geometry.
    for (const id of this.prevInkRemote) {
      if (inkTouched.has(id) || this.remoteRotate.has(id)) continue;
      const svg = this.inkEls.get(id);
      const o = this.objects.get(id);
      const obj = o ? readObject(o) : null;
      if (svg && obj?.type === "stroke") this.paintStroke(svg, obj);
      else if (svg && obj?.type === "connector") this.paintConnector(svg, obj);
    }
    this.prevInkRemote = inkTouched;
    this.updateConnectorDots(); // dots follow a peer's dragged/resized shape
    this.opts.onShapesMoved?.(); // re-route connectors during a peer's drag/resize glide
    this.rerouteBoundConnectors(); // …and re-paint the visible DOM connectors so they follow too
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
      const isInk = obj?.type === "stroke" || obj?.type === "connector";
      if (obj?.type !== "text" && obj?.type !== "stamp" && obj?.type !== "image" && !isInk) {
        this.remoteResizeCurrent.delete(id);
        continue;
      }
      const inkBB = isInk ? this.inkBBox.get(id) : undefined;
      // A stamp's committed start state is its box (centre−half-size → top-left, square size); ink's
      // is its world AABB (cached in inkBBox).
      const startGeom =
        obj.type === "stamp"
          ? {
              x: obj.x - obj.size / 2,
              y: obj.y - obj.size / 2,
              width: obj.size,
              height: obj.size,
              fontSize: obj.size,
            }
          : obj.type === "stroke" || obj.type === "connector"
            ? {
                x: inkBB?.x ?? 0,
                y: inkBB?.y ?? 0,
                width: inkBB?.width ?? 1,
                height: inkBB?.height ?? 1,
                fontSize: 0,
              }
            : {
                x: obj.x,
                y: obj.y,
                width: obj.width,
                height: obj.height,
                fontSize: obj.type === "text" ? obj.fontSize : 0, // images carry no font
              };
      const cur = this.remoteResizeCurrent.get(id) ?? startGeom;
      const nx = cur.x + (target.x - cur.x) * LERP;
      const nfs = cur.fontSize + (target.fontSize - cur.fontSize) * LERP;
      const lerpOpt = (c: number | undefined, t: number | undefined): number | undefined =>
        typeof c === "number" && typeof t === "number" ? c + (t - c) * LERP : t;
      const nw = lerpOpt(cur.width, target.width);
      const ny = lerpOpt(cur.y, target.y) ?? startGeom.y; // shape/stamp resize moves the top edge too
      const nh = lerpOpt(cur.height, target.height);
      const near = (a: number | undefined, b: number | undefined, e: number): boolean =>
        typeof a !== "number" || typeof b !== "number" || Math.abs(a - b) < e;
      const settled =
        Math.abs(target.x - nx) < 0.05 &&
        Math.abs(target.fontSize - nfs) < 0.05 &&
        near(target.width, nw, 0.5) &&
        near(target.y, ny, 0.05) &&
        near(target.height, nh, 0.5);
      this.remoteResizeCurrent.set(
        id,
        settled ? { ...target } : { x: nx, y: ny, width: nw, height: nh, fontSize: nfs },
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
      runs: elementToRuns(e.editable),
    };
    if (e.width != null) state.width = e.width;
    if (e.bg != null) state.bg = e.bg;
    if (e.shape != null) state.shape = e.shape;
    if (e.height != null) state.height = e.height;
    if (e.borderColor != null) state.borderColor = e.borderColor;
    if (e.borderStyle != null) state.borderStyle = e.borderStyle;
    if (e.rotation != null) state.rotation = e.rotation;
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
      if (typeof te.rotation === "number" && isFinite(te.rotation)) g.rotation = te.rotation;
      if (typeof te.borderColor === "string" && te.borderColor) g.borderColor = te.borderColor;
      if (te.borderStyle === "solid" || te.borderStyle === "dashed" || te.borderStyle === "none")
        g.borderStyle = te.borderStyle;
      let el = this.remoteEdits.get(cid);
      if (!el) {
        el = document.createElement("div");
        el.className = "komu-text komu-text-remote";
        this.root.appendChild(el);
        this.remoteEdits.set(cid, el);
      }
      el.innerHTML = runsToHtml(te.runs);
      el.style.color = INK;
      el.style.setProperty("--remote", typeof st.color === "string" ? st.color : "#4a9eff");
      // a peer's live shape/sticky shows its outline + fill (or paper colour + square)
      if (g.shape) this.applyShape(el, g.shape, g.bg, g.borderColor, g.borderStyle);
      else this.applySticky(el, g.bg);
      this.applyRotation(el, g.rotation ?? 0); // an edited ROTATED box must not flip upright for peers
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
  commit(keepTool = false): void {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    this.bar.hide();
    document.removeEventListener("selectionchange", this.onSelChange);
    if (this.editTimer !== null) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    const runs = elementToRuns(e.editable); // read the DOM before detaching it
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
            ...(e.borderColor != null ? { borderColor: e.borderColor } : {}),
            ...(e.borderStyle != null ? { borderStyle: e.borderStyle } : {}),
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
      if (e.borderColor != null) obj.borderColor = e.borderColor;
      if (e.borderStyle != null) obj.borderStyle = e.borderStyle;
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
    this.opts.onCommitted?.(keepTool); // let the canvas revert the text/sticky tool to select
  }

  destroy(): void {
    if (this.edit) this.commit();
    this.opts.awareness.off("change", this.onAwareness);
    this.objects.unobserveDeep(this.observer);
    orderArray(this.opts.doc).unobserve(this.orderObserver);
    this.objCache.clear();
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
