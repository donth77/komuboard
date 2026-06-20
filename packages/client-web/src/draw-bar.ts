// <co-draw-bar> — the brush bar: a compact vertical floating column on desktop and a slide-up
// bottom sheet (with a pull-tab) on mobile. Pen/highlighter brushes + expandable popovers for
// line style, colour and stroke width. Emits `pen-change` events (bubbling → handled on #app in
// main.ts → canvas). Light DOM; reuses the global `.swatches`/`.seg`/range styles +
// <co-color-picker>. See docs/adr/0005.

import { icon, iconFilled } from "./icons";
import type { StrokeStyle } from "@coboard/shared";
import "./color-picker";
import type { CoColorPicker } from "./color-picker";
import { wireSheetHandle } from "./mobile-sheet";

/** The `pen-change` event detail — only the changed field(s) are present. */
export interface PenChange {
  color?: string;
  width?: number;
  style?: StrokeStyle;
}

/** FigJam palette names, shown in the swatch hover tooltips. */
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

type Brush = "pen" | "highlighter";
type Dash = "solid" | "dotted";

export class CoDrawBar extends HTMLElement {
  #swatches: string[] = [];
  #color = "#0e1116";
  #width = 14;
  #brush: Brush = "pen";
  #dash: Dash = "solid";
  #open: string | null = null;
  #pop: HTMLElement | null = null;
  #picker: CoColorPicker | null = null;
  #onDocPointer: ((e: PointerEvent) => void) | null = null;
  #wired = false;

