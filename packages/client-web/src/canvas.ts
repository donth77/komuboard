import Konva from "konva";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  addStroke,
  DEFAULT_SHAPE_FILL,
  DEFAULT_STICKY_COLOR,
  deleteObjects,
  objectsMap,
  orderArray,
  randomId,
  readObject,
  setObjectsPoints,
  translateObjects,
  type PresenceState,
  type ShapeKind,
  type StrokeObject,
  type StrokeStyle,
} from "@coboard/shared";
import { ViewportController } from "./viewport";
import { TextLayer } from "./text-layer";

export type ToolId = "select" | "hand" | "pen" | "text" | "sticky" | "shapes";

export interface CanvasOptions {
  container: HTMLElement;
  doc: Y.Doc;
  awareness: Awareness;
  user: PresenceState;
  /** Ask the host to switch tools (updates the dock highlight) — e.g. revert to select after a
   *  text/sticky box is placed + finished. */
  requestTool?: (tool: ToolId) => void;
}

const CURSOR_HZ = 30;
const LERP = 0.3;
// At/above this many strokes the board viewport-culls (hides off-screen nodes so a
// dense board only draws what's near the screen). Smaller boards draw everything —
// zero overhead, no behavior change. Tunable.
const CULL_MIN_OBJECTS = 1200;
// Off-screen pre-warm ring as a fraction of the viewport, so nothing pops at the edge.
const CULL_MARGIN = 0.25;
const SELECT_BLUE = "#4a9eff";
// Konva attr that tags a rendered node with its object id (the select tool's hit→id contract).
// One const so the writer (renderObjects) and reader (objIdOf) can't drift on a string literal.
const OBJ_ID_ATTR = "objId";
// FigJam-style arrow pointer (Lucide mouse-pointer-2): used for the local CSS cursor
// (black fill, white edge) AND remote presence cursors (filled in each user's colour).
const CURSOR_PATH =
  "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z";
const CURSOR_URL = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#1e1e1e" stroke="#ffffff" stroke-width="1.75" stroke-linejoin="round"><path d="${CURSOR_PATH}"/></svg>`,
)}") 4 4, auto`;
// Pen tool: a pen cursor matching the toolbar icon, hotspot at the writing tip (2,22).
const PEN_CURSOR_URL = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#ffffff" stroke="#1e1e1e" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
)}") 2 22, auto`;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** A *remote* peer's in-progress stroke, streamed over awareness while they draw. */
interface DrawState {
  id: string;
  points: number[];
  color: string;
  width: number;
  style: StrokeStyle;
  opacity: number;
}

/** One node's live transform (position + scale) in a *remote* peer's in-progress resize. */
interface ResizeNode {
  id: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

const MAX_PREVIEW_VERTS = 128; // cap broadcast live-stroke vertices (cost); the committed stroke is full-res
/** Stride a flat [x,y,…] list down to ≤ maxVerts vertices, always keeping the last (the pen tip). */
function downsamplePoints(pts: number[], maxVerts: number): number[] {
  const verts = pts.length >> 1;
  if (verts <= maxVerts) return pts;
  const stride = Math.ceil(verts / maxVerts);
  const out: number[] = [];
  for (let i = 0; i < verts; i += stride) out.push(pts[i * 2] as number, pts[i * 2 + 1] as number);
  const lx = pts[pts.length - 2] as number;
  const ly = pts[pts.length - 1] as number;
  if (out[out.length - 2] !== lx || out[out.length - 1] !== ly) out.push(lx, ly);
  return out;
}

/**
 * BoardCanvas — renders the room's Yjs document with Konva and drives M1
 * interaction: infinite pan/zoom (the dot grid tracks the camera), a freehand
 * pen (color/width/style/opacity) that writes strokes into the single shared
 * doc, live labeled cursors, and a FigJam-style **select** tool (marquee +
 * click select, a transform box with corner handles, drag-to-move and resize).
 */
export class BoardCanvas {
  private readonly stage: Konva.Stage;
  private readonly content = new Konva.Layer();
  private readonly overlay = new Konva.Layer();
  /** Top layer for selection chrome (marquee + transform box) — never wiped by renderObjects. */
  private readonly uiLayer = new Konva.Layer();
  private readonly transformer: Konva.Transformer;
  /** Light-blue per-node outlines drawn under the union transform box for multi-selections. */
  private readonly highlightGroup = new Konva.Group({ listening: false });
  private readonly objects: Y.Map<Y.Map<unknown>>;
  private readonly cursors = new Map<number, Konva.Group>();
  private readonly cursorTargets = new Map<number, { x: number; y: number }>();
  /** Remote cursors render in their own stage whose container sits ABOVE the HTML text overlay, so a
   *  cursor is never painted under a text box (all main-stage Konva layers live below the overlay).
   *  It mirrors the main camera transform (syncCursorStage) so world-space cursors still line up. */
  private cursorStage!: Konva.Stage;
  private readonly cursorLayer = new Konva.Layer({ listening: false });
  /** Colored outlines showing what each *remote* peer has selected (drawn in their cursor color). */
  private readonly remoteSelections = new Konva.Group({ listening: false });
  /** Outline rects reused across renders, keyed `clientId:objId` — avoids per-frame Konva churn
   *  while a peer's selection glides during an interpolated drag/resize. */
  private readonly remoteSelRects = new Map<string, Konva.Rect>();
  /** Live map of object id → its rendered Konva node (rebuilt every render). */
  private readonly nodeById = new Map<string, Konva.Line>();
  private readonly selected = new Set<string>();
  /** Local edit history (objects + z-order). Remote edits keep a different origin, so undo only reverts *your* changes. */
  private readonly undoManager: Y.UndoManager;
  /** Camera: owns the stage transform (pan/zoom), wheel, grid, and zoom readout. */
  private readonly viewport: ViewportController;
  /** HTML overlay that renders + edits text objects (kept out of the Konva scene). */
  private readonly textLayer: TextLayer;

