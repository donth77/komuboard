// The panel's live texture: a hidden 2D canvas (painted by the board rasterizer) uploaded onto the
// panel mesh. We own the panel's ENTIRE material — A-Frame's material component replaces the mesh
// material after init (silently dropping an attached map), and flagged needsUpdate re-uploads never
// reached the GPU (the panel froze at its first upload). So: enforce our material on an interval,
// and recreate the CanvasTexture on every (throttled, ~10 Hz) upload — the pixel upload dominates,
// so rebuilding the two JS objects is noise.

import type { AEntity, AframeNS, Tex } from "./three-types";

export interface PanelTexture {
  readonly canvas: HTMLCanvasElement;
  /** Re-upload the canvas to the GPU (call after painting). */
  upload(): void;
  /** Keep our material on the mesh (safe to call anytime; a no-op once stable). */
  attach(): void;
  dispose(): void;
}

export function createPanelTexture(
  aframe: AframeNS | undefined,
  panel: AEntity,
  width: number,
  height: number,
): PanelTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.id = "vr-board-canvas";
  canvas.style.display = "none";
  document.body.appendChild(canvas);

  let texture: Tex | null = null;
  let material: { map: Tex } | null = null;

  const attach = (): void => {
    const mesh = panel.getObject3D?.("mesh") as { material?: unknown } | undefined;
    const THREE = aframe?.THREE;
    if (!mesh || !THREE) return;
    if (!texture) {
      texture = new THREE.CanvasTexture(canvas);
      if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    }
    material ??= new THREE.MeshBasicMaterial({ map: texture });
    if (mesh.material !== material) mesh.material = material;
  };

  const upload = (): void => {
    texture?.dispose?.();
    texture = null;
    material = null;
    attach();
  };

  // The a-plane primitive's material component initializes LATE and overwrites mesh.material
  // without any event — cheap identity-check enforcement keeps ours in place.
  const enforce = window.setInterval(attach, 250);

  return {
    canvas,
    upload,
    attach,
    dispose() {
      window.clearInterval(enforce);
      texture?.dispose?.();
      canvas.remove();
    },
  };
}
