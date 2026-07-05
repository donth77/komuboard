import { routePartykitRequest } from "partyserver";
import { MAX_UPLOAD_BYTES, UPLOAD_IMAGE_EXT } from "@komuboard/shared";
import { Board } from "./board";
import { sniffImage } from "./image-sniff";
import { keysToSweep, sweepIsSafe, type R2ObjectInfo } from "./reap-assets";

// The Durable Object class must be exported from the Worker entry module.
export { Board };

export interface Env {
  /** One Durable Object per room; routed at /parties/main/:roomId. */
  Main: DurableObjectNamespace<Board>;
  /** R2 bucket for uploaded images (bytes; the Yjs doc only holds the key). */
  UPLOADS: R2Bucket;
  /** Per-IP upload rate limiter (Cloudflare ratelimit binding). Optional: absent in local dev. */
  UPLOAD_RL?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** Per-IP room-join (WS connect) rate limiter — bounds room-id enumeration. Optional in dev. */
  JOIN_RL?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** KV room→referenced-image-keys index (each Board DO writes its own entry on save); read by the
   *  scheduled orphan-image sweep. Optional: absent in local dev, where the sweep no-ops. */
  ASSET_INDEX?: KVNamespace;
}

// Image-upload guards (MAX_UPLOAD_BYTES + the type→ext allow-list) live in @komuboard/shared so the
// worker + client can't drift. The client also validates + downscales before POSTing.
const IMMUTABLE = "public, max-age=31536000, immutable";
// Uploads are a cross-origin fetch in dev (vite :5173 → worker :8787); image GETs are <img> loads
// (no CORS needed). `*` is fine — images are public anyway.
const CORS = { "Access-Control-Allow-Origin": "*" };

/** POST /upload — validate, content-hash, and store an image in R2. Returns the key. */
async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: CORS });

  // Per-IP rate limit (the endpoint is unauthenticated and stores 5MB blobs — a flood is a
  // storage-cost DoS). Only when Cloudflare gives us a real client IP (prod) and the binding exists;
  // wrapped so a limiter hiccup / local-dev absence fails OPEN rather than blocking uploads.
  const ip = request.headers.get("cf-connecting-ip");
  if (ip && env.UPLOAD_RL) {
    try {
      if (!(await env.UPLOAD_RL.limit({ key: ip })).success)
        return Response.json({ error: "rate limited" }, { status: 429, headers: CORS });
    } catch {
      /* limiter unavailable → fail open */
    }
  }

  // Fast pre-filter on the declared type (a friendlier error), but it is NOT trusted for what we
  // store — the authoritative content-type comes from the real magic bytes below.
  const declared = (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!UPLOAD_IMAGE_EXT[declared])
    return Response.json({ error: "unsupported image type" }, { status: 415, headers: CORS });

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "image too large or empty" }, { status: 413, headers: CORS });
  }

  // Sniff the REAL type from the bytes and store/serve THAT — a non-image (e.g. HTML) labelled
  // image/png can't sneak through to be MIME-sniffed into script on the serving origin.
  const sniffed = sniffImage(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16)));
  if (!sniffed)
    return Response.json({ error: "not a valid image" }, { status: 415, headers: CORS });

  // Content-addressed key: identical images dedup, and the immutable cache is always safe.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `${hash}.${sniffed.ext}`;
  await env.UPLOADS.put(key, bytes, {
    httpMetadata: { contentType: sniffed.type, cacheControl: IMMUTABLE },
  });
  return Response.json({ key }, { headers: CORS });
}

