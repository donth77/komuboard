// VR mode (M4 stage 2) — lazy-loaded A-Frame scene rendering the board as a textured panel.
//
// The panel is a finite viewport window onto the infinite canvas (per docs/04): its texture is the
// board-raster Canvas2D drawing of a world rect seeded from the 2D camera, refreshed (throttled) on
// every doc update so remote edits appear live. When the browser supports immersive-vr the scene
// enters a headset session; otherwise it stays as a non-immersive "magic window" 3D preview (the
// documented fallback — also what e2e exercises headlessly). Exit tears everything down and returns
// to the untouched 2D app underneath.

import type * as Y from "yjs";

import { drawBoardRegion, type WorldRect } from "./board-raster";

export interface VREnterOptions {
  doc: Y.Doc;
  /** The 2D camera's visible world rect — seeds the panel's viewport window. */
  viewport: WorldRect;
  onExit(): void;
}

const TEX_W = 2048;
const TEX_H = 1229; // ≈ the panel's 2.0 × 1.2 m aspect

/** Expand `r` (centred) to the panel aspect so the texture isn't distorted. */
function fitAspect(r: WorldRect, aspect: number): WorldRect {
  let { width, height } = r;
  if (width / height > aspect) height = width / aspect;
  else width = height * aspect;
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
}

