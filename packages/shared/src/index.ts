/**
 * Coboard shared contracts.
 *
 * The `shared` package is the single contract layer consumed by `client-web`,
 * `vr`, and `worker` so the three can never diverge: the PartyServer party name,
 * the Yjs document schema, and the awareness/presence payload types.
 */

/** The PartyServer "party" name; the worker routes /parties/main/:roomId. */
export const PARTY = "main" as const;

// Yjs document schema + presence types (the shared contract for canvas content).
export * from "./schema";

/**
 * Derive a safe room id from a board URL. Prefers `?room=`, then the first path
 * segment, else the fallback. Always sanitized.
 */
export function roomIdFromUrl(url: URL, fallback = "lobby"): string {
  const query = url.searchParams.get("room");
  if (query) return sanitizeRoomId(query, fallback);
  const segment = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return segment ? sanitizeRoomId(segment, fallback) : fallback;
}

/** Lowercase, collapse to a URL-safe slug, and fall back if nothing usable remains. */
export function sanitizeRoomId(raw: string, fallback = "lobby"): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}
