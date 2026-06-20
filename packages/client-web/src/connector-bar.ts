// src/connector-bar.ts — the floating toolbar shown above a selected connector. Light, matching the
// text / draw bars (FigJam's dark pill is only a layout reference, not the visual design).
//
// The canvas owns its lifecycle: show(state) when a single connector is selected, positionAt(rect)
// as the camera/endpoints move, reflect(state) when the connector's style changes, hide() otherwise.
// Controls route back through the host, which writes them to the doc via setConnectorStyle. The bar
// lives in document.body (position: fixed) so its popovers aren't clipped by the board overflow.

import "./color-picker";
import type { CoColorPicker } from "./color-picker";
import { lineWeightIcon } from "./icons";
import { SWATCHES } from "./palette";
import { COLOR_NAMES } from "./draw-bar";
import type { ConnectorCap, ConnectorStyle } from "@coboard/shared";

export interface ConnectorBarHost {
  setColor(hex: string): void;
  setWidth(width: number): void;
  setStyle(style: ConnectorStyle): void;
  setStartCap(cap: ConnectorCap): void;
  setEndCap(cap: ConnectorCap): void;
}

export interface ConnectorBarState {
  color: string;
  width: number;
  style: ConnectorStyle;
  startCap: ConnectorCap;
  endCap: ConnectorCap;
}

/** Line weights offered (canvas units), with friendly names instead of raw numbers. */
const WEIGHTS: { w: number; label: string }[] = [
  { w: 2.5, label: "Thin" },
  { w: 5, label: "Medium" }, // keep in sync with DEFAULT_CONNECTOR_WIDTH (a new connector = Medium)
  { w: 8, label: "Thick" },
  { w: 13, label: "Bold" },
];
const CAPS_ORDER: ConnectorCap[] = ["none", "line", "arrow", "triangle", "circle", "diamond"];
const CAP_NAMES: Record<ConnectorCap, string> = {
  none: "None",
  line: "Arrow",
  arrow: "Solid",
  triangle: "Outline",
  circle: "Circle",
  diamond: "Diamond",
};

/** The marker glyph for a cap, drawn on a short shaft. `dir` flips it so a start cap faces left and
 *  an end cap faces right (per the reference). */
function capIcon(cap: ConnectorCap, dir: "left" | "right"): string {
  const inner =
    cap === "none"
      ? '<path d="M3 12h18"/>'
      : cap === "line"
        ? '<path d="M3 12h13"/><path d="M12 7l5 5-5 5"/>'
        : cap === "arrow"
          ? '<path d="M3 12h10"/><path d="M12 6.5l7 5.5-7 5.5z" fill="currentColor"/>'
          : cap === "triangle"
            ? '<path d="M3 12h10"/><path d="M12 6.5l7 5.5-7 5.5z" fill="#ffffff"/>'
            : cap === "circle"
              ? '<path d="M3 12h11"/><circle cx="18" cy="12" r="3.4" fill="#ffffff"/>'
              : '<path d="M3 12h10"/><path d="M18 7.5l4.5 4.5-4.5 4.5-4.5-4.5z" fill="#ffffff"/>';
  const g = dir === "left" ? `<g transform="scale(-1,1) translate(-24,0)">${inner}</g>` : inner;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="cb-ico">${g}</svg>`;
}
function styleIcon(style: ConnectorStyle): string {
  const dash = style === "dashed" ? ' stroke-dasharray="4 3"' : "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="cb-ico"><path d="M3 12h18"${dash}/></svg>`;
}

