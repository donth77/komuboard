// VR mode (M4) — the orchestrator. Assembles the A-Frame scene (environment + whiteboard model +
// board panel), wires the live pipeline, and owns entry/exit. The heavy lifting lives in focused
// modules: board-raster (Canvas2D doc renderer), board-texture (GPU upload plumbing),
// whiteboard-model (GLB normalization + surface detection), presence-3d (60 fps peer cursors +
// content-change detection). Enters an immersive session where WebXR exists; otherwise stays a
// mouse-look "magic window" preview (the documented fallback — also what e2e exercises headlessly).

import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { drawBoardRegion, type WorldRect } from "./board-raster";
import { createPanelTexture } from "./board-texture";
import { createPresence3D } from "./presence-3d";
import { loadAframe } from "./three-types";
import { DEFAULT_FIT, fitWhiteboardModel, type BoardFit } from "./whiteboard-model";

export interface VREnterOptions {
  doc: Y.Doc;
  /** Peers' ephemeral state — cursors, live strokes/drags, selections — shown on/near the panel. */
  awareness: Awareness;
  /** The 2D camera's visible world rect — seeds the panel's viewport window. */
  viewport: WorldRect;
  onExit(): void;
}

const TEX_W = 2048;

/** Expand `r` (centred) to `aspect` so the texture isn't distorted. */
function fitAspect(r: WorldRect, aspect: number): WorldRect {
  let { width, height } = r;
  if (width / height > aspect) height = width / aspect;
  else width = height * aspect;
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
}

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
    '<a-circle rotation="-90 0 0" radius="9" color="#1a212b" position="0 0 0"></a-circle>' +
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
    drawBoardRegion(ctx, opts.doc, rect, {
      background: surface,
      grid: { mode: gridMode, color: gridColor },
      onAssetLoad: () => onUpdate(), // an image/stamp bitmap arrived → redraw (throttled)
      presence: presence.peers(),
    });
    tex.upload();
  };
  // Content redraws are throttled to ~10 Hz — doc edits, live strokes/drags, selections. Cursor
  // motion deliberately does NOT repaint (presence-3d moves cursor entities at 60 fps instead).
  let pending = false;
  const onUpdate = (): void => {
    if (pending) return;
    pending = true;
    window.setTimeout(() => {
      pending = false;
      draw();
    }, 100);
  };
  opts.doc.on("update", onUpdate);

  const presence = createPresence3D({
    awareness: opts.awareness,
    scene,
    panelFit: () => panelFit,
    worldRect: () => rect,
    onContentChange: onUpdate,
  });

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
    rect = fitAspect(opts.viewport, fit.width / fit.height);
    draw();
  });

  // Exit control — a DOM overlay above the scene (works in preview; headset users exit the session
  // first, which lands them back in the preview with this button).
  const exit = document.createElement("button");
  exit.type = "button";
  exit.className = "vr-exit";
  exit.textContent = "Exit VR";
  root.appendChild(exit);
  const teardown = (): void => {
    opts.doc.off("update", onUpdate);
    presence.destroy();
    scene.removeEventListener("loaded", onLoaded);
    panel.removeEventListener("object3dset", onLoaded);
    void scene.exitVR?.().catch(() => undefined);
    tex.dispose();
    root.remove();
    opts.onExit();
  };
  exit.addEventListener("click", teardown);

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
