// VR board interaction — one pointer pipeline for BOTH input sources: the scene's mouse cursor in
// the desktop magic-window preview and laser-controls on real controllers (A-Frame fires the same
// entity events for each, with the intersection carried on the raycaster). Tools: select (tap →
// selection, broadcast over the same awareness field the 2D uses), hand (drag pans the viewport
// window), pen (draw into the SAME doc, live-previewed to peers over the "draw" field), eraser
// (drag-over deletes). Hovering the panel publishes the world point as the normal cursor field, so
// web users see the VR user as an ordinary labelled cursor (cross-reality presence).

import {
  addObject,
  deleteObject,
  randomId,
  type StrokeObject,
  type StrokeStyle,
} from "@komuboard/shared";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { docContentBounds, hitTestWorld, type WorldRect } from "./board-raster";
import type { VRTool } from "./tool-dock-3d";
import { onSceneTick } from "./three-types";
import { pan, zoomAt, zoomToFit } from "./viewport-window";

interface RaycasterEl extends HTMLElement {
  components?: {
    raycaster?: { getIntersection(el: Element): { uv?: { x: number; y: number } } | null };
  };
}

interface CursorEventDetail {
  cursorEl?: RaycasterEl;
  intersection?: { uv?: { x: number; y: number } };
}

export interface InteractionOptions {
  scene: HTMLElement;
  /** The camera rig — the controllers ride it, so locomotion carries them along. */
  rig: HTMLElement;
  panel: HTMLElement;
  doc: Y.Doc;
  awareness: Awareness;
  getRect(): WorldRect;
  setRect(r: WorldRect): void;
  /** Redraw the texture promptly (~30 Hz) — local gestures must feel immediate. */
  requestRedraw(): void;
  onToolChange(tool: VRTool): void;
  /** Per-tick pointer feed: panel UV (null when off-board) + whether a gesture is pressing. */
  onPointer?(uv: { x: number; y: number } | null, active: boolean): void;
  /** Panel UV where a hand-held marker/eraser is pressed against the board face (null when not). */
  contactUV?(): { x: number; y: number } | null;
}

export interface PenOptions {
  color: string;
  width: number;
  style: StrokeStyle;
}

export interface Interaction {
  setTool(tool: VRTool): void;
  getTool(): VRTool;
  selection(): string[];
  setPenOptions(o: PenOptions): void;
  penOptions(): PenOptions;
  /** Delete the current selection from the doc (skips locked objects) — one undo step. */
  deleteSelection(): void;
  zoomStep(dir: 1 | -1): void;
  zoomFit(): void;
  /** The laser-controls entity for one hand. */
  controller(hand: "left" | "right"): HTMLElement;
  /** Gate the board gestures (off while the board is still loading and hidden). */
  setEnabled(v: boolean): void;
  destroy(): void;
}

