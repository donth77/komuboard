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
const LERP = 0.35;

/**
 * BoardCanvas — renders the room's Yjs document with Konva and drives M1
 * interaction: infinite pan/zoom, a freehand pen (color/width/style/opacity)
 * that writes strokes into the single shared doc, and live labeled cursors
 * that glide via rAF interpolation of the throttled awareness stream.
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
    this.startCursorAnim();

    opts.awareness.setLocalStateField("user", opts.user.name);
    opts.awareness.setLocalStateField("color", opts.user.color);
    this.setTool("pen");
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
      strokeWidth: highlight ? width * 3 : width,
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
    this.stage.on("pointerleave", finish);
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
      this.scaleCursors();
      this.stage.batchDraw();
    });
    this.stage.on("dragmove", () => this.scaleCursors());
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
  }

  private buildCursor(color: string, name: string): Konva.Group {
    const group = new Konva.Group({ listening: false });
    group.add(
      new Konva.Path({
        data: "M2 2 L2 18 L7 13 L10 19 L13 18 L10 12 L16 12 Z",
        fill: color,
        stroke: "#fff",
        strokeWidth: 1,
        shadowColor: "rgba(0,0,0,0.25)",
        shadowBlur: 3,
        shadowOffsetY: 1,
      }),
    );
    const label = new Konva.Label({ x: 13, y: 15 });
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

  /** Glide remote cursors toward their latest reported position (mask latency). */
  private startCursorAnim(): void {
    const step = (): void => {
      let moved = false;
      this.cursors.forEach((group, id) => {
        const t = this.cursorTargets.get(id);
        if (!t) return;
        const p = group.position();
        const nx = p.x + (t.x - p.x) * LERP;
        const ny = p.y + (t.y - p.y) * LERP;
        if (Math.abs(nx - p.x) > 0.05 || Math.abs(ny - p.y) > 0.05) {
          group.position({ x: nx, y: ny });
          moved = true;
        }
      });
      if (moved) this.overlay.batchDraw();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.stage.destroy();
  }
}
