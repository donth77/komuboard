import { routePartykitRequest } from "partyserver";
import { Board } from "./board";
import { sniffImage } from "./image-sniff";

// The Durable Object class must be exported from the Worker entry module.
export { Board };

export interface Env {
  /** One Durable Object per room; routed at /parties/main/:roomId. */
  Main: DurableObjectNamespace<Board>;
  /** R2 bucket for uploaded images (bytes; the Yjs doc only holds the key). */
  UPLOADS: R2Bucket;
  /** Per-IP upload rate limiter (Cloudflare ratelimit binding). Optional: absent in local dev. */
  UPLOAD_RL?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

// Image-upload guards (free-tier R2: bound storage, zero egress). The client also validates + downscales.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
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
  if (!ALLOWED_TYPES[declared])
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Image upload + serve (before the PartyServer WS routing).
    if (url.pathname === "/upload") return handleUpload(request, env);
    if (url.pathname.startsWith("/img/")) {
      return handleServe(decodeURIComponent(url.pathname.slice("/img/".length)), env);
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
} satisfies ExportedHandler<Env>;
