// VR mode (M4) — the orchestrator. Assembles the A-Frame scene (environment + whiteboard model +
// board panel), wires the live pipeline, and owns entry/exit. The heavy lifting lives in focused
// modules: board-raster (Canvas2D doc renderer), board-texture (GPU upload plumbing),
// whiteboard-model (GLB normalization + surface detection), presence-3d (60 fps peer cursors +
// content-change detection). Enters an immersive session where WebXR exists; otherwise stays a
// mouse-look "magic window" preview (the documented fallback — also what e2e exercises headlessly).

import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { drawBoardRegion, type PeerPresence, type WorldRect } from "./board-raster";
import { createPanelTexture } from "./board-texture";
import { createInteraction } from "./interaction";
import { createPenMenu3D, type PenMenuState } from "./pen-menu-3d";
import { createPresence3D } from "./presence-3d";
import { createToolDock3D } from "./tool-dock-3d";
import { createTrayProps } from "./tray-props";
import { loadAframe, registerSceneTicker } from "./three-types";
import { fitAspect } from "./viewport-window";
import { DEFAULT_FIT, fitWhiteboardModel, type BoardFit } from "./whiteboard-model";

export interface VREnterOptions {
  doc: Y.Doc;
  /** Peers' ephemeral state — cursors, live strokes/drags, selections — shown on/near the panel. */
  awareness: Awareness;
  /** The 2D camera's visible world rect — seeds the panel's viewport window. */
  viewport: WorldRect;
  /** Shared-doc history (the 2D UndoManager tracks VR commits too) — drives the dock's buttons. */
  onUndo(): void;
  onRedo(): void;
  onExit(): void;
}

const TEX_W = 2048;

