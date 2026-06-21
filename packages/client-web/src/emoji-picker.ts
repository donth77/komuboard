// <co-emoji-picker> — the FigJam-style emoji picker opened from the stamp wheel's "+". Category tabs +
// search + a lazy Noto-SVG grid (served from /emoji/<codepoint>.svg). Picking emits `emoji-pick`
// (detail.cp = codepoint) → main.ts → canvas.setStamp("emoji:<cp>") + recents. Light DOM.
import GROUPS from "./emoji-data.json";

type Emoji = { c: string; u: string; n: string };
type Group = { name: string; emojis: Emoji[] };
const groups = GROUPS as Group[];

function tile(e: Emoji): string {
  return (
    `<button class="ep-emoji" type="button" data-cp="${e.u}" title="${e.n}" aria-label="${e.n}">` +
    `<img src="/emoji/${e.u}.svg" alt="" loading="lazy" draggable="false"></button>`
  );
}

export class CoEmojiPicker extends HTMLElement {
  #wired = false;
  #active = 0;

  connectedCallback(): void {
    this.classList.add("co-emoji-picker");
    if (this.#wired) return;
    this.#wired = true;
    const tabs = groups
      .map(
        (g, i) =>
          `<button class="ep-tab${i === 0 ? " on" : ""}" type="button" data-tab="${i}" title="${g.name}" aria-label="${g.name}">` +
          `<img src="/emoji/${g.emojis[0]?.u}.svg" alt="" draggable="false"></button>`,
      )
      .join("");
    this.innerHTML =
      `<div class="ep-tabs">${tabs}</div>` +
      `<div class="ep-search"><input type="search" placeholder="Search" aria-label="Search emoji"></div>` +
      `<div class="ep-grid" role="listbox"></div>`;
    this.renderGrid();

    this.querySelector(".ep-tabs")?.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (!t) return;
      this.#active = Number(t.getAttribute("data-tab"));
      for (const b of this.querySelectorAll(".ep-tab")) b.classList.remove("on");
      t.classList.add("on");
      const input = this.querySelector<HTMLInputElement>(".ep-search input");
      if (input) input.value = "";
      this.renderGrid();
    });
    this.querySelector<HTMLInputElement>(".ep-search input")?.addEventListener("input", (e) => {
      this.renderGrid((e.target as HTMLInputElement).value.trim().toLowerCase());
    });
    this.querySelector(".ep-grid")?.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cp]");
      const cp = b?.getAttribute("data-cp");
      if (cp) this.dispatchEvent(new CustomEvent("emoji-pick", { detail: { cp }, bubbles: true }));
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
      html = hits.length ? hits.map(tile).join("") : `<div class="ep-empty">No emoji found</div>`;
    } else {
      html = (groups[this.#active]?.emojis ?? []).map(tile).join("");
    }
    grid.innerHTML = html;
    grid.scrollTop = 0;
  }
}

if (!customElements.get("co-emoji-picker")) customElements.define("co-emoji-picker", CoEmojiPicker);

declare global {
  interface HTMLElementTagNameMap {
    "co-emoji-picker": CoEmojiPicker;
  }
}
