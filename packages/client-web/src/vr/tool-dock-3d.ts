// The floating VR tool dock — a vertical column of laser/mouse-clickable buttons beside the board,
// mirroring the 2D dock's icons. Pure A-Frame primitives (no models): each button is an a-plane
// "key" with the tool's SVG icon rendered as an a-image texture. Works identically in the desktop
// magic-window preview (scene mouse cursor) and with controllers (laser-controls) — both fire the
// same entity click events.

import { icon } from "../icons";
import type { AEntity } from "./three-types";
import type { BoardFit } from "./whiteboard-model";

export type VRTool = "select" | "hand" | "pen" | "eraser";

export interface ToolDock3DOptions {
  scene: HTMLElement;
  onTool(tool: VRTool): void;
  onZoom(dir: 1 | -1): void;
  onZoomFit(): void;
}

export interface ToolDock3D {
  setActive(tool: VRTool): void;
  /** Re-position beside the (model-fitted) board. */
  place(fit: BoardFit): void;
  destroy(): void;
}

const BTN = 0.11; // key size (m)
const GAP = 0.025;
const IDLE_BG = "#1d2530";
const ACTIVE_BG = "#4a9eff";

function iconUrl(name: Parameters<typeof icon>[0]): string {
  // icon() emits inline-DOM SVG — as an IMAGE it additionally needs the xmlns namespace (browsers
  // refuse to render it otherwise) and explicit pixel dimensions (no intrinsic size → blank).
  const svg = icon(name)
    .replace(/currentColor/g, "#e7ecf3")
    .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" ');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function createToolDock3D(opts: ToolDock3DOptions): ToolDock3D {
  const rootEnt = document.createElement("a-entity") as AEntity;
  rootEnt.id = "vr-dock";
  opts.scene.appendChild(rootEnt);

  const tools: { key: VRTool; ic: Parameters<typeof icon>[0] }[] = [
    { key: "select", ic: "select" },
    { key: "hand", ic: "hand" },
    { key: "pen", ic: "pen" },
    { key: "eraser", ic: "eraser" },
  ];
  const bgs = new Map<VRTool, AEntity>();

  const makeButton = (ic: Parameters<typeof icon>[0], y: number, onClick: () => void): AEntity => {
    const bg = document.createElement("a-plane") as AEntity;
    bg.classList.add("vr-interactive");
    bg.setAttribute("width", String(BTN));
    bg.setAttribute("height", String(BTN));
    bg.setAttribute("position", `0 ${y} 0`);
    bg.setAttribute("material", `shader: flat; color: ${IDLE_BG}`);
    const img = document.createElement("a-image") as AEntity;
    img.setAttribute("src", iconUrl(ic));
    img.setAttribute("width", String(BTN * 0.62));
    img.setAttribute("height", String(BTN * 0.62));
    img.setAttribute("position", "0 0 0.002");
    bg.appendChild(img);
    bg.addEventListener("click", onClick);
    rootEnt.appendChild(bg);
    return bg;
  };

  tools.forEach((t, i) => {
    const bg = makeButton(t.ic, -i * (BTN + GAP), () => opts.onTool(t.key));
    bgs.set(t.key, bg);
  });
  // Zoom cluster under the tools: − / + / fit.
  const zy = -tools.length * (BTN + GAP) - GAP;
  makeButton("minus", zy, () => opts.onZoom(-1));
  makeButton("plus", zy - (BTN + GAP), () => opts.onZoom(1));
  makeButton("fit", zy - 2 * (BTN + GAP), () => opts.onZoomFit());

  return {
    setActive(tool) {
      for (const [key, bg] of bgs)
        bg.setAttribute("material", `shader: flat; color: ${key === tool ? ACTIVE_BG : IDLE_BG}`);
    },
    place(fit) {
      // A column left of the board, top-aligned with its upper edge, angled slightly inward.
      const x = fit.x - fit.width / 2 - 0.16;
      const y = fit.y + fit.height / 2 - BTN / 2;
      rootEnt.setAttribute(
        "position",
        `${x.toFixed(3)} ${y.toFixed(3)} ${(fit.z + 0.02).toFixed(3)}`,
      );
      rootEnt.setAttribute("rotation", "0 12 0");
    },
    destroy() {
      rootEnt.remove();
    },
  };
}
