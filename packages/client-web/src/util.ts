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
