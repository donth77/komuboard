// Accessibility: the offscreen DOM semantic mirror + live-region announcer (docs/07 §5.1).
//
// A <canvas>/DOM whiteboard is opaque to screen readers — they see pixels, not shapes. This module
// mirrors the Yjs document into a visually-hidden but screen-reader-navigable list (one labelled item
// per object), regenerated from the same typed accessors the renderer uses, and announces the
// multiplayer dimension (who joined/left, that the board changed) through a polite aria-live region.
// It is purely additive: it reads the doc + awareness and owns its own hidden DOM — no renderer or
// interaction code changes.

import { objectsMap, orderArray, readObject, type BoardObject } from "@komuboard/shared";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { onLocaleChange, t, tc } from "../i18n";

export interface BoardA11yOptions {
  doc: Y.Doc;
  awareness: Awareness;
  /** The board `<main>` — gets a descriptive label + `aria-describedby` pointing at the mirror. */
  board: HTMLElement;
  /** Select a board object by id (focus/activate a mirror item → select it on the canvas, so the
   *  keyboard shortcuts — delete/nudge/rotate/z-order/group/lock — can act on it). */
  selectObject?: (id: string) => void;
}

export interface BoardA11y {
  destroy(): void;
}

function truncate(s: string, n = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** A short, human-readable description of one board object for a screen reader. */
function objectLabel(o: BoardObject): string {
  switch (o.type) {
    case "text": {
      const text = truncate((o.runs ?? []).map((r) => r.text).join(""));
      const kind = o.shape
        ? t(`shape.${o.shape}`)
        : t(o.bg ? "a11y.objStickyNote" : "a11y.objText");
      return text ? t("a11y.objLabeled", { kind, text }) : t("a11y.objEmpty", { kind });
    }
    case "stroke":
      return t("a11y.objStroke");
    case "connector":
      return t("a11y.objConnector");
    case "image":
      return t("a11y.objImage");
    case "stamp":
      return (o.src ?? "").startsWith("emoji:") ? t("a11y.objEmojiSticker") : t("a11y.objSticker");
    default:
      return t("a11y.objGeneric");
  }
}

export function createBoardA11y(opts: BoardA11yOptions): BoardA11y {
  // The board is a labelled application surface; the mirror carries the actual content for AT.
  const applyChrome = (): void => {
    opts.board.setAttribute("aria-roledescription", t("a11y.roleDescription"));
    opts.board.setAttribute("aria-label", t("a11y.boardLabel"));
    mirror.setAttribute("aria-label", t("a11y.mirrorLabel"));
  };
  opts.board.setAttribute("aria-describedby", "board-a11y-mirror-hint");

  const mirror = document.createElement("section");
  mirror.id = "board-a11y-mirror";
  mirror.className = "sr-only";
  mirror.tabIndex = -1;
  const hint = document.createElement("p");
  hint.id = "board-a11y-mirror-hint";
  const list = document.createElement("ul");
  mirror.append(hint, list);

  applyChrome();

  const announcer = document.createElement("div");
  announcer.className = "sr-only";
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");
  announcer.setAttribute("aria-atomic", "true");

  opts.board.parentElement?.append(mirror, announcer);

  let announceTimer = 0;
  const announce = (msg: string): void => {
    // Replacing the text (aria-atomic) re-announces; clear first so identical consecutive messages
    // (e.g. two people leaving) are still spoken.
    window.clearTimeout(announceTimer);
    announcer.textContent = "";
    announceTimer = window.setTimeout(() => (announcer.textContent = msg), 60);
  };

  // Focusing (Tab) or activating (Enter/Space/click) a mirror item selects that object on the canvas,
  // so the existing keyboard shortcuts can act on it. Delegated so it survives list reconciliation.
  const onItemActivate = (e: Event): void => {
    // `data-object-id`, NOT `data-id` — the canvas renderer already uses `data-id`, and a duplicate
    // would make every `[data-id="…"]` query (renderer + tests) ambiguous.
    const id = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-object-id]")
      ?.dataset.objectId;
    if (id) opts.selectObject?.(id);
  };
  if (opts.selectObject) {
    list.addEventListener("focusin", onItemActivate);
    list.addEventListener("click", onItemActivate);
    // Space activates the focused item — stop it reaching the canvas' hold-Space-to-pan. Arrows,
    // Delete, ⌘-combos, [ / ] deliberately DO propagate so they nudge/delete/z-order the selection.
    list.addEventListener("keydown", (e) => {
      if (e.key === " ") e.stopPropagation();
    });
  }

  // ---- semantic mirror: rebuild the object list on doc change (debounced) ----
  const rebuild = (): void => {
    const map = objectsMap(opts.doc);
    const order = orderArray(opts.doc).toArray();
    const seen = new Set<string>();
    const items: { id: string; label: string }[] = [];
    for (const id of order) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      const m = map.get(id);
      const o = m ? readObject(m) : null;
      if (o) items.push({ id, label: objectLabel(o) });
    }
    const selectable = !!opts.selectObject;
    hint.textContent =
      items.length === 0
        ? t("a11y.empty")
        : selectable
          ? tc("a11y.hintSelectable", items.length)
          : tc("a11y.hintListed", items.length);
    // Reconcile the <li><button> set in place (cheap; the list is small and updates are debounced).
    while (list.children.length > items.length) list.lastElementChild?.remove();
    while (list.children.length < items.length) {
      const li = document.createElement("li");
      if (selectable) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "board-a11y-item";
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
    items.forEach(({ id, label }, i) => {
      const host = (list.children[i]!.firstElementChild ?? list.children[i]!) as HTMLElement;
      if (host.dataset.objectId !== id) host.dataset.objectId = id;
      if (host.textContent !== label) host.textContent = label;
    });
  };

  let rebuildTimer = 0;
  const scheduleRebuild = (): void => {
    if (rebuildTimer) return;
    rebuildTimer = window.setTimeout(() => {
      rebuildTimer = 0;
      rebuild();
    }, 250);
  };
  opts.doc.on("update", scheduleRebuild);
  rebuild();

  // ---- presence announcer: who joined / left (the multiplayer dimension AT users can't see) ----
  const nameOf = (id: number): string => {
    const st = opts.awareness.getStates().get(id) as { user?: unknown } | undefined;
    return typeof st?.user === "string" && st.user ? st.user : t("a11y.someone");
  };
  const onAwareness = (delta: { added: number[]; removed: number[] }): void => {
    const self = opts.awareness.clientID;
    const joined = delta.added.filter((id) => id !== self).map(nameOf);
    const left = delta.removed.filter((id) => id !== self).length;
    if (joined.length === 1) announce(t("a11y.joined", { name: joined[0]! }));
    else if (joined.length > 1) announce(t("a11y.joinedMany", { count: joined.length }));
    else if (left === 1) announce(t("a11y.someoneLeft"));
    else if (left > 1) announce(t("a11y.leftMany", { count: left }));
  };
  opts.awareness.on("change", onAwareness);

  // Re-translate everything on a language switch (a locale change fires no doc update).
  const offLocale = onLocaleChange(() => {
    applyChrome();
    rebuild();
  });

  return {
    destroy() {
      opts.doc.off("update", scheduleRebuild);
      opts.awareness.off("change", onAwareness);
      offLocale();
      window.clearTimeout(rebuildTimer);
      window.clearTimeout(announceTimer);
      mirror.remove();
      announcer.remove();
    },
  };
}
