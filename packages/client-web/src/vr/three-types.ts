// Minimal structural types for the slice of THREE/A-Frame the VR modules touch, plus the one place
// that loads A-Frame. We deliberately avoid @types/three (A-Frame bundles its own THREE) — these
// interfaces document exactly which surface we depend on.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): void;
  setScalar(s: number): void;
  lerp(v: { x: number; y: number; z: number }, alpha: number): Vec3;
}

export interface Box3Like {
  min: Vec3;
  max: Vec3;
  setFromObject(o: unknown): Box3Like;
  getSize(v: Vec3): Vec3;
  getCenter(v: Vec3): Vec3;
}

export interface Tex {
  needsUpdate: boolean;
  colorSpace?: string;
  dispose?: () => void;
}

export interface ThreeNS {
  CanvasTexture: new (c: HTMLCanvasElement) => Tex;
  MeshBasicMaterial: new (p: { map: Tex }) => { map: Tex };
  Box3: new () => Box3Like;
  Vector3: new () => Vec3;
  SRGBColorSpace?: string;
}

export interface AframeNS {
  THREE?: ThreeNS;
  registerComponent?: (name: string, def: unknown) => void;
  components?: Record<string, unknown>;
}

/** An A-Frame entity element (its DOM node + the three.js object it wraps). */
export type AEntity = HTMLElement & {
  object3D?: { position: Vec3; scale: Vec3; rotation?: { y: number }; visible?: boolean };
  getObject3D?: (kind: string) => { material?: unknown } | undefined;
};

// ---- scene tick registry ------------------------------------------------------------------------
// Per-frame callbacks for the VR modules. Two schedulers, standards-only (no A-Frame internals —
// its behavior/component tick paths proved unreliable to hook in this build):
//   • a permanent window.requestAnimationFrame loop — drives the desktop preview;
//   • while an immersive session is active, an XRSession.requestAnimationFrame loop — window rAF
//     stalls in-headset, and the session loop dies with the session (window's resumes after).
// A per-frame dedupe keeps double-scheduling harmless when both fire (e.g. emulated sessions).
const tickCallbacks = new Set<() => void>();
let lastRun = -1;

function runCallbacks(): void {
  const now = performance.now();
  if (now - lastRun < 4) return; // both schedulers fired this frame — run once
  lastRun = now;
  for (const cb of tickCallbacks) {
    try {
      cb();
    } catch {
      /* a bad frame must not kill the loop */
    }
  }
}

let windowLoopStarted = false;

export function registerSceneTicker(_aframe: AframeNS | undefined, scene: HTMLElement): void {
  if (!windowLoopStarted) {
    windowLoopStarted = true;
    const wLoop = (): void => {
      runCallbacks();
      window.requestAnimationFrame(wLoop);
    };
    window.requestAnimationFrame(wLoop);
  }
  interface XRFrameLoop {
    requestAnimationFrame(cb: () => void): void;
  }
  const sceneXR = scene as HTMLElement & {
    xrSession?: XRFrameLoop;
    renderer?: { xr?: { getSession?: () => XRFrameLoop | null } };
  };
  scene.addEventListener("enter-vr", () => {
    const session = sceneXR.xrSession ?? sceneXR.renderer?.xr?.getSession?.();
    if (!session) return;
    const sLoop = (): void => {
      runCallbacks();
      try {
        session.requestAnimationFrame(sLoop);
      } catch {
        /* session ended — the window loop carries on */
      }
    };
    session.requestAnimationFrame(sLoop);
  });
}

/** Register a per-frame callback (ticks in preview AND inside immersive sessions). Returns an
 *  unsubscribe. */
export function onSceneTick(cb: () => void): () => void {
  tickCallbacks.add(cb);
  return () => tickCallbacks.delete(cb);
}

/** Load A-Frame (registers the <a-*> custom elements) and return its namespace. CRITICAL: the
 *  module build may not set window.AFRAME, so capture the namespace from the import itself —
 *  reading only the global made every texture attach silently no-op (the "white panel" bug). */
export async function loadAframe(): Promise<AframeNS | undefined> {
  const mod = (await import("aframe")) as { default?: unknown } & Record<string, unknown>;
  return (mod.default ?? mod ?? (window as unknown as { AFRAME?: unknown }).AFRAME) as
    | AframeNS
    | undefined;
}
