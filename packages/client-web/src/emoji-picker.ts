// <komu-emoji-picker> — the emoji picker opened from the stamp wheel's "+". Category tabs +
// search + a lazy Noto-SVG grid (served from /emoji/<codepoint>.svg). Picking emits `emoji-pick`
// (detail.cp = codepoint) → main.ts → canvas.setStamp("emoji:<cp>") + recents. Light DOM.
import GROUPS from "./emoji-data.json";
import { applyTranslations, t } from "./i18n";

type Emoji = { c: string; u: string; n: string };
type Group = { name: string; emojis: Emoji[] };
const groups = GROUPS as Group[];

function tile(e: Emoji): string {
  return (
    `<button class="ep-emoji" type="button" data-cp="${e.u}" title="${e.n}" aria-label="${e.n}" tabindex="-1">` +
    `<img src="/emoji/${e.u}.svg" alt="" loading="lazy" draggable="false"></button>`
  );
}

export class CoEmojiPicker extends HTMLElement {
  #wired = false;
  #active = 0;

  connectedCallback(): void {
    this.classList.add("komu-emoji-picker");
    if (this.#wired) return;
    this.#wired = true;
    const tabs = groups
      .map(
        (g, i) =>
          `<button class="ep-tab${i === 0 ? " on" : ""}" type="button" data-tab="${i}" title="${g.name}" aria-label="${g.name}" aria-pressed="${i === 0}">` +
          `<img src="/emoji/${g.emojis[0]?.u}.svg" alt="" draggable="false"></button>`,
      )
      .join("");
    this.innerHTML =
      `<div class="ep-tabs">${tabs}</div>` +
      `<div class="ep-search"><input type="search" data-i18n-placeholder="emoji.search" data-i18n-aria="emoji.searchAria"></div>` +
      `<div class="ep-grid"></div>`;
    this.renderGrid();
    applyTranslations(this); // translate the search field placeholder + aria for the active locale

    this.querySelector(".ep-tabs")?.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (!t) return;
      this.#active = Number(t.getAttribute("data-tab"));
      for (const b of this.querySelectorAll(".ep-tab")) {
        b.classList.remove("on");
        b.setAttribute("aria-pressed", "false");
      }
      t.classList.add("on");
      t.setAttribute("aria-pressed", "true");
      const input = this.querySelector<HTMLInputElement>(".ep-search input");
      if (input) input.value = "";
      this.renderGrid();
    });
    this.querySelector<HTMLInputElement>(".ep-search input")?.addEventListener("input", (e) => {
      this.renderGrid((e.target as HTMLInputElement).value.trim().toLowerCase());
    });
    const grid = this.querySelector<HTMLElement>(".ep-grid");
    grid?.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cp]");
      const cp = b?.getAttribute("data-cp");
      if (cp) this.dispatchEvent(new CustomEvent("emoji-pick", { detail: { cp }, bubbles: true }));
    });
    // Arrow-key grid navigation (roving tabindex) so the hundreds of tiles are ONE tab stop, not
    // hundreds. Enter/Space activate natively (they're buttons); column count is measured from the row.
    grid?.addEventListener("keydown", (e) => {
      const tiles = [...grid.querySelectorAll<HTMLElement>(".ep-emoji")];
      const cur = tiles.indexOf(document.activeElement as HTMLElement);
      if (cur < 0) return;
      const top0 = tiles[0]?.offsetTop ?? 0;
      let cols = 1;
      while (cols < tiles.length && tiles[cols]?.offsetTop === top0) cols++;
      let next = cur;
      if (e.key === "ArrowRight") next = Math.min(cur + 1, tiles.length - 1);
      else if (e.key === "ArrowLeft") next = Math.max(cur - 1, 0);
      else if (e.key === "ArrowDown") next = Math.min(cur + cols, tiles.length - 1);
      else if (e.key === "ArrowUp") next = Math.max(cur - cols, 0);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tiles.length - 1;
      else return;
      e.preventDefault();
      tiles[cur]!.tabIndex = -1;
      tiles[next]!.tabIndex = 0;
      tiles[next]!.focus();
    });
  }

  private renderGrid(query = ""): void {
    const grid = this.querySelector(".ep-grid");
    if (!grid) return;
    let html: string;
    if (query) {
      // search every group by name; keep it bounded so a 1-char query doesn't render 1,600 tiles
      const hits: Emoji[] = [];
      for (const g of groups) {
        for (const e of g.emojis) if (e.n.includes(query)) hits.push(e);
        if (hits.length > 300) break;
      }
      html = hits.length
        ? hits.map(tile).join("")
        : `<div class="ep-empty">${t("emoji.noResults")}</div>`;
    } else {
      html = (groups[this.#active]?.emojis ?? []).map(tile).join("");
    }
    grid.innerHTML = html;
    grid.scrollTop = 0;
    grid.querySelector<HTMLElement>(".ep-emoji")?.setAttribute("tabindex", "0"); // roving entry point
  }
}

if (!customElements.get("komu-emoji-picker"))
  customElements.define("komu-emoji-picker", CoEmojiPicker);

declare global {
  interface HTMLElementTagNameMap {
    "komu-emoji-picker": CoEmojiPicker;
  }
}
