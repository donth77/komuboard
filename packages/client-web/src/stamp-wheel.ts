// <co-stamp-wheel> — the FigJam-style radial stamp picker shown while the Stamp tool is active.
//
// Outer ring: 8 gray pie-wedge slots (hover-highlighted) — 7 colour mark stickers + the user's own
// avatar. thumbs-up sits at 12:00, star at 3:00, thumbs-down at 6:00, the avatar at 9:00. Inner
// (light-blue) disc: the 5 most-recently-used emojis around a central "+". Picking a stamp emits
// `stamp-pick` (detail.src = "mark:<name>" | "emoji:<cp>" | "img:<dataURL>" for the avatar); "+"
// emits `stamp-picker-open`. Light DOM; styled by .co-stamp-wheel rules in styles.css.
import { paintAvatar, initials, safePhotoUrl } from "./util";
import { emojiStickerUrl, cachedEmojiSticker } from "./emoji-sticker";

type Profile = { name: string; color: string; photo?: string };

// Outer ring, clockwise from 12:00. Each colour roughly matches the FigJam sticker palette. The
// avatar slot (9:00) renders the user's photo / initials instead of a masked mark.
// The colour + white sticker outline is baked into each SVG (scripts/make-mark-stickers), so the
// wheel and the placed canvas image render the same sticker.
const SLOTS: ReadonlyArray<{ key: string; file?: string; avatar?: boolean }> = [
  { key: "mark:thumbs-up", file: "thumbs-up" }, // 12:00
  { key: "mark:one-plus", file: "one-plus" }, // 1:30
  { key: "mark:star", file: "star" }, // 3:00
  { key: "mark:question-mark", file: "question-mark" }, // 4:30
  { key: "mark:thumbs-down", file: "thumbs-down" }, // 6:00
  { key: "mark:sparkle", file: "sparkle" }, // 7:30
  { key: "avatar", avatar: true }, // 9:00
  { key: "mark:heart", file: "heart" }, // 10:30
];

// Popular starter set (no heart — the wheel already has a heart mark): 😂 🔥 🎉 🙏 😎
const DEFAULT_RECENTS = ["1f602", "1f525", "1f389", "1f64f", "1f60e"];
const RECENTS_KEY = "coboard-stamp-recents-v2"; // bumped → resets stale recents to the new defaults
const MAX_RECENTS = 5;

// Wheel geometry (px, in the 280-unit SVG viewBox / the host's own 280×280 box).
const SIZE = 280;
const C = SIZE / 2;
const RO = 134; // wedge outer radius
const RI = 74; // wedge inner radius (just outside the emoji disc)
const ICON_R = 36.5; // mark/avatar centre, as % of SIZE → ~102px from centre
const GAP = 0.05; // angular gap between wedges (rad)

export function loadStampRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "null");
    if (Array.isArray(raw) && raw.every((c) => typeof c === "string") && raw.length) {
      return raw.slice(0, MAX_RECENTS);
    }
  } catch {
    /* corrupt → fall back to defaults */
  }
  return DEFAULT_RECENTS;
}
/** Push a just-used emoji codepoint to the front of the recents list (deduped, capped). */
export function pushStampRecent(cp: string): string[] {
  const next = [cp, ...loadStampRecents().filter((c) => c !== cp)].slice(0, MAX_RECENTS);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  return next;
}

/** Place an item evenly around a circle of `r` (% of the wheel), from the top, clockwise. */
function ringStyle(i: number, count: number, r: number): string {
  const a = (i / count) * 2 * Math.PI;
  return `left:${(50 + r * Math.sin(a)).toFixed(2)}%;top:${(50 - r * Math.cos(a)).toFixed(2)}%`;
}

export class CoStampWheel extends HTMLElement {
  #wired = false;
  #active: string | null = null;
  private profile: Profile | null = null;
  private avatarImg: HTMLImageElement | null = null;

