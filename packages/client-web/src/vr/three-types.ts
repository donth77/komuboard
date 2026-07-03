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
}

/** An A-Frame entity element (its DOM node + the three.js object it wraps). */
export type AEntity = HTMLElement & {
  object3D?: { position: Vec3; scale: Vec3; rotation?: { y: number }; visible?: boolean };
  getObject3D?: (kind: string) => { material?: unknown } | undefined;
};

/** Load A-Frame (registers the <a-*> custom elements) and return its namespace. CRITICAL: the
 *  module build may not set window.AFRAME, so capture the namespace from the import itself —
 *  reading only the global made every texture attach silently no-op (the "white panel" bug). */
export async function loadAframe(): Promise<AframeNS | undefined> {
  const mod = (await import("aframe")) as { default?: unknown } & Record<string, unknown>;
  return (mod.default ?? mod ?? (window as unknown as { AFRAME?: unknown }).AFRAME) as
    | AframeNS
    | undefined;
}
