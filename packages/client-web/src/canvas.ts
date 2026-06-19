import Konva from "konva";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  addStroke,
  deleteObjects,
  objectsMap,
  orderArray,
  randomId,
  readObject,
  setObjectsPoints,
  translateObjects,
  type PresenceState,
  type StrokeObject,
  type StrokeStyle,
} from "@coboard/shared";

export type ToolId = "select" | "hand" | "pen";

export interface CanvasOptions {
  container: HTMLElement;
  doc: Y.Doc;
  awareness: Awareness;
  user: PresenceState;
}

const CURSOR_HZ = 30;
const LERP = 0.3;
const GRID = 24;
const SELECT_BLUE = "#4a9eff";
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
  /** Colored outlines showing what each *remote* peer has selected (drawn in their cursor color). */
  private readonly remoteSelections = new Konva.Group({ listening: false });
  /** Live map of object id → its rendered Konva node (rebuilt every render). */
  private readonly nodeById = new Map<string, Konva.Line>();
  private readonly selected = new Set<string>();
  /** Local edit history (objects + z-order). Remote edits keep a different origin, so undo only reverts *your* changes. */
  private readonly undoManager: Y.UndoManager;

  private tool: ToolId = "select";
  private color = "#0e1116";
  private widthPx = 4;
  private style: StrokeStyle = "solid";
  private opacity = 1;
  private drawing: { id: string; points: number[]; line: Konva.Line } | null = null;
  private marquee: Konva.Rect | null = null;
  private marqueeStart: { x: number; y: number } | null = null;
  private marqueeBase = new Set<string>();
  private moveState: { startX: number; startY: number; dx: number; dy: number } | null = null;
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  private lastCursorSent = 0;
  /** Last selection broadcast on awareness (sorted, joined) — skips republishing an unchanged set. */
  private lastPublishedSelection = "";
  /** Throttle clock for selection broadcasts during a live marquee drag (ms). */
  private lastSelectionSent = 0;
  /** Signature of the last-rendered remote selections — lets cursor-only awareness ticks skip the rebuild. */
  private lastRemoteSelKey = "";
  /** Awareness listener kept as a field so destroy() can detach it (it fires after the stage is gone otherwise). */
  private readonly onAwarenessChange = (): void => {
    this.syncCursors();
    this.renderRemoteSelections();
  };
  /** Window listeners kept as fields so destroy() can detach them (else they leak / fire on a dead stage). */
  private readonly onWindowBlur = (): void => {
    this.opts.awareness.setLocalStateField("cursor", null);
  };
  private readonly onWindowPointerUp = (): void => {
    if (this.moveState) this.endMove();
    else if (this.marquee) this.endMarquee();
  };
  private resizeObserver: ResizeObserver | null = null;
  /** Cache of content-relative client rects per object id; cleared whenever geometry rebuilds. */
  private readonly rectCache = new Map<string, Rect>();
  /** Drawn object ids in z-order from the last render — a same-order change updates nodes in place. */
  private renderedOrder: string[] = [];
  private raf = 0;
  private animating = false;
  private zoomListener: ((pct: number) => void) | null = null;
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
    // with the board) and below the cursors (which are added to the overlay lazily).
    this.overlay.add(this.remoteSelections);

    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right"],
      borderStroke: SELECT_BLUE,
      borderStrokeWidth: 1.5,
      anchorStroke: SELECT_BLUE,
      anchorFill: "#ffffff",
      anchorSize: 9,
      anchorCornerRadius: 2,
      padding: 4,
      // Never let a resize collapse the box to nothing.
      boundBoxFunc: (oldBox, newBox) => (newBox.width < 6 || newBox.height < 6 ? oldBox : newBox),
    });
    this.transformer.on("transformend", () => this.commitTransform());
    this.transformer.on("transform", () => this.renderSelectionBoxes());
    this.uiLayer.add(this.highlightGroup);
    this.uiLayer.add(this.transformer);

    this.renderObjects();
    this.objects.observeDeep(() => this.renderObjects());

    this.bindPointer();
    this.bindSelection();
    this.bindTouch();
    this.bindWheelZoom();
    this.bindResize();
    this.bindAwareness();
    this.syncGrid();

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
    this.tool = tool;
    this.stage.draggable(tool === "hand");
    this.stage.container().style.cursor =
      tool === "hand" ? "grab" : tool === "pen" ? PEN_CURSOR_URL : CURSOR_URL;
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
  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  // ---- zoom controls (driven by the bottom-left widget) ----
  setZoomListener(cb: (pct: number) => void): void {
    this.zoomListener = cb;
    this.notifyZoom();
  }
  getZoomPercent(): number {
    return Math.round(this.stage.scaleX() * 100);
  }
  private notifyZoom(): void {
    this.zoomListener?.(Math.round(this.stage.scaleX() * 100));
  }
  private afterTransform(): void {
    this.scaleCursors();
    this.styleTransformerForZoom();
    this.renderSelectionBoxes();
    this.renderRemoteSelections(true); // zoom changed the geometry → force a rebuild (not in the cache key)
    this.syncGrid();
    this.stage.batchDraw();
    this.notifyZoom();
  }
  private zoomAroundCenter(newScale: number): void {
    const old = this.stage.scaleX();
    const cx = this.stage.width() / 2;
    const cy = this.stage.height() / 2;
    const origin = { x: (cx - this.stage.x()) / old, y: (cy - this.stage.y()) / old };
    this.stage.scale({ x: newScale, y: newScale });
    this.stage.position({ x: cx - origin.x * newScale, y: cy - origin.y * newScale });
    this.afterTransform();
  }
  zoomBy(factor: number): void {
    this.zoomAroundCenter(Math.min(8, Math.max(0.1, this.stage.scaleX() * factor)));
  }
  resetZoom(): void {
    this.zoomAroundCenter(0.5); // default zoom: 50%
  }
  /** Set an absolute zoom (1 = 100%), clamped to the supported range. */
  zoomTo(scale: number): void {
    this.zoomAroundCenter(Math.min(8, Math.max(0.1, scale)));
  }
  /** Frame all content in view (or reset when the board is empty). */
  zoomToFit(): void {
    const box = this.content.getClientRect({ skipTransform: true });
    if (!box.width || !box.height) {
      this.resetZoom();
      return;
    }
    const pad = 96;
    const sw = this.stage.width();
    const sh = this.stage.height();
    const scale = Math.min(
      8,
      Math.max(0.1, Math.min((sw - pad) / box.width, (sh - pad) / box.height)),
    );
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({
      x: (sw - box.width * scale) / 2 - box.x * scale,
      y: (sh - box.height * scale) / 2 - box.y * scale,
    });
    this.afterTransform();
  }

  /** Keep the CSS dot grid locked to the camera (it pans + scales with zoom). */
  private syncGrid(): void {
    const size = GRID * this.stage.scaleX();
    const c = this.opts.container;
    c.style.backgroundSize = `${size}px ${size}px`;
    c.style.backgroundPosition = `${this.stage.x()}px ${this.stage.y()}px`;
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

  // ---- stroke styling (shared by stored strokes + the live preview) ----
  private lineConfig(
    color: string,
    width: number,
    style: StrokeStyle,
    opacity: number,
  ): Konva.LineConfig {
    const highlight = style === "highlight";
    return {
      stroke: color,
      strokeWidth: highlight ? width * 1.6 : width,
      opacity: highlight ? Math.min(opacity, 0.4) : opacity,
      dash: style === "dashed" ? [Math.max(2, width * 2.5), Math.max(2, width * 2)] : [],
      lineCap: "round",
      lineJoin: "round",
      globalCompositeOperation: highlight ? "multiply" : "source-over",
      listening: false,
    };
  }

  private renderObjects(): void {
    this.rectCache.clear(); // geometry is about to change → drop cached client rects
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
        // A prior local drag/resize leaves a transform on the node; the doc stores baked
        // absolute coords, so clear the transform before re-applying geometry + style.
        line.position({ x: 0, y: 0 });
        line.scale({ x: 1, y: 1 });
        line.setAttrs(this.lineConfig(obj.color, obj.width, obj.style, obj.opacity));
        line.listening(true);
        line.points(obj.points);
        line.hitStrokeWidth(Math.max(obj.width, 14));
      }
    } else {
      this.content.destroyChildren();
      this.nodeById.clear();
      for (const id of drawn) {
        const obj = objById.get(id);
        if (!obj) continue;
        const line = new Konva.Line({
          points: obj.points,
          ...this.lineConfig(obj.color, obj.width, obj.style, obj.opacity),
        });
        // Make stored strokes selectable: hittable along their stroke + tagged with id.
        line.listening(true);
        line.hitStrokeWidth(Math.max(obj.width, 14));
        line.name("obj");
        line.setAttr("objId", obj.id);
        this.content.add(line);
        this.nodeById.set(obj.id, line);
      }
      this.renderedOrder = drawn;
    }
    this.content.batchDraw();
    this.reattachTransformer();
    this.renderRemoteSelections(true); // objects moved/resized/deleted/added → force (geometry not in the cache key)
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
      if (!this.drawing) return;
      this.drawing.points.push(p.x, p.y);
      this.drawing.line.points(this.drawing.points);
      this.content.batchDraw();
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
        addStroke(this.opts.doc, stroke);
      } else {
        this.content.batchDraw();
      }
    };
    this.stage.on("pointerup", finish);
    this.stage.on("pointerleave", () => {
      finish();
      this.opts.awareness.setLocalStateField("cursor", null); // hide my cursor for peers
    });
    window.addEventListener("blur", this.onWindowBlur);
  }

  // ---- selection (FigJam-style: marquee + click select, move, resize) ----
  private bindSelection(): void {
    this.stage.on("pointerdown", (e) => {
      if (this.tool !== "select") return;
      if (this.isOnTransformer(e.target)) return; // a handle drag → let the transformer resize
      this.cancelMarquee(); // drop any marquee orphaned by a missed pointerup before starting fresh
      const shift = (e.evt as PointerEvent).shiftKey;
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
      if (this.moveState) this.updateMove();
      else if (this.marquee) this.updateMarquee();
    });
    this.stage.on("pointerup", this.onWindowPointerUp);
    // A release that lands outside the stage still ends the gesture.
    window.addEventListener("pointerup", this.onWindowPointerUp);
  }

  /** Walk up from a hit node to its owning object id (null for empty canvas). */
  private objIdOf(node: Konva.Node): string | null {
    let n: Konva.Node | null = node;
    while (n && n !== this.stage) {
      const id = n.getAttr("objId");
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
    this.reattachTransformer();
  }
  clearSelection(): void {
    if (!this.selected.size) return;
    this.selected.clear();
    this.reattachTransformer();
  }
  /** Select every object on the board (⌘A). */
  selectAll(): void {
    this.setSelection([...this.nodeById.keys()]);
  }
  deleteSelection(): void {
    if (!this.selected.size) return;
    const ids = [...this.selected];
    this.selected.clear();
    deleteObjects(this.opts.doc, ids); // observer re-renders; reattach drops the gone ids
  }
  hasSelection(): boolean {
    return this.selected.size > 0;
  }
  /** Test/debug hook: how many remote-peer selection outlines are currently drawn. */
  remoteSelectionCount(): number {
    return this.remoteSelections.getChildren().length;
  }
  /** Test/debug hook: a rendered object's content-relative bounding rect (null if not drawn). */
  nodeContentRect(id: string): Rect | null {
    const node = this.nodeById.get(id);
    return node ? node.getClientRect({ relativeTo: this.content }) : null;
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
    this.selectionListener?.(this.selected.size);
  }

  /**
   * Broadcast my selected object ids on the awareness channel so peers can outline
   * them. Cleared to null when empty; skips the broadcast when the set is unchanged
   * (reattachTransformer runs on every render, including unrelated remote edits).
   */
  private publishSelection(): void {
    const ids = [...this.selected];
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
    this.styleTransformerForZoom();
    this.renderSelectionBoxes();
    this.notifySelection();
    this.publishSelection();
  }

  /** Keep the transform box border + handles a constant screen size at any zoom. */
  private styleTransformerForZoom(): void {
    const inv = 1 / this.stage.scaleX();
    this.transformer.anchorSize(9 * inv);
    this.transformer.borderStrokeWidth(1.5 * inv);
    this.transformer.anchorStrokeWidth(1.5 * inv);
    this.transformer.padding(4 * inv);
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
  }
  private endMove(): void {
    const m = this.moveState;
    this.moveState = null;
    this.stage.container().style.cursor = this.tool === "select" ? CURSOR_URL : "grab";
    if (!m) return;
    if (Math.abs(m.dx) < 0.01 && Math.abs(m.dy) < 0.01) return; // a click, not a drag
    translateObjects(this.opts.doc, [...this.selected], m.dx, m.dy); // → re-render at new coords
  }

  // ---- resize bake: fold the transformer's scale/translate into the points ----
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
    this.marquee = new Konva.Rect({
      x: p.x,
      y: p.y,
      width: 0,
      height: 0,
      fill: "rgba(74, 158, 255, 0.12)",
      stroke: SELECT_BLUE,
      strokeWidth: 1 / this.stage.scaleX(),
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
        if (rectsIntersect(box, this.nodeRect(id, node))) hits.add(id);
      }
    }
    this.setSelection([...hits]);
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
      const sw = 1.2 / this.stage.scaleX();
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
    const peers: { color: string; ids: string[] }[] = [];
    const parts: string[] = [];
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const ids = state["selection"] as string[] | undefined;
      if (!ids?.length) return;
      const color = String(state["color"] ?? "#2563eb");
      peers.push({ color, ids });
      parts.push(`${clientId}:${color}:${ids.join(",")}`);
    });
    const key = parts.sort().join("|");
    if (!force && key === this.lastRemoteSelKey) return;
    this.lastRemoteSelKey = key;

    this.remoteSelections.destroyChildren();
    const inv = 1 / this.stage.scaleX();
    const pad = 4 * inv;
    for (const { color, ids } of peers) {
      for (const id of ids) {
        const node = this.nodeById.get(id);
        if (!node) continue;
        const r = this.nodeRect(id, node);
        this.remoteSelections.add(
          new Konva.Rect({
            x: r.x - pad,
            y: r.y - pad,
            width: r.width + pad * 2,
            height: r.height + pad * 2,
            stroke: color,
            strokeWidth: 1.5 * inv,
            cornerRadius: 2 * inv,
            listening: false,
          }),
        );
      }
    }
    this.overlay.batchDraw();
  }

  // ---- touch: pinch-to-zoom + two-finger pan (mobile) ----
  private bindTouch(): void {
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
      const oldScale = this.stage.scaleX();
      const newScale = Math.min(8, Math.max(0.1, oldScale * (dist / this.pinch.dist)));
      // The canvas point under the previous pinch centre is pinned to the new centre,
      // which folds zoom + two-finger pan into one transform.
      const cx = (this.pinch.cx - this.stage.x()) / oldScale;
      const cy = (this.pinch.cy - this.stage.y()) / oldScale;
      this.stage.scale({ x: newScale, y: newScale });
      this.stage.position({ x: center.x - cx * newScale, y: center.y - cy * newScale });
      this.pinch = { dist, cx: center.x, cy: center.y };
      this.afterTransform();
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
      this.content.batchDraw();
    }
    if (this.marquee) this.cancelMarquee();
    if (this.moveState) {
      for (const id of this.selected) this.nodeById.get(id)?.position({ x: 0, y: 0 });
      this.moveState = null;
      this.transformer.forceUpdate();
      this.content.batchDraw();
    }
  }

  // ---- pan / zoom ----
  private bindWheelZoom(): void {
    this.stage.on("wheel", (e) => {
      e.evt.preventDefault();
      const oldScale = this.stage.scaleX();
      const pointer = this.stage.getPointerPosition();
      if (!pointer) return;
      const origin = {
        x: (pointer.x - this.stage.x()) / oldScale,
        y: (pointer.y - this.stage.y()) / oldScale,
      };
      const newScale = Math.min(
        8,
        Math.max(0.1, e.evt.deltaY > 0 ? oldScale / 1.08 : oldScale * 1.08),
      );
      this.stage.scale({ x: newScale, y: newScale });
      this.stage.position({
        x: pointer.x - origin.x * newScale,
        y: pointer.y - origin.y * newScale,
      });
      this.afterTransform();
    });
    this.stage.on("dragmove", () => {
      this.scaleCursors();
      this.syncGrid();
    });
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
      this.stage.size({
        width: this.opts.container.clientWidth,
        height: this.opts.container.clientHeight,
      });
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
        group.scale({ x: 1 / this.stage.scaleX(), y: 1 / this.stage.scaleX() });
        this.cursors.set(clientId, group);
        this.overlay.add(group);
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
    this.overlay.batchDraw();
    this.ensureCursorAnim();
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
    const inv = 1 / this.stage.scaleX();
    this.cursors.forEach((g) => g.scale({ x: inv, y: inv }));
  }

  /**
   * Glide remote cursors toward their latest reported position. The rAF loop
   * runs ONLY while cursors are actually moving, then stops — no idle cost.
   */
  private ensureCursorAnim(): void {
    if (this.animating) return;
    this.animating = true;
    const step = (): void => {
      let moving = false;
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
    cancelAnimationFrame(this.raf);
    this.opts.awareness.off("change", this.onAwarenessChange);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("pointerup", this.onWindowPointerUp);
    this.resizeObserver?.disconnect();
    this.stage.destroy();
  }
}