  private tool: ToolId = "select";
  private color = "#0e1116";
  private stickyColor: string = DEFAULT_STICKY_COLOR;
  /** The shape/line kind the "Shapes and lines" tool draws next (driven by the shape menu). */
  private currentShape: ShapeKind = "rectangle";
  /** True while setTool is baking an open editor → suppresses the commit's auto-revert-to-select. */
  private suppressAutoSelect = false;
  private widthPx = 14;
  private style: StrokeStyle = "solid";
  private opacity = 1; // fixed default — the pen panel has no opacity control yet
  private drawing: { id: string; points: number[]; line: Konva.Line } | null = null;
  private marquee: Konva.Rect | null = null;
  private marqueeStart: { x: number; y: number } | null = null;
  private marqueeBase = new Set<string>();
  private marqueeAdditive = false;
  private moveState: { startX: number; startY: number; dx: number; dy: number } | null = null;
  /** A tap on an already-sole-selected text/sticky box → edit it on release (FigJam two-click:
   *  first click selects the box, second click enters its text). Cleared if the tap becomes a drag. */
  private textTapEdit: { id: string; x: number; y: number } | null = null;
  /** When/what text box was last freshly selected — the two-click edit only fires on a QUICK second
   *  click (within TWO_CLICK_MS), so a later click on a still-selected box re-selects, not edits. */
  private textSelectAt: { id: string; t: number } | null = null;
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  private lastCursorSent = 0;
  /** Throttle clocks for the live drag / resize broadcasts (ms). */
  private lastDragSent = 0;
  private lastResizeSent = 0;
  /** True while the local user is actively resizing via the transformer handles. */
  private resizing = false;
  /** Live transform (position + scale) showing a *remote* peer's in-progress drag or resize,
   *  per object id. A drag carries scale 1; a resize carries the scale too. */
  private readonly remoteXforms = new Map<
    string,
    { x: number; y: number; sx: number; sy: number }
  >();
  /** Ids whose remote drag/resize has already committed to the doc — guards against the
   *  (briefly) still-present awareness re-applying the transform on top of the baked geometry. */
  private readonly committedXforms = new Set<string>();
  /** Throttle clock for the live in-progress-stroke broadcast (ms). */
  private lastDrawSent = 0;
  /** Ephemeral preview lines for *remote* peers' in-progress strokes, keyed by stroke id. */
  private readonly remoteDraws = new Map<string, Konva.Line>();
  private readonly remoteDrawGroup = new Konva.Group({ listening: false });
  /** Last selection broadcast on awareness (sorted, joined) — skips republishing an unchanged set. */
  private lastPublishedSelection = "";
  /** Throttle clock for selection broadcasts during a live marquee drag (ms). */
  private lastSelectionSent = 0;
  /** Signature of the last-rendered remote selections — lets cursor-only awareness ticks skip the rebuild. */
  private lastRemoteSelKey = "";
  /** Union of remote peers' selected ids from the previous awareness tick — lets us spot an id a
   *  peer has *just* selected (last-writer-wins ownership; see yieldSelectionToPeers). */
  private prevRemoteSel = new Set<string>();
  /** Awareness listener kept as a field so destroy() can detach it (it fires after the stage is gone otherwise). */
  private readonly onAwarenessChange = (): void => {
    this.syncCursors();
    this.yieldSelectionToPeers(); // release any node a peer has just taken over (selected/dragged)…
    const xformsMoved = this.renderRemoteXforms(); // …then apply peers' live drags + resizes…
    this.renderRemoteSelections(xformsMoved); // …so force the outline rebuild when they do
    this.renderRemoteDraws(); // peers' in-progress strokes
  };
  /** Window listeners kept as fields so destroy() can detach them (else they leak / fire on a dead stage). */
  private readonly onWindowBlur = (): void => {
    this.opts.awareness.setLocalStateField("cursor", null);
  };
  private readonly onWindowPointerUp = (): void => {
    if (this.textLayer.isMoving()) this.textLayer.endMove();
    else if (this.moveState) this.endMove();
    else if (this.marquee) this.endMarquee();
    // Two-click: releasing a tap on an already-sole-selected box enters its text editor.
    if (this.textTapEdit) {
      const at = this.textTapEdit;
      this.textTapEdit = null;
      this.textLayer.editOrCreate(at, true); // edit with all text selected (FigJam-style)
    }
  };
  private resizeObserver: ResizeObserver | null = null;
  /** Cache of content-relative client rects per object id; cleared whenever geometry rebuilds. */
  private readonly rectCache = new Map<string, Rect>();
  /** Drawn object ids in z-order from the last render — a same-order change updates nodes in place. */
  private renderedOrder: string[] = [];
  /** World-space bbox per object id, for viewport culling (populated only on dense boards). */
  private readonly cullRects = new Map<string, Rect>();
  /** True while off-screen nodes are hidden — lets us restore them once if the board shrinks. */
  private culled = false;
  private raf = 0;
  private animating = false;
  private selectionListener: ((count: number) => void) | null = null;

  constructor(private readonly opts: CanvasOptions) {
    this.objects = objectsMap(opts.doc);
    // captureTimeout 0: each edit (one transaction) is its own undo step, so undo
    // pops one stroke/move/delete at a time instead of merging rapid edits.
    this.undoManager = new Y.UndoManager([this.objects, orderArray(opts.doc)], {
      captureTimeout: 0,
    });
    this.stage = new Konva.Stage({
      container: opts.container as HTMLDivElement,
      width: opts.container.clientWidth,
      height: opts.container.clientHeight,
    });
    this.stage.add(this.content);
    this.stage.add(this.overlay);
    this.stage.add(this.uiLayer);
    // Peers' selection outlines sit in the overlay, in world space (so they pan/zoom
    // with the board) and below the cursors (which are added to the overlay lazily). Peers'
    // in-progress strokes render below the outlines, like content.
    this.overlay.add(this.remoteDrawGroup);
    this.overlay.add(this.remoteSelections);

    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right"],
      borderStroke: SELECT_BLUE,
      borderStrokeWidth: 1.5,
      anchorStroke: SELECT_BLUE,
      anchorStrokeWidth: 1.5,
      anchorFill: "#ffffff",
      anchorSize: 9,
      anchorCornerRadius: 2,
      padding: 4,
      // Never let a resize collapse the box to nothing.
      boundBoxFunc: (oldBox, newBox) => (newBox.width < 6 || newBox.height < 6 ? oldBox : newBox),
    });
    this.transformer.on("transformstart", () => {
      this.resizing = true;
    });
    this.transformer.on("transform", () => {
      this.renderSelectionBoxes();
      // A transformer-anchor drag captures the pointer, so the stage's normal pointermove (which
      // publishes the cursor) doesn't fire — publish here too, else the resizer's cursor freezes
      // for peers. publishCursor self-throttles, so calling it every transform tick is fine.
      this.publishCursor(this.point());
      // Stream the live resize to peers (throttled). Ephemeral — commitTransform bakes it on end.
      const now = Date.now();
      if (now - this.lastResizeSent >= 1000 / CURSOR_HZ) {
        this.lastResizeSent = now;
        this.broadcastResize();
      }
    });
    this.transformer.on("transformend", () => {
      this.resizing = false;
      this.commitTransform(); // bake the scale into points (→ doc) first…
      this.opts.awareness.setLocalStateField("resize", null); // …then end the live preview
    });
    this.uiLayer.add(this.highlightGroup);
    this.uiLayer.add(this.transformer);

    // Camera owns the stage transform; re-sync our viewport-dependent chrome on any change.
    this.viewport = new ViewportController(this.stage, opts.container, () => {
      this.cull(); // re-cull for the new viewport before the redraw below
      this.scaleCursors();
      this.syncCursorStage(); // keep the cursor stage locked to the camera
      this.refreshTransformer();
      this.renderSelectionBoxes();
      this.renderRemoteSelections(true); // zoom changes screen-space geometry → force rebuild
      this.textLayer.syncTransform(); // keep HTML text boxes locked to the camera
    });
    // The text overlay positions HTML boxes in screen space from the live camera transform.
    this.textLayer = new TextLayer({
      container: opts.container,
      doc: opts.doc,
      awareness: opts.awareness,
      camera: () => ({ scale: this.stage.scaleX(), x: this.stage.x(), y: this.stage.y() }),
      onSelectionChange: () => {
        this.notifySelection(); // fold the text selection into the count…
        this.publishSelection(); // …and broadcast it so peers see the text outline
      },
      onCommitted: () => {
        // Finishing a box placed with the text/sticky/shapes tool reverts to select (one-shot).
        // Suppressed when the commit was triggered by an explicit tool switch (don't fight the user).
        if (this.suppressAutoSelect) return;
        if (this.tool === "text" || this.tool === "sticky" || this.tool === "shapes")
          this.opts.requestTool?.("select");
      },
    });

    // The cursor stage's container is appended AFTER the text overlay → cursors paint on top of text.
    const cursorContainer = document.createElement("div");
    cursorContainer.className = "cursor-layer";
    opts.container.appendChild(cursorContainer);
    this.cursorStage = new Konva.Stage({
      container: cursorContainer,
      width: this.stage.width(),
      height: this.stage.height(),
      listening: false,
    });
    this.cursorStage.add(this.cursorLayer);
    this.syncCursorStage();

    this.renderObjects();
    this.objects.observeDeep(() => this.renderObjects());

    this.bindPointer();
    // Hand-pan moves the viewport without a zoom transform, so re-cull + re-sync text on drag too.
    this.stage.on("dragmove", () => {
      this.cull();
      this.textLayer.syncTransform();
    });
    this.bindSelection();
    this.bindTouch();
    this.bindDragCursor();
    this.bindResize();
    this.bindAwareness();
    this.bindText();
    this.bindSticky();
    this.bindShapes();

