// <co-zoombar> — the zoom + fullscreen widget (light-DOM Web Component).
//
// Buttons/typed-% emit a single `zoom` event ({ action, value? }); the host
// pushes the live zoom level back in via the `percent` property (without
// clobbering an in-progress edit). Reuses the global `.zoombar` / `.zb` styles.
// See docs/adr/0005.

import { icon } from "./icons";

export interface ZoomDetail {
  action: "in" | "out" | "reset" | "fullscreen" | "set";
  value?: number; // percent, for action "set"
}

export class CoZoombar extends HTMLElement {
  #percent = 100;
  #input?: HTMLInputElement;
  #wired = false;

  connectedCallback(): void {
    this.classList.add("zoombar");
    if (this.#wired) return;
    this.#wired = true;
    this.innerHTML =
      '<button class="zb" data-act="out" type="button" aria-label="Zoom out" data-tip="Zoom out">−</button>' +
      '<span class="zb pct" data-tip="Zoom level"><input type="text" inputmode="numeric" value="100" aria-label="Zoom level (percent)" />%</span>' +
      '<button class="zb" data-act="in" type="button" aria-label="Zoom in" data-tip="Zoom in">+</button>' +
      '<span class="zb-sep"></span>' +
      `<button class="zb" data-act="reset" type="button" aria-label="Reset zoom" data-tip="Reset zoom">${icon("fit", "ico-sm")}</button>` +
      `<button class="zb" data-act="fullscreen" type="button" aria-label="Toggle fullscreen" data-tip="Toggle fullscreen">${icon("expand", "ico-sm")}</button>`;
    this.#input = this.querySelector("input") ?? undefined;

    this.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement | null)
        ?.closest<HTMLElement>("[data-act]")
        ?.getAttribute("data-act");
      if (act === "in" || act === "out" || act === "reset" || act === "fullscreen") {
        this.dispatchEvent(
          new CustomEvent<ZoomDetail>("zoom", { detail: { action: act }, bubbles: true }),
        );
      }
    });

    const inp = this.#input;
    inp?.addEventListener("focus", () => inp.select());
    inp?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.#commit();
        inp.blur();
      } else if (e.key === "Escape") {
        inp.value = String(this.#percent);
        inp.blur();
      }
    });
    inp?.addEventListener("blur", () => this.#commit());
  }

  get percent(): number {
    return this.#percent;
  }
  set percent(p: number) {
    this.#percent = p;
    // don't clobber what the user is typing
    if (this.#input && document.activeElement !== this.#input) this.#input.value = String(p);
  }

  #commit(): void {
    if (!this.#input) return;
    const pct = parseInt(this.#input.value.replace(/[^0-9]/g, ""), 10);
    if (Number.isFinite(pct) && pct > 0) {
      this.dispatchEvent(
        new CustomEvent<ZoomDetail>("zoom", {
          detail: { action: "set", value: pct },
          bubbles: true,
        }),
      );
    } else {
      this.#input.value = String(this.#percent); // revert invalid input
    }
  }
}

if (!customElements.get("co-zoombar")) customElements.define("co-zoombar", CoZoombar);

declare global {
  interface HTMLElementTagNameMap {
    "co-zoombar": CoZoombar;
  }
}
