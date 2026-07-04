// <komu-topbar> — the top app bar (light-DOM Web Component).
//
// Presentational shell: the hamburger menu button, the room pill (with the live
// connection dot), and the presence row. App state
// stays in main.ts — the bar takes `room` / connection via properties + setters
// and emits a `nav-toggle` intent (which main.ts routes to the desktop dropdown
// or the mobile drawer). Reuses the global `.topbar` styles + utility classes
// (light DOM). See docs/adr/0005.

import { icon } from "./icons";
import "./avatar-presence-row";

export class CoTopbar extends HTMLElement {
  #wired = false;
  #dot: HTMLElement | null = null;

  connectedCallback(): void {
    this.classList.add("topbar");
    this.setAttribute("role", "banner");
    if (this.#wired) return;
    this.#wired = true;
    const room = this.getAttribute("room") ?? "";
    this.innerHTML =
      '<div class="brand">' +
      `<button class="iconbtn nav-btn" id="nav-toggle" data-act="nav" type="button" aria-label="Menu">${icon("menu")}</button>` +
      '<span class="logo">◳</span> <span class="brand-name">Komuboard</span>' +
      "</div>" +
      // On-screen undo / redo / reset-view — shown only on the touch layout (CSS), where there's no
      // keyboard for ⌘Z / zoom-to-fit.
      '<div class="tb-history">' +
      `<button class="iconbtn tb-undo" data-act="undo" type="button" data-testid="undo" aria-label="Undo" title="Undo">${icon("undo")}</button>` +
      `<button class="iconbtn tb-redo" data-act="redo" type="button" data-testid="redo" aria-label="Redo" title="Redo">${icon("redo")}</button>` +
      `<button class="iconbtn tb-fit" data-act="reset-view" type="button" data-testid="reset-view" aria-label="Reset view" title="Reset view">${icon("fit")}</button>` +
      "</div>" +
      `<div class="room-pill" data-testid="room"><span class="dot" data-testid="dot"></span> <strong>${room}</strong></div>` +
      '<div class="spacer"></div>' +
      // per-avatar tooltips live on the avatars themselves (a host title would double up)
      '<komu-avatar-presence-row id="presence-row" data-testid="presence-row"></komu-avatar-presence-row>' +
      // icon-only Share, pinned to the far right with the presence row immediately to its left
      `<button class="btn-share" data-act="share" type="button" data-testid="share" aria-label="Share board" title="Share board">${icon("share", "ico")}</button>`;

    this.#dot = this.querySelector('[data-testid="dot"]');

    this.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement | null)
        ?.closest<HTMLElement>("[data-act]")
        ?.getAttribute("data-act");
      if (act === "nav") this.dispatchEvent(new CustomEvent("nav-toggle", { bubbles: true }));
      else if (act === "share")
        this.dispatchEvent(new CustomEvent("share-board", { bubbles: true }));
      else if (act === "undo") this.dispatchEvent(new CustomEvent("undo", { bubbles: true }));
      else if (act === "redo") this.dispatchEvent(new CustomEvent("redo", { bubbles: true }));
      else if (act === "reset-view")
        this.dispatchEvent(new CustomEvent("reset-view", { bubbles: true }));
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

  /** Connection status → the room-pill dot colour. */
  setStatus(status: string): void {
    if (this.#dot && this.#dot.dataset.state !== status) this.#dot.dataset.state = status;
  }
}

if (!customElements.get("komu-topbar")) customElements.define("komu-topbar", CoTopbar);

declare global {
  interface HTMLElementTagNameMap {
    "komu-topbar": CoTopbar;
  }
}
