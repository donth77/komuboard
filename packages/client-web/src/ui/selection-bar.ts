// Mobile selection action bar — a compact icon row that appears in the bottom tool-sheet slot when an
// object is selected (Select mode). It surfaces the actions that are otherwise keyboard-only (and so
// impossible on touch): Duplicate, Rotate 15°, Bring-to-front / Send-to-back, Group / Ungroup,
// Lock / Unlock, Delete. It reuses the slot the per-tool option sheets use — and since a selection
// and an active drawing tool are mutually exclusive, there's no contention. Desktop hides it (CSS):
// desktop has the keyboard + transform chrome. Icon-only (with aria-label/title) so the full set fits
// a 390px phone row; Group/Ungroup are mutually exclusive and shown by context.
import { bringFrontIcon, icon, sendBackIcon } from "../icons";
import { applyTranslations, t } from "../i18n";
import { ensureSheetHandle, wireSheetHandle } from "../mobile-sheet";

export interface SelectionBarOpts {
  onDuplicate: () => void;
  onRotate: () => void;
  onBringFront: () => void;
  onSendBack: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onLock: () => void;
  onDelete: () => void;
}

export interface SelectionBarState {
  /** Show the bar at all (the host decides: a selection exists AND we're in select mode on touch). */
  visible: boolean;
  /** The selection is fully locked → the lock button shows "Unlock". */
  locked: boolean;
  /** ≥2 objects that aren't already one group → show Group. */
  canGroup: boolean;
  /** The selection is a single group → show Ungroup. */
  canUngroup: boolean;
  /** The selection overlaps another object → show Bring-to-front / Send-to-back. */
  canReorder: boolean;
}

export interface SelectionBar {
  update(state: SelectionBarState): void;
}

export function createSelectionBar(opts: SelectionBarOpts): SelectionBar {
  // A mobile mini-sheet (like the draw / sticky / shape ones): it lives in the .sheet-wrap clip,
  // slides up flush out of the dock, and collapses to a peek tab via its grab handle. Starts tucked
  // (.hidden); update() slides it out when there's a selection. Desktop hides it entirely (CSS).
  const bar = document.createElement("div");
  bar.className = "selection-actions mini-sheet hidden";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("data-i18n-aria", "selection.barLabel");
  const row = document.createElement("div");
  row.className = "sa-row";

  const make = (act: string, key: string, svg: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sa-btn";
    b.dataset.act = act;
    b.dataset.i18nTitle = key;
    b.dataset.i18nAria = key;
    b.innerHTML = svg;
    b.addEventListener("click", onClick);
    return b;
  };

  // Bring-to-front / send-to-back use the filled design-asset glyphs; the rest use the stroke set.
  const frontBtn = make(
    "front",
    "common.bringToFront",
    bringFrontIcon("sa-ico"),
    opts.onBringFront,
  );
  const backBtn = make("back", "common.sendToBack", sendBackIcon("sa-ico"), opts.onSendBack);
  const groupBtn = make("group", "common.group", icon("group", "sa-ico"), opts.onGroup);
  const ungroupBtn = make("ungroup", "common.ungroup", icon("ungroup", "sa-ico"), opts.onUngroup);
  const lockBtn = make("lock", "common.lock", icon("lock", "sa-ico"), opts.onLock);
  const deleteBtn = make("delete", "common.delete", icon("trash", "sa-ico"), opts.onDelete);
  deleteBtn.classList.add("sa-danger");

  row.append(
    make("duplicate", "common.duplicate", icon("copy", "sa-ico"), opts.onDuplicate),
    make("rotate", "selection.rotate", icon("rotate", "sa-ico"), opts.onRotate),
    frontBtn,
    backBtn,
    groupBtn,
    ungroupBtn,
    lockBtn,
    deleteBtn,
  );
  bar.append(row);
  wireSheetHandle(bar, ensureSheetHandle(bar)); // grab-handle drag-to-collapse (prepends the handle)
  (document.querySelector(".sheet-wrap") ?? document.body).appendChild(bar);
  applyTranslations(bar); // fill in the icon-button titles + aria for the active locale

  return {
    update(state: SelectionBarState): void {
      const wasHidden = bar.classList.contains("hidden");
      bar.classList.toggle("hidden", !state.visible);
      if (state.visible && wasHidden) bar.classList.remove("collapsed"); // a fresh selection re-expands
      const lockKey = state.locked ? "common.unlock" : "common.lock";
      lockBtn.innerHTML = icon(state.locked ? "unlock" : "lock", "sa-ico");
      lockBtn.dataset.i18nTitle = lockKey;
      lockBtn.dataset.i18nAria = lockKey;
      lockBtn.title = t(lockKey);
      lockBtn.setAttribute("aria-label", t(lockKey));
      frontBtn.style.display = state.canReorder ? "" : "none"; // z-order only when overlapping
      backBtn.style.display = state.canReorder ? "" : "none";
      groupBtn.style.display = state.canGroup ? "" : "none";
      ungroupBtn.style.display = state.canUngroup ? "" : "none";
    },
  };
}
