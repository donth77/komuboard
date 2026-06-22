// <komu-sticky-bar> — the sticky-note colour palette: a horizontal pill of circular swatches, shown
// while the Sticky tool is active. Picking a swatch sets the colour of the next dropped note (and
// recolours the one being edited). Emits `sticky-color` (bubbling → handled on #app in main.ts →
// canvas). Light DOM; reuses the global `.sw` swatch styling. Sibling pattern to <komu-draw-bar>.

import { STICKY_COLORS, STICKY_COLOR_NAMES } from "@komuboard/shared";
import { ensureSheetHandle, wireSheetHandle } from "./mobile-sheet";

export class CoStickyBar extends HTMLElement {
  #color = "";
  #wired = false;

  connectedCallback(): void {
    this.classList.add("sticky-bar", "mini-sheet");
    this.setAttribute("role", "toolbar");
    this.setAttribute("aria-label", "Sticky note colours");
    if (this.#wired) return;
    this.#wired = true;
    this.innerHTML =
      '<div class="swatches" data-swatches>' +
      STICKY_COLORS.map((c) => {
        const name = STICKY_COLOR_NAMES[c.toUpperCase()] ?? c;
        return `<button class="sw" type="button" data-color="${c}" data-tip="${name}" style="--sw:${c}" aria-label="${name}"></button>`;
      }).join("") +
      "</div>";
    wireSheetHandle(this, ensureSheetHandle(this)); // mobile sheet drag-to-collapse
    this.#sync();
    this.addEventListener("click", (e) => {
      const sw = (e.target as HTMLElement).closest<HTMLElement>(".sw");
      const color = sw?.getAttribute("data-color");
      if (!color) return;
      this.color = color;
      this.dispatchEvent(new CustomEvent("sticky-color", { detail: { color }, bubbles: true }));
    });
  }

  get color(): string {
    return this.#color;
  }
  set color(c: string) {
    this.#color = c;
    this.#sync();
  }

  #sync(): void {
    const cur = this.#color.toLowerCase();
    for (const sw of this.querySelectorAll<HTMLElement>(".sw")) {
      sw.classList.toggle("on", (sw.getAttribute("data-color") ?? "").toLowerCase() === cur);
    }
  }
}

if (!customElements.get("komu-sticky-bar")) customElements.define("komu-sticky-bar", CoStickyBar);

declare global {
  interface HTMLElementTagNameMap {
    "komu-sticky-bar": CoStickyBar;
  }
}