  connectedCallback(): void {
    this.classList.add("co-stamp-wheel");
    if (this.#wired) return;
    this.#wired = true;
    this.render();
    this.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-src],[data-plus]");
      if (!el) return;
      if (el.hasAttribute("data-plus")) {
        this.dispatchEvent(new CustomEvent("stamp-picker-open", { bubbles: true }));
        return;
      }
      const key = el.getAttribute("data-src");
      if (!key) return;
      this.active = key; // light up the chosen slot (the avatar matches on the "avatar" sentinel)
      const src = key === "avatar" ? this.avatarStampSrc() : key;
      if (src)
        this.dispatchEvent(new CustomEvent("stamp-pick", { detail: { src }, bubbles: true }));
    });
  }

  /** The signed-in user — drives the avatar slot + the avatar stamp it places. */
  setProfile(p: Profile): void {
    this.profile = p;
    const url = safePhotoUrl(p.photo);
    if (url) {
      const img = new Image();
      img.crossOrigin = "anonymous"; // so we can draw it to a canvas for the placed stamp
      img.onload = () => (this.avatarImg = img);
      img.onerror = () => (this.avatarImg = null);
      img.src = url;
    } else {
      this.avatarImg = null;
    }
    if (this.#wired) this.paintAvatarSlot();
  }

  /** Mark which stamp is armed (so the wheel shows what a canvas click will place). */
  set active(key: string | null) {
    this.#active = key;
    this.applyActive();
  }
  private applyActive(): void {
    for (const b of this.querySelectorAll<HTMLElement>("[data-src]")) {
      b.classList.toggle("on", b.getAttribute("data-src") === this.#active);
    }
  }

  private wedgePath(i: number): string {
    const half = Math.PI / 8 - GAP;
    const phi = (i * Math.PI) / 4;
    const P = (a: number, r: number): string =>
      `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
    return (
      `M${P(phi - half, RO)} A${RO} ${RO} 0 0 1 ${P(phi + half, RO)} ` +
      `L${P(phi + half, RI)} A${RI} ${RI} 0 0 0 ${P(phi - half, RI)} Z`
    );
  }

  /** Rebuild (e.g. after the recents change). */
  render(): void {
    const wedges = SLOTS.map(
      (s, i) => `<path class="sw-wedge" data-src="${s.key}" d="${this.wedgePath(i)}"></path>`,
    ).join("");
    const icons = SLOTS.map((s, i) => {
      const pos = ringStyle(i, SLOTS.length, ICON_R);
      return s.avatar
        ? `<span class="sw-avatar" style="${pos}"></span>`
        : `<img class="sw-ico" src="/stamps/${s.file}.svg" alt="" draggable="false" style="${pos}">`;
    }).join("");
    const recents = loadStampRecents();
    const emojis = recents
      .map(
        (cp, i) =>
          `<button class="sw-emoji" type="button" data-src="emoji:${cp}" style="${ringStyle(i, recents.length, 14)}">` +
          `<img src="/emoji/${cp}.svg" alt="" draggable="false"></button>`,
      )
      .join("");
    this.innerHTML =
      `<div class="sw-disc"></div>` +
      `<svg class="sw-wedges" viewBox="0 0 ${SIZE} ${SIZE}" aria-hidden="true">${wedges}</svg>` +
      icons +
      `<div class="sw-inner"></div>` +
      emojis +
      `<button class="sw-plus" type="button" data-plus aria-label="More emoji">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>`;
    this.paintAvatarSlot();
    this.upgradeEmojiStickers();
    this.applyActive();
  }

  /** Swap each recent-emoji <img> to its white-outlined sticker (cached → instant, else on generate),
   *  so wheel emojis read like the colour marks without a per-frame CSS filter. */
  private upgradeEmojiStickers(): void {
    for (const btn of this.querySelectorAll<HTMLElement>(".sw-emoji")) {
      const cp = btn.getAttribute("data-src")?.slice("emoji:".length);
      const img = btn.querySelector("img");
      if (!cp || !img) continue;
      const ready = cachedEmojiSticker(cp);
      if (ready) {
        img.src = ready;
      } else {
        void emojiStickerUrl(cp).then((url) => {
          if (img.isConnected && btn.getAttribute("data-src") === `emoji:${cp}`) img.src = url;
        });
      }
    }
  }

  private paintAvatarSlot(): void {
    const el = this.querySelector<HTMLElement>(".sw-avatar");
    if (el && this.profile) paintAvatar(el, this.profile);
  }

  /** Render the user's avatar (photo, else colour + initials) to a circular PNG data URL so it can
   *  be placed as a stamp. Falls back to the (always clean) initials circle if the photo taints. */
  private avatarStampSrc(): string {
    // Draw the avatar as a sticker: a white ring (matching the emoji/mark border) around the circular
    // photo (or the initials disc). `withPhoto=false` is the tainted-canvas fallback (initials only).
    const draw = (ctx: CanvasRenderingContext2D, S: number, withPhoto: boolean): void => {
      const margin = 4; // breathing room for the CSS drop-shadow
      const R = S / 2 - margin; // outer (white border) circle radius
      const ring = 11; // white border thickness (≈ the emoji/mark ~8% outline)
      const Rp = R - ring; // inner content circle radius
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, R, 0, Math.PI * 2);
      ctx.fill();
      const img = this.avatarImg;
      if (withPhoto && img && img.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(S / 2, S / 2, Rp, 0, Math.PI * 2);
        ctx.clip();
        const d = Rp * 2;
        const s = Math.max(d / img.naturalWidth, d / img.naturalHeight);
        const w = img.naturalWidth * s;
        const h = img.naturalHeight * s;
        ctx.drawImage(img, S / 2 - w / 2, S / 2 - h / 2, w, h);
        ctx.restore();
      } else {
        this.drawInitials(ctx, S / 2, S / 2, Rp);
      }
    };
    const S = 128;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const ctx = cv.getContext("2d");
    if (!ctx) return "";
    draw(ctx, S, true);
    try {
      return "img:" + cv.toDataURL("image/png");
    } catch {
      const c2 = document.createElement("canvas");
      c2.width = c2.height = S;
      const x = c2.getContext("2d");
      if (x) draw(x, S, false); // tainted photo → initials only (always exportable)
      return "img:" + c2.toDataURL("image/png");
    }
  }

  /** Draw the initials disc (colour + centred initials) of radius `r` centred at (cx, cy). */
  private drawInitials(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    ctx.fillStyle = this.profile?.color ?? "#8a90a2";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${Math.round(r * 0.84)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(this.profile?.name ?? "?"), cx, cy + r * 0.06);
  }
}

if (!customElements.get("co-stamp-wheel")) customElements.define("co-stamp-wheel", CoStampWheel);

declare global {
  interface HTMLElementTagNameMap {
    "co-stamp-wheel": CoStampWheel;
  }
}
