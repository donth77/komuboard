// <komu-tool-dock> — the floating tool dock (light-DOM Web Component).
//
// Owns its button list + active-state rendering; selection goes out via a
// `tool-change` event, and the host can drive the active tool back in via the
// `tool` property (e.g. when a keyboard shortcut switches tools). Reuses the
// global `.dock` / `.tool` styles. See docs/adr/0005.

import { icon } from "./icons";
import type { ToolId } from "./canvas";

// icon, shortcut key, i18n key, tool (null = not yet wired). The i18n key drives the aria-label +
// tooltip via the data-i18n sweep (i18n.ts); the visible label is resolved at translate time.
const TOOLS: ReadonlyArray<readonly [string, string, string, ToolId | null]> = [
  ["select", "v", "tool.select", "select"],
  ["hand", "h", "tool.hand", "hand"],
  ["pen", "p", "tool.pen", "pen"],
  ["eraser", "e", "tool.eraser", "eraser"],
  // Phone-only "Insert" launcher: on small screens it replaces the five insert tools below (which CSS
  // hides), opening a sheet to pick one. On tablet/desktop it's hidden and all five show inline.
  ["plus", "", "tool.insert", "insert"],
  ["sticky", "s", "tool.sticky", "sticky"],
  ["text", "t", "tool.text", "text"],
  ["shapes", "r", "tool.shapes", "shapes"],
  ["stamp", "k", "tool.stamp", "stamp"],
  ["image", "i", "tool.image", "image"],
];

// The "drop an object" tools that collapse behind the Insert (+) launcher on phones.
const INSERT_TOOLS = new Set<ToolId>(["sticky", "text", "shapes", "stamp", "image"]);

export class CoToolDock extends HTMLElement {
  #active: ToolId = "select";
  #wired = false;

  connectedCallback(): void {
    this.classList.add("dock");
    this.setAttribute("role", "toolbar");
    this.setAttribute("data-i18n-aria", "tool.dockLabel");
    if (this.#wired) return;
    this.#wired = true;
    this.innerHTML = TOOLS.map(([name, key, msgKey, tool]) => {
      // Tooltip uses the body-level singleton (always top-most — never hidden under a submenu;
      // see tooltip.ts): beside the vertical dock, with the shortcut key as a chip for wired tools.
      const keyAttr = tool && key ? ` data-tip-key="${key.toUpperCase()}"` : "";
      const groupAttr = tool && INSERT_TOOLS.has(tool) ? ` data-group="insert"` : "";
      // data-i18n-tip / -aria are filled by the i18n sweep (label + tooltip in the active locale).
      return `<button class="tool${tool ? "" : " disabled"}" type="button" data-tool="${tool ?? ""}" data-i18n-tip="${msgKey}" data-tip-pos="right"${keyAttr}${groupAttr} data-i18n-aria="${msgKey}" aria-pressed="false">${icon(name)}</button>`;
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
      const on = b.getAttribute("data-tool") === this.#active;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("tip-off", on); // the active tool suppresses its own tooltip (you know what it is)
    }
  }
}

if (!customElements.get("komu-tool-dock")) customElements.define("komu-tool-dock", CoToolDock);

declare global {
  interface HTMLElementTagNameMap {
    "komu-tool-dock": CoToolDock;
  }
}