  connectedCallback(): void {
    this.classList.add("draw-bar", "mini-sheet");
    this.setAttribute("role", "toolbar");
    this.setAttribute("aria-label", "Draw options");
    if (this.#wired) return;
    this.#wired = true;
    this.#build();
  }

  get swatches(): string[] {
    return this.#swatches;
  }
  set swatches(list: string[]) {
    this.#swatches = list;
  }
  get color(): string {
    return this.#color;
  }
  set color(c: string) {
    this.#color = c;
    this.#syncColorDot();
  }

  #build(): void {
    // A grab handle (mobile-only) tops the button row so the sheet can expand/collapse to a tab.
    // Each button carries a styled .db-tip (name only — no keyboard shortcut). The tip is a
    // sibling of the icon so the dynamic style-icon / colour-dot updates never wipe it.
    this.innerHTML =
      '<div class="sheet-handle" aria-hidden="true"></div>' +
      '<div class="db-row">' +
      `<button class="db-btn" type="button" data-brush="pen" aria-label="Pen">${iconFilled("penClip")}<span class="db-tip">Pen</span></button>` +
      `<button class="db-btn" type="button" data-brush="highlighter" aria-label="Highlighter">${icon("highlighter")}<span class="db-tip">Highlighter</span></button>` +
      `<button class="db-btn" type="button" data-pop="style" aria-label="Line style"><span class="db-ico-slot">${icon(this.#styleIconName())}</span><span class="db-tip">Line style</span></button>` +
      `<button class="db-btn db-color" type="button" data-pop="color" aria-label="Colour"><span class="db-dot"></span><span class="db-tip">Color</span></button>` +
      `<button class="db-btn" type="button" data-pop="width" aria-label="Stroke width">${icon("weight")}<span class="db-tip">Stroke width</span></button>` +
      "</div>";
    this.#syncBrush();
    this.#syncColorDot();
    this.#wireHandle();

    this.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".db-btn");
      if (!btn) return;
      const brush = btn.getAttribute("data-brush");
      const pop = btn.getAttribute("data-pop");
      if (brush) {
        this.#setBrush(brush as Brush);
        this.#closePop();
      } else if (pop) {
        this.#togglePop(pop, btn);
      }
    });
  }

  // Mobile bottom sheet: the grab handle expands/collapses the sheet between fully open and a peek
  // "tab" (the pen tool stays selected throughout — switching tools is what dismisses it). The
  // drag-to-collapse behaviour is shared with the sticky/shape sheets (see mobile-sheet.ts).
  #wireHandle(): void {
    const handle = this.querySelector<HTMLElement>(".sheet-handle");
    if (handle) wireSheetHandle(this, handle, () => this.#closePop());
  }

  // ---- brushes (pen / highlighter map onto the existing StrokeStyle) ----
  #style(): StrokeStyle {
    // brush and dash are independent → highlighter can also be dotted (highlight-dashed)
    const dotted = this.#dash === "dotted";
    if (this.#brush === "highlighter") return dotted ? "highlight-dashed" : "highlight";
    return dotted ? "dashed" : "solid";
  }
  #setBrush(b: Brush): void {
    this.#brush = b;
    this.#syncBrush();
    this.#emit({ style: this.#style() });
  }
  #syncBrush(): void {
    this.querySelectorAll<HTMLElement>("[data-brush]").forEach((b) =>
      b.classList.toggle("active", b.getAttribute("data-brush") === this.#brush),
    );
  }
  #syncColorDot(): void {
    const dot = this.querySelector<HTMLElement>(".db-dot");
    if (dot) dot.style.background = this.#color;
  }
  #styleIconName(): string {
    return this.#dash === "dotted" ? "lineDotted" : "lineSolid"; // the button previews the current style
  }
  #renderStyleBtn(): void {
    const slot = this.querySelector<HTMLElement>('[data-pop="style"] .db-ico-slot');
    if (slot) slot.innerHTML = icon(this.#styleIconName()); // update only the icon; keep .db-tip
  }

  // ---- expandable popovers (style / colour / width) ----
  #togglePop(which: string, anchor: HTMLElement): void {
    if (this.#open === which) this.#closePop();
    else this.#openPop(which, anchor);
  }
  #openPop(which: string, anchor: HTMLElement): void {
    this.#closePop();
    this.#open = which;
    this.classList.add("pop-open"); // a submenu is open → suppress bar tooltips
    const pop = document.createElement("div");
    pop.className = "db-popover";
    pop.innerHTML = this.#popContent(which);
    document.body.appendChild(pop);
    this.#pop = pop;
    this.#wirePop(which, pop);
    const r = anchor.getBoundingClientRect();
    if (window.matchMedia("(max-width: 640px)").matches) {
      // mobile: the bar is a bottom sheet → open the popover UPWARD, centered over the button
      const w = pop.offsetWidth;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
      pop.style.left = `${left}px`;
      pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 10)}px`;
    } else {
      pop.style.left = `${r.right + 10}px`; // desktop: to the right of the vertical bar
      pop.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - pop.offsetHeight - 8))}px`;
    }
    anchor.classList.add("active");
    this.#onDocPointer = (e) => {
      const t = e.target as Node;
      if (pop.contains(t) || anchor.contains(t) || this.#picker?.contains(t)) return;
      this.#closePop();
    };
    document.addEventListener("pointerdown", this.#onDocPointer, true);
  }
  #closePop(): void {
    this.#pop?.remove();
    this.#pop = null;
    this.classList.remove("pop-open");
    this.#picker?.classList.add("hidden");
    this.querySelectorAll("[data-pop].active").forEach((b) => b.classList.remove("active"));
    if (this.#onDocPointer) {
      document.removeEventListener("pointerdown", this.#onDocPointer, true);
      this.#onDocPointer = null;
    }
    this.#open = null;
  }

  #popContent(which: string): string {
    if (which === "style") {
      return (
        '<div class="seg" data-style>' +
        `<button class="seg-opt${this.#dash === "solid" ? " on" : ""}" type="button" data-dash="solid" title="Solid" aria-label="Solid">${icon("lineSolid")}</button>` +
        `<button class="seg-opt${this.#dash === "dotted" ? " on" : ""}" type="button" data-dash="dotted" title="Dotted" aria-label="Dotted">${icon("lineDotted")}</button>` +
        "</div>"
      );
    }
    if (which === "color") {
      const sw = this.#swatches
        .map((c) => {
          const name = COLOR_NAMES[c.toUpperCase()] ?? c;
          return `<button class="sw${c === this.#color ? " on" : ""}" type="button" data-color="${c}" data-tip="${name}" style="--sw:${c}" aria-label="${name}"></button>`;
        })
        .join("");
      const isCustom = !!this.#color && !this.#swatches.includes(this.#color);
      return `<div class="swatches" data-swatches>${sw}<button class="sw sw-custom${isCustom ? " on" : ""}" type="button" data-custom data-tip="Custom" aria-label="Custom colour"></button></div>`;
    }
    return (
      `<div class="db-pop-label">Stroke width · <b data-w-val>${this.#width}</b> px</div>` +
      `<input type="range" data-width min="1" max="96" value="${this.#width}" />`
    );
  }

  #wirePop(which: string, pop: HTMLElement): void {
    if (which === "style") {
      pop.querySelector("[data-style]")?.addEventListener("click", (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>("[data-dash]");
        if (!t) return;
        this.#dash = (t.getAttribute("data-dash") as Dash) ?? "solid";
        pop.querySelectorAll(".seg-opt").forEach((s) => s.classList.toggle("on", s === t));
        this.#renderStyleBtn();
        this.#emit({ style: this.#style() });
      });
    } else if (which === "color") {
      pop.querySelector("[data-swatches]")?.addEventListener("click", (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>(".sw");
        if (!t) return;
        if (t.hasAttribute("data-custom")) {
          this.#openPicker(pop);
          return;
        }
        this.#color = t.getAttribute("data-color") ?? this.#color;
        this.#syncColorDot();
        this.#emit({ color: this.#color });
        this.#closePop();
      });
    } else {
      const wIn = pop.querySelector<HTMLInputElement>("[data-width]");
      const wVal = pop.querySelector<HTMLElement>("[data-w-val]");
      wIn?.addEventListener("input", () => {
        this.#width = Number(wIn.value);
        if (wVal) wVal.textContent = String(this.#width);
        this.#emit({ width: this.#width });
      });
    }
  }

  #openPicker(anchorPop: HTMLElement): void {
    // Hide the swatch's "Custom" tooltip while picking — on touch a tap leaves it stuck in :hover,
    // so it'd linger under the picker. The class rides along with the popover (gone on close).
    anchorPop.querySelector("[data-custom]")?.classList.add("tip-off");
    if (!this.#picker) {
      this.#picker = document.createElement("co-color-picker") as CoColorPicker;
      document.body.appendChild(this.#picker);
      this.#picker.addEventListener("color-change", (e) => {
        this.#color = (e as CustomEvent<{ color: string }>).detail.color;
        this.#syncColorDot();
        this.#syncSwatchSelection(); // move the popover's selection ring onto the custom swatch
        this.#emit({ color: this.#color });
      });
    }
    this.#picker.value = this.#color || "#1E1E1E";
    this.#picker.classList.remove("hidden"); // un-hide first so offsetHeight/Width are measurable
    const r = anchorPop.getBoundingClientRect();
    if (window.matchMedia("(max-width: 640px)").matches) {
      // mobile: right-align the picker with the colour popover and stack it ABOVE (not over) it,
      // so both stay visible — picker on top, then the palette, then the sheet.
      const w = this.#picker.offsetWidth || 232;
      const h = this.#picker.offsetHeight || 260;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      this.#picker.style.left = `${left}px`;
      this.#picker.style.top = `${Math.max(8, r.top - h - 10)}px`;
    } else {
      this.#picker.style.left = `${r.right + 8}px`;
      this.#picker.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - 280))}px`;
    }
  }

  // Reflect the active colour in the open popover's swatch ring — the custom (rainbow) swatch
  // lights up when the colour isn't one of the presets.
  #syncSwatchSelection(): void {
    const pop = this.#pop;
    if (!pop) return;
    const isCustom = !this.#swatches.includes(this.#color);
    pop.querySelectorAll<HTMLElement>(".sw").forEach((s) => {
      const on = s.hasAttribute("data-custom")
        ? isCustom
        : s.getAttribute("data-color") === this.#color;
      s.classList.toggle("on", on);
    });
  }

  #emit(detail: PenChange): void {
    this.dispatchEvent(new CustomEvent("pen-change", { detail, bubbles: true }));
  }
}

if (!customElements.get("co-draw-bar")) customElements.define("co-draw-bar", CoDrawBar);

declare global {
  interface HTMLElementTagNameMap {
    "co-draw-bar": CoDrawBar;
  }
}
