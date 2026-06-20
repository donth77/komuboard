// Platform detection for shortcut *display*. The key handlers accept `metaKey || ctrlKey` on every
// OS (so ⌘ and Ctrl both work everywhere); this only decides which glyph we SHOW in tooltips and the
// shortcuts menu — ⌘/⌥/⇧ on macOS, Ctrl/Alt/Shift elsewhere.

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
  const plat = ua.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  return /mac/i.test(plat); // "MacIntel" / "macOS"; iPad-with-keyboard also reports Mac (uses ⌘) — fine
}

/** True on macOS / iPadOS (where the modifier is ⌘, not Ctrl). Computed once at load. */
export const IS_MAC = detectMac();

/** Modifier glyphs for shortcut hints — ⌘/⌥/⇧ on macOS, Ctrl/Alt/Shift elsewhere. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
export const SHIFT_KEY = IS_MAC ? "⇧" : "Shift";
