// src/mobile-sheet.ts — the shared mobile "mini-sheet" behaviour used by the draw bar, sticky
// palette, and shape menu. On mobile each of those is a `.mini-sheet` inside a `.sheet-wrap` clip
// window whose bottom edge is the dock's top, so the sheet appears to expand out of / collapse into
// the toolbar. This module wires the grab-handle drag-to-collapse (tap toggles; a drag follows the
// finger and snaps to the nearest state) — the one piece of behaviour all three share.

/** Collapsed peek height (px) — only the grab handle stays visible. Matches the `.mini-sheet.collapsed`
 *  translate (and the `.sheet-handle` height) in styles.css. */
const TAB = 30;

/**
 * Wire a grab handle to expand/collapse its sheet between fully open and a peek tab.
 * @param sheet  the `.mini-sheet` element that slides.
 * @param handle the `.sheet-handle` grab bar inside it.
 * @param onDragStart optional hook (e.g. close a floating popover before the sheet slides).
 */
export function wireSheetHandle(
  sheet: HTMLElement,
  handle: HTMLElement,
  onDragStart?: () => void,
): void {
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let wasCollapsed = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    dy = 0;
    wasCollapsed = sheet.classList.contains("collapsed");
    onDragStart?.();
    sheet.style.transition = "none";
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dy = e.clientY - startY;
    const base = wasCollapsed ? sheet.offsetHeight - TAB : 0;
    const t = Math.min(sheet.offsetHeight - TAB, Math.max(0, base + dy));
    sheet.style.transform = `translateY(${t}px)`;
  });
  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = ""; // restore the CSS slide transition
    sheet.style.transform = ""; // hand control back to the .collapsed class
    if (Math.abs(dy) < 5) {
      sheet.classList.toggle("collapsed"); // tap → toggle open / tab
    } else {
      const base = wasCollapsed ? sheet.offsetHeight - TAB : 0;
      sheet.classList.toggle("collapsed", base + dy > (sheet.offsetHeight - TAB) / 2); // snap nearest
    }
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

/** Prepend a `.sheet-handle` grab bar to a sheet host (idempotent) and return it. */
export function ensureSheetHandle(host: HTMLElement): HTMLElement {
  let handle = host.querySelector<HTMLElement>(":scope > .sheet-handle");
  if (!handle) {
    handle = document.createElement("div");
    handle.className = "sheet-handle";
    handle.setAttribute("aria-hidden", "true");
    // Focusable (mouse only, not in tab order) so a TAP on it becomes the editor's blur relatedTarget.
    // That keeps the commit's keepTool path (it's inside the tool-picker element) — otherwise tapping a
    // collapsed shape/sticky sheet's handle to expand it would instead revert to select and hide it.
    handle.tabIndex = -1;
    host.prepend(handle);
  }
  return handle;
}
