// The Export dialog — pick a file type (PNG / PDF) and a background (Grid / Transparent / Solid), then
// Export. Reuses the shared <komu-dialog> chrome (title + close). The actual capture lives in the
// canvas (exportCanvas) + main.ts (blob / PDF + download); this module is just the picker UI.

import { createDialog } from "../dialog";

export type ExportFormat = "png" | "pdf";
export type ExportBackground = "grid" | "transparent" | "solid";

export interface ExportDialog {
  open(): void;
}

const BG_LABELS: Record<ExportBackground, string> = {
  grid: "Grid",
  transparent: "Transparent",
  solid: "Solid",
};
const BG_ORDER: ExportBackground[] = ["grid", "transparent", "solid"];

export function createExportDialog(
  onExport: (opts: { format: ExportFormat; background: ExportBackground }) => void,
): ExportDialog {
  let background: ExportBackground = "solid";

  const body =
    '<div class="export-row">' +
    '<span class="export-label">File type</span>' +
    '<div class="export-radios" role="radiogroup" aria-label="File type">' +
    '<label class="export-radio"><input type="radio" name="komu-export-format" value="png" checked /><span>PNG</span></label>' +
    '<label class="export-radio"><input type="radio" name="komu-export-format" value="pdf" /><span>PDF</span></label>' +
    "</div>" +
    "</div>" +
    '<div class="export-row">' +
    '<span class="export-label">Background</span>' +
    '<div class="export-bg">' +
    '<button type="button" class="export-bg-btn" aria-haspopup="true" aria-expanded="false"><span class="export-bg-current">Solid</span><span class="export-bg-caret" aria-hidden="true">⌄</span></button>' +
    '<div class="export-bg-menu hidden" role="menu">' +
    BG_ORDER.map(
      (k) =>
        `<button type="button" class="export-bg-opt" role="menuitemradio" data-bg="${k}"><span class="bg-check" aria-hidden="true">✓</span><span class="bg-swatch bg-${k}" aria-hidden="true"></span><span class="bg-name">${BG_LABELS[k]}</span></button>`,
    ).join("") +
    "</div>" +
    "</div>";

  const footer = '<button type="button" class="btn-primary export-go">Export</button>';

  const dialog = createDialog({ title: "Export", width: 460, body, footer });
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
    bgCurrent.textContent = BG_LABELS[b];
    opts.forEach((o) => o.classList.toggle("selected", o.dataset.bg === b));
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
