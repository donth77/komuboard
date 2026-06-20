// Small shared helpers for rendering a person (avatar initials + photo).

/** Initials for an avatar fallback, e.g. "Gentle Panda" → "GP". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?").slice(0, 2);
}

/**
 * Returns `url` if it is safe to interpolate into a CSS `url("…")`, else null.
 *
 * Photos arrive over the peer-controlled `usersMap`/awareness channel, so they are
 * untrusted. We can't use CSS.escape (it would mangle a data: URL); instead we require
 * a data:image or https: URL and reject any character that could break out of the
 * `url("…")` (quote, paren, backslash, whitespace/control). Callers fall back to
 * initials when this returns null.
 */
export function safePhotoUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  if (!(url.startsWith("data:image/") || url.startsWith("https://"))) return null;
  return /["')\\\s]/.test(url) ? null : url;
}

/**
 * Paint `el` as a circular avatar for a person: their photo (if it passes safePhotoUrl) as a
 * cover background, else their colour (--av) + initials. The circle shape/size comes from CSS
 * (e.g. `.menu-avatar`, `.po-av`). Used wherever we show "you" outside the presence row.
 */
export function paintAvatar(
  el: HTMLElement,
  p: { name: string; color: string; photo?: string },
): void {
  el.style.setProperty("--av", p.color);
  const photo = safePhotoUrl(p.photo);
  if (photo) {
    el.style.backgroundImage = `url("${photo}")`;
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = initials(p.name);
  }
}

/**
 * Paint a profile preview inside `root`: the person's name into `[data-profile-name]` and their
 * avatar into `[data-profile-avatar]`. Used by the "Edit profile" menu row (app menu + drawer).
 */
export function paintProfile(
  root: HTMLElement,
  p: { name: string; color: string; photo?: string },
): void {
  const name = root.querySelector<HTMLElement>("[data-profile-name]");
  if (name) name.textContent = p.name;
  const av = root.querySelector<HTMLElement>("[data-profile-avatar]");
  if (av) paintAvatar(av, p);
}
