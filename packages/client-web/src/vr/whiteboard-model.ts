// The standing-whiteboard GLB (user-provided; credited in the README): auto-normalize on load and
// report where the live board panel should sit. Models ship at arbitrary scale/origin, so we
// measure bounds, face the wide side toward the camera, scale to ~2.3 m, ground it on the floor,
// then find the WRITING-SURFACE mesh and pin the panel to its world bounds.

import type { AEntity, AframeNS, Box3Like } from "./three-types";

/** Where the live board panel should sit (world units), matched to the model's writing surface. */
export interface BoardFit {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** The model's marker tray, when one is detected: rest surface for the tool props. */
  tray?: { y: number; z: number };
}

/** Default free-floating panel placement (also the no-model fallback). */
export const DEFAULT_FIT: BoardFit = { x: 0, y: 1.5, z: -1.6, width: 2, height: 1.2 };

export function fitWhiteboardModel(
  aframe: AframeNS | undefined,
  model: AEntity,
  onFit: (fit: BoardFit) => void,
): void {
  model.addEventListener("model-loaded", () => {
    const THREE = aframe?.THREE;
    const o3 = model.object3D;
    if (!THREE || !o3) return;
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

    // Find the writing surface: prefer meshes NAMED like the surface (this model: "Backboard…"),
    // never frame/leg parts; within a tier the THINNEST slab wins (frames and stands are hollow →
    // fat bounding boxes, so "largest area" wrongly picked the legs assembly).
    const finalBox = new THREE.Box3().setFromObject(o3);
    let board: Box3Like | null = null;
    let bestKey = Infinity;
    let tray: Box3Like | null = null;
    (o3 as unknown as { traverse(fn: (n: unknown) => void): void }).traverse((n) => {
      if (!(n as { isMesh?: boolean }).isMesh) return;
      const name = (n as { name?: string }).name ?? "";
      // The model's marker tray (this GLB: "Marker_Holder…") — the props rest on its top face.
      if (/holder|tray/i.test(name) && !/wheel/i.test(name)) {
        tray = new THREE.Box3().setFromObject(n);
        return;
      }
      const b = new THREE.Box3().setFromObject(n);
      const sx = b.max.x - b.min.x;
      const sy = b.max.y - b.min.y;
      const sz = b.max.z - b.min.z;
      if (sx < 0.6 || sy < 0.4) return; // too small to be the writing surface
      if (sz > Math.min(sx, sy) * 0.25) return; // not a thin, face-on slab
      const preferred =
        /back|board|surface|panel/i.test(name) && !/stand|leg|corner|side/i.test(name);
      const key = (preferred ? 0 : 10) + sz;
      console.debug(`[vr] board candidate ${name || "?"}`, sx, sy, sz, key);
      if (key < bestKey) {
        bestKey = key;
        board = b;
      }
    });
    const trayBox = tray as Box3Like | null;
    // Rest line = the tray's FRONT lip (its z-centre sits underneath the board face).
    const trayFit = trayBox ? { y: trayBox.max.y, z: trayBox.max.z - 0.035 } : undefined;
    const found = board as Box3Like | null;
    if (found) {
      // Near-full coverage: the frame bars sit in FRONT of the panel plane, so a slight overlap
      // tucks behind them (like a real board surface) — insetting more left white strips visible.
      onFit({
        x: (found.min.x + found.max.x) / 2,
        y: (found.min.y + found.max.y) / 2,
        z: found.max.z + 0.006,
        width: (found.max.x - found.min.x) * 0.99,
        height: (found.max.y - found.min.y) * 0.99,
        ...(trayFit ? { tray: trayFit } : {}),
      });
    } else {
      // Single merged mesh → proportional guess: the board area sits in the model's upper half.
      const h = finalBox.max.y - finalBox.min.y;
      onFit({
        x: 0,
        y: finalBox.min.y + h * 0.65,
        z: (finalBox.min.z + finalBox.max.z) / 2 + 0.05,
        width: 1.8,
        height: 1.08,
      });
    }
  });
}
