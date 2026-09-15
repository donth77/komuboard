// <komu-shape-menu> — the "Shapes and lines" picker: a vertical menu (lines/arrows on
// top, the four core shapes below, then "More shapes") shown when the Shapes tool is active.
// Picking an item sets the kind drawn next and emits `shape-change` (bubbling → #app in main.ts →
// canvas); "More shapes" emits `shape-more` (→ main.ts opens <komu-shape-panel>). While a shape
// picked from the panel is armed, the More row shows THAT shape's icon + name (highlighted) so the
// user can see what a tap will place. Light DOM. Sibling of <komu-draw-bar>. On mobile it's a mini
// bottom-sheet (drag-to-collapse) like the draw bar — see mobile-sheet.ts.

import { shapeDef, type ConnectorKind } from "@komuboard/shared";

import { applyTranslations, onLocaleChange, t } from "./i18n";
import { ensureSheetHandle, wireSheetHandle } from "./mobile-sheet";

/** A menu pick: one of the four connectors, one of the four core shapes, or (via the panel) any
 *  catalog id / "custom". */
export type ShapeChoice = string;

/** Wrap inner SVG markup in a styled <svg>. `inner` is the full element(s) — paths included. */
function smIco(inner: string, cls = "sm-ico"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export interface LineItem {
  kind: ConnectorKind;
  /** i18n key (en.ts) — drives the aria-label + visible label via the data-i18n sweep. */
  key: string;
  svg: string;
}

/** The four connectors (shared with the shapes panel's "Lines" section). */
export const LINE_ITEMS: readonly LineItem[] = [
  { kind: "line", key: "shape.line", svg: '<path d="M5 19 19 5"/>' },
  { kind: "arrow", key: "shape.arrow", svg: '<path d="M5 19 18 6M11.5 6H18v6.5"/>' },
  { kind: "elbow", key: "shape.elbow", svg: '<path d="M6 4v8a3 3 0 0 0 3 3h6M13 12l4 3-4 3"/>' },
  {
    kind: "block",
    key: "shape.block",
    svg: '<path d="m4 20 9.5-9.5"/><path d="M9.5 6.5 18 5l-1.5 8.5z"/>',
  },
];

/** A connector's icon in the panel's tile style. */
export function lineIconSvg(item: LineItem, cls = "sp-ico"): string {
  return smIco(item.svg, cls);
}

interface ShapeItem {
  kind: string;
  key: string;
  svg: string;
}

/** The four core shapes that stay on the menu (the panel has the rest). */
const SHAPE_ITEMS: readonly ShapeItem[] = [
  {
    kind: "rectangle",
    key: "shape.rectangle",
    svg: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  },
  { kind: "ellipse", key: "shape.ellipse", svg: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>' },
  { kind: "rhombus", key: "shape.rhombus", svg: '<path d="M12 4 20 12 12 20 4 12z"/>' },
  { kind: "triangle", key: "shape.triangle", svg: '<path d="M12 5 20 19H4z"/>' },
];

const MENU_KINDS = new Set<string>([
  ...LINE_ITEMS.map((i) => i.kind),
  ...SHAPE_ITEMS.map((i) => i.kind),
]);

// "More shapes": a square, a circle, a triangle, and a plus.
const MORE_SVG =
  '<rect x="3" y="3" width="7.5" height="7.5" rx="1.2"/><circle cx="17.2" cy="6.8" r="3.8"/><path d="M6.8 13.5 3 20.5h7.5z"/><path d="M17.2 13.5v7M13.7 17h7"/>';

/** What the More row shows while a panel-picked shape is armed. */
export interface ArmedMeta {
  label: string;
  /** Inline <svg> markup. */
  icon: string;
}

export class CoShapeMenu extends HTMLElement {
  #value: ShapeChoice = "rectangle";
  #armed: ArmedMeta | null = null;
  #wired = false;

  connectedCallback(): void {
    this.classList.add("shape-menu", "mini-sheet");
    this.setAttribute("role", "menu");
    this.setAttribute("data-i18n-aria", "tool.shapes");
    if (this.#wired) return;
    this.#wired = true;
    const item = (it: { kind: string; key: string; svg: string }, cls = ""): string =>
      // No data-tip: the visible label already names it on desktop (the icon-only mobile sheet
      // doesn't use hover tooltips), so a tooltip would just echo the label.
      `<button class="sm-item${cls}" type="button" role="menuitemradio" data-kind="${it.kind}" data-i18n-aria="${it.key}">` +
      smIco(it.svg) +
      `<span class="sm-label" data-i18n="${it.key}"></span>` +
      "</button>";
    this.innerHTML =
      LINE_ITEMS.map((it) => item(it)).join("") +
      SHAPE_ITEMS.map((it, i) => item(it, i === 0 ? " sm-sep" : "")).join("") +
      // "More shapes" opens the full panel; it doubles as the armed-shape readout (see #sync).
      `<button class="sm-item sm-sep sm-more" type="button" role="menuitem" data-act="more" data-i18n-aria="shapes.more">` +
      `<span class="sm-more-ico">${smIco(MORE_SVG)}</span><span class="sm-label" data-i18n="shapes.more"></span>` +
      `<span class="sm-chevron" aria-hidden="true">›</span></button>`;
    applyTranslations(this); // translate the freshly-built menu items (aria + visible label)
    wireSheetHandle(this, ensureSheetHandle(this)); // mobile sheet drag-to-collapse
    this.#sync();
    onLocaleChange(() => this.#sync()); // the armed shape's name follows the language
    this.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-act='more']")) {
        this.dispatchEvent(new CustomEvent("shape-more", { bubbles: true }));
        return;
      }
      const btn = target.closest<HTMLElement>(".sm-item[data-kind]");
      const kind = btn?.getAttribute("data-kind");
      if (!kind) return;
      this.setArmed(kind);
      this.dispatchEvent(new CustomEvent("shape-change", { detail: { kind }, bubbles: true }));
    });
  }

  get value(): ShapeChoice {
    return this.#value;
  }
  set value(v: ShapeChoice) {
    this.setArmed(v);
  }

  /** Reflect the kind armed on the canvas. A kind the menu doesn't list (a panel pick) lights the
   *  More row and paints `meta`'s icon + name into it. */
  setArmed(kind: ShapeChoice, meta?: ArmedMeta): void {
    this.#value = kind;
    this.#armed = !MENU_KINDS.has(kind) && meta ? meta : null;
    this.#sync();
  }

  #sync(): void {
    for (const b of this.querySelectorAll<HTMLElement>(".sm-item[data-kind]")) {
      const on = b.getAttribute("data-kind") === this.#value;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    const more = this.querySelector<HTMLElement>(".sm-more");
    if (!more) return;
    const armed = !MENU_KINDS.has(this.#value);
    more.classList.toggle("on", armed);
    const ico = more.querySelector<HTMLElement>(".sm-more-ico");
    const label = more.querySelector<HTMLElement>(".sm-label");
    if (!ico || !label) return;
    if (armed && this.#armed) {
      // A catalog shape's name is looked up live (it follows the language); a custom shape keeps
      // the name the panel sent (its filename).
      const name = shapeDef(this.#value) ? t(`shape.${this.#value}`) : this.#armed.label;
      ico.innerHTML = this.#armed.icon;
      label.textContent = name;
      label.removeAttribute("data-i18n"); // a locale sweep must not overwrite the shape's name
      more.setAttribute("aria-label", `${name} (${t("shapes.more")})`);
    } else {
      ico.innerHTML = smIco(MORE_SVG);
      label.setAttribute("data-i18n", "shapes.more");
      label.textContent = t("shapes.more");
      more.setAttribute("aria-label", t("shapes.more"));
    }
  }
}

if (!customElements.get("komu-shape-menu")) customElements.define("komu-shape-menu", CoShapeMenu);

declare global {
  interface HTMLElementTagNameMap {
    "komu-shape-menu": CoShapeMenu;
  }
}
