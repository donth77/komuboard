/**
 * Komuboard shared contracts.
 *
 * The `shared` package is the single contract layer consumed by `client-web`,
 * `vr`, and `worker` so the three can never diverge: the PartyServer party name,
 * the Yjs document schema, and the awareness/presence payload types.
 */

/** The PartyServer "party" name; the worker routes /parties/main/:roomId. */
export const PARTY = "main" as const;

/**
 * WebSocket close codes the room DO uses to *deliberately* refuse a connection (the client recognizes
 * these to stop its retry loop and explain why, instead of reconnecting forever). App range (4xxx),
 * since the spec reserves 1xxx and only 1000/3000–4999 are settable from app code.
 */
export const CLOSE_ROOM_FULL = 4503; // room at capacity
export const CLOSE_RATE_LIMIT = 4429; // closed for sustained message flooding

/** Max simultaneous editors per room (the cap behind CLOSE_ROOM_FULL). */
export const MAX_CONNECTIONS = 50;

// Yjs document schema + presence types (the shared contract for canvas content).
export * from "./schema";
export * from "./uploads";

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
