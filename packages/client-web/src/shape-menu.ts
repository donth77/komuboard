// <co-shape-menu> — the "Shapes and lines" picker: a vertical FigJam-style menu (lines/arrows on
// top, shapes below) shown when the Shapes tool is active. Picking an item sets the kind drawn next
// and emits `shape-change` (bubbling → #app in main.ts → canvas). Light DOM. Sibling of <co-draw-bar>.

export type ShapeChoice =
  | "line"
  | "arrow"
  | "elbow"
  | "block"
  | "rectangle"
  | "ellipse"
  | "rhombus"
  | "triangle"
  | "divider";

/** Wrap inner SVG markup in a styled <svg>. `inner` is the full element(s) — paths included. */
function smIco(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="sm-ico">${inner}</svg>`;
}

interface Item {
  kind: ShapeChoice;
  label: string;
  svg: string;
  /** Draw a divider above this item (separates the lines/arrows group from the shapes group). */
  sep?: boolean;
}

const ITEMS: readonly Item[] = [
  { kind: "line", label: "Line", svg: '<path d="M5 19 19 5"/>' },
  { kind: "arrow", label: "Arrow", svg: '<path d="M5 19 18 6M11.5 6H18v6.5"/>' },
  { kind: "elbow", label: "Elbow arrow", svg: '<path d="M6 4v8a3 3 0 0 0 3 3h6M13 12l4 3-4 3"/>' },
  {
    kind: "block",
    label: "Block arrow",
    svg: '<path d="m4 20 9.5-9.5"/><path d="M9.5 6.5 18 5l-1.5 8.5z"/>',
  },
  {
    kind: "rectangle",
    label: "Rectangle",
    sep: true,
    svg: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  },
  { kind: "ellipse", label: "Oval", svg: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>' },
  { kind: "rhombus", label: "Rhombus", svg: '<path d="M12 4 20 12 12 20 4 12z"/>' },
  { kind: "triangle", label: "Triangle", svg: '<path d="M12 5 20 19H4z"/>' },
  { kind: "divider", label: "Divider", svg: '<path d="M4 12h16"/>' },
];

export class CoShapeMenu extends HTMLElement {
  #value: ShapeChoice = "rectangle";
  #wired = false;

  connectedCallback(): void {
    this.classList.add("shape-menu");
    this.setAttribute("role", "menu");
    this.setAttribute("aria-label", "Shapes and lines");
    if (this.#wired) return;
    this.#wired = true;
    this.innerHTML = ITEMS.map(
      (it) =>
        `<button class="sm-item${it.sep ? " sm-sep" : ""}" type="button" role="menuitemradio" data-kind="${it.kind}">` +
        smIco(it.svg) +
        `<span class="sm-label">${it.label}</span>` +
        "</button>",
    ).join("");
    this.#sync();
    this.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".sm-item");
      const kind = btn?.getAttribute("data-kind") as ShapeChoice | undefined;
      if (!kind) return;
      this.value = kind;
      this.dispatchEvent(new CustomEvent("shape-change", { detail: { kind }, bubbles: true }));
    });
  }

  get value(): ShapeChoice {
    return this.#value;
  }
  set value(v: ShapeChoice) {
    this.#value = v;
    this.#sync();
  }

  #sync(): void {
    for (const b of this.querySelectorAll<HTMLElement>(".sm-item")) {
      const on = b.getAttribute("data-kind") === this.#value;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  }
}

if (!customElements.get("co-shape-menu")) customElements.define("co-shape-menu", CoShapeMenu);

declare global {
  interface HTMLElementTagNameMap {
    "co-shape-menu": CoShapeMenu;
  }
}
