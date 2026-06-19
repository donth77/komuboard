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
} from "@coboard/shared";

export type ToolId = "select" | "hand" | "pen";

export interface CanvasOptions {
  container: HTMLElement;
  doc: Y.Doc;
  awareness: Awareness;
  user: PresenceState;
}

const CURSOR_HZ = 30;

/**
 * BoardCanvas — renders the room's Yjs document with Konva and drives M1
 * interaction: infinite pan/zoom, a freehand pen that writes strokes into the
 * single shared doc, and live labeled cursors over the awareness channel.
 * (Sticky/shape/text/select/resize/undo arrive next.)
 */
export class BoardCanvas {
  private readonly stage: Konva.Stage;
  private readonly content = new Konva.Layer();
  private readonly overlay = new Konva.Layer();
  private readonly objects: Y.Map<Y.Map<unknown>>;
  private readonly cursors = new Map<number, Konva.Group>();

  private tool: ToolId = "pen";
  private color = "#0e1116";
  private widthPx = 4;
  private drawing: { id: string; points: number[]; line: Konva.Line } | null = null;
  private lastCursorSent = 0;

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

  private point(): { x: number; y: number } {
    const p = this.stage.getRelativePointerPosition();
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  }

  // ---- content (strokes) ----
  private renderObjects(): void {
    this.content.destroyChildren();
    for (const id of orderArray(this.opts.doc).toArray()) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type === "stroke") {
        this.content.add(this.strokeNode(obj));
      }
    }
    this.content.batchDraw();
  }

  private strokeNode(obj: StrokeObject): Konva.Line {
    return new Konva.Line({
      points: obj.points,
      stroke: obj.color,
      strokeWidth: obj.width,
      lineCap: "round",
      lineJoin: "round",
      listening: false,
    });
  }

  // ---- pointer / drawing ----
  private bindPointer(): void {
    this.stage.on("pointerdown", () => {
      if (this.tool !== "pen") return;
      const p = this.point();
      const line = new Konva.Line({
        points: [p.x, p.y],
        stroke: this.color,
        strokeWidth: this.widthPx,
        lineCap: "round",
        lineJoin: "round",
        listening: false,
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
      const mousePoint = {
        x: (pointer.x - this.stage.x()) / oldScale,
        y: (pointer.y - this.stage.y()) / oldScale,
      };
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const newScale = Math.min(8, Math.max(0.1, oldScale * (direction > 0 ? 1.08 : 1 / 1.08)));
      this.stage.scale({ x: newScale, y: newScale });
      this.stage.position({
        x: pointer.x - mousePoint.x * newScale,
        y: pointer.y - mousePoint.y * newScale,
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
    this.opts.awareness.on("change", () => this.renderCursors());
    this.renderCursors();
  }

  private renderCursors(): void {
    const self = this.opts.awareness.clientID;
    const seen = new Set<number>();
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const cursor = state["cursor"] as { x: number; y: number } | undefined;
      if (!cursor) return;
      seen.add(clientId);
      const color = String(state["color"] ?? "#2563eb");
      const name = String(state["user"] ?? "Guest");
      let group = this.cursors.get(clientId);
      if (!group) {
        group = this.buildCursor(color, name);
        this.cursors.set(clientId, group);
        this.overlay.add(group);
      }
      group.position({ x: cursor.x, y: cursor.y });
    });
    for (const [clientId, group] of this.cursors) {
      if (!seen.has(clientId)) {
        group.destroy();
        this.cursors.delete(clientId);
      }
    }
    this.scaleCursors();
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
      }),
    );
    const label = new Konva.Label({ x: 12, y: 14 });
    label.add(new Konva.Tag({ fill: color, cornerRadius: 8 }));
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

  destroy(): void {
    this.stage.destroy();
  }
}
