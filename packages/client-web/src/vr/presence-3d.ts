// Peers in VR, the cheap-and-smooth way. Cursors are NOT painted into the board texture — awareness
// spams cursor moves at 20-30 Hz and a texture repaint means a full multi-MB GPU upload, so cursors
// are small 3D entities hovering just in front of the panel, lerped toward their latest target every
// frame (60 fps, GPU transforms only — the same trick the 2D renderer uses). The texture only
// repaints when CONTENT changes: doc updates, or a peer's live stroke / drag / selection delta.

import type { Awareness } from "y-protocols/awareness";

import { CURSOR_PATH } from "../canvas";
import type { PeerPresence, WorldRect } from "./board-raster";
import type { AEntity } from "./three-types";
import type { BoardFit } from "./whiteboard-model";

export interface Presence3DOptions {
  awareness: Awareness;
  /** The <a-scene> to hang the cursor entities off. */
  scene: HTMLElement;
  /** Live getters — the panel fit + texture viewport change after the model loads. */
  panelFit(): BoardFit;
  worldRect(): WorldRect;
  /** A peer's live stroke / drag / selection changed (or a peer joined/left) → repaint the texture. */
  onContentChange(): void;
}

export interface Presence3D {
  /** Peers in the rasterizer's shape — cursors omitted (they're 3D entities, not texture pixels). */
  peers(): PeerPresence[];
  destroy(): void;
}

interface CursorEnt {
  ent: AEntity;
  label: AEntity;
  img: AEntity;
  target: { x: number; y: number } | null;
  color: string;
  name: string;
}

/** Cursor sizing (metres) — deliberately large so a peer across the room is findable at a glance. */
const POINTER_SIZE = 0.1;
const LABEL_W = 0.42; // a-text "width" — glyph size follows it, so keep it modest

/** The SAME pointer icon as the 2D cursors (Lucide mouse-pointer-2), tinted per peer. */
function pointerSvg(color: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="${color}" stroke="#ffffff" stroke-width="1.75" stroke-linejoin="round"><path d="${CURSOR_PATH}"/></svg>`,
  )}`;
}

export function createPresence3D(opts: Presence3DOptions): Presence3D {
  const rootEnt = document.createElement("a-entity");
  rootEnt.id = "vr-cursors";
  opts.scene.appendChild(rootEnt);

  const cursors = new Map<number, CursorEnt>();
  /** clientID → JSON signature of the fields that require a texture repaint. */
  const contentSig = new Map<number, string>();

  const makeCursor = (name: string, color: string): CursorEnt => {
    const ent = document.createElement("a-entity") as AEntity;
    // The entity origin is the cursor POINT; the icon plane offsets so its tip (the path's hotspot
    // at ~4/24 of the viewBox) lands on that origin — same alignment as the 2D pointer.
    const img = document.createElement("a-image") as AEntity;
    img.setAttribute("src", pointerSvg(color));
    img.setAttribute("width", String(POINTER_SIZE));
    img.setAttribute("height", String(POINTER_SIZE));
    img.setAttribute("position", `${POINTER_SIZE * 0.33} ${-POINTER_SIZE * 0.33} 0`);
    const label = document.createElement("a-text") as AEntity;
    label.setAttribute("value", name);
    label.setAttribute("align", "left");
    label.setAttribute("color", color);
    label.setAttribute("width", String(LABEL_W));
    label.setAttribute("wrap-count", "18");
    label.setAttribute("position", `${POINTER_SIZE * 0.55} ${-POINTER_SIZE * 0.85} 0.001`);
    ent.appendChild(img);
    ent.appendChild(label);
    rootEnt.appendChild(ent);
    return { ent, label, img, target: null, color, name };
  };

  const onChange = (): void => {
    let content = false;
    const seen = new Set<number>();
    for (const [id, st] of opts.awareness.getStates()) {
      if (id === opts.awareness.clientID || !st) continue;
      seen.add(id);
      const state = st as Record<string, unknown>;
      const name = typeof state.user === "string" ? state.user : "Guest";
      const color = typeof state.color === "string" ? state.color : "#3b82f6";
      let cur = cursors.get(id);
      if (!cur) {
        cur = makeCursor(name, color);
        cursors.set(id, cur);
        content = true; // a joiner may already carry selection/drag state
      }
      if (cur.name !== name) {
        cur.name = name;
        cur.label.setAttribute("value", name);
      }
      if (cur.color !== color) {
        cur.color = color;
        cur.img.setAttribute("src", pointerSvg(color));
        cur.label.setAttribute("color", color);
      }
      cur.target = (state.cursor as { x: number; y: number } | null | undefined) ?? null;
      const sig = JSON.stringify([state.draw ?? 0, state.drag ?? 0, state.selection ?? 0]);
      if (contentSig.get(id) !== sig) {
        contentSig.set(id, sig);
        content = true;
      }
    }
    for (const [id, cur] of cursors) {
      if (seen.has(id)) continue;
      cur.ent.remove();
      cursors.delete(id);
      contentSig.delete(id);
      content = true;
    }
    if (content) opts.onContentChange();
  };
  opts.awareness.on("change", onChange);
  onChange();

  // 60 fps glide: each frame, ease every cursor toward its latest target.
  let raf = 0;
  const step = (): void => {
    const fit = opts.panelFit();
    const rect = opts.worldRect();
    for (const cur of cursors.values()) {
      const o3 = cur.ent.object3D;
      if (!o3) continue;
      if (!cur.target) {
        if (o3.visible !== false) o3.visible = false;
        continue;
      }
      // World → panel-local, clamped to the board edges (an off-viewport peer pins to the border).
      const u = Math.min(1, Math.max(0, (cur.target.x - rect.x) / rect.width));
      const v = Math.min(1, Math.max(0, (cur.target.y - rect.y) / rect.height));
      const tx = fit.x + (u - 0.5) * fit.width;
      const ty = fit.y + (0.5 - v) * fit.height;
      const tz = fit.z + 0.015;
      if (o3.visible === false) {
        o3.visible = true;
        o3.position.set(tx, ty, tz); // first sighting: snap, don't glide in from (0,0,0)
        continue;
      }
      o3.position.lerp({ x: tx, y: ty, z: tz }, 0.25);
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);

  const peers = (): PeerPresence[] => {
    const out: PeerPresence[] = [];
    for (const [id, st] of opts.awareness.getStates()) {
      if (id === opts.awareness.clientID || !st) continue;
      const state = st as Record<string, unknown>;
      out.push({
        name: typeof state.user === "string" ? state.user : "Guest",
        color: typeof state.color === "string" ? state.color : "#3b82f6",
        cursor: null, // cursors live as 3D entities, not texture pixels
        draw: (state.draw as PeerPresence["draw"]) ?? null,
        drag: (state.drag as PeerPresence["drag"]) ?? null,
        selection: (state.selection as string[] | null | undefined) ?? null,
      });
    }
    return out;
  };

  return {
    peers,
    destroy() {
      cancelAnimationFrame(raf);
      opts.awareness.off("change", onChange);
      rootEnt.remove();
      cursors.clear();
    },
  };
}
