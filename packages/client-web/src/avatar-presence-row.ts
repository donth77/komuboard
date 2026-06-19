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
import { initials, safePhotoUrl } from "./util";

export interface PresencePerson {
  id: string;
  name: string;
  color: string;
  photo?: string;
  me: boolean;
}

// Snappy spring with a hint of overshoot — close to Framer Motion's layout feel.
const SPRING = { type: "spring", stiffness: 500, damping: 34 } as const;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Shallow value-equality for the presence list, so an unchanged list skips the FLIP re-render. */
function samePeople(a: PresencePerson[], b: PresencePerson[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x === undefined ||
      y === undefined ||
      x.id !== y.id ||
      x.name !== y.name ||
      x.color !== y.color ||
      x.photo !== y.photo ||
      x.me !== y.me
    ) {
      return false;
    }
  }
  return true;
}

export class CoAvatarPresenceRow extends HTMLElement {
  #avatars = new Map<string, HTMLElement>();
  #people: PresencePerson[] = [];
  #wired = false;
  /** Open "+N" overflow popover (a scrollable list of the hidden collaborators), or null. */
  #overflowPop: HTMLElement | null = null;
  #onDocPointer: ((e: PointerEvent) => void) | null = null;

  connectedCallback(): void {
    this.classList.add("avatar-presence-row"); // reuse the global stylesheet
    if (this.#wired) return;
    this.#wired = true;
    this.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      const more = t?.closest(".avatar.more");
      if (more instanceof HTMLElement) {
        this.#toggleOverflow(more);
        return;
      }
      if (t?.closest?.(".avatar.self")) {
        this.dispatchEvent(new CustomEvent("rename", { bubbles: true }));
      }
    });
    // The "+N" chip is keyboard-operable (role=button) → Enter/Space opens its overflow list.
    this.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if ((e.key === "Enter" || e.key === " ") && t?.classList.contains("more")) {
        e.preventDefault();
        this.#toggleOverflow(t);
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
    if (samePeople(this.#people, list)) return; // cursor-only awareness ticks → no DOM/FLIP work
    this.#people = list;
    this.#render();
  }

  #paint(el: HTMLElement, p: PresencePerson): void {
    el.style.setProperty("--av", p.color);
    el.classList.toggle("self", p.me);
    const label = p.me ? `${p.name} (you)` : p.name;
    el.dataset.tip = label; // unified hover pill (drops below — top-edge; see styles.css)
    el.setAttribute("aria-label", label); // keep the accessible name (data-tip is visual only)
    const photo = safePhotoUrl(p.photo);
    if (photo) {
      el.style.backgroundImage = `url("${photo}")`;
      el.classList.add("has-photo");
      el.textContent = "";
    } else {
      el.style.backgroundImage = "";
      el.classList.remove("has-photo");
      el.textContent = initials(p.name);
    }
  }

  #render(): void {
    this.#closeOverflow(); // membership/profiles changed → don't leave a stale overflow list open
    // Single-player (just me, or nobody yet): hide the whole row — there's no one else to show.
    // Inline display beats the `.avatar-presence-row { display: flex }` rule; "" restores it.
    this.style.display = this.#people.length <= 1 ? "none" : "";
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
        more.setAttribute("role", "button");
        more.setAttribute("tabindex", "0");
        more.setAttribute("aria-haspopup", "true");
      }
      more.textContent = `+${extra}`;
      more.setAttribute("aria-label", `Show ${extra} more ${extra === 1 ? "person" : "people"}`);
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
      void animate(el, { opacity: [1, 0], scale: [1, 0.6] }, { duration: 0.18 }).finished.then(() =>
        el.remove(),
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

  // ---- "+N" overflow popover: a scrollable list of the collaborators beyond `max` ----
  #toggleOverflow(anchor: HTMLElement): void {
    if (this.#overflowPop) this.#closeOverflow();
    else this.#openOverflow(anchor);
  }

  #openOverflow(anchor: HTMLElement): void {
    const overflow = this.#people.slice(this.max);
    if (!overflow.length) return;
    const pop = document.createElement("div");
    pop.className = "presence-overflow";
    pop.setAttribute("role", "menu");
    pop.setAttribute("aria-label", "More collaborators");
    for (const p of overflow) {
      const item = document.createElement("div");
      item.className = "po-item";
      const av = document.createElement("span");
      av.className = "po-av";
      av.style.setProperty("--av", p.color);
      const photo = safePhotoUrl(p.photo);
      if (photo) {
        av.classList.add("has-photo");
        av.style.backgroundImage = `url("${photo}")`;
      } else {
        av.textContent = initials(p.name);
      }
      const name = document.createElement("span");
      name.className = "po-name";
      name.textContent = p.me ? `${p.name} (you)` : p.name; // textContent → names can't inject markup
      item.append(av, name);
      pop.appendChild(item);
    }
    document.body.appendChild(pop);
    this.#overflowPop = pop;
    anchor.setAttribute("aria-expanded", "true");
    // Anchor under the chip, right-aligned to it (the row lives at the top-right of the bar).
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    this.#onDocPointer = (ev) => {
      const tt = ev.target as Node;
      if (pop.contains(tt) || anchor.contains(tt)) return;
      this.#closeOverflow();
    };
    document.addEventListener("pointerdown", this.#onDocPointer, true);
  }

  #closeOverflow(): void {
    this.#overflowPop?.remove();
    this.#overflowPop = null;
    this.querySelector(".avatar.more")?.setAttribute("aria-expanded", "false");
    if (this.#onDocPointer) {
      document.removeEventListener("pointerdown", this.#onDocPointer, true);
      this.#onDocPointer = null;
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