/** GET /img/:key — stream an image out of R2 with an immutable cache (CDN-cacheable). */
async function handleServe(key: string, env: Env): Promise<Response> {
  const obj = await env.UPLOADS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", IMMUTABLE);
  headers.set("ETag", obj.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff"); // never let the browser re-sniff a stored image
  // Allow cross-origin reads so a board export can rasterize these images without tainting the canvas
  // (the deployed client is a different origin than the worker). The images are public anyway.
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(obj.body, { headers });
}

/** Periodic orphan-image sweep (SEC-R2): delete R2 images referenced by no live room and older than
 *  the grace window. The referenced set is the union of every room's KV index entry (written by the
 *  Board DO on save). Heavily guarded — this deletes user data:
 *   - ABORT if the KV index is unreadable (never treat "can't read" as "nothing referenced").
 *   - ABORT if the index is empty (0 rooms) while R2 has objects (index lost / not yet populated).
 *   - ABORT if the decision would delete > half the bucket (circuit breaker).
 *   - the grace window in keysToSweep spares freshly-uploaded (not-yet-saved) images. */
async function sweepOrphanImages(env: Env): Promise<void> {
  const kv = env.ASSET_INDEX;
  if (!kv) {
    console.warn("[sweep] ASSET_INDEX not bound — skipping orphan-image sweep");
    return;
  }

  const referenced = new Set<string>();
  let rooms = 0;
  try {
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix: "room:", cursor });
      for (const k of page.keys) {
        rooms++;
        const val = await kv.get(k.name);
        if (val) for (const key of JSON.parse(val) as string[]) referenced.add(key);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    console.error("[sweep] aborting — asset index unreadable:", err);
    return;
  }

  const objects: R2ObjectInfo[] = [];
  let r2cursor: string | undefined;
  do {
    const listed = await env.UPLOADS.list({ cursor: r2cursor });
    for (const o of listed.objects) objects.push({ key: o.key, uploaded: o.uploaded.getTime() });
    r2cursor = listed.truncated ? listed.cursor : undefined;
  } while (r2cursor);

  const doomed = keysToSweep(referenced, objects, Date.now());
  if (rooms === 0 && objects.length > 0) {
    console.error(
      `[sweep] aborting — index empty (0 rooms) but R2 holds ${objects.length} objects`,
    );
    return;
  }
  if (!sweepIsSafe(doomed.length, objects.length)) {
    console.error(`[sweep] aborting — would delete ${doomed.length}/${objects.length} (>50%)`);
    return;
  }

  for (let i = 0; i < doomed.length; i += 1000) await env.UPLOADS.delete(doomed.slice(i, i + 1000));
  console.log(
    `[sweep] deleted ${doomed.length} orphan image(s) — ${objects.length} R2 objects, ${rooms} rooms, ${referenced.size} referenced`,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Image upload + serve (before the PartyServer WS routing).
    if (url.pathname === "/upload") return handleUpload(request, env);
    if (url.pathname.startsWith("/img/")) {
      let key: string;
      try {
        key = decodeURIComponent(url.pathname.slice("/img/".length));
      } catch {
        return new Response("Bad request", { status: 400 }); // malformed %-escape → 400, not a 500
      }
      return handleServe(key, env);
    }

    // Per-IP join rate limit before opening a room WS: bounds room-id enumeration (a scanner of the
    // friendly-name space makes one connection per guess). Generous (6/s) so legit multi-tab/reconnect
    // never trips it; fails OPEN where the binding/IP is absent (local dev). See docs/09 SEC-RM/SEC-DO.
    if (url.pathname.startsWith("/parties/")) {
      const ip = request.headers.get("cf-connecting-ip");
      if (ip && env.JOIN_RL) {
        try {
          if (!(await env.JOIN_RL.limit({ key: ip })).success)
            return new Response("Too many connection attempts — try again shortly", {
              status: 429,
            });
        } catch {
          /* limiter unavailable → fail open */
        }
      }
    }

    // PartyServer routes /parties/<binding>/<room> to the matching Durable Object
    // (here the "Main" binding => /parties/main/:roomId). Returns null on no match.
    const routed = await routePartykitRequest(request, env as unknown as Record<string, unknown>);
    if (routed) return routed;

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "komuboard-worker", party: "main" });
    }

    return new Response("Not found — connect a WebSocket to /parties/main/:roomId", {
      status: 404,
    });
  },
  /** Cron entry point for the orphan-image sweep — schedule in wrangler.toml [triggers]. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sweepOrphanImages(env);
  },
} satisfies ExportedHandler<Env>;
