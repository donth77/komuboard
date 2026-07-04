// The pen tool's 3D submenu — a compact option panel beside the board (mirrors the 2D draw-bar):
// brush (pen / highlighter), line style (solid / dotted), stroke width presets, and the FigJam
// colour palette. Buttons are the same laser/mouse-clickable a-plane keys as the dock. Visible
// only while the pen tool is active.

import { icon } from "../icons";
import type { AEntity } from "./three-types";
import type { BoardFit } from "./whiteboard-model";

export type PenBrush = "pen" | "highlighter";
export type PenDash = "solid" | "dotted";

export interface PenMenuState {
  brush: PenBrush;
  dash: PenDash;
  width: number;
  color: string;
}

export interface PenMenu3DOptions {
  scene: HTMLElement;
  onChange(partial: Partial<PenMenuState>): void;
}

export interface PenMenu3D {
  place(fit: BoardFit): void;
  setVisible(v: boolean): void;
  setState(s: PenMenuState): void;
  destroy(): void;
}

/** The 2D draw-bar's FigJam palette (see draw-bar.ts COLOR_NAMES). */
export const PEN_SWATCHES = [
  "#0E1116",
  "#DC2626",
  "#F59E0B",
  "#FACC15",
  "#16A34A",
  "#2563EB",
  "#7C3AED",
  "#EC4899",
];
export const PEN_WIDTHS = [4, 8, 16];

const BTN = 0.085;
const GAP = 0.018;
const IDLE_BG = "#1d2530";
const ACTIVE_BG = "#4a9eff";

function svgUrl(inner: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#e7ecf3" stroke-width="2" stroke-linecap="round">${inner}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function iconUrl(name: Parameters<typeof icon>[0]): string {
  const svg = icon(name)
    .replace(/currentColor/g, "#e7ecf3")
    .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" ');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function createPenMenu3D(opts: PenMenu3DOptions): PenMenu3D {
  const rootEnt = document.createElement("a-entity") as AEntity;
  rootEnt.id = "vr-penmenu";
  opts.scene.appendChild(rootEnt);

  // key → its background plane, for active-state refresh
  const keys = new Map<string, AEntity>();

  const makeKey = (
    id: string,
    x: number,
    y: number,
    src: string | null,
    fill: string | null,
    onClick: () => void,
  ): void => {
    const bg = document.createElement("a-plane") as AEntity;
    bg.classList.add("vr-interactive");
    bg.dataset.opt = id;
    bg.setAttribute("width", String(BTN));
    bg.setAttribute("height", String(BTN));
    bg.setAttribute("position", `${x} ${y} 0`);
    bg.setAttribute("material", `shader: flat; color: ${IDLE_BG}`);
    if (src) {
      const img = document.createElement("a-image") as AEntity;
      img.setAttribute("src", src);
      img.setAttribute("width", String(BTN * 0.66));
      img.setAttribute("height", String(BTN * 0.66));
      img.setAttribute("position", "0 0 0.002");
      bg.appendChild(img);
    } else if (fill) {
      const dot = document.createElement("a-plane") as AEntity;
      dot.setAttribute("width", String(BTN * 0.6));
      dot.setAttribute("height", String(BTN * 0.6));
      dot.setAttribute("position", "0 0 0.002");
      dot.setAttribute("material", `shader: flat; color: ${fill}`);
      bg.appendChild(dot);
    }
    bg.addEventListener("click", onClick);
    rootEnt.appendChild(bg);
    keys.set(id, bg);
  };

  const col = (i: number): number => i * (BTN + GAP);
  let y = 0;
  // Row 1 — brush: pen | highlighter.
  makeKey("brush:pen", col(0), y, iconUrl("pen"), null, () => opts.onChange({ brush: "pen" }));
  makeKey("brush:highlighter", col(1), y, iconUrl("highlighter"), null, () =>
    opts.onChange({ brush: "highlighter" }),
  );
  // Row 2 — line style: solid | dotted.
  y -= BTN + GAP;
  makeKey("dash:solid", col(0), y, svgUrl('<path d="M4 12h16"/>'), null, () =>
    opts.onChange({ dash: "solid" }),
  );
  makeKey(
    "dash:dotted",
    col(1),
    y,
    svgUrl('<path d="M4 12h2M10 12h2M16 12h2" stroke-width="2.6"/>'),
    null,
    () => opts.onChange({ dash: "dotted" }),
  );
  // Row 3 — stroke width presets (dot size = weight).
  y -= BTN + GAP;
  PEN_WIDTHS.forEach((w, i) => {
    const rad = 2.2 + i * 2.2;
    makeKey(
      `width:${w}`,
      col(i),
      y,
      svgUrl(`<circle cx="12" cy="12" r="${rad}" fill="#e7ecf3" stroke="none"/>`),
      null,
      () => opts.onChange({ width: w }),
    );
  });
  // Rows 4-5 — the colour palette.
  y -= BTN + GAP;
  PEN_SWATCHES.forEach((c, i) => {
    const row = Math.floor(i / 3);
    makeKey(`color:${c}`, col(i % 3), y - row * (BTN + GAP), null, c, () =>
      opts.onChange({ color: c }),
    );
  });

  return {
    place(fit) {
      // Mirrors the dock: a small panel on the board's RIGHT edge, top-aligned, angled inward.
      const x = fit.x + fit.width / 2 + 0.14;
      const top = fit.y + fit.height / 2 - BTN / 2;
      rootEnt.setAttribute(
        "position",
        `${x.toFixed(3)} ${top.toFixed(3)} ${(fit.z + 0.02).toFixed(3)}`,
      );
      rootEnt.setAttribute("rotation", "0 -12 0");
    },
    setVisible(v) {
      const o3 = (rootEnt as { object3D?: { visible: boolean } }).object3D;
      if (o3) o3.visible = v;
      // While hidden, the keys must not swallow laser/mouse rays either.
      for (const bg of keys.values()) {
        if (v) bg.classList.add("vr-interactive");
        else bg.classList.remove("vr-interactive");
      }
    },
    setState(s) {
      const active = new Set([
        `brush:${s.brush}`,
        `dash:${s.dash}`,
        `width:${s.width}`,
        `color:${s.color}`,
      ]);
      for (const [id, bg] of keys) {
        const isColor = id.startsWith("color:");
        const on = active.has(id);
        // Colour keys highlight with a bright frame (the swatch itself keeps its colour).
        bg.setAttribute(
          "material",
          `shader: flat; color: ${on ? (isColor ? "#e7ecf3" : ACTIVE_BG) : IDLE_BG}`,
        );
      }
    },
    destroy() {
      rootEnt.remove();
    },
  };
}