    opts.awareness.setLocalStateField("user", opts.user.name);
    opts.awareness.setLocalStateField("color", opts.user.color);
    this.setTool("select");
    this.resetZoom(); // start at the default zoom (see resetZoom)
  }

  setTool(tool: ToolId): void {
    if (this.tool === "select" && tool !== "select") {
      this.clearSelection();
      this.cancelMarquee();
    }
    // Leaving a text-editing tool (text/sticky/shapes) bakes any open editor into the doc. The bake
    // must NOT trigger the commit's auto-revert-to-select (the user is explicitly choosing a tool).
    const editingTool = (t: ToolId): boolean => t === "text" || t === "sticky" || t === "shapes";
    if (editingTool(this.tool) && tool !== this.tool) {
      this.suppressAutoSelect = true;
      this.textLayer.commit();
      this.suppressAutoSelect = false;
    }
    if (tool !== "sticky") this.textLayer.hideStickyGhost(); // ghost only rides with the sticky tool
    this.tool = tool;
    this.stage.draggable(tool === "hand");
    this.stage.container().style.cursor =
      tool === "hand"
        ? "grab"
        : tool === "pen"
          ? PEN_CURSOR_URL
          : tool === "text"
            ? "text"
            : CURSOR_URL;
  }
  /** The colour the next dropped sticky note gets (driven by the sticky palette). */
  setStickyColor(color: string): void {
    this.stickyColor = color;
    this.textLayer.setStickyColor(color); // recolours the note currently being edited, too
  }
  /** The shape/line the "Shapes and lines" tool draws next (driven by the shape menu). */
  setShape(kind: ShapeKind): void {
    this.currentShape = kind;
  }
  setColor(color: string): void {
    this.color = color;
  }
  setWidth(width: number): void {
    this.widthPx = width;
  }
  setStyle(style: StrokeStyle): void {
    this.style = style;
  }

  // ---- zoom controls (delegated to the camera; driven by the bottom-left widget) ----
  setZoomListener(cb: (pct: number) => void): void {
    this.viewport.setZoomListener(cb);
  }
  getZoomPercent(): number {
    return this.viewport.getZoomPercent();
  }
  zoomBy(factor: number): void {
    this.viewport.zoomBy(factor);
  }
  zoomStep(dir: number): void {
    this.viewport.zoomStep(dir);
  }
  resetZoom(): void {
    this.viewport.resetZoom();
  }
  /** Set an absolute zoom (1 = 100%), clamped to the supported range. */
  zoomTo(scale: number): void {
    this.viewport.zoomTo(scale);
  }
  /** Frame all content in view (or reset when the board is empty). */
  zoomToFit(): void {
    this.viewport.zoomToFitBox(this.content.getClientRect({ skipTransform: true }));
  }

  private point(): { x: number; y: number } {
    const p = this.stage.getRelativePointerPosition();
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  }

  /** Content-relative client rect of an object's node, cached until renderObjects clears it. */
  private nodeRect(id: string, node: Konva.Line): Rect {
    let r = this.rectCache.get(id);
    if (!r) {
      r = node.getClientRect({ relativeTo: this.content });
      this.rectCache.set(id, r);
    }
    return r;
  }

  /** World-space bbox of a stroke straight from its points (+ stroke half-width).
      Visibility-independent (no getClientRect), so culling never depends on draw state. */
  private strokeBBox(obj: StrokeObject): Rect {
    const p = obj.points;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
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

  /**
   * Viewport culling — dense boards only (≥ CULL_MIN_OBJECTS). Hides Konva nodes whose
   * world bbox is outside the viewport expanded by a margin ring, so a big board only
   * *draws* what's near the screen. Selected nodes stay visible (the transform box needs
   * their bounds; off-screen nodes can't be clicked/marquee'd anyway). Sparse boards keep
   * everything visible — no overhead, no behavior change. Cheap (one AABB test per node)
   * and runs on every viewport change (zoom, pan) + render.
   */
  private cull(): void {
    if (this.nodeById.size < CULL_MIN_OBJECTS) {
      if (!this.culled) return; // sparse and nothing hidden → nothing to do
      for (const n of this.nodeById.values()) n.visible(true); // dropped below threshold → restore all
      this.culled = false;
      this.content.batchDraw();
      return;
    }
    this.culled = true;
    const v = this.viewport.worldViewport();
    const mx = v.width * CULL_MARGIN;
    const my = v.height * CULL_MARGIN;
    const view: Rect = {
      x: v.x - mx,
      y: v.y - my,
      width: v.width + mx * 2,
      height: v.height + my * 2,
    };
    for (const [id, node] of this.nodeById) {
      const r = this.cullRects.get(id);
      node.visible(this.selected.has(id) || !r || rectsIntersect(r, view));
    }
    this.content.batchDraw();
  }

  // ---- stroke styling (shared by stored strokes + the live preview) ----
  private lineConfig(
    color: string,
    width: number,
    style: StrokeStyle,
    opacity: number,
  ): Konva.LineConfig {
    // brush (highlight) and dash are independent: `highlight-dashed` is both at once.
    const highlight = style === "highlight" || style === "highlight-dashed";
    const dashed = style === "dashed" || style === "highlight-dashed";
    return {
      stroke: color,
      strokeWidth: highlight ? width * 1.6 : width,
      opacity: highlight ? Math.min(opacity, 0.4) : opacity,
      dash: dashed ? [Math.max(2, width * 2.5), Math.max(2, width * 2)] : [],
      lineCap: "round",
      lineJoin: "round",
      globalCompositeOperation: highlight ? "multiply" : "source-over",
      listening: false,
    };
  }

  private renderObjects(): void {
    this.rectCache.clear(); // geometry is about to change → drop cached client rects
    this.cullRects.clear();
    const order = orderArray(this.opts.doc).toArray();
    // Resolve the drawable strokes in z-order.
    const drawn: string[] = [];
    const objById = new Map<string, StrokeObject>();
    for (const id of order) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type === "stroke") {
        drawn.push(id);
        objById.set(id, obj);
      }
    }
    const dense = drawn.length >= CULL_MIN_OBJECTS; // compute cull bboxes only when culling is on
    // Fast path: same ids in the same z-order (a move/resize/no-op) → update the existing
    // Konva.Lines in place instead of destroying + recreating every node. Structural changes
    // (add / remove / reorder) fall back to a full rebuild.
    const sameOrder =
      drawn.length === this.renderedOrder.length &&
      drawn.every((id, i) => id === this.renderedOrder[i]);
    if (sameOrder) {
      for (const id of drawn) {
        const obj = objById.get(id);
        const line = this.nodeById.get(id);
        if (!obj || !line) continue;
        if (dense) this.cullRects.set(id, this.strokeBBox(obj));
        // A prior local drag/resize leaves a transform on the node; the doc stores baked
        // absolute coords, so clear the transform before re-applying geometry + style. If a
        // *remote* peer is mid drag/resize on this node, a changed head OR tail vertex means
        // their gesture just committed (a scale pins at most one vertex, so head+tail can't both
        // be unchanged) → drop the live transform. Unchanged = an unrelated edit landed mid-
        // gesture → keep the preview so it doesn't snap back.
        const xf = this.remoteXforms.get(id);
        const old = line.points();
        const np = obj.points;
        const committed =
          !!xf &&
          (old[0] !== np[0] ||
            old[1] !== np[1] ||
            old[old.length - 2] !== np[np.length - 2] ||
            old[old.length - 1] !== np[np.length - 1]);
        line.setAttrs(this.lineConfig(obj.color, obj.width, obj.style, obj.opacity));
        line.listening(true);
        line.points(np);
        line.hitStrokeWidth(Math.max(obj.width, 14));
        if (!xf || committed) {
          line.position({ x: 0, y: 0 });
          line.scale({ x: 1, y: 1 });
          if (xf) {
            this.remoteXforms.delete(id);
            this.committedXforms.add(id); // until the lagging awareness clears
          }
        }
        // else: an ongoing remote gesture — leave the rAF-interpolated transform in place
      }
    } else {
      this.content.destroyChildren();
      this.nodeById.clear();
      for (const id of drawn) {
        const obj = objById.get(id);
        if (!obj) continue;
        if (dense) this.cullRects.set(id, this.strokeBBox(obj));
        const line = new Konva.Line({
          points: obj.points,
          ...this.lineConfig(obj.color, obj.width, obj.style, obj.opacity),
        });
        // Make stored strokes selectable: hittable along their stroke + tagged with id.
        line.listening(true);
        line.hitStrokeWidth(Math.max(obj.width, 14));
        line.setAttr(OBJ_ID_ATTR, obj.id);
        this.content.add(line);
        this.nodeById.set(obj.id, line);
      }
      this.renderedOrder = drawn;
    }
    this.cull(); // hide off-screen nodes (dense boards) before the draw
    this.content.batchDraw();
    this.reattachTransformer();
    this.renderRemoteSelections(true); // objects moved/resized/deleted/added → force (geometry not in the cache key)
    this.pruneCommittedDraws(); // a peer's stroke just committed → drop its live preview (no double-draw)
  }

  /** Remove any remote-draw preview now backed by a committed node (clean draw→commit handoff). */
  private pruneCommittedDraws(): void {
    if (!this.remoteDraws.size) return;
    let pruned = false;
    for (const [id, line] of this.remoteDraws) {
      if (!this.nodeById.has(id)) continue;
      line.destroy();
      this.remoteDraws.delete(id);
      pruned = true;
    }
    if (pruned) this.overlay.batchDraw();
  }

  // ---- pen / drawing ----
  private bindPointer(): void {
    this.stage.on("pointerdown", () => {
      if (this.tool !== "pen") return;
      const p = this.point();
      const line = new Konva.Line({
        points: [p.x, p.y],
        ...this.lineConfig(this.color, this.widthPx, this.style, this.opacity),
      });
      this.content.add(line);
      this.drawing = { id: randomId("st"), points: [p.x, p.y], line };
    });

    this.stage.on("pointermove", () => {
      const p = this.point();
      this.publishCursor(p);
      if (this.tool === "sticky") this.textLayer.showStickyGhost(p, this.stickyColor); // placement preview
      if (this.tool === "text") {
        // I-beam over an existing text box (click to edit it); the default cursor over empty board.
        this.stage.container().style.cursor = this.textLayer.hitTest(p) ? "text" : CURSOR_URL;
      }
      if (!this.drawing) return;
      this.drawing.points.push(p.x, p.y);
      this.drawing.line.points(this.drawing.points);
      this.content.batchDraw();
      // Stream the in-progress stroke to peers (throttled like cursors). It's ephemeral —
      // addStroke commits the finished stroke on finish(), so no doc/undo churn mid-draw.
      const now = Date.now();
      if (now - this.lastDrawSent >= 1000 / CURSOR_HZ) {
        this.lastDrawSent = now;
        this.opts.awareness.setLocalStateField("draw", {
          id: this.drawing.id,
          points: downsamplePoints(this.drawing.points, MAX_PREVIEW_VERTS),
          color: this.color,
          width: this.widthPx,
          style: this.style,
          opacity: this.opacity,
        });
      }
    });

    const finish = (): void => {
      const d = this.drawing;
      this.drawing = null;
      if (!d) return;
      d.line.destroy(); // remove local preview; the doc observer re-adds it authoritatively
      if (d.points.length >= 4) {
        const stroke: StrokeObject = {
          id: d.id,
          type: "stroke",
          points: d.points,
          color: this.color,
          width: this.widthPx,
          style: this.style,
          opacity: this.opacity,
          authorId: String(this.opts.awareness.clientID),
        };
        addStroke(this.opts.doc, stroke); // commit first…
      } else {
        this.content.batchDraw();
      }
      this.opts.awareness.setLocalStateField("draw", null); // …then end the live preview
    };
    this.stage.on("pointerup", finish);
    this.stage.on("pointerleave", () => {
      finish();
      // A text resize drags an HTML handle sitting *over* the canvas, so the pointer "leaves" the
      // Konva content while still on the board — TextLayer keeps publishing the cursor there, so
      // clearing it here would make peers' cursor flicker (the cursor group is destroyed/recreated).
      if (this.textLayer.isResizing()) return;
      this.textLayer.hideStickyGhost(); // pointer left the board → drop the placement preview
      this.opts.awareness.setLocalStateField("cursor", null); // hide my cursor for peers
    });
    window.addEventListener("blur", this.onWindowBlur);
  }

  // ---- text + sticky (tap to place) ----
  /** Shared tap-to-place binding for the text + sticky tools. Movement is tracked across
   *  pointermove (reliable while the pointer is down) rather than from the pointerup position —
   *  on touch, getRelativePointerPosition() can be stale/null at touchend, which would otherwise
   *  turn every tap into a "drag" and silently drop the placement (the mobile bug). */
  private bindTapPlace(
    tool: ToolId,
    place: (at: { x: number; y: number }, client?: { x: number; y: number }) => void,
  ): void {
    let down: { x: number; y: number } | null = null;
    let client: { x: number; y: number } | null = null;
    let moved = false;
    this.stage.on("pointerdown", (e) => {
      if (this.tool !== tool) return;
      down = this.point();
      const ev = e.evt as PointerEvent; // viewport coords for caret-from-point on an edit
      client = { x: ev.clientX, y: ev.clientY };
      moved = false;
    });
    this.stage.on("pointermove", () => {
      if (this.tool !== tool || !down) return;
      const p = this.point();
      if (Math.hypot(p.x - down.x, p.y - down.y) > this.textLayer.tapSlop()) moved = true;
    });
    this.stage.on("pointerup", () => {
      if (this.tool !== tool || !down) return;
      const at = down;
      const c = client;
      const wasTap = !moved;
      down = null;
      client = null;
      if (wasTap) place(at, c ?? undefined); // drag-to-size a fixed-width box is a later increment
    });
  }

  private bindText(): void {
    this.bindTapPlace("text", (at, client) => this.textLayer.editOrCreate(at, false, client));
  }

  private bindSticky(): void {
    this.bindTapPlace("sticky", (at) => this.textLayer.stickyAt(at, this.stickyColor));
  }

  private bindShapes(): void {
    this.bindTapPlace("shapes", (at) =>
      this.textLayer.shapeAt(at, this.currentShape, DEFAULT_SHAPE_FILL),
    );
  }

  // ---- selection (FigJam-style: marquee + click select, move, resize) ----
  private bindSelection(): void {
    this.stage.on("pointerdown", (e) => {
      if (this.tool !== "select") return;
      if (this.isOnTransformer(e.target)) return; // a handle drag → let the transformer resize
      this.cancelMarquee(); // drop any marquee orphaned by a missed pointerup before starting fresh
      const shift = (e.evt as PointerEvent).shiftKey;
      // Text lives in the HTML overlay (not the Konva hit graph), so hit-test it first.
      const tid = this.textLayer.hitTest(this.point());
      if (tid) {
        // Two-click: a QUICK second tap on the already-sole-selected box edits it (fired on release
        // if it stayed a tap — a drag instead moves the box). A slow click just re-selects, so you
        // can always re-select a box you picked a while ago instead of dropping into its text.
        const p = this.point();
        const TWO_CLICK_MS = 700;
        const alreadySole =
          !shift &&
          this.selected.size === 0 &&
          this.textLayer.isSelected(tid) &&
          this.textLayer.selectedIds().length === 1;
        const recent =
          !!this.textSelectAt &&
          this.textSelectAt.id === tid &&
          Date.now() - this.textSelectAt.t < TWO_CLICK_MS;
        if (!shift) this.clearSelection(); // drop stroke selection (clearSelection also clears text)
        if (shift || !this.textLayer.isSelected(tid)) this.textLayer.selectText(tid, shift);
        this.textLayer.beginMove(this.point());
        const edit = alreadySole && recent;
        this.textTapEdit = edit ? { id: tid, x: p.x, y: p.y } : null;
        this.textSelectAt = edit ? null : { id: tid, t: Date.now() }; // record/restart the window
        return;
      }
      this.textTapEdit = null;
      this.textSelectAt = null;
      if (!shift) this.textLayer.clearSelection(); // clicking strokes/empty drops the text selection
      const id = this.objIdOf(e.target);
      if (id) {
        if (shift) {
          if (this.selected.has(id)) this.selected.delete(id);
          else this.selected.add(id);
          this.reattachTransformer();
          if (this.selected.has(id)) this.beginMove();
        } else {
          if (!this.selected.has(id)) this.setSelection([id]);
          this.beginMove();
        }
      } else {
        if (!shift) this.clearSelection();
        this.beginMarquee(shift);
      }
    });
    this.stage.on("pointermove", () => {
      if (this.textTapEdit) {
        const p = this.point();
        const d = Math.hypot(p.x - this.textTapEdit.x, p.y - this.textTapEdit.y);
        if (d > this.textLayer.tapSlop()) this.textTapEdit = null; // became a drag → move, don't edit
      }
      if (this.textLayer.isMoving()) this.textLayer.moveTo(this.point());
      else if (this.moveState) this.updateMove();
      else if (this.marquee) this.updateMarquee();
    });
    this.stage.on("pointerup", this.onWindowPointerUp);
    // A release that lands outside the stage still ends the gesture.
    window.addEventListener("pointerup", this.onWindowPointerUp);
    // (Editing is driven by the windowed two-click above — a quick second tap on a selected box —
    // which also covers native double-clicks, so no separate dblclick handler is needed.)
  }

  /** Walk up from a hit node to its owning object id (null for empty canvas). */
  private objIdOf(node: Konva.Node): string | null {
    let n: Konva.Node | null = node;
    while (n && n !== this.stage) {
      const id = n.getAttr(OBJ_ID_ATTR);
      if (typeof id === "string") return id;
      n = n.getParent();
    }
    return null;
  }

  private isOnTransformer(node: Konva.Node): boolean {
    let n: Konva.Node | null = node;
    while (n && n !== this.stage) {
      if (n === this.transformer) return true;
      n = n.getParent();
    }
    return false;
  }

  private setSelection(ids: string[]): void {
    this.selected.clear();
    for (const id of ids) if (this.nodeById.has(id)) this.selected.add(id);
    this.cull(); // keep selected (possibly off-screen) nodes visible so the transform box bounds them
    this.reattachTransformer();
  }
  clearSelection(): void {
    this.textLayer.clearSelection();
    if (!this.selected.size) return;
    this.selected.clear();
    this.cull(); // re-hide any off-screen nodes that were kept visible only because selected
    this.reattachTransformer();
  }
  /** Select every object on the board (⌘A). */
  selectAll(): void {
    this.setSelection([...this.nodeById.keys()]);
    this.textLayer.selectAll();
  }
  deleteSelection(): void {
    this.textLayer.deleteSelected();
    if (!this.selected.size) return;
    const ids = [...this.selected];
    this.selected.clear();
    deleteObjects(this.opts.doc, ids); // observer re-renders; reattach drops the gone ids
  }
  hasSelection(): boolean {
    return this.selected.size > 0 || this.textLayer.hasSelection();
  }
  /** Test/debug hook: how many remote-peer selection outlines are currently drawn. */
  remoteSelectionCount(): number {
    return this.remoteSelections.getChildren().length;
  }
  /** Test/debug hook: how many remote-peer in-progress stroke previews are currently drawn. */
  remoteDrawCount(): number {
    return this.remoteDraws.size;
  }
  /** Test/debug hook: the screen-space (container-relative) centre of a transformer anchor
   *  (e.g. "bottom-right"), or null if nothing is selected. */
  transformerAnchorPos(name: string): { x: number; y: number } | null {
    const anchor = this.transformer.findOne(`.${name}`);
    if (!anchor) return null;
    const r = anchor.getClientRect({ relativeTo: this.stage });
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  /** Test/debug hook: a rendered object's content-relative bounding rect (null if not drawn). */
  nodeContentRect(id: string): Rect | null {
    const node = this.nodeById.get(id);
    return node ? node.getClientRect({ relativeTo: this.content }) : null;
  }
  /** Test/debug hook: total object nodes vs. how many are currently drawn (viewport-culling check). */
  drawnNodeCount(): { total: number; visible: number } {
    let visible = 0;
    for (const node of this.nodeById.values()) if (node.visible()) visible++;
    return { total: this.nodeById.size, visible };
  }
  /** Undo / redo your own edits (remote edits are untracked, so they're never reverted). */
  undo(): void {
    this.undoManager.undo();
  }
  redo(): void {
    this.undoManager.redo();
  }
  setSelectionListener(cb: (count: number) => void): void {
    this.selectionListener = cb;
    this.notifySelection();
  }
  private notifySelection(): void {
    this.selectionListener?.(this.selected.size + this.textLayer.selectedCount());
  }

  /**
   * Broadcast my selected object ids on the awareness channel so peers can outline
   * them. Cleared to null when empty; skips the broadcast when the set is unchanged
   * (reattachTransformer runs on every render, including unrelated remote edits).
   */
  private publishSelection(): void {
    const ids = [...this.selected, ...this.textLayer.selectedIds()]; // strokes + text so peers outline both
    const key = ids.slice().sort().join(",");
    if (key === this.lastPublishedSelection) return;
    // A live marquee resolves the selection on every pointermove; cap that broadcast
    // rate (as we do for cursors). endMarquee clears this.marquee *before* its final
    // applyMarquee, so the settled selection always goes out immediately — peers converge
    // exactly, they just see fewer intermediate frames while the band is still moving.
    if (this.marquee) {
      const now = Date.now();
      if (now - this.lastSelectionSent < 1000 / CURSOR_HZ) return;
      this.lastSelectionSent = now;
    }
    this.lastPublishedSelection = key;
    this.opts.awareness.setLocalStateField("selection", ids.length ? ids : null);
  }

  /** Point the transformer at the currently-selected nodes (called after every render). */
  private reattachTransformer(): void {
    for (const id of [...this.selected]) if (!this.nodeById.has(id)) this.selected.delete(id);
    const nodes = [...this.selected]
      .map((id) => this.nodeById.get(id))
      .filter((n): n is Konva.Line => !!n);
    this.transformer.nodes(nodes);
    this.refreshTransformer();
    this.renderSelectionBoxes();
    this.notifySelection();
    this.publishSelection();
  }

  /**
   * Re-derive the transform box after a camera change. Konva draws the box border + handles
   * in screen space, so they keep a constant size at any zoom on their own — only the box's
   * position/size needs refreshing here. The chrome dimensions (anchorSize, padding, stroke
   * widths) are set once at construction; scaling them by 1/zoom was a double-compensation
   * that ballooned the box when zoomed far out.
   */
  private refreshTransformer(): void {
    this.transformer.forceUpdate();
  }

  // ---- move (drag the whole selection as one unit) ----
  private beginMove(): void {
    const p = this.point();
    this.moveState = { startX: p.x, startY: p.y, dx: 0, dy: 0 };
    this.stage.container().style.cursor = "move";
  }
  private updateMove(): void {
    if (!this.moveState) return;
    const p = this.point();
    this.moveState.dx = p.x - this.moveState.startX;
    this.moveState.dy = p.y - this.moveState.startY;
    for (const id of this.selected) {
      this.nodeById.get(id)?.position({ x: this.moveState.dx, y: this.moveState.dy });
    }
    this.transformer.forceUpdate();
    this.renderSelectionBoxes();
    this.content.batchDraw();
    // Stream the in-progress move to peers (throttled like cursors). The doc only commits
    // on release (endMove), so this preview is ephemeral — no undo/persistence churn.
    const now = Date.now();
    if (now - this.lastDragSent >= 1000 / CURSOR_HZ) {
      this.lastDragSent = now;
      this.opts.awareness.setLocalStateField("drag", {
        ids: [...this.selected],
        dx: this.moveState.dx,
        dy: this.moveState.dy,
      });
    }
  }
  private endMove(): void {
    const m = this.moveState;
    this.moveState = null;
    this.stage.container().style.cursor = this.tool === "select" ? CURSOR_URL : "grab";
    // Commit the move to the doc first (peers re-render at the baked coords), then stop the
    // live preview — this ordering lets the committed geometry land before the offset clears.
    if (m && (Math.abs(m.dx) >= 0.01 || Math.abs(m.dy) >= 0.01)) {
      translateObjects(this.opts.doc, [...this.selected], m.dx, m.dy);
    }
    this.opts.awareness.setLocalStateField("drag", null);
  }

  // ---- resize bake: fold the transformer's scale/translate into the points ----
  /** Broadcast each selected node's live transform (position + scale) so peers can mirror an
   *  in-progress resize. Cleared on transformend, where commitTransform bakes it into the doc. */
  private broadcastResize(): void {
    const nodes: ResizeNode[] = [];
    for (const id of this.selected) {
      const node = this.nodeById.get(id);
      if (!node) continue;
      nodes.push({ id, x: node.x(), y: node.y(), sx: node.scaleX(), sy: node.scaleY() });
    }
    this.opts.awareness.setLocalStateField("resize", nodes.length ? { nodes } : null);
  }

  private commitTransform(): void {
    const updates: { id: string; points: number[] }[] = [];
    for (const id of this.selected) {
      const node = this.nodeById.get(id);
      if (!node) continue;
      const tr = node.getTransform();
      const pts = node.points();
      const out: number[] = [];
      for (let i = 0; i < pts.length; i += 2) {
        const moved = tr.point({ x: pts[i] ?? 0, y: pts[i + 1] ?? 0 });
        out.push(moved.x, moved.y);
      }
      updates.push({ id, points: out });
    }
    if (updates.length) setObjectsPoints(this.opts.doc, updates); // → re-render at baked coords
  }

  // ---- marquee (rubber-band) selection — resolves live while you drag (FigJam-style) ----
  private beginMarquee(additive: boolean): void {
    const p = this.point();
    this.marqueeStart = p;
    this.marqueeBase = new Set(additive ? this.selected : []);
    this.marqueeAdditive = additive;
    this.marquee = new Konva.Rect({
      x: p.x,
      y: p.y,
      width: 0,
      height: 0,
      fill: "rgba(74, 158, 255, 0.12)",
      stroke: SELECT_BLUE,
      strokeWidth: this.viewport.screenPx(1),
      listening: false,
    });
    this.uiLayer.add(this.marquee);
    this.marquee.moveToBottom();
  }
  private updateMarquee(): void {
    if (!this.marquee || !this.marqueeStart) return;
    const p = this.point();
    const s = this.marqueeStart;
    const box: Rect = {
      x: Math.min(p.x, s.x),
      y: Math.min(p.y, s.y),
      width: Math.abs(p.x - s.x),
      height: Math.abs(p.y - s.y),
    };
    this.marquee.setAttrs(box);
    this.applyMarquee(box); // show the resulting selection live, before release
  }
  private endMarquee(): void {
    if (!this.marquee) return;
    const box: Rect = {
      x: this.marquee.x(),
      y: this.marquee.y(),
      width: this.marquee.width(),
      height: this.marquee.height(),
    };
    this.cancelMarquee();
    this.applyMarquee(box);
  }
  private applyMarquee(box: Rect): void {
    const hits = new Set(this.marqueeBase);
    if (box.width >= 2 || box.height >= 2) {
      for (const [id, node] of this.nodeById) {
        if (!node.visible()) continue; // culled (off-screen) → can't be inside an on-screen marquee
        if (rectsIntersect(box, this.nodeRect(id, node))) hits.add(id);
      }
    }
    this.setSelection([...hits]);
    this.textLayer.selectInBox(box, this.marqueeAdditive); // text isn't a Konva node — select it separately
  }
  private cancelMarquee(): void {
    this.marquee?.destroy();
    this.marquee = null;
    this.marqueeStart = null;
    this.uiLayer.batchDraw();
  }

  /** Light-blue per-node outlines for a multi-selection (the union gets the transform box). */
  private renderSelectionBoxes(): void {
    this.highlightGroup.destroyChildren();
    if (this.selected.size > 1) {
      const sw = this.viewport.screenPx(1.2);
      for (const id of this.selected) {
        const node = this.nodeById.get(id);
        if (!node) continue;
        const r = node.getClientRect({ relativeTo: this.content });
        this.highlightGroup.add(
          new Konva.Rect({
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            stroke: "#8fbcff",
            strokeWidth: sw,
            listening: false,
          }),
        );
      }
    }
    this.uiLayer.batchDraw();
  }

  /**
   * Outline every object each *remote* peer has selected, tinted to their cursor
   * color (FigJam-style presence). Drawn in world space relative to `content`, so the
   * boxes pan/zoom with the board; stroke width is kept a constant screen size.
   */
  private renderRemoteSelections(force = false): void {
    const self = this.opts.awareness.clientID;
    // Gather each peer's (color + selected ids) and a signature of the same. Cursor /
    // name awareness ticks don't change the signature, so those (frequent) changes skip
    // the rebuild. Geometry (move/resize/delete) and zoom aren't in the signature, so
    // those callers pass force=true; node membership only changes via renderObjects,
    // which is one of those forced callers — so the cached path stays correct.
    const peers: { clientId: number; color: string; ids: string[] }[] = [];
    const parts: string[] = [];
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const ids = state["selection"] as string[] | undefined;
      if (!ids?.length) return;
      const color = String(state["color"] ?? "#2563eb");
      peers.push({ clientId, color, ids });
      parts.push(`${clientId}:${color}:${ids.join(",")}`);
    });
    const key = parts.sort().join("|");
    if (!force && key === this.lastRemoteSelKey) return;
    this.lastRemoteSelKey = key;

    const inv = this.viewport.screenPx(1);
    const pad = 4 * inv;
    const seen = new Set<string>();
    // Reuse one rect per (peer, object): update attrs in place rather than destroy + recreate,
    // so the per-frame outline refresh during an interpolated remote drag/resize is allocation-free.
    for (const { clientId, color, ids } of peers) {
      for (const id of ids) {
        const node = this.nodeById.get(id);
        if (!node || !node.visible()) continue; // skip culled (off-screen) peers' selections
        const r = this.nodeRect(id, node);
        const rkey = `${clientId}:${id}`;
        seen.add(rkey);
        let rect = this.remoteSelRects.get(rkey);
        if (!rect) {
          rect = new Konva.Rect({ listening: false });
          this.remoteSelections.add(rect);
          this.remoteSelRects.set(rkey, rect);
        }
        rect.setAttrs({
          x: r.x - pad,
          y: r.y - pad,
          width: r.width + pad * 2,
          height: r.height + pad * 2,
          stroke: color,
          strokeWidth: 1.5 * inv,
          cornerRadius: 2 * inv,
        });
      }
    }
    // drop rects for selections that are gone (deselected, deleted, or culled off-screen)
    for (const [rkey, rect] of this.remoteSelRects) {
      if (seen.has(rkey)) continue;
      rect.destroy();
      this.remoteSelRects.delete(rkey);
    }
    this.overlay.batchDraw();
  }

  /**
   * Last-writer-wins selection ownership. A node can be the *active* selection of only one
   * peer at a time: when another user selects (or starts dragging) a node I currently have
   * selected, they've taken it over, so I drop it from my selection here. This implements
   * "a newer selection overrides an older one" and fixes the stale transform box that used to
   * linger at a node's old spot while a peer dragged it out from under my selection.
   *
   * Decided without cross-client clocks: an id that *just* entered some peer's selection this
   * tick (absent last tick) was selected after mine, so I yield it; an id a peer is actively
   * dragging is unconditionally theirs. My own in-progress gesture is never disturbed.
   */
  private yieldSelectionToPeers(): void {
    const self = this.opts.awareness.clientID;
    const remoteSel = new Set<string>();
    const dragging = new Set<string>();
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const ids = state["selection"] as string[] | undefined;
      if (ids) for (const id of ids) remoteSel.add(id);
      // a peer actively dragging OR resizing a node owns it → force-yield it below
      const drag = state["drag"] as { ids?: string[] } | undefined;
      if (drag?.ids) for (const id of drag.ids) dragging.add(id);
      const resize = state["resize"] as { nodes?: { id?: string }[] } | undefined;
      if (resize?.nodes) for (const n of resize.nodes) if (n?.id) dragging.add(n.id);
    });
    // Never disturb an in-progress local gesture (drag/marquee); just record remote state below.
    if (this.selected.size && !this.moveState && !this.marquee) {
      let changed = false;
      for (const id of [...this.selected]) {
        if (dragging.has(id) || (remoteSel.has(id) && !this.prevRemoteSel.has(id))) {
          this.selected.delete(id); // a peer took it over → release my transform box
          changed = true;
        }
      }
      if (changed) {
        this.cull(); // re-hide any off-screen node kept visible only because it was selected
        this.reattachTransformer(); // detach the box from the yielded nodes + rebroadcast my selection
      }
    }
    this.prevRemoteSel = remoteSel;
  }

  /**
   * Track every *remote* peer's in-progress drag AND resize: record their live transform (position
   * + scale) as a per-node interpolation target that the rAF loop glides toward, so moves/resizes
   * stream over awareness like cursors and the doc only commits on release. Returns true if a node
   * was snapped here (a cancelled gesture) so the caller refreshes outlines; ongoing gestures glide
   * in the loop, which refreshes outlines itself. Commit handoff is reconciled in renderObjects.
   */
  private renderRemoteXforms(): boolean {
    const self = this.opts.awareness.clientID;
    const next = new Map<string, { x: number; y: number; sx: number; sy: number }>();
    const active = new Set<string>(); // ids in any peer's drag/resize, committed or not
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      // drag: one shared offset across the moved ids
      const d = state["drag"] as { ids?: string[]; dx?: number; dy?: number } | undefined;
      if (d?.ids?.length) {
        const x = d.dx ?? 0;
        const y = d.dy ?? 0;
        for (const id of d.ids) {
          active.add(id);
          if (!this.committedXforms.has(id)) next.set(id, { x, y, sx: 1, sy: 1 });
        }
      }
      // resize: a per-node position + scale
      const r = state["resize"] as { nodes?: Partial<ResizeNode>[] } | undefined;
      if (r?.nodes?.length) {
        for (const n of r.nodes) {
          if (!n?.id) continue;
          active.add(n.id);
          if (!this.committedXforms.has(n.id)) {
            next.set(n.id, { x: n.x ?? 0, y: n.y ?? 0, sx: n.sx ?? 1, sy: n.sy ?? 1 });
          }
        }
      }
    });
    // release each commit guard once its peer's gesture awareness has fully cleared
    for (const id of this.committedXforms) if (!active.has(id)) this.committedXforms.delete(id);

    const localOwns = (id: string): boolean =>
      (this.moveState !== null || this.resizing) && this.selected.has(id);

    let changed = false;
    // reset nodes whose remote gesture ended without a doc commit (e.g. the peer cancelled)
    for (const id of [...this.remoteXforms.keys()]) {
      if (next.has(id)) continue;
      this.remoteXforms.delete(id);
      const node = this.nodeById.get(id);
      if (
        node &&
        (node.x() !== 0 || node.y() !== 0 || node.scaleX() !== 1 || node.scaleY() !== 1)
      ) {
        node.position({ x: 0, y: 0 });
        node.scale({ x: 1, y: 1 });
        this.rectCache.delete(id); // cached client rect is now stale → let the outline recompute
        changed = true;
      }
    }
    // record each peer's transform as the interpolation *target*; the rAF loop glides nodes
    // toward it (same LERP as cursors → the object stays glued under the peer's caret) rather
    // than snapping at the 30 Hz awareness rate, which looked stepped on fast gestures.
    for (const [id, xf] of next) {
      if (localOwns(id)) continue; // a local gesture owns this node
      if (this.nodeById.has(id)) this.remoteXforms.set(id, xf);
    }
    if (this.remoteXforms.size) this.ensureAnim();
    if (changed) this.content.batchDraw();
    return changed;
  }

  /**
   * Render every *remote* peer's in-progress stroke as an ephemeral preview so drawing streams
   * live (the doc only commits the finished stroke via addStroke). Previews are keyed by the
   * eventual stroke id and dropped the moment the committed node appears (here or in
   * renderObjects/pruneCommittedDraws) or the peer's draw awareness clears (e.g. cancel).
   */
  private renderRemoteDraws(): void {
    const self = this.opts.awareness.clientID;
    const active = new Set<string>();
    let changed = false;
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const d = state["draw"] as Partial<DrawState> | undefined;
      if (!d?.id || !d.points?.length) return;
      active.add(d.id);
      if (this.nodeById.has(d.id)) return; // already committed → the real node renders it
      let line = this.remoteDraws.get(d.id);
      if (!line) {
        line = new Konva.Line({ listening: false });
        this.remoteDrawGroup.add(line);
        this.remoteDraws.set(d.id, line);
      }
      line.setAttrs(
        this.lineConfig(d.color ?? "#000000", d.width ?? 4, d.style ?? "solid", d.opacity ?? 1),
      );
      line.points(d.points);
      changed = true;
    });
    // drop previews that committed (a node now exists) or ended (no longer broadcast)
    for (const [id, line] of this.remoteDraws) {
      if (active.has(id) && !this.nodeById.has(id)) continue;
      line.destroy();
      this.remoteDraws.delete(id);
      changed = true;
    }
    if (changed) this.overlay.batchDraw();
  }

  // ---- touch: pinch-to-zoom + two-finger pan (mobile) ----
  private bindTouch(): void {
    // Suppress the browser's own menus on the board (long-press context menu on mobile, right-click
    // on desktop) so they don't fight node selection — except inside an active text editor, where
    // the native edit menu (paste etc.) is still wanted.
    this.stage.container().addEventListener("contextmenu", (e) => {
      if (!(e.target as HTMLElement).closest?.(".co-text-editor")) e.preventDefault();
    });
    // On touch, a tap normally generates emulated mouse events (mousedown/up/click) afterwards.
    // With the text/sticky tools that emulated mousedown lands on the canvas and blurs the editor
    // we just opened + focused → it commits instantly (the "menu flicker" + text never sticks on
    // mobile). Cancelling the touch's default action suppresses the emulation; the Konva pointer
    // events (which place + focus the box) still fire, so placement keeps working.
    const placing = (): boolean =>
      this.tool === "text" || this.tool === "sticky" || this.tool === "shapes";
    this.stage.on("touchend", (e) => {
      if (placing()) e.evt.preventDefault();
    });
    this.stage.on("touchstart", (e) => {
      if (placing()) e.evt.preventDefault();
    });
    this.stage.on("touchmove", (e) => {
      const touches = (e.evt as TouchEvent).touches;
      if (!touches || touches.length < 2) return;
      e.evt.preventDefault();
      const a = touches[0];
      const b = touches[1];
      if (!a || !b) return;
      const rect = this.stage.container().getBoundingClientRect();
      const p1 = { x: a.clientX - rect.left, y: a.clientY - rect.top };
      const p2 = { x: b.clientX - rect.left, y: b.clientY - rect.top };
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      this.cancelGestures(); // a 2nd finger turns any draw/marquee/move into a pinch
      if (this.stage.isDragging()) this.stage.stopDrag();
      if (!this.pinch) {
        this.pinch = { dist, cx: center.x, cy: center.y };
        return;
      }
      const oldScale = this.viewport.scale();
      const newScale = this.viewport.clamp(oldScale * (dist / this.pinch.dist));
      // The canvas point under the previous pinch centre is pinned to the new centre,
      // which folds zoom + two-finger pan into one transform.
      const cx = (this.pinch.cx - this.stage.x()) / oldScale;
      const cy = (this.pinch.cy - this.stage.y()) / oldScale;
      this.pinch = { dist, cx: center.x, cy: center.y };
      this.viewport.applyTransform(newScale, {
        x: center.x - cx * newScale,
        y: center.y - cy * newScale,
      });
    });
    const end = (e: Konva.KonvaEventObject<TouchEvent>): void => {
      if (((e.evt as TouchEvent).touches?.length ?? 0) < 2) this.pinch = null;
    };
    this.stage.on("touchend", end);
    this.stage.on("touchcancel", end);
  }

  /** Abort any in-progress single-pointer gesture (used when a pinch begins). */
  private cancelGestures(): void {
    if (this.drawing) {
      this.drawing.line.destroy();
      this.drawing = null;
      this.opts.awareness.setLocalStateField("draw", null); // cancelled → stop the live preview
      this.content.batchDraw();
    }
    if (this.marquee) this.cancelMarquee();
    if (this.moveState) {
      for (const id of this.selected) this.nodeById.get(id)?.position({ x: 0, y: 0 });
      this.moveState = null;
      this.opts.awareness.setLocalStateField("drag", null); // cancelled → stop the live preview
      this.transformer.forceUpdate();
      this.content.batchDraw();
    }
    if (this.resizing) {
      this.resizing = false;
      this.opts.awareness.setLocalStateField("resize", null); // cancelled → stop the live preview
    }
  }

  // ---- hand-pan cursor (wheel-zoom + grid tracking live in ViewportController) ----
  private bindDragCursor(): void {
    // Grab → grabbing while the hand tool is actively dragging.
    this.stage.on("dragstart", () => {
      if (this.tool === "hand") this.stage.container().style.cursor = "grabbing";
    });
    this.stage.on("dragend", () => {
      if (this.tool === "hand") this.stage.container().style.cursor = "grab";
    });
  }

  private bindResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.viewport.resize();
      this.syncCursorStage();
    });
    this.resizeObserver.observe(this.opts.container);
  }

  // ---- presence / cursors ----
  private publishCursor(p: { x: number; y: number }): void {
    const now = Date.now();
    if (now - this.lastCursorSent < 1000 / CURSOR_HZ) return;
    this.lastCursorSent = now;
    this.opts.awareness.setLocalStateField("cursor", { x: p.x, y: p.y });
  }

  private bindAwareness(): void {
    this.opts.awareness.on("change", this.onAwarenessChange);
    this.onAwarenessChange();
  }

  private syncCursors(): void {
    const self = this.opts.awareness.clientID;
    const seen = new Set<number>();
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const cursor = state["cursor"] as { x: number; y: number } | undefined;
      if (!cursor) return;
      seen.add(clientId);
      let group = this.cursors.get(clientId);
      if (!group) {
        group = this.buildCursor(
          String(state["color"] ?? "#2563eb"),
          String(state["user"] ?? "Guest"),
        );
        group.position(cursor);
        group.scale({ x: this.viewport.screenPx(1), y: this.viewport.screenPx(1) });
        this.cursors.set(clientId, group);
        this.cursorLayer.add(group);
      }
      this.cursorTargets.set(clientId, cursor);
    });
    for (const [clientId, group] of this.cursors) {
      if (!seen.has(clientId)) {
        group.destroy();
        this.cursors.delete(clientId);
        this.cursorTargets.delete(clientId);
      }
    }
    this.cursorLayer.batchDraw();
    this.ensureAnim();
  }

  private buildCursor(color: string, name: string): Konva.Group {
    const group = new Konva.Group({ listening: false });
    // Matches the design-mockup cursor: a filled pointer caret with a white edge.
    group.add(
      new Konva.Path({
        data: CURSOR_PATH,
        fill: color,
        stroke: "#fff",
        strokeWidth: 1.5,
        lineJoin: "round",
        shadowColor: "rgba(0,0,0,0.25)",
        shadowBlur: 3,
        shadowOffsetY: 1,
      }),
    );
    const label = new Konva.Label({ x: 16, y: 18 });
    label.add(new Konva.Tag({ fill: color, cornerRadius: 9 }));
    label.add(
      new Konva.Text({ text: name, fill: "#fff", fontSize: 12, padding: 5, fontStyle: "600" }),
    );
    group.add(label);
    return group;
  }

  /** Keep cursors a constant screen size regardless of zoom. */
  private scaleCursors(): void {
    const inv = this.viewport.screenPx(1);
    this.cursors.forEach((g) => g.scale({ x: inv, y: inv }));
  }

  /** Mirror the main camera transform + size onto the cursor stage so its world-space cursors line
   *  up exactly with the board, then redraw. (The cursor stage sits above the HTML text overlay.) */
  private syncCursorStage(): void {
    this.cursorStage.scale({ x: this.stage.scaleX(), y: this.stage.scaleY() });
    this.cursorStage.position(this.stage.position());
    this.cursorStage.size({ width: this.stage.width(), height: this.stage.height() });
    this.cursorLayer.batchDraw();
  }

  /**
   * Glide remote cursors AND remote-dragged/resized objects toward their latest reported targets
   * (same LERP, so a dragged object stays glued under the peer's caret instead of stepping at the
   * 30 Hz awareness rate). The rAF loop runs ONLY while something is actually moving, then stops —
   * no idle cost. Objects' outlines are refreshed in-loop so they track the gliding nodes.
   */
  private ensureAnim(): void {
    if (this.animating) return;
    this.animating = true;
    const step = (): void => {
      let moving = false;
      // remote cursors
      this.cursors.forEach((group, id) => {
        const t = this.cursorTargets.get(id);
        if (!t) return;
        const p = group.position();
        const dx = t.x - p.x;
        const dy = t.y - p.y;
        if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
          group.position(t);
          return;
        }
        group.position({ x: p.x + dx * LERP, y: p.y + dy * LERP });
        moving = true;
      });
      // remote-dragged / resized objects (position + scale)
      let contentMoved = false;
      this.remoteXforms.forEach((tf, id) => {
        const node = this.nodeById.get(id);
        if (!node) return;
        const x = node.x();
        const y = node.y();
        const sx = node.scaleX();
        const sy = node.scaleY();
        const dx = tf.x - x;
        const dy = tf.y - y;
        const dsx = tf.sx - sx;
        const dsy = tf.sy - sy;
        if (
          Math.abs(dx) < 0.05 &&
          Math.abs(dy) < 0.05 &&
          Math.abs(dsx) < 0.0005 &&
          Math.abs(dsy) < 0.0005
        ) {
          if (x !== tf.x || y !== tf.y || sx !== tf.sx || sy !== tf.sy) {
            node.position({ x: tf.x, y: tf.y });
            node.scale({ x: tf.sx, y: tf.sy });
            this.rectCache.delete(id);
            contentMoved = true;
          }
          return;
        }
        node.position({ x: x + dx * LERP, y: y + dy * LERP });
        node.scale({ x: sx + dsx * LERP, y: sy + dsy * LERP });
        this.rectCache.delete(id);
        moving = true;
        contentMoved = true;
      });
      if (contentMoved) {
        this.content.batchDraw();
        this.renderRemoteSelections(true); // keep peers' outlines glued to the gliding nodes
      }
      this.cursorLayer.batchDraw(); // cursors glided this frame (their own top stage)
      this.overlay.batchDraw();
      if (moving) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.animating = false;
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  destroy(): void {
    this.textLayer.destroy();
    cancelAnimationFrame(this.raf);
    this.viewport.stopZoomAnim(); // stop any in-flight zoom-step rAF before the stage is gone
    this.opts.awareness.off("change", this.onAwarenessChange);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("pointerup", this.onWindowPointerUp);
    this.resizeObserver?.disconnect();
    const cursorContainer = this.cursorStage.container();
    this.cursorStage.destroy();
    cursorContainer.remove();
    this.stage.destroy();
  }
}
