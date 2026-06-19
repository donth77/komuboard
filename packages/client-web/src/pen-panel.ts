// <co-pen-panel> — the contextual pen properties panel (light-DOM Web Component).
//
// Owns its swatch grid, width slider, and style segmented control, and
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
}

const STYLES: ReadonlyArray<readonly [StrokeStyle, string]> = [
  ["solid", "Solid"],
  ["dashed", "Dashed"],
  ["highlight", "Highlight"],
];

// FigJam palette names shown in the hover tooltip.
export const COLOR_NAMES: Record<string, string> = {
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
      '<div class="sheet-handle" aria-hidden="true"></div>' +
      '<div class="panel-sec">' +
      '<div class="swatches" data-swatches role="group" aria-label="Color"></div></div>' +
      '<div class="panel-sec"><div class="panel-label">Stroke width · <b data-w-val>14</b> px</div>' +
      '<input type="range" data-width min="1" max="96" value="14" /></div>' +
      '<div class="panel-sec">' +
      '<div class="seg" data-style role="group" aria-label="Style">' +
      STYLES.map(
        ([v, lbl], i) =>
          `<button class="seg-opt${i === 0 ? " on" : ""}" type="button" data-style-val="${v}">${lbl}</button>`,
      ).join("") +
      "</div></div>";
    this.#renderSwatches();

    // Mobile bottom sheet: the grab handle expands/collapses the sheet between fully
    // open and a peek "tab" (the pen tool stays selected throughout — switching tools is
    // what dismisses it entirely). Tap toggles; a drag follows the finger and snaps to the
    // nearest state. TAB must match the .collapsed translate in styles.css. (Hidden on desktop.)
    const handle = this.querySelector<HTMLElement>(".sheet-handle");
    if (handle) {
      const TAB = 26;
      let startY = 0;
      let dy = 0;
      let dragging = false;
      let wasCollapsed = false;
      handle.addEventListener("pointerdown", (e) => {
        dragging = true;
        startY = e.clientY;
        dy = 0;
        wasCollapsed = this.classList.contains("collapsed");
        this.style.transition = "none";
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        dy = e.clientY - startY;
        const base = wasCollapsed ? this.offsetHeight - TAB : 0;
        const t = Math.min(this.offsetHeight - TAB, Math.max(0, base + dy));
        this.style.transform = `translateY(${t}px)`;
      });
      const endDrag = (): void => {
        if (!dragging) return;
        dragging = false;
        this.style.transition = ""; // restore the CSS slide transition
        this.style.transform = ""; // hand control back to the .collapsed class
        if (Math.abs(dy) < 5) {
          this.classList.toggle("collapsed"); // tap → toggle open / tab
        } else {
          const base = wasCollapsed ? this.offsetHeight - TAB : 0;
          this.classList.toggle("collapsed", base + dy > (this.offsetHeight - TAB) / 2); // snap nearest
        }
      };
      handle.addEventListener("pointerup", endDrag);
      handle.addEventListener("pointercancel", endDrag);
    }

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
    }
    this.#picker.value = this.#color || "#1E1E1E";
    this.#positionPicker();
    this.#picker.classList.remove("hidden");
    // Only listen for outside-clicks while the picker is open (removed in #closePicker), so
    // we don't run a global capture handler + querySelector on every pointerdown all session.
    if (this.#onDocPointer) document.addEventListener("pointerdown", this.#onDocPointer, true);
  }
  #closePicker(): void {
    this.#picker?.classList.add("hidden");
    if (this.#onDocPointer) document.removeEventListener("pointerdown", this.#onDocPointer, true);
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
