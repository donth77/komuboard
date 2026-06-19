// <co-drawer> — slide-out menu drawer + scrim (light-DOM Web Component).
//
// Opened by the hamburger in <co-topbar> (host sets `open = true`); it closes
// itself when the scrim is clicked. On mobile it hosts the settings controls
// (grid style + theme switch) — the gear/Settings dialog is hidden on mobile.
// The controls are shared with the desktop dialog (settings-controls.ts) and
// wired centrally in main.ts via delegation, so the drawer just renders them.
// App state (theme, grid, room) stays in main.ts. Reuses the global `.drawer` /
// `.drawer-scrim` styles; the host is `display: contents` so the position:fixed
// scrim/panel render exactly as before. See docs/adr/0005.

import { icon } from "./icons";
import { settingsControlsHTML } from "./settings-controls";

export class CoDrawer extends HTMLElement {
  #wired = false;
  #panel: HTMLElement | null = null;
  #scrim: HTMLElement | null = null;

  connectedCallback(): void {
    this.style.display = "contents"; // transparent wrapper; the children are position:fixed
    if (this.#wired) return;
    this.#wired = true;
    const room = this.getAttribute("room") ?? "";
    this.innerHTML =
      '<div class="drawer-scrim" id="drawer-scrim" data-act="close"></div>' +
      '<aside class="drawer" id="drawer" aria-label="Menu">' +
      '<div class="drawer-head"><span class="logo">◳</span> <strong>Coboard</strong></div>' +
      `<div class="drawer-room">Room · <strong>${room}</strong></div>` +
      settingsControlsHTML() +
      `<button class="drawer-item" data-act="help" type="button"><span>Keyboard shortcuts</span><span class="drawer-item-ic">${icon("help")}</span></button>` +
      "</aside>";
    this.#scrim = this.querySelector(".drawer-scrim");
    this.#panel = this.querySelector(".drawer");

    this.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement | null)
        ?.closest<HTMLElement>("[data-act]")
        ?.getAttribute("data-act");
      if (act === "close") this.open = false;
      else if (act === "help") {
        this.open = false;
        this.dispatchEvent(new CustomEvent("help", { bubbles: true }));
      }
    });
  }

  get open(): boolean {
    return this.#panel?.classList.contains("open") ?? false;
  }
  set open(v: boolean) {
    this.#panel?.classList.toggle("open", v);
    this.#scrim?.classList.toggle("open", v);
  }

  get room(): string {
    return this.getAttribute("room") ?? "";
  }
  set room(r: string) {
    this.setAttribute("room", r);
    const el = this.querySelector<HTMLElement>(".drawer-room strong");
    if (el) el.textContent = r;
  }
}

if (!customElements.get("co-drawer")) customElements.define("co-drawer", CoDrawer);

declare global {
  interface HTMLElementTagNameMap {
    "co-drawer": CoDrawer;
  }
}
