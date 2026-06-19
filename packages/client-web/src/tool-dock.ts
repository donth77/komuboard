// <co-tool-dock> — the floating tool dock (light-DOM Web Component).
//
// Owns its button list + active-state rendering; selection goes out via a
// `tool-change` event, and the host can drive the active tool back in via the
// `tool` property (e.g. when a keyboard shortcut switches tools). Reuses the
// global `.dock` / `.tool` styles. See docs/adr/0005.

import { icon } from "./icons";
import type { ToolId } from "./canvas";

// icon, key, label, tool (null = not yet wired — lands in a later M1 increment)
const TOOLS: ReadonlyArray<readonly [string, string, string, ToolId | null]> = [
  ["select", "v", "Select", "select"],
  ["hand", "h", "Hand", "hand"],
  ["pen", "p", "Draw", "pen"],
  ["sticky", "s", "Sticky note", null],
  ["text", "t", "Text", null],
  ["rect", "r", "Rectangle", null],
  ["ellipse", "o", "Ellipse", null],
];

export class CoToolDock extends HTMLElement {
  #active: ToolId = "select";
  #wired = false;

  connectedCallback(): void {
    this.classList.add("dock");
    this.setAttribute("role", "toolbar");
    this.setAttribute("aria-label", "Tools");
    if (this.#wired) return;
    this.#wired = true;
    this.innerHTML = TOOLS.map(([name, key, label, tool]) => {
      const tip = tool
        ? `${label} <kbd class="kbd">${key.toUpperCase()}</kbd>`
        : `${label} <span class="tip-soon">Soon</span>`;
      return `<button class="tool${tool ? "" : " disabled"}" type="button" data-tool="${tool ?? ""}" aria-label="${label}">${icon(name)}<span class="tool-tip">${tip}</span></button>`;
    }).join("");
    this.#sync();
    this.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(".tool[data-tool]");
      const tool = btn?.getAttribute("data-tool");
      if (!tool) return; // disabled / "coming soon"
      this.tool = tool as ToolId;
      this.dispatchEvent(new CustomEvent("tool-change", { detail: { tool }, bubbles: true }));
    });
  }

  get tool(): ToolId {
    return this.#active;
  }
  set tool(t: ToolId) {
    this.#active = t;
    this.#sync();
  }

  #sync(): void {
    for (const b of this.querySelectorAll<HTMLElement>(".tool[data-tool]")) {
      b.classList.toggle("active", b.getAttribute("data-tool") === this.#active);
    }
  }
}

if (!customElements.get("co-tool-dock")) customElements.define("co-tool-dock", CoToolDock);

declare global {
  interface HTMLElementTagNameMap {
    "co-tool-dock": CoToolDock;
  }
}
