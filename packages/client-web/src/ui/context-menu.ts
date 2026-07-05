// Right-click context menu for the board — an "object" variant (acts on the selection) and a
// "canvas" variant (paste / select all / zoom). Built fresh per open (like the app menu), positioned
// at the pointer and clamped into the viewport; dismissed by click-away, Escape, wheel, or an action.

import { applyTranslations } from "../i18n";
import { MOD_KEY, SHIFT_KEY } from "../platform";

export interface ContextMenuActions {
  cut(): void;
  copy(): void;
  paste(): void;
  duplicate(): void;
  remove(): void;
  bringToFront(): void;
  sendToBack(): void;
  group(): void;
  ungroup(): void;
  toggleLock(): void;
  selectAll(): void;
  zoomToFit(): void;
  canPaste(): boolean;
}

export interface SelectionMetaLite {
  count: number;
  locked: boolean;
  grouped: boolean;
}

export interface ContextMenu {
  openAt(x: number, y: number, kind: "object" | "canvas", meta: SelectionMetaLite): void;
  close(): void;
  readonly isOpen: boolean;
}

interface Item {
  label: string;
  /** i18n key (en.ts) — drives the visible label via the data-i18n sweep. */
  key: string;
  hint?: string;
  act: keyof ContextMenuActions;
  disabled?: boolean;
}

export function createContextMenu(actions: ContextMenuActions): ContextMenu {
  let el: HTMLElement | null = null;

  const close = (): void => {
    el?.remove();
    el = null;
    document.removeEventListener("pointerdown", onAway, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("wheel", onAway, true);
  };
  const onAway = (e: Event): void => {
    if (el && !el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !el) return;
    close();
    // Swallow this Escape so the global handler doesn't ALSO clear the selection the menu acted on.
    e.stopPropagation();
    e.preventDefault();
  };

  const openAt = (
    x: number,
    y: number,
    kind: "object" | "canvas",
    meta: SelectionMetaLite,
  ): void => {
    close();
    const groups: Item[][] =
      kind === "object"
        ? [
            [
              { label: "Cut", key: "menu.cut", hint: `${MOD_KEY} X`, act: "cut" },
              { label: "Copy", key: "menu.copy", hint: `${MOD_KEY} C`, act: "copy" },
              {
                label: "Paste",
                key: "menu.paste",
                hint: `${MOD_KEY} V`,
                act: "paste",
                disabled: !actions.canPaste(),
              },
              { label: "Duplicate", key: "common.duplicate", act: "duplicate" },
            ],
            [
              {
                label: "Bring to front",
                key: "common.bringToFront",
                hint: `${MOD_KEY} ]`,
                act: "bringToFront",
              },
              {
                label: "Send to back",
                key: "common.sendToBack",
                hint: `${MOD_KEY} [`,
                act: "sendToBack",
              },
            ],
            [
              ...(meta.grouped
                ? [
                    {
                      label: "Ungroup",
                      key: "common.ungroup",
                      hint: `${MOD_KEY} ${SHIFT_KEY} G`,
                      act: "ungroup",
                    } satisfies Item,
                  ]
                : []),
              ...(!meta.grouped && meta.count >= 2
                ? [
                    {
                      label: "Group",
                      key: "common.group",
                      hint: `${MOD_KEY} G`,
                      act: "group",
                    } satisfies Item,
                  ]
                : []),
              {
                label: meta.locked ? "Unlock" : "Lock",
                key: meta.locked ? "common.unlock" : "common.lock",
                hint: `${MOD_KEY} L`,
                act: "toggleLock",
              },
            ],
            [{ label: "Delete", key: "common.delete", hint: "Del", act: "remove" }],
          ]
        : [
            [
              {
                label: "Paste",
                key: "menu.paste",
                hint: `${MOD_KEY} V`,
                act: "paste",
                disabled: !actions.canPaste(),
              },
              {
                label: "Select all",
                key: "menu.selectAll",
                hint: `${MOD_KEY} A`,
                act: "selectAll",
              },
            ],
            [{ label: "Zoom to fit", key: "menu.zoomToFit", act: "zoomToFit" }],
          ];

    el = document.createElement("div");
    el.className = "ctx-menu";
    el.setAttribute("role", "menu");
    el.innerHTML = groups
      .filter((g) => g.length)
      .map((g) =>
        g
          .map(
            (it) =>
              `<button type="button" class="ctx-item" role="menuitem" data-act="${it.act}"${it.disabled ? " disabled" : ""}><span data-i18n="${it.key}">${it.label}</span>${it.hint ? `<span class="ctx-kbd">${it.hint}</span>` : ""}</button>`,
          )
          .join(""),
      )
      .join('<div class="ctx-sep" role="separator"></div>');
    el.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".ctx-item");
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act as keyof ContextMenuActions;
      close();
      const fn = actions[act];
      if (act !== "canPaste") (fn as () => void)();
    });
    document.body.appendChild(el);
    applyTranslations(el); // translate the freshly-built items before measuring for the viewport clamp
    // Clamp into the viewport (measure once after append; flip away from the near edges).
    const r = el.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 8);
    const py = Math.min(y, window.innerHeight - r.height - 8);
    el.style.left = `${Math.max(8, px)}px`;
    el.style.top = `${Math.max(8, py)}px`;

    document.addEventListener("pointerdown", onAway, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("wheel", onAway, true);
  };

  return {
    openAt,
    close,
    get isOpen() {
      return el !== null;
    },
  };
}
