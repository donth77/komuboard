// The Export dialog — pick a file type (PNG / PDF) and a background (Grid / Transparent / Solid), then
// Export. Reuses the shared <komu-dialog> chrome (title + close). The actual capture lives in the
// canvas (exportCanvas) + main.ts (blob / PDF + download); this module is just the picker UI.

import { createDialog } from "../dialog";
import { t } from "../i18n";

export type ExportFormat = "png" | "pdf";
export type ExportBackground = "grid" | "transparent" | "solid";

export interface ExportDialog {
  open(): void;
}

const BG_LABEL_KEYS: Record<ExportBackground, string> = {
  grid: "export.bgGrid",
  transparent: "export.bgTransparent",
  solid: "export.bgSolid",
};
const BG_ORDER: ExportBackground[] = ["grid", "transparent", "solid"];

export function createExportDialog(
  onExport: (opts: { format: ExportFormat; background: ExportBackground }) => void,
): ExportDialog {
  let background: ExportBackground = "solid";

  const body =
    '<div class="export-row">' +
    '<span class="export-label" data-i18n="export.fileType"></span>' +
    '<div class="export-radios" role="radiogroup" data-i18n-aria="export.fileType">' +
    '<label class="export-radio"><input type="radio" name="komu-export-format" value="png" checked /><span>PNG</span></label>' +
    '<label class="export-radio"><input type="radio" name="komu-export-format" value="pdf" /><span>PDF</span></label>' +
    "</div>" +
    "</div>" +
    '<div class="export-row">' +
    '<span class="export-label" data-i18n="export.background"></span>' +
    '<div class="export-bg">' +
    '<button type="button" class="export-bg-btn" aria-haspopup="true" aria-expanded="false"><span class="export-bg-current"></span><span class="export-bg-caret" aria-hidden="true">⌄</span></button>' +
    '<div class="export-bg-menu hidden" role="menu">' +
    BG_ORDER.map(
      (k) =>
        `<button type="button" class="export-bg-opt" role="menuitemradio" data-bg="${k}" aria-checked="false"><span class="bg-check" aria-hidden="true">✓</span><span class="bg-swatch bg-${k}" aria-hidden="true"></span><span class="bg-name" data-i18n="${BG_LABEL_KEYS[k]}"></span></button>`,
    ).join("") +
    "</div>" +
    "</div>";

  const footer =
    '<button type="button" class="btn-primary export-go" data-i18n="export.title"></button>';

  const dialog = createDialog({ titleKey: "export.title", width: 460, body, footer });
  dialog.classList.add("export-dialog"); // lets CSS let the background dropdown overflow the body

  const bgBtn = dialog.querySelector<HTMLButtonElement>(".export-bg-btn")!;
  const bgMenu = dialog.querySelector<HTMLElement>(".export-bg-menu")!;
  const bgCurrent = dialog.querySelector<HTMLElement>(".export-bg-current")!;
  const opts = dialog.querySelectorAll<HTMLButtonElement>(".export-bg-opt");

  const closeMenu = (): void => {
    bgMenu.classList.add("hidden");
    bgBtn.setAttribute("aria-expanded", "false");
  };
  const setBg = (b: ExportBackground): void => {
    background = b;
    bgCurrent.setAttribute("data-i18n", BG_LABEL_KEYS[b]);
    bgCurrent.textContent = t(BG_LABEL_KEYS[b]);
    opts.forEach((o) => {
      const on = o.dataset.bg === b;
      o.classList.toggle("selected", on);
      o.setAttribute("aria-checked", String(on));
    });
  };
  setBg("solid");

  bgBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowOpen = bgMenu.classList.toggle("hidden") === false;
    bgBtn.setAttribute("aria-expanded", String(nowOpen));
  });
  opts.forEach((o) =>
    o.addEventListener("click", () => {
      setBg(o.dataset.bg as ExportBackground);
      closeMenu();
    }),
  );
  // A click anywhere else in the dialog closes the background menu.
  dialog.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".export-bg")) closeMenu();
  });

  dialog.querySelector<HTMLButtonElement>(".export-go")!.addEventListener("click", () => {
    const format = (dialog.querySelector<HTMLInputElement>(
      'input[name="komu-export-format"]:checked',
    )?.value ?? "png") as ExportFormat;
    dialog.close();
    onExport({ format, background });
  });

  return {
    open() {
      closeMenu();
      dialog.open();
    },
  };
}
