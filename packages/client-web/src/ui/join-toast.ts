// Join toasts — a small bottom-center stack that announces "<name> joined" when a new peer arrives
// after you're settled in the room. Existing occupants (present when you first connect) don't toast;
// see the settle window in main.ts. Purely cosmetic and non-interactive (pointer-events: none).

import { t } from "../i18n";

const VISIBLE_MS = 3200;
const FADE_MS = 260;

export interface JoinToasts {
  /** Announce that `name` (shown in their identity `color`) just joined. */
  show(name: string, color: string): void;
}

export function createJoinToasts(): JoinToasts {
  let container: HTMLDivElement | null = null;

  function ensure(): HTMLDivElement {
    if (container) return container;
    const c = document.createElement("div");
    c.className = "join-toasts";
    document.body.appendChild(c);
    container = c;
    return c;
  }

  return {
    show(name: string, color: string): void {
      const toast = document.createElement("div");
      toast.className = "join-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");

      const dot = document.createElement("span");
      dot.className = "join-toast-dot";
      dot.style.background = color;

      const label = document.createElement("span");
      const who = document.createElement("b");
      who.textContent = name;
      const [pre, post] = t("presence.joinedToast").split("{name}");
      label.append(pre ?? "", who, post ?? "");

      toast.append(dot, label);
      ensure().appendChild(toast);
      requestAnimationFrame(() => toast.classList.add("in"));

      window.setTimeout(() => {
        toast.classList.remove("in");
        window.setTimeout(() => toast.remove(), FADE_MS);
      }, VISIBLE_MS);
    },
  };
}
