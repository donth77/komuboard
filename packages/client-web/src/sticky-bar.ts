// <komu-sticky-bar> — the sticky-note colour palette: a horizontal pill of circular swatches, shown
// while the Sticky tool is active. Picking a swatch sets the colour of the next dropped note (and
// recolours the one being edited). Emits `sticky-color` (bubbling → handled on #app in main.ts →
// canvas). Light DOM; reuses the global `.sw` swatch styling. Sibling pattern to <komu-draw-bar>.

import { STICKY_COLORS, STICKY_COLOR_NAMES } from "@komuboard/shared";
import { t } from "./i18n";
import { ensureSheetHandle, wireSheetHandle } from "./mobile-sheet";

export class CoStickyBar extends HTMLElement {
  #color = "";
  #wired = false;

  connectedCallback(): void {
    this.classList.add("sticky-bar", "mini-sheet");
    this.setAttribute("role", "toolbar");
    this.setAttribute("data-i18n-aria", "sticky.barLabel");
    if (this.#wired) return;
    this.#wired = true;
    this.innerHTML =
      '<div class="swatches" data-swatches>' +
      STICKY_COLORS.map((c) => {
        const en = STICKY_COLOR_NAMES[c.toUpperCase()];
        const name = en ? t("color." + en.toLowerCase()) : c;
        return `<button class="sw" type="button" data-color="${c}" data-tip="${name}" style="--sw:${c}" aria-label="${name}"></button>`;
      }).join("") +
      "</div>";
    wireSheetHandle(this, ensureSheetHandle(this)); // mobile sheet drag-to-collapse
    // Pressing anywhere in the palette — a swatch, or the mobile grab handle — must not move focus.
    // A note you've just dropped is a focused contenteditable, and any focus change blurs it, which
    // COMMITS and closes the note; the pick that follows then has nothing left to recolour. Cancelling
    // the press keeps the edit session alive, so the swatch recolours the note you're typing on.
    // Same trick (and same event) the text bar uses. On touch the emulated mousedown still arrives
    // before focus moves, so this covers taps too.
    //
    // mousedown ONLY — do not add pointerdown here. WebKit (iOS Safari) swallows the click when
    // pointerdown is cancelled, so the swatch would go dead on exactly the devices this is for;
    // Chromium fires click either way and hides the breakage.
    this.addEventListener("mousedown", (e) => e.preventDefault());
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
