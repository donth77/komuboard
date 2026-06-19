// <co-topbar> — the top app bar (light-DOM Web Component).
//
// Presentational shell: brand + menu button, the room pill (with the live
// connection dot), the theme button, the dev connection readout, and the
// presence row. App state stays in main.ts — the bar takes `room` / `theme` /
// connection via properties + setters and emits `nav-toggle` + `theme-toggle`
// intents. Reuses the global `.topbar` styles + utility classes (light DOM).
// See docs/adr/0005.

import { icon } from "./icons";
import "./avatar-presence-row";

export class CoTopbar extends HTMLElement {
  #wired = false;
  #themeBtn: HTMLElement | null = null;
  #dot: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #synced: HTMLElement | null = null;

  connectedCallback(): void {
    this.classList.add("topbar");
    this.setAttribute("role", "banner");
    if (this.#wired) return;
    this.#wired = true;
    const room = this.getAttribute("room") ?? "";
    this.innerHTML =
      '<div class="brand">' +
      `<button class="iconbtn nav-btn" id="nav-toggle" data-act="nav" type="button" aria-label="Menu">${icon("menu")}</button>` +
      '<span class="logo">◳</span> <span class="brand-name">Coboard</span>' +
      "</div>" +
      `<div class="room-pill" data-testid="room"><span class="dot" data-testid="dot"></span> <strong>${room}</strong></div>` +
      '<button class="iconbtn theme-btn" id="theme-toggle" data-act="theme" type="button" aria-label="Toggle light / dark theme"></button>' +
      '<div class="spacer"></div>' +
      '<div class="devstatus" title="connection status">WS <b data-testid="status">connecting…</b> · <b data-testid="synced">syncing…</b></div>' +
      '<co-avatar-presence-row id="presence-row" data-testid="presence-row" title="People here — click your avatar to rename"></co-avatar-presence-row>';

    this.#themeBtn = this.querySelector(".theme-btn");
    this.#dot = this.querySelector('[data-testid="dot"]');
    this.#status = this.querySelector('[data-testid="status"]');
    this.#synced = this.querySelector('[data-testid="synced"]');

    this.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement | null)
        ?.closest<HTMLElement>("[data-act]")
        ?.getAttribute("data-act");
      if (act === "nav") this.dispatchEvent(new CustomEvent("nav-toggle", { bubbles: true }));
      else if (act === "theme")
        this.dispatchEvent(new CustomEvent("theme-toggle", { bubbles: true }));
    });
  }

  get room(): string {
    return this.getAttribute("room") ?? "";
  }
  set room(r: string) {
    this.setAttribute("room", r);
    const el = this.querySelector<HTMLElement>(".room-pill strong");
    if (el) el.textContent = r;
  }

  /** Theme-button glyph: sun in dark mode, moon in light. */
  set theme(t: "light" | "dark") {
    if (this.#themeBtn) this.#themeBtn.innerHTML = icon(t === "dark" ? "sun" : "moon");
  }

  /** Connection status → readout text + the room-pill dot colour. */
  setStatus(status: string): void {
    if (this.#status && this.#status.textContent !== status) this.#status.textContent = status;
    if (this.#dot && this.#dot.dataset.state !== status) this.#dot.dataset.state = status;
  }
  /** Yjs sync readout text. */
  setSynced(text: string): void {
    if (this.#synced && this.#synced.textContent !== text) this.#synced.textContent = text;
  }
}

if (!customElements.get("co-topbar")) customElements.define("co-topbar", CoTopbar);

declare global {
  interface HTMLElementTagNameMap {
    "co-topbar": CoTopbar;
  }
}
