// <komu-shape-panel> — the "Shapes" library panel opened from the shape menu's "More shapes":
// a search field over collapsible sections (Lines, Basic, Flowchart, Your shapes) of shape tiles,
// plus "Browse and upload SVG shapes" for the per-device custom library. Picking a tile emits
// `shape-change` (bubbling → main.ts → canvas.setShape) with the same detail as the menu, plus the
// custom geometry / a label + icon for the menu's armed-shape readout. Closing (X / Escape / a
// tool switch) emits `shape-panel-close`. Desktop: a side panel right of the dock, replacing the
// menu while open. Phone: a bottom sheet that closes after a pick. Light DOM.
import { CUSTOM_SHAPE, type CustomShape } from "@komuboard/shared";

import { icon } from "./icons";
import { applyTranslations, onLocaleChange, t } from "./i18n";
import { TOUCH_MEDIA } from "./platform";
import {
  catalogTiles,
  gridHtml,
  initGridTabStops,
  libraryTiles,
  wireGridKeys,
  type GridTile,
} from "./shape-grid";
import { importShapeSvg, ShapeImportError } from "./shape-import";
import {
  addToLibrary,
  LibraryFullError,
  removeFromLibrary,
  onLibraryChange,
} from "./shape-library";
import { LINE_ITEMS, lineIconSvg } from "./shape-menu";

/** `shape-change` detail from the panel (the menu sends just `{ kind }`). */
export interface ShapePickDetail {
  kind: string;
  custom?: CustomShape;
  label: string;
  icon: string;
  source: "panel";
}

