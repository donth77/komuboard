/**
 * <co-avatar-presence-row> — presence avatar stack as a standards-based Web Component.
 *
 * Like <co-dialog>, this is deliberately LIGHT DOM: it reuses Coboard's global
 * design system (the `.avatar-presence-row` / `.avatar` rules in styles.css, the
 * CSS tokens, and the global prefers-reduced-motion reset) instead of duplicating
 * styles behind a shadow boundary — class selectors don't pierce Shadow DOM.
 * See docs/adr/0005-ui-chrome-web-components.md.
 *
 * Data in via the `people` property; the "rename me" intent (a click on your
 * own avatar) goes out via a bubbling `rename` event. All awareness/Yjs wiring
 * stays in the app glue (main.ts) — this element is presentation only.
 *
 * Join/leave motion is modelled on github.com/donth77/presence-challenge, which
 * uses Framer Motion's `layout` + AnimatePresence. We reproduce that with Motion
 * (motion.dev), the vanilla successor to Framer Motion:
 *   - enter: spring in from the right (x: 30 → 0) + fade,
 *   - exit:  fade + shrink, popped out of flow so the row closes immediately,
 *   - layout: a FLIP pass springs the remaining avatars from their old slot to
 *     the new one, so neighbours glide into the gap instead of snapping.
 */
import { animate } from "motion";

export interface PresencePerson {
  id: string;
  name: string;
  color: string;
  photo?: string;
  me: boolean;
}

// Snappy spring with a hint of overshoot — close to Framer Motion's layout feel.
const SPRING = { type: "spring", stiffness: 500, damping: 34 } as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?").slice(0, 2);
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export class CoAvatarPresenceRow extends HTMLElement {
  #avatars = new Map<string, HTMLElement>();
  #people: PresencePerson[] = [];
  #wired = false;

  connectedCallback(): void {
    this.classList.add("avatar-presence-row"); // reuse the global stylesheet
    if (this.#wired) return;
    this.#wired = true;
    this.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".avatar.self")) {
        this.dispatchEvent(new CustomEvent("rename", { bubbles: true }));
      }
    });
  }

  get max(): number {
    const v = Number(this.getAttribute("max"));
    return Number.isFinite(v) && v > 0 ? v : 5;
  }
  set max(v: number) {
    this.setAttribute("max", String(v));
  }

  get people(): PresencePerson[] {
    return this.#people;
  }
  set people(list: PresencePerson[]) {
    this.#people = list;
    this.#render();
  }

  #paint(el: HTMLElement, p: PresencePerson): void {
    el.style.setProperty("--av", p.color);
    el.classList.toggle("self", p.me);
    el.title = p.me ? `${p.name} (you)` : p.name;
    if (p.photo) {
      el.style.backgroundImage = `url("${p.photo}")`;
      el.classList.add("has-photo");
      el.textContent = "";
    } else {
      el.style.backgroundImage = "";
      el.classList.remove("has-photo");
      el.textContent = initials(p.name);
    }
  }

  #render(): void {
    const reduce = prefersReducedMotion();
    const shown = this.#people.slice(0, this.max);
    const shownIds = new Set(shown.map((p) => p.id));

    // FLIP step 1 — record where every current avatar sits before the DOM changes.
    const firstLeft = new Map<string, number>();
    for (const [id, el] of this.#avatars) firstLeft.set(id, el.getBoundingClientRect().left);

    // Add / update / (re)order the avatars that should be visible.
    const entering: HTMLElement[] = [];
    for (const p of shown) {
      let el = this.#avatars.get(p.id);
      if (!el) {
        el = document.createElement("span");
        el.className = "avatar";
        if (!reduce) el.style.opacity = "0"; // stay hidden until the enter spring runs
        this.#avatars.set(p.id, el);
        entering.push(el);
      }
      this.#paint(el, p);
      this.appendChild(el); // (re)order to match the sorted list
    }

    // The "+N more" chip always trails the row.
    const extra = this.#people.length - shown.length;
    let more = this.querySelector<HTMLElement>(".avatar.more");
    if (extra > 0) {
      if (!more) {
        more = document.createElement("span");
        more.className = "avatar more";
      }
      more.textContent = `+${extra}`;
      this.appendChild(more);
    } else if (more) {
      more.remove();
    }

    // Exit — pop leavers out of flow (so the row closes its gap immediately and
    // the FLIP pass below animates it), then fade + shrink them out on top.
    const host = this.getBoundingClientRect();
    for (const [id, el] of [...this.#avatars]) {
      if (shownIds.has(id)) continue;
      this.#avatars.delete(id);
      if (reduce) {
        el.remove();
        continue;
      }
      const r = el.getBoundingClientRect();
      el.style.position = "absolute";
      el.style.left = `${r.left - host.left}px`;
      el.style.top = `${r.top - host.top}px`;
      el.style.width = `${r.width}px`;
      el.style.margin = "0";
      el.style.pointerEvents = "none";
      el.style.zIndex = "0";
      void animate(el, { opacity: [1, 0], scale: [1, 0.6] }, { duration: 0.18 }).finished.then(
        () => el.remove(),
      );
    }

    if (reduce) return;

    // FLIP step 2 — spring the remaining avatars from their old slot to the new one.
    for (const [id, el] of this.#avatars) {
      const first = firstLeft.get(id);
      if (first === undefined) continue; // just entered — handled below
      const dx = first - el.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) void animate(el, { x: [dx, 0] }, SPRING);
    }

    // Enter — spring in from the right + fade (à la the reference).
    for (const el of entering) {
      void animate(el, { opacity: [0, 1], x: [30, 0] }, SPRING);
    }
  }
}

if (!customElements.get("co-avatar-presence-row"))
  customElements.define("co-avatar-presence-row", CoAvatarPresenceRow);

declare global {
  interface HTMLElementTagNameMap {
    "co-avatar-presence-row": CoAvatarPresenceRow;
  }
}