export class ConnectorBar {
  readonly root: HTMLDivElement;
  private pop: HTMLDivElement | null = null;
  private picker: CoColorPicker | null = null;
  private state: ConnectorBarState | null = null;
  private readonly onDocDown = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (this.root.contains(t)) return;
    if (this.pop?.contains(t)) return;
    if (this.picker && !this.picker.classList.contains("hidden") && this.picker.contains(t)) return;
    this.closePop();
  };

  constructor(private readonly host: ConnectorBarHost) {
    const el = document.createElement("div");
    el.className = "co-connector-bar";
    el.style.display = "none";
    el.innerHTML =
      `<button class="cb-btn" data-act="color" data-tip="Color"><span class="cb-color-dot" data-color></span><span class="cb-caret">▾</span></button>` +
      `<button class="cb-btn" data-act="weight" data-tip="Line weight"><span class="cb-weight">${lineWeightIcon("cb-ico")}</span><span class="cb-caret">▾</span></button>` +
      `<span class="cb-sep"></span>` +
      `<button class="cb-btn" data-act="style" data-tip="Line style"><span class="cb-style">${styleIcon("solid")}</span><span class="cb-caret">▾</span></button>` +
      `<span class="cb-sep"></span>` +
      `<button class="cb-btn" data-act="startcap" data-tip="Start point"><span class="cb-startcap">${capIcon("none", "left")}</span><span class="cb-caret">▾</span></button>` +
      `<button class="cb-btn" data-act="endcap" data-tip="End point"><span class="cb-endcap">${capIcon("arrow", "right")}</span><span class="cb-caret">▾</span></button>`;
    document.body.appendChild(el);
    this.root = el;
    this.wire();
  }

  private wire(): void {
    this.root.addEventListener("mousedown", (e) => e.preventDefault());
    this.root.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("button.cb-btn");
      if (!btn) return;
      switch (btn.dataset.act) {
        case "color":
          return this.openColorPop(btn);
        case "weight":
          return this.openWeightPop(btn);
        case "style":
          return this.openStylePop(btn);
        case "startcap":
          return this.openCapPop(btn, "start");
        case "endcap":
          return this.openCapPop(btn, "end");
      }
    });
  }

  private openColorPop(anchor: HTMLElement): void {
    if (this.togglePop("color")) return;
    const cur = (this.state?.color ?? "").toLowerCase();
    const custom = !!cur && !SWATCHES.some((c) => c.toLowerCase() === cur);
    const pop = this.makePop("color");
    pop.innerHTML =
      `<div class="cb-swatches">` +
      SWATCHES.map(
        (c) =>
          `<button class="cb-sw${c.toLowerCase() === cur ? " on" : ""}" data-color="${c}" data-tip="${COLOR_NAMES[c.toUpperCase()] ?? c}" style="--sw:${c}"></button>`,
      ).join("") +
      `<button class="cb-sw sw-custom${custom ? " on" : ""}" data-custom data-tip="Custom"></button>` +
      `</div>`;
    pop.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-custom]")) return this.openPicker(anchor);
      const sw = t.closest<HTMLElement>("[data-color]");
      if (!sw) return;
      this.host.setColor(sw.getAttribute("data-color")!);
      this.closePop();
    });
    this.placePop(pop, anchor);
  }

  /** The shared colour picker for an arbitrary connector colour (reuses the draw/text tool's picker). */
  private openPicker(anchor: HTMLElement): void {
    this.closePop();
    if (!this.picker) {
      this.picker = document.createElement("co-color-picker") as CoColorPicker;
      document.body.appendChild(this.picker);
      this.picker.addEventListener("color-change", (e) => {
        this.host.setColor((e as CustomEvent<{ color: string }>).detail.color);
      });
    }
    this.picker.value = this.state?.color || "#1f2933";
    this.picker.classList.remove("hidden");
    const r = anchor.getBoundingClientRect();
    const pw = this.picker.offsetWidth || 232;
    this.picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pw - 8))}px`;
    this.picker.style.top = `${r.bottom + 6}px`;
    document.addEventListener("pointerdown", this.onDocDown);
  }

  private openWeightPop(anchor: HTMLElement): void {
    if (this.togglePop("weight")) return;
    const cur = this.state?.width ?? 6;
    const pop = this.makePop("weight");
    pop.classList.add("cb-pop-list"); // a named vertical list, not a number grid
    pop.innerHTML = WEIGHTS.map(
      (o) =>
        `<button class="cb-weight-opt${o.w === cur ? " on" : ""}" data-w="${o.w}">` +
        `<span class="cb-weight-name">${o.label}</span>` +
        `<span class="cb-weight-line" style="height:${Math.max(2, Math.round(o.w * 0.6))}px"></span>` +
        `</button>`,
    ).join("");
    pop.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-w]");
      if (!b) return;
      this.host.setWidth(Number(b.getAttribute("data-w")));
      this.closePop();
    });
    this.placePop(pop, anchor);
  }

  private openStylePop(anchor: HTMLElement): void {
    if (this.togglePop("style")) return;
    const cur = this.state?.style ?? "solid";
    const pop = this.makePop("style");
    const styles: ConnectorStyle[] = ["solid", "dashed"];
    pop.innerHTML = styles
      .map(
        (s) =>
          `<button class="cb-opt${s === cur ? " on" : ""}" data-style="${s}" data-tip="${s}">${styleIcon(s)}</button>`,
      )
      .join("");
    pop.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-style]");
      if (!b) return;
      this.host.setStyle(b.getAttribute("data-style") as ConnectorStyle);
      this.closePop();
    });
    this.placePop(pop, anchor);
  }

  private openCapPop(anchor: HTMLElement, which: "start" | "end"): void {
    if (this.togglePop(which + "cap")) return;
    const cur = which === "start" ? this.state?.startCap : this.state?.endCap;
    const dir = which === "start" ? "left" : "right";
    const pop = this.makePop(which + "cap");
    pop.innerHTML = CAPS_ORDER.map(
      (cap) =>
        `<button class="cb-opt${cap === cur ? " on" : ""}" data-cap="${cap}" data-tip="${CAP_NAMES[cap]}">${capIcon(cap, dir)}</button>`,
    ).join("");
    pop.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cap]");
      if (!b) return;
      const cap = b.getAttribute("data-cap") as ConnectorCap;
      if (which === "start") this.host.setStartCap(cap);
      else this.host.setEndCap(cap);
      this.closePop();
    });
    this.placePop(pop, anchor);
  }

  /** Returns true when the same popover was open (so the click just closes it). */
  private togglePop(id: string): boolean {
    const same = this.pop?.dataset.for === id;
    this.closePop();
    return same;
  }
  private makePop(id: string): HTMLDivElement {
    const pop = document.createElement("div");
    pop.className = "cb-pop";
    pop.dataset.for = id;
    pop.addEventListener("mousedown", (e) => e.preventDefault());
    return pop;
  }
  /** Place a popover below its anchor (the bar already sits above the connector). */
  private placePop(pop: HTMLDivElement, anchor: HTMLElement): void {
    document.body.appendChild(pop);
    const ar = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 180;
    pop.style.left = `${Math.max(8, Math.min(ar.left + ar.width / 2 - pw / 2, window.innerWidth - pw - 8))}px`;
    pop.style.top = `${ar.bottom + 6}px`;
    this.pop = pop;
    document.addEventListener("pointerdown", this.onDocDown);
  }
  private closePop(): void {
    this.pop?.remove();
    this.pop = null;
    this.picker?.classList.add("hidden");
    document.removeEventListener("pointerdown", this.onDocDown);
  }

  show(state: ConnectorBarState): void {
    this.root.style.display = "";
    this.reflect(state);
  }
  hide(): void {
    this.closePop();
    this.root.style.display = "none";
  }
  isVisible(): boolean {
    return this.root.style.display !== "none";
  }
  /** Centre the bar above the connector's screen bounding box. */
  positionAt(rect: { x: number; y: number; width: number; height: number }): void {
    const barW = this.root.offsetWidth || 240;
    const barH = this.root.offsetHeight || 40;
    let top = rect.y - barH - 12;
    if (top < 8) top = rect.y + rect.height + 12; // flip below if it'd run off the top
    const left = Math.max(
      8,
      Math.min(rect.x + rect.width / 2 - barW / 2, window.innerWidth - barW - 8),
    );
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }
  reflect(state: ConnectorBarState): void {
    this.state = state;
    const dot = this.root.querySelector<HTMLElement>("[data-color]");
    if (dot) dot.style.background = state.color;
    const wt = this.root.querySelector<HTMLElement>(".cb-startcap");
    if (wt) wt.innerHTML = capIcon(state.startCap, "left");
    const ec = this.root.querySelector<HTMLElement>(".cb-endcap");
    if (ec) ec.innerHTML = capIcon(state.endCap, "right");
    const st = this.root.querySelector<HTMLElement>(".cb-style");
    if (st) st.innerHTML = styleIcon(state.style);
  }
  destroy(): void {
    this.closePop();
    this.root.remove();
  }
}