type SectionId = "lines" | "basic" | "flowchart" | "yours";
const SECTIONS: ReadonlyArray<readonly [SectionId, string]> = [
  ["lines", "shapes.lines"],
  ["basic", "shapes.basic"],
  ["flowchart", "shapes.flowchart"],
  ["yours", "shapes.yours"],
];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export class CoShapePanel extends HTMLElement {
  #wired = false;
  #query = "";
  #armed: string | null = null;
  #collapsed = new Set<SectionId>();
  #body: HTMLElement | null = null;
  #search: HTMLInputElement | null = null;
  #file: HTMLInputElement | null = null;

  connectedCallback(): void {
    this.classList.add("komu-shape-panel");
    this.setAttribute("role", "dialog");
    this.setAttribute("data-i18n-aria", "shapes.title");
    if (this.#wired) return;
    this.#wired = true;
    this.innerHTML =
      `<div class="sp-head"><h2 class="sp-title" data-i18n="shapes.title"></h2>` +
      `<button class="sp-close" type="button" data-act="close" data-i18n-aria="common.close" data-i18n-tip="common.close">✕</button></div>` +
      `<div class="sp-search"><input type="search" autocomplete="off" spellcheck="false" data-i18n-placeholder="shapes.search" data-i18n-aria="shapes.searchAria"></div>` +
      `<div class="sp-body"></div>` +
      `<input class="sp-file" type="file" accept=".svg,image/svg+xml" multiple hidden>`;
    this.#body = this.querySelector(".sp-body");
    this.#search = this.querySelector(".sp-search input");
    this.#file = this.querySelector(".sp-file");
    applyTranslations(this);
    this.render();
    onLocaleChange(() => this.render());
    onLibraryChange(() => this.render());
    wireGridKeys(this);

    this.#search?.addEventListener("input", () => {
      this.#query = this.#search?.value ?? "";
      this.render();
    });
    this.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // the panel owns its Esc (main.ts's handler would also cancel the tool)
      if (this.#query && e.target === this.#search) {
        // first Esc in a non-empty search clears it (native search-field behaviour), second closes
        this.#query = "";
        if (this.#search) this.#search.value = "";
        this.render();
        return;
      }
      this.close();
    });
    this.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const act = target.closest<HTMLElement>("[data-act]")?.getAttribute("data-act");
      if (act === "close") return this.close();
      if (act === "upload") return this.#file?.click();
      const toggle = target.closest<HTMLElement>("[data-toggle]")?.getAttribute("data-toggle");
      if (toggle) return this.#toggleSection(toggle as SectionId);
      const remove = target.closest<HTMLElement>("[data-remove]")?.getAttribute("data-remove");
      if (remove) return removeFromLibrary(remove); // the library listener re-renders
      const tile = target.closest<HTMLElement>(".sp-tile[data-kind]");
      if (tile) this.#pick(tile);
    });
    this.#file?.addEventListener("change", () => {
      const files = this.#file?.files ? [...this.#file.files] : [];
      if (this.#file) this.#file.value = ""; // re-picking the same file must fire "change" again
      void this.#upload(files);
    });
  }

  /** Show the panel (and put the keyboard in the search field on pointer devices). */
  open(): void {
    this.classList.remove("hidden");
    if (!window.matchMedia(TOUCH_MEDIA).matches)
      requestAnimationFrame(() => this.isOpen && this.#search?.focus());
  }
  close(): void {
    if (!this.isOpen) return;
    this.classList.add("hidden");
    this.dispatchEvent(new CustomEvent("shape-panel-close", { bubbles: true }));
  }
  get isOpen(): boolean {
    return !this.classList.contains("hidden");
  }

  /** The armed tile key (catalog id / `custom:<library id>` / connector kind) — highlights it. */
  get armed(): string | null {
    return this.#armed;
  }
  set armed(key: string | null) {
    this.#armed = key;
    for (const b of this.querySelectorAll<HTMLElement>(".sp-tile")) {
      const on = b.getAttribute("data-key") === key;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
  }

  #lineTiles(): GridTile[] {
    const q = this.#query.trim().toLowerCase();
    return LINE_ITEMS.filter(
      (li) => !q || t(li.key).toLowerCase().includes(q) || li.kind.includes(q),
    ).map((li) => ({ key: li.kind, kind: li.kind, label: t(li.key), icon: lineIconSvg(li) }));
  }

  #tilesFor(id: SectionId): GridTile[] {
    if (id === "lines") return this.#lineTiles();
    if (id === "yours") return libraryTiles(this.#query);
    return catalogTiles(id, this.#query);
  }

  private render(): void {
    const body = this.#body;
    if (!body) return;
    const q = this.#query.trim();
    if (q) {
      // Search mode: one flat grid of every match across sections (or the empty state).
      const all = SECTIONS.flatMap(([id]) => this.#tilesFor(id));
      body.innerHTML = all.length
        ? gridHtml(all, this.#armed, {
            removable: false,
            label: t("shapes.title"),
            cls: "sp-results",
          })
        : `<div class="sp-empty">${esc(t("shapes.noResults"))}</div>`;
    } else {
      body.innerHTML = SECTIONS.map(([id, key]) => this.#section(id, key)).join("");
    }
    initGridTabStops(body);
  }

  #section(id: SectionId, titleKey: string): string {
    const open = !this.#collapsed.has(id);
    const tiles = this.#tilesFor(id);
    const yours = id === "yours";
    const hint = yours
      ? `<button class="sp-hint" type="button" aria-label="${esc(t("shapes.yoursHint"))}" data-tip="${esc(t("shapes.yoursHint"))}">${icon("info", "sp-hint-ico")}</button>`
      : "";
    const upload = yours
      ? `<button class="sp-upload" type="button" data-act="upload">${icon("upload", "sp-upload-ico")}<span>${esc(t("shapes.upload"))}</span></button>`
      : "";
    const grid = tiles.length
      ? gridHtml(tiles, this.#armed, { removable: yours, label: t(titleKey) })
      : "";
    return (
      `<section class="sp-section" data-section="${id}">` +
      `<div class="sp-section-row"><button class="sp-section-head" type="button" data-toggle="${id}" aria-expanded="${open}">` +
      `<span class="sp-section-title">${esc(t(titleKey))}</span><span class="sp-chevron" aria-hidden="true">${icon("chevron", "sp-chevron-ico")}</span></button>${hint}</div>` +
      `<div class="sp-section-body"${open ? "" : " hidden"}>${grid}${upload}</div></section>`
    );
  }

  #toggleSection(id: SectionId): void {
    if (this.#collapsed.has(id)) this.#collapsed.delete(id);
    else this.#collapsed.add(id);
    const sec = this.querySelector<HTMLElement>(`.sp-section[data-section="${id}"]`);
    const open = !this.#collapsed.has(id);
    sec?.querySelector(".sp-section-head")?.setAttribute("aria-expanded", String(open));
    const body = sec?.querySelector<HTMLElement>(".sp-section-body");
    if (body) body.hidden = !open;
  }

  #pick(tile: HTMLElement): void {
    const kind = tile.getAttribute("data-kind") ?? "";
    const key = tile.getAttribute("data-key") ?? kind;
    const detail: ShapePickDetail = {
      kind,
      label: tile.getAttribute("aria-label") ?? kind,
      icon: tile.innerHTML,
      source: "panel",
    };
    if (kind === CUSTOM_SHAPE) {
      const lib = tile.getAttribute("data-library");
      const entry = lib ? libraryTiles().find((tl) => tl.libraryId === lib) : undefined;
      if (!entry?.custom) return; // removed meanwhile
      detail.custom = entry.custom;
    }
    this.armed = key;
    this.dispatchEvent(new CustomEvent<ShapePickDetail>("shape-change", { detail, bubbles: true }));
  }

  async #upload(files: File[]): Promise<void> {
    let added = false;
    for (const file of files) {
      try {
        const shape = await importShapeSvg(file);
        addToLibrary({ name: file.name, ...shape }); // the library listener re-renders the grid
        added = true;
      } catch (err) {
        const message =
          err instanceof ShapeImportError
            ? err.message
            : err instanceof LibraryFullError
              ? t("toast.svgLibraryFull")
              : t("toast.svgInvalid");
        this.dispatchEvent(new CustomEvent("komu-toast", { detail: { message }, bubbles: true }));
      }
    }
    if (!added) return;
    // Reveal the new tile: expand "Your shapes" if it was collapsed and scroll it into view.
    if (this.#collapsed.delete("yours")) this.render();
    this.querySelector('.sp-section[data-section="yours"]')?.scrollIntoView({ block: "end" });
  }
}

if (!customElements.get("komu-shape-panel"))
  customElements.define("komu-shape-panel", CoShapePanel);

declare global {
  interface HTMLElementTagNameMap {
    "komu-shape-panel": CoShapePanel;
  }
}