export async function enterVR(opts: VREnterOptions): Promise<void> {
  const aframe = await loadAframe();

  // Mirror the 2D board's look: the theme's surface + grid colours and the viewer's dots/lines
  // preference, read once at entry (the VR panel should feel like the same product).
  const rootCss = getComputedStyle(document.documentElement);
  const surface = rootCss.getPropertyValue("--surface").trim() || "#ffffff";
  const gridColor = rootCss.getPropertyValue("--grid").trim() || "#d2d8e2";
  const gridMode =
    document.getElementById("board")?.getAttribute("data-grid") === "lines" ? "lines" : "dots";

  const root = document.createElement("div");
  root.className = "vr-root";
  // vr-mode-ui stays ENABLED: browsers only honour requestSession within seconds of a user gesture,
  // and the Enter VR click first lazy-loads the A-Frame chunk — on a slow (headset) connection the
  // gesture can expire and our auto-enter below gets rejected. A-Frame's own goggles button is the
  // battle-tested manual path (it appears only when immersive-vr is actually supported).
  root.innerHTML =
    '<a-scene vr-mode-ui="enterAREnabled: false" style="position: fixed; inset: 0; z-index: 200;">' +
    '<a-sky color="#10151c"></a-sky>' +
    // Platform: a COZY pedestal under the board, not a 9m ground plane — the huge disc's far
    // surface overpainted nearer geometry in this build (hid the model's legs + tray props), and a
    // small platform floating in the dark sky reads better anyway. The invisible wall (interaction)
    // clamps movement to its rim.
    '<a-cylinder id="vr-floor" radius="2.4" height="0.02" color="#1a212b" position="0 -0.01 0"></a-cylinder>' +
    '<a-entity id="vr-model" gltf-model="url(/models/low_poly_whiteboard.glb)"></a-entity>' +
    `<a-plane id="vr-board" width="${DEFAULT_FIT.width}" height="${DEFAULT_FIT.height}" position="${DEFAULT_FIT.x} ${DEFAULT_FIT.y} ${DEFAULT_FIT.z}"></a-plane>` +
    '<a-text value="Komuboard" align="center" color="#8a94a6" width="1.6" position="0 2.25 -1.6"></a-text>' +
    "</a-scene>";
  document.body.appendChild(root);
  const scene = root.querySelector("a-scene") as HTMLElement & {
    enterVR?: () => Promise<void>;
    exitVR?: () => Promise<void>;
    hasLoaded?: boolean;
  };
  const panel = root.querySelector("#vr-board") as HTMLElement;
  registerSceneTicker(aframe, scene); // per-frame callbacks ride a component tick (XR-frame safe)

  // Live state: the panel fit (updates when the model's surface is detected) and the world viewport
  // it shows (re-fitted to the surface's aspect).
  let panelFit: BoardFit = DEFAULT_FIT;
  let rect = fitAspect(opts.viewport, panelFit.width / panelFit.height);

  const tex = createPanelTexture(
    aframe,
    panel,
    TEX_W,
    Math.round((TEX_W * DEFAULT_FIT.height) / DEFAULT_FIT.width),
  );
  const ctx = tex.canvas.getContext("2d");

  const draw = (): void => {
    if (!ctx) return;
    // Our OWN ephemeral state renders through the same presence pass as peers': the selection made
    // with the VR select tool and the pen tool's live stroke (both also broadcast to web peers).
    const local = opts.awareness.getLocalState() as Record<string, unknown> | null;
    const self: PeerPresence = {
      name: "",
      color: typeof local?.color === "string" ? (local.color as string) : "#3b82f6",
      cursor: null,
      draw: (local?.draw as PeerPresence["draw"]) ?? null,
      drag: null,
      selection: interactionRef?.selection() ?? null,
    };
    drawBoardRegion(ctx, opts.doc, rect, {
      background: surface,
      grid: { mode: gridMode, color: gridColor },
      onAssetLoad: () => onUpdate(), // an image/stamp bitmap arrived → redraw (throttled)
      presence: [...presence.peers(), self],
    });
    tex.upload();
  };
  // Content redraws are throttled ADAPTIVELY: ~30 Hz while a peer is mid-gesture (drag / resize /
  // rotate / live stroke / typing — worth the extra texture uploads for smoothness), ~10 Hz for
  // ordinary doc edits. Cursor motion never repaints (presence-3d moves entities at 60 fps).
  let pending = false;
  const schedule = (delay: number): void => {
    if (pending) return;
    pending = true;
    window.setTimeout(() => {
      pending = false;
      draw();
    }, delay);
  };
  // presenceRef is late-bound: createPresence3D invokes onContentChange synchronously during its
  // own construction, before `presence` finishes initializing.
  const onUpdate = (): void => schedule(presenceRef?.gestureActive() ? 33 : 100);
  /** Local gestures (pan/pen/select) redraw promptly. */
  const fastRedraw = (): void => schedule(33);
  opts.doc.on("update", onUpdate);

  let presenceRef: ReturnType<typeof createPresence3D> | null = null;
  const presence = createPresence3D({
    awareness: opts.awareness,
    scene,
    panelFit: () => panelFit,
    worldRect: () => rect,
    onContentChange: onUpdate,
  });
  presenceRef = presence;

  // Interaction (select / hand-pan / pen / eraser + zoom) and the floating tool dock — one pointer
  // pipeline for the preview's mouse cursor and (on device) controller lasers.
  let interactionRef: ReturnType<typeof createInteraction> | null = null;
  const dock = createToolDock3D({
    scene,
    onTool: (t) => interactionRef?.setTool(t),
    onZoom: (dir) => interactionRef?.zoomStep(dir),
    onZoomFit: () => interactionRef?.zoomFit(),
    onUndo: opts.onUndo,
    onRedo: opts.onRedo,
  });
  dock.place(panelFit);
  // The marker + eraser props resting on the board's tray — grab one to use its tool like a real
  // object (it rides the pointer, draws, flips, drops with gravity, and returns to the tray).
  const props = createTrayProps({ aframe, scene, onTool: (t) => interactionRef?.setTool(t) });
  props.place(panelFit);
  // The pen tool's option submenu (brush / line style / width / colour), shown while pen is active.
  let penState: PenMenuState = { brush: "pen", dash: "solid", width: 8, color: "#0E1116" };
  const penStyle = (): "solid" | "dashed" | "highlight" | "highlight-dashed" => {
    const dotted = penState.dash === "dotted";
    if (penState.brush === "highlighter") return dotted ? "highlight-dashed" : "highlight";
    return dotted ? "dashed" : "solid";
  };
  const penMenu = createPenMenu3D({
    scene,
    onChange: (partial) => {
      penState = { ...penState, ...partial };
      interactionRef?.setPenOptions({
        color: penState.color,
        width: penState.width,
        style: penStyle(),
      });
      props.tint(penState.color);
      penMenu.setState(penState);
    },
  });
  penMenu.place(panelFit);
  penMenu.setState(penState);
  penMenu.setVisible(false);
  props.tint(penState.color);
  const interaction = createInteraction({
    scene,
    panel,
    doc: opts.doc,
    awareness: opts.awareness,
    getRect: () => rect,
    setRect: (r) => {
      rect = r;
    },
    requestRedraw: fastRedraw,
    onToolChange: (t) => {
      dock.setActive(t);
      props.setActive(t);
      penMenu.setVisible(t === "pen");
    },
    // Feed the held prop its ride-along point: panel UV → the board face's world plane.
    onPointer: (uv, active) => {
      if (!uv) {
        props.follow(null, false);
        return;
      }
      props.follow(
        {
          x: panelFit.x + (uv.x - 0.5) * panelFit.width,
          y: panelFit.y + (uv.y - 0.5) * panelFit.height,
          z: panelFit.z,
        },
        active,
      );
    },
  });
  interactionRef = interaction;
  // e2e/debug hook — headless tests drive tools through this (projecting 3D dock buttons to screen
  // coordinates is brittle; the dock's click path shares the panel's, which IS tested directly).
  (window as unknown as { __komuvr?: unknown }).__komuvr = {
    setTool: (t: Parameters<typeof interaction.setTool>[0]) => interaction.setTool(t),
    getTool: () => interaction.getTool(),
    rect: () => rect,
    selection: () => interaction.selection(),
    penOptions: () => interaction.penOptions(),
    propState: () => props.debugState(),
  };

  // First draw once the scene is ready; the panel's mesh may (re)appear asynchronously too.
  const onLoaded = (): void => draw();
  if (scene.hasLoaded) draw();
  else scene.addEventListener("loaded", onLoaded, { once: true });
  panel.addEventListener("object3dset", onLoaded);

  // The whiteboard model: once its writing surface is found, pin the panel to it and re-fit the
  // texture to the surface's aspect. The scene works without the model (free-floating panel).
  fitWhiteboardModel(aframe, root.querySelector("#vr-model") as HTMLElement, (fit) => {
    panelFit = fit;
    panel.setAttribute("width", fit.width.toFixed(3));
    panel.setAttribute("height", fit.height.toFixed(3));
    panel.setAttribute("position", `${fit.x.toFixed(3)} ${fit.y.toFixed(3)} ${fit.z.toFixed(3)}`);
    tex.canvas.height = Math.max(64, Math.round((TEX_W * fit.height) / fit.width));
    rect = fitAspect(rect, fit.width / fit.height);
    dock.place(fit);
    props.place(fit);
    penMenu.place(fit);
    draw();
  });

  // Exit control — a DOM overlay above the scene (works in preview; headset users exit the session
  // first, which lands them back in the preview with this button).
  const exit = document.createElement("button");
  exit.type = "button";
  exit.className = "vr-exit";
  exit.textContent = "Exit VR";
  root.appendChild(exit);
  let keyHandler: ((e: KeyboardEvent) => void) | null = null;
  const teardown = (): void => {
    if (keyHandler) window.removeEventListener("keydown", keyHandler, true);
    opts.doc.off("update", onUpdate);
    interaction.destroy();
    dock.destroy();
    props.destroy();
    penMenu.destroy();
    delete (window as unknown as { __komuvr?: unknown }).__komuvr;
    presence.destroy();
    scene.removeEventListener("loaded", onLoaded);
    panel.removeEventListener("object3dset", onLoaded);
    void scene.exitVR?.().catch(() => undefined);
    tex.dispose();
    root.remove();
    opts.onExit();
  };
  exit.addEventListener("click", teardown);

  // Keyboard (the desktop preview has one; headsets don't): the familiar 2D letters drive the VR
  // tools. The 2D app's global handler self-mutes while `.vr-root` exists (see main.ts), and
  // A-Frame's wasd-controls keep receiving W/A/S/D + arrows so you can walk around the board.
  // ⌘Z / ⌘⇧Z / ⌘Y reach the 2D handler on purpose — undo acts on the shared doc, and VR commits
  // are local-origin transactions the 2D UndoManager already tracks.
  keyHandler = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (k === "v") interaction.setTool("select");
    else if (k === "h") interaction.setTool("hand");
    else if (k === "p") interaction.setTool("pen");
    else if (k === "e") interaction.setTool("eraser");
    else if (e.key === "+" || e.key === "=") interaction.zoomStep(1);
    else if (e.key === "-" || e.key === "_") interaction.zoomStep(-1);
    else if (e.key === "!" || (e.shiftKey && e.key === "1")) interaction.zoomFit();
    else if (k === "g")
      props.drop(); // let go of the held marker/eraser — it falls + resets
    else if (e.key === "Delete" || e.key === "Backspace") interaction.deleteSelection();
    else if (e.key === "Escape") teardown();
    else handled = false;
    if (handled) e.preventDefault();
  };
  window.addEventListener("keydown", keyHandler, true);

  // Immersive session when the device supports it; otherwise this stays a mouse-look 3D preview.
  try {
    const xr = (
      navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }
    ).xr;
    if (xr && (await xr.isSessionSupported("immersive-vr"))) await scene.enterVR?.();
  } catch {
    /* stay in the magic-window preview */
  }
}
