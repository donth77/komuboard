import Konva from "konva";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  addStroke,
  objectsMap,
  orderArray,
  randomId,
  readObject,
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

/**
 * BoardCanvas — renders the room's Yjs document with Konva and drives M1
 * interaction: infinite pan/zoom (the dot grid tracks the camera), a freehand
 * pen (color/width/style/opacity) that writes strokes into the single shared
 * doc, and live labeled cursors that glide via an on-demand rAF interpolation
 * of the throttled awareness stream.
 */
export class BoardCanvas {
  private readonly stage: Konva.Stage;
  private readonly content = new Konva.Layer();
  private readonly overlay = new Konva.Layer();
  private readonly objects: Y.Map<Y.Map<unknown>>;
  private readonly cursors = new Map<number, Konva.Group>();
  private readonly cursorTargets = new Map<number, { x: number; y: number }>();

  private tool: ToolId = "pen";
  private color = "#0e1116";
  private widthPx = 4;
  private style: StrokeStyle = "solid";
  private opacity = 1;
  private drawing: { id: string; points: number[]; line: Konva.Line } | null = null;
  private lastCursorSent = 0;
  private raf = 0;
  private animating = false;
  private zoomListener: ((pct: number) => void) | null = null;

  constructor(private readonly opts: CanvasOptions) {
    this.objects = objectsMap(opts.doc);
    this.stage = new Konva.Stage({
      container: opts.container as HTMLDivElement,
      width: opts.container.clientWidth,
      height: opts.container.clientHeight,
    });
    this.stage.add(this.content);
    this.stage.add(this.overlay);

    this.renderObjects();
    this.objects.observeDeep(() => this.renderObjects());

    this.bindPointer();
    this.bindWheelZoom();
    this.bindResize();
    this.bindAwareness();
    this.syncGrid();

    opts.awareness.setLocalStateField("user", opts.user.name);
    opts.awareness.setLocalStateField("color", opts.user.color);
    this.setTool("pen");
    this.zoomAroundCenter(0.6); // roomier default — 1:1 feels cramped on an empty board
  }

  setTool(tool: ToolId): void {
    this.tool = tool;
    this.stage.draggable(tool === "hand");
    this.stage.container().style.cursor =
      tool === "hand" ? "grab" : tool === "pen" ? "crosshair" : "default";
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
  private notifyZoom(): void {
    this.zoomListener?.(Math.round(this.stage.scaleX() * 100));
  }
  private afterTransform(): void {
    this.scaleCursors();
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
    this.zoomAroundCenter(1);
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
    this.content.destroyChildren();
    for (const id of orderArray(this.opts.doc).toArray()) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type === "stroke") {
        this.content.add(
          new Konva.Line({
            points: obj.points,
            ...this.lineConfig(obj.color, obj.width, obj.style, obj.opacity),
          }),
        );
      }
    }
    this.content.batchDraw();
  }

  // ---- pointer / drawing ----
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
    window.addEventListener("blur", () => this.opts.awareness.setLocalStateField("cursor", null));
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
    const ro = new ResizeObserver(() => {
      this.stage.size({
        width: this.opts.container.clientWidth,
        height: this.opts.container.clientHeight,
      });
    });
    ro.observe(this.opts.container);
  }

  // ---- presence / cursors ----
  private publishCursor(p: { x: number; y: number }): void {
    const now = Date.now();
    if (now - this.lastCursorSent < 1000 / CURSOR_HZ) return;
    this.lastCursorSent = now;
    this.opts.awareness.setLocalStateField("cursor", { x: p.x, y: p.y });
  }

  private bindAwareness(): void {
    this.opts.awareness.on("change", () => this.syncCursors());
    this.syncCursors();
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
        group = this.buildCursor(String(state["color"] ?? "#2563eb"), String(state["user"] ?? "Guest"));
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
        data: "M5 3l5 16 2.6-6.6L19 10 5 3z",
        fill: color,
        stroke: "#fff",
        strokeWidth: 1.3,
        lineJoin: "round",
        shadowColor: "rgba(0,0,0,0.25)",
        shadowBlur: 3,
        shadowOffsetY: 1,
      }),
    );
    const label = new Konva.Label({ x: 14, y: 16 });
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
    this.stage.destroy();
  }
}