export function createInteraction(opts: InteractionOptions): Interaction {
  const { scene, panel, awareness, doc } = opts;
  panel.classList.add("vr-interactive");
  // Mouse pointer → same raycast pipeline as controller lasers (the preview's input source).
  scene.setAttribute("cursor", "rayOrigin: mouse; fuse: false");
  scene.setAttribute("raycaster", "objects: .vr-interactive");
  // Controllers (validated on device day): standard laser-controls; their triggers fire the same
  // entity events the mouse cursor does.
  const makeController = (hand: "left" | "right"): RaycasterEl => {
    const c = document.createElement("a-entity") as RaycasterEl;
    c.setAttribute("laser-controls", `hand: ${hand}`);
    c.setAttribute("raycaster", "objects: .vr-interactive; lineColor: #4a9eff; lineOpacity: 0.75");
    opts.rig.appendChild(c);
    return c;
  };
  const hands = { left: makeController("left"), right: makeController("right") };
  const controllers: RaycasterEl[] = [hands.left, hands.right];

  let tool: VRTool = "select";
  let selected: string[] = [];
  let penOpts: PenOptions = { color: "#0E1116", width: 8, style: "solid" };
  // A hidden panel still raycasts (three.js doesn't consult `visible`), so gestures are gated here.
  let enabled = true;

  // The pointer's current world position (from whichever raycaster is engaged with the panel).
  const uvToWorld = (uv: { x: number; y: number }): { x: number; y: number } => {
    const r = opts.getRect();
    // Plane UVs have v = 0 at the BOTTOM; the texture's world rect has y growing downward.
    return { x: r.x + uv.x * r.width, y: r.y + (1 - uv.y) * r.height };
  };
  const intersectionUV = (source: RaycasterEl | null): { x: number; y: number } | null => {
    const ray = source?.components?.raycaster ?? (scene as RaycasterEl).components?.raycaster;
    try {
      const uv = ray?.getIntersection(panel)?.uv;
      return uv ? { x: uv.x, y: uv.y } : null;
    } catch {
      // A-Frame's raycaster throws if queried before its first tick initializes its arrays.
      return null;
    }
  };

  // ---- gestures --------------------------------------------------------------------------------
  interface Gesture {
    kind: VRTool;
    source: RaycasterEl | null;
    /** Driven by a hand-held prop touching the board (not a trigger/mouse press). */
    touch: boolean;
    startWorld: { x: number; y: number };
    startRect: WorldRect;
    points: number[]; // pen
    erased: Set<string>;
    moved: boolean;
  }
  let gesture: Gesture | null = null;
  let lastCursorSent = 0;

  const commitPen = (g: Gesture): void => {
    awareness.setLocalStateField("draw", null);
    if (g.points.length < 4) return;
    const stroke: StrokeObject = {
      id: randomId("st"),
      type: "stroke",
      points: g.points,
      color: penOpts.color,
      width: penOpts.width,
      style: penOpts.style,
      opacity: 1,
      authorId: String(awareness.clientID),
    };
    addObject(doc, stroke);
  };

  const setSelection = (ids: string[]): void => {
    selected = ids;
    awareness.setLocalStateField("selection", ids.length ? ids : null);
    opts.requestRedraw(); // our own outline renders via the texture's presence pass
  };

  const step = (): void => {
    if (!enabled) return;
    // Physical contact: a hand-held marker/eraser pressed against the board face draws/erases like
    // the real thing, no trigger needed (only while no laser/mouse gesture is running).
    const touchUV = opts.contactUV?.() ?? null;
    if (touchUV && !gesture && (tool === "pen" || tool === "eraser")) begin(null, touchUV, true);
    else if (gesture?.touch && !touchUV) finish();
    // Mid-gesture: track the raycaster (or contact) that started it. Idle: whichever pointer is on
    // the board — the preview's mouse ray or (in-headset) either controller's laser, so laser HOVER
    // publishes the cross-reality cursor too, not just trigger-holds.
    let uv = gesture
      ? gesture.touch
        ? touchUV
        : intersectionUV(gesture.source)
      : intersectionUV(null);
    if (!uv && !gesture) for (const c of controllers) if ((uv = intersectionUV(c))) break;
    opts.onPointer?.(uv, !!gesture);
    if (uv) {
      const w = uvToWorld(uv);
      // Cross-reality presence: our hover point is a normal 2D cursor for web peers (~30 Hz).
      const now = performance.now();
      if (now - lastCursorSent > 33) {
        lastCursorSent = now;
        awareness.setLocalStateField("cursor", { x: w.x, y: w.y });
      }
      if (gesture) {
        if (gesture.kind === "hand") {
          // Keep the grabbed world point under the pointer: pan by the drift within the START rect.
          const u0 = (gesture.startWorld.x - gesture.startRect.x) / gesture.startRect.width;
          const v0 = (gesture.startWorld.y - gesture.startRect.y) / gesture.startRect.height;
          const dx = (u0 - uv.x) * gesture.startRect.width;
          const dy = (v0 - (1 - uv.y)) * gesture.startRect.height;
          opts.setRect(pan(gesture.startRect, dx, dy));
          gesture.moved = true;
          opts.requestRedraw();
        } else if (gesture.kind === "pen") {
          const n = gesture.points.length;
          const lx = gesture.points[n - 2] ?? Infinity;
          const ly = gesture.points[n - 1] ?? Infinity;
          if (Math.hypot(w.x - lx, w.y - ly) > 1.5) {
            gesture.points.push(w.x, w.y);
            awareness.setLocalStateField("draw", {
              id: "vr-live",
              points: gesture.points,
              color: penOpts.color,
              width: penOpts.width,
              style: penOpts.style,
            });
            opts.requestRedraw();
          }
        } else if (gesture.kind === "eraser") {
          const hit = hitTestWorld(doc, w);
          if (hit && !gesture.erased.has(hit)) {
            gesture.erased.add(hit);
            deleteObject(doc, hit);
          }
        }
      }
    }
  };
  // Ticks via the shared komu-tick component (XR-frame safe; window rAF stalls in immersive
  // sessions, and this A-Frame build's addBehavior only ticks real components).
  const offTick = onSceneTick(step);

  // Mouse-drag on the panel is a TOOL gesture, not look-around — freeze the preview camera's
  // look-controls for the duration (dragging the sky still looks around).
  const setLook = (enabled: boolean): void => {
    const cam = (scene as unknown as { camera?: { el?: HTMLElement } }).camera?.el;
    cam?.setAttribute("look-controls", `enabled: ${enabled}`);
  };

  const begin = (
    source: RaycasterEl | null,
    uv: { x: number; y: number },
    touch: boolean,
  ): void => {
    const w = uvToWorld(uv);
    gesture = {
      kind: tool,
      source,
      touch,
      startWorld: w,
      startRect: { ...opts.getRect() },
      points: tool === "pen" ? [w.x, w.y] : [],
      erased: new Set(),
      moved: false,
    };
    if (tool === "eraser") {
      const hit = hitTestWorld(doc, w);
      if (hit) {
        gesture.erased.add(hit);
        deleteObject(doc, hit);
      }
    }
  };
  const finish = (): void => {
    const g = gesture;
    gesture = null;
    if (!g) return;
    if (g.kind === "pen") commitPen(g);
    else if (g.kind === "select" && !g.moved) {
      const hit = hitTestWorld(doc, g.startWorld);
      setSelection(hit ? [hit] : []);
    }
  };

  const onDown = (evt: Event): void => {
    if (!enabled) return;
    if (gesture) return; // one gesture at a time (a trigger press can synthesize two mousedowns)
    const detail = (evt as CustomEvent<CursorEventDetail>).detail;
    const source = detail?.cursorEl ?? null;
    setLook(false);
    // Prefer the intersection the cursor ACTED on (carried on the event) — polling the raycaster
    // right after a fast move can be one tick stale.
    const evtUV = detail?.intersection?.uv;
    const uv = evtUV ? { x: evtUV.x, y: evtUV.y } : intersectionUV(source);
    if (uv) begin(source, uv, false);
  };
  const onUp = (): void => {
    setLook(true);
    if (!gesture?.touch) finish(); // lifting a trigger doesn't end a stroke drawn by contact
  };
  panel.addEventListener("mousedown", onDown);
  panel.addEventListener("mouseup", onUp);

  // Preview nicety: wheel over the panel zooms about the pointer.
  const onWheel = (e: Event): void => {
    const uv = enabled ? intersectionUV(null) : null;
    if (!uv) return;
    const factor = (e as WheelEvent).deltaY > 0 ? 1.12 : 1 / 1.12;
    opts.setRect(zoomAt(opts.getRect(), uv.x, 1 - uv.y, factor));
    opts.requestRedraw();
    e.preventDefault();
  };
  scene.addEventListener("wheel", onWheel, { passive: false });

  const setTool = (t: VRTool): void => {
    tool = t;
    opts.onToolChange(t);
  };
  setTool("select");

  return {
    setTool,
    getTool: () => tool,
    selection: () => selected,
    setPenOptions(o) {
      penOpts = o;
    },
    penOptions: () => penOpts,
    deleteSelection() {
      const objects = doc.getMap("objects");
      const ids = selected.filter((id) => {
        const o = objects.get(id) as { get?: (k: string) => unknown } | undefined;
        return o && o.get?.("locked") !== true;
      });
      if (!ids.length) return;
      doc.transact(() => {
        for (const id of ids) deleteObject(doc, id);
      });
      setSelection([]);
    },
    zoomStep(dir) {
      opts.setRect(zoomAt(opts.getRect(), 0.5, 0.5, dir > 0 ? 1 / 1.25 : 1.25));
      opts.requestRedraw();
    },
    zoomFit() {
      const r = opts.getRect();
      opts.setRect(zoomToFit(docContentBounds(doc), r.width / r.height));
      opts.requestRedraw();
    },
    controller: (hand) => hands[hand],
    setEnabled(v) {
      enabled = v;
    },
    destroy() {
      offTick();
      panel.removeEventListener("mousedown", onDown);
      panel.removeEventListener("mouseup", onUp);
      scene.removeEventListener("wheel", onWheel);
      awareness.setLocalStateField("draw", null);
      awareness.setLocalStateField("cursor", null);
    },
  };
}
