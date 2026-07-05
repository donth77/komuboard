// Mobile "Insert" launcher sheet — opened by the dock's + button on phones, where the five insert
// tools (sticky / text / shape / stamp / image) are collapsed behind it. Tapping an option activates
// that tool (or opens the image picker), then the sheet closes. It's a mini-sheet like draw/sticky/
// shape, so it slides up flush out of the dock and collapses via its grab handle. Tablet/desktop never
// show it — the five tools sit inline in the dock there (CSS).
import { icon } from "../icons";
import { applyTranslations } from "../i18n";
import { ensureSheetHandle, wireSheetHandle } from "../mobile-sheet";

export type InsertKind = "sticky" | "text" | "shapes" | "stamp" | "image";

export interface InsertSheet {
  readonly el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export function createInsertSheet(onPick: (kind: InsertKind) => void): InsertSheet {
  const sheet = document.createElement("div");
  sheet.className = "insert-sheet mini-sheet hidden";
  sheet.setAttribute("role", "menu");
  sheet.setAttribute("data-i18n-aria", "tool.insert");
  const row = document.createElement("div");
  row.className = "insert-row";

  const make = (kind: InsertKind, key: string, iconName: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "insert-btn";
    b.dataset.insert = kind;
    b.dataset.i18nAria = key;
    b.innerHTML = `${icon(iconName, "insert-ico")}<span class="insert-label" data-i18n="${key}"></span>`;
    b.addEventListener("click", () => onPick(kind));
    return b;
  };

  row.append(
    make("sticky", "insert.sticky", "sticky"),
    make("text", "tool.text", "text"),
    make("shapes", "insert.shape", "shapes"),
    make("stamp", "tool.stamp", "stamp"),
    make("image", "tool.image", "image"),
  );
  sheet.append(row);
  wireSheetHandle(sheet, ensureSheetHandle(sheet)); // grab-handle drag-to-collapse (prepends the handle)
  (document.querySelector(".sheet-wrap") ?? document.body).appendChild(sheet);
  applyTranslations(sheet); // fill in the button labels + aria for the active locale

  return {
    el: sheet,
    open() {
      sheet.classList.remove("hidden", "collapsed");
    },
    close() {
      sheet.classList.add("hidden");
    },
    get isOpen() {
      return !sheet.classList.contains("hidden");
    },
  };
}