export async function enterVR(opts: VREnterOptions): Promise<void> {
  // Registers the <a-scene>/<a-*> custom elements (side-effect). CRITICAL: the module build may not
  // set window.AFRAME, so capture the namespace from the import itself — every texture attach needs
  // AFRAME.THREE, and reading only the global made attaches silently no-op (the "white panel" bug).
  const aframeModule = (await import("aframe")) as { default?: unknown } & Record<string, unknown>;
  const AFRAME = (aframeModule.default ??
    aframeModule ??
    (window as unknown as { AFRAME?: unknown }).AFRAME) as { THREE?: ThreeNS } | undefined;

  // Hidden texture source canvas — drawn by the board rasterizer, uploaded as the panel's texture.
  const cv = document.createElement("canvas");
  cv.width = TEX_W;
  cv.height = TEX_H;
  cv.id = "vr-board-canvas";
  cv.style.display = "none";
  document.body.appendChild(cv);
  // Mutable: re-fitted to the whiteboard model's detected board aspect once it loads.
  let rect = fitAspect(opts.viewport, TEX_W / TEX_H);
  const ctx = cv.getContext("2d");

  // Mirror the 2D board's look: the theme's surface + grid colours and the viewer's dots/lines
  // preference, read once at entry (the VR panel should feel like the same product).
  const rootCss = getComputedStyle(document.documentElement);
  const surface = rootCss.getPropertyValue("--surface").trim() || "#ffffff";
  const gridColor = rootCss.getPropertyValue("--grid").trim() || "#d2d8e2";
  const gridMode =
    document.getElementById("board")?.getAttribute("data-grid") === "lines" ? "lines" : "dots";

  const root = document.createElement("div");
  root.className = "vr-root";
  root.innerHTML =
    '<a-scene vr-mode-ui="enabled: false" style="position: fixed; inset: 0; z-index: 200;">' +
    '<a-sky color="#10151c"></a-sky>' +
    '<a-circle rotation="-90 0 0" radius="9" color="#1a212b" position="0 0 0"></a-circle>' +
    '<a-entity id="vr-model" gltf-model="url(/models/low_poly_whiteboard.glb)"></a-entity>' +
    '<a-plane id="vr-board" width="2" height="1.2" position="0 1.5 -1.6"></a-plane>' +
    '<a-text value="Komuboard" align="center" color="#8a94a6" width="1.6" position="0 2.25 -1.6"></a-text>' +
    "</a-scene>";
  document.body.appendChild(root);
  const scene = root.querySelector("a-scene") as HTMLElement & {
    enterVR?: () => Promise<void>;
    exitVR?: () => Promise<void>;
  };
  const panel = root.querySelector("#vr-board") as HTMLElement & {
    getObject3D?: (k: string) => { material?: { map?: { needsUpdate: boolean } } } | undefined;
  };

  // We own the panel's ENTIRE material (not just the map): A-Frame's material component replaces
  // the mesh material after init, which silently dropped a map assigned to the previous one — the
  // "white panel" bug. The plane carries no material attribute, and we re-enforce ours on every
  // draw + object3dset so nothing can swap it back out.
  interface Tex {
    needsUpdate: boolean;
    dispose?: () => void;
  }
  interface ThreeNS {
    CanvasTexture: new (c: HTMLCanvasElement) => Tex & { colorSpace?: string };
    MeshBasicMaterial: new (p: { map: Tex }) => { map: Tex };
    SRGBColorSpace?: string;
  }
  let texture: Tex | null = null;
  let material: { map: Tex } | null = null;
  const attachTexture = (): void => {
    const mesh = panel.getObject3D?.("mesh") as unknown as { material?: unknown } | undefined;
    const THREE = AFRAME?.THREE;
    if (!mesh || !THREE) return;
    if (!texture) {
      const t = new THREE.CanvasTexture(cv);
      if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
      texture = t;
    }
    material ??= new THREE.MeshBasicMaterial({ map: texture });
    if (mesh.material !== material) mesh.material = material;
  };
  const draw = (): void => {
    if (!ctx) return;
    drawBoardRegion(ctx, opts.doc, rect, {
      background: surface,
      grid: { mode: gridMode, color: gridColor },
      onAssetLoad: () => onUpdate(), // an image/stamp bitmap arrived → redraw (throttled)
    });
    // Recreate the texture each redraw instead of flagging needsUpdate — flagged re-uploads never
    // landed (the panel stayed frozen at the FIRST upload; likely A-Frame's material component
    // disposing GL state under us). Draws are throttled to ~10 Hz and the pixel upload dominates,
    // so rebuilding the two JS objects is noise. dispose() frees the stale GL texture.
    texture?.dispose?.();
    texture = null;
    material = null;
    attachTexture();
  };
  // Live updates: any doc update (local or remote) redraws the texture, throttled to ~10 Hz.
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

  // First draw once the scene is ready; the panel's mesh/material may also (re)appear asynchronously
  // (object3dset), so redraw + reattach the texture then too. And because the a-plane primitive's
  // material component initializes LATE and overwrites mesh.material WITHOUT any event, keep a cheap
  // enforcement interval (an identity check — a no-op once stable).
  const onLoaded = (): void => draw();
  if ((scene as unknown as { hasLoaded?: boolean }).hasLoaded) draw();
  else scene.addEventListener("loaded", onLoaded, { once: true });
  panel.addEventListener("object3dset", onLoaded);
  const enforce = window.setInterval(attachTexture, 250);

  // Standing-whiteboard model (user-provided GLB, CC-attributed in the README): auto-normalize on
  // load — models ship at arbitrary scale/origin, so measure its bounds, scale it to ~2.3 m wide,
  // ground it on the floor at the panel spot, then float the live board texture just in front of
  // its face (sized to the board area). The scene works without it (the panel stays a free-floating
  // viewport window) if the asset is missing.
  interface Vec3 {
    x: number;
    y: number;
    z: number;
    setScalar(s: number): void;
    set(x: number, y: number, z: number): void;
  }
  interface Box3Like {
    min: Vec3;
    max: Vec3;
    setFromObject(o: unknown): Box3Like;
    getSize(v: Vec3): Vec3;
    getCenter(v: Vec3): Vec3;
  }
  const model = root.querySelector("#vr-model") as HTMLElement & {
    object3D?: { scale: Vec3; position: Vec3 };
  };
  model.addEventListener("model-loaded", () => {
    const THREE = AFRAME?.THREE as
      | { Box3?: new () => Box3Like; Vector3?: new () => Vec3 }
      | undefined;
    const o3 = model.object3D as (typeof model.object3D & { rotation?: { y: number } }) | undefined;
    if (!THREE?.Box3 || !THREE.Vector3 || !o3) return;
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(o3).getSize(size);
    const footprint = Math.max(size.x, size.z);
    if (!footprint) return;
    // Face the camera: if the model is wider along z than x, its board faces ±x — rotate 90°.
    if (size.z > size.x && o3.rotation) o3.rotation.y = Math.PI / 2;
    o3.scale.setScalar(2.3 / footprint);
    const box = new THREE.Box3().setFromObject(o3);
    const c = new THREE.Vector3();
    box.getCenter(c);
    // Grounded on the floor, centred where the panel lives.
    o3.position.set(o3.position.x - c.x, o3.position.y - box.min.y, o3.position.z - 1.6 - c.z);
    // Fit the live texture EXACTLY to the model's writing surface: find the board mesh — the
    // largest slab that's thin along z (viewer-facing) and board-sized — and pin the panel to its
    // world bounds (slightly inset so the frame lip never clips it). Falls back to a proportional
    // guess if the model is a single merged mesh.
    const finalBox = new THREE.Box3().setFromObject(o3);
    const h = finalBox.max.y - finalBox.min.y;
    const Box3 = THREE.Box3;
    let board: Box3Like | null = null;
    let bestKey = Infinity;
    (o3 as unknown as { traverse(fn: (n: unknown) => void): void }).traverse((n) => {
      if (!(n as { isMesh?: boolean }).isMesh) return;
      const b = new Box3().setFromObject(n);
      const sx = b.max.x - b.min.x;
      const sy = b.max.y - b.min.y;
      const sz = b.max.z - b.min.z;
      if (sx < 0.6 || sy < 0.4) return; // too small to be the writing surface
      if (sz > Math.min(sx, sy) * 0.25) return; // not a thin, face-on slab
      // Prefer meshes NAMED like the surface (this model: "Backboard…"), never frame/leg parts;
      // within a tier the THINNEST slab wins (frames and stands are hollow → fat bounding boxes,
      // so "largest area" wrongly picked the legs assembly).
      const name = (n as { name?: string }).name ?? "";
      const preferred =
        /back|board|surface|panel/i.test(name) && !/stand|leg|corner|side/i.test(name);
      const key = (preferred ? 0 : 10) + sz;
      console.debug(`[vr] board candidate ${name || "?"}`, sx, sy, sz, key);
      if (key < bestKey) {
        bestKey = key;
        board = b;
      }
    });
    const found = board as Box3Like | null;
    if (found) {
      // Near-full coverage: the frame bars sit in FRONT of the panel plane, so a slight overlap
      // tucks behind them (like a real board surface) — insetting more left white strips visible.
      const w = (found.max.x - found.min.x) * 0.99;
      const bh = (found.max.y - found.min.y) * 0.99;
      panel.setAttribute("width", w.toFixed(3));
      panel.setAttribute("height", bh.toFixed(3));
      panel.setAttribute(
        "position",
        `${((found.min.x + found.max.x) / 2).toFixed(3)} ${((found.min.y + found.max.y) / 2).toFixed(3)} ${(found.max.z + 0.006).toFixed(3)}`,
      );
      // Re-fit the texture to the board's aspect (canvas height follows; UVs stay 0-1).
      cv.height = Math.max(64, Math.round((TEX_W * bh) / w));
      rect = fitAspect(opts.viewport, w / bh);
      draw();
    } else {
      const faceZ = (finalBox.min.z + finalBox.max.z) / 2 + 0.05;
      panel.setAttribute("width", "1.8");
      panel.setAttribute("height", "1.08");
      panel.setAttribute(
        "position",
        `0 ${(finalBox.min.y + h * 0.65).toFixed(3)} ${faceZ.toFixed(3)}`,
      );
    }
  });

  // Exit control — a DOM overlay above the scene (works in preview; headset users exit the session
  // first, which lands them back in the preview with this button).
  const exit = document.createElement("button");
  exit.type = "button";
  exit.className = "vr-exit";
  exit.textContent = "Exit VR";
  root.appendChild(exit);
  const teardown = (): void => {
    window.clearInterval(enforce);
    opts.doc.off("update", onUpdate);
    scene.removeEventListener("loaded", onLoaded);
    panel.removeEventListener("object3dset", onLoaded);
    void scene.exitVR?.().catch(() => undefined);
    root.remove();
    cv.remove();
    opts.onExit();
  };
  exit.addEventListener("click", teardown);

  // Immersive session when the device supports it; otherwise this stays a mouse-look 3D preview.
  try {
    const xr = (
      navigator as Navigator & {
        xr?: { isSessionSupported(mode: string): Promise<boolean> };
      }
    ).xr;
    if (xr && (await xr.isSessionSupported("immersive-vr"))) await scene.enterVR?.();
  } catch {
    /* stay in the magic-window preview */
  }
}
