// <co-pen-panel> — the contextual pen properties panel (light-DOM Web Component).
//
// Owns its swatch grid, width/opacity sliders, and style segmented control, and
// reports edits via a single `pen-change` event carrying only the changed field.
// The fixed palette + the initially-selected colour come in via properties; a
// trailing rainbow swatch opens a <co-color-picker> for any custom colour.
// Reuses the global `.panel` / `.swatches` / `.seg` styles. See docs/adr/0005.

import type { StrokeStyle } from "@coboard/shared";
import "./color-picker";
import type { CoColorPicker } from "./color-picker";

export interface PenChange {
  color?: string;
  width?: number;
  style?: StrokeStyle;
  opacity?: number; // 0..1
}

const STYLES: ReadonlyArray<readonly [StrokeStyle, string]> = [
  ["solid", "Solid"],
  ["dashed", "Dashed"],
  ["highlight", "Highlight"],
];

// FigJam palette names shown in the hover tooltip.
const COLOR_NAMES: Record<string, string> = {
  "#0E1116": "Black",
  "#DC2626": "Red",
  "#F59E0B": "Orange",
  "#FACC15": "Yellow",
  "#16A34A": "Green",
  "#2563EB": "Blue",
  "#7C3AED": "Purple",
  "#EC4899": "Pink",
  "#FFFFFF": "White",
};

export class CoPenPanel extends HTMLElement {
  #swatches: string[] = [];
  #color = "";
  #wired = false;
  #picker: CoColorPicker | null = null;
  #onDocPointer: ((e: PointerEvent) => void) | null = null;

  connectedCallback(): void {
    this.classList.add("panel", "pen-panel");
    this.setAttribute("aria-label", "Pen properties");
    if (this.#wired) return;
    this.#wired = true;
    this.#build();
  }

  get swatches(): string[] {
    return this.#swatches;
  }
  set swatches(list: string[]) {
    this.#swatches = list;
    this.#renderSwatches();
  }
  get color(): string {
    return this.#color;
  }
  set color(c: string) {
    this.#color = c;
    this.#renderSwatches();
  }

  #build(): void {
    this.innerHTML =
      '<div class="panel-head">Pen</div>' +
      '<div class="panel-sec">' +
      '<div class="swatches" data-swatches role="group" aria-label="Color"></div></div>' +
      '<div class="panel-sec"><div class="panel-label">Stroke width · <b data-w-val>24</b> px</div>' +
      '<input type="range" data-width min="1" max="96" value="24" /></div>' +
      '<div class="panel-sec">' +
      '<div class="seg" data-style role="group" aria-label="Style">' +
      STYLES.map(
        ([v, lbl], i) =>
          `<button class="seg-opt${i === 0 ? " on" : ""}" type="button" data-style-val="${v}">${lbl}</button>`,
      ).join("") +
      "</div></div>" +
      '<div class="panel-sec"><div class="panel-label">Opacity · <b data-o-val>100</b>%</div>' +
      '<input type="range" data-opacity min="10" max="100" value="100" /></div>';
    this.#renderSwatches();

    this.querySelector("[data-swatches]")?.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".sw");
      if (!t) return;
      if (t.hasAttribute("data-custom")) {
        this.#togglePicker();
        return;
      }
      this.#color = t.getAttribute("data-color") ?? this.#color;
      this.#closePicker();
      this.#renderSwatches();
      this.#emit({ color: this.#color });
    });

    const wIn = this.querySelector<HTMLInputElement>("[data-width]");
    const wVal = this.querySelector<HTMLElement>("[data-w-val]");
    wIn?.addEventListener("input", () => {
      const w = Number(wIn.value);
      if (wVal) wVal.textContent = String(w);
      this.#emit({ width: w });
    });

    const seg = this.querySelector("[data-style]");
    seg?.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".seg-opt");
      if (!t) return;
      seg.querySelectorAll(".seg-opt").forEach((s) => s.classList.toggle("on", s === t));
      this.#emit({ style: (t.getAttribute("data-style-val") as StrokeStyle) ?? "solid" });
    });

    const oIn = this.querySelector<HTMLInputElement>("[data-opacity]");
    const oVal = this.querySelector<HTMLElement>("[data-o-val]");
    oIn?.addEventListener("input", () => {
      const pct = Number(oIn.value);
      if (oVal) oVal.textContent = String(pct);
      this.#emit({ opacity: pct / 100 });
    });
  }

  #renderSwatches(): void {
    const wrap = this.querySelector<HTMLElement>("[data-swatches]");
    if (!wrap) return;
    const isCustom = !!this.#color && !this.#swatches.includes(this.#color);
    wrap.innerHTML =
      this.#swatches
        .map((c) => {
          const name = COLOR_NAMES[c.toUpperCase()] ?? c;
          return `<button class="sw${c === this.#color ? " on" : ""}" type="button" data-color="${c}" data-tip="${name}" style="--sw:${c}" aria-label="${name}"></button>`;
        })
        .join("") +
      `<button class="sw sw-custom${isCustom ? " on" : ""}" type="button" data-custom data-tip="Custom" aria-label="Custom colour"></button>`;
  }

  // ---- custom-colour picker (FigJam-style rainbow swatch) ----
  #togglePicker(): void {
    if (this.#picker && !this.#picker.classList.contains("hidden")) this.#closePicker();
    else this.#openPicker();
  }
  #openPicker(): void {
    if (!this.#picker) {
      this.#picker = document.createElement("co-color-picker") as CoColorPicker;
      document.body.appendChild(this.#picker);
      this.#picker.addEventListener("color-change", (e) => {
        this.#color = (e as CustomEvent<{ color: string }>).detail.color;
        this.#renderSwatches();
        this.#emit({ color: this.#color });
      });
      this.#onDocPointer = (e) => {
        const t = e.target as Node;
        if (this.#picker?.contains(t)) return;
        if (this.querySelector("[data-custom]")?.contains(t)) return;
        this.#closePicker();
      };
      document.addEventListener("pointerdown", this.#onDocPointer, true);
    }
    this.#picker.value = this.#color || "#1E1E1E";
    this.#positionPicker();
    this.#picker.classList.remove("hidden");
  }
  #closePicker(): void {
    this.#picker?.classList.add("hidden");
  }
  #positionPicker(): void {
    if (!this.#picker) return;
    const panel = this.getBoundingClientRect();
    const w = 232;
    let left = panel.left - w - 10;
    if (left < 8) left = panel.right + 10; // flip to the right if there's no room on the left
    this.#picker.style.left = `${left}px`;
    this.#picker.style.top = `${Math.max(8, Math.min(panel.top, window.innerHeight - 250))}px`;
  }

  #emit(detail: PenChange): void {
    this.dispatchEvent(new CustomEvent("pen-change", { detail, bubbles: true }));
  }
}

if (!customElements.get("co-pen-panel")) customElements.define("co-pen-panel", CoPenPanel);

declare global {
  interface HTMLElementTagNameMap {
    "co-pen-panel": CoPenPanel;
  }
}
