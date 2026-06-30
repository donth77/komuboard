import { routePartykitRequest } from "partyserver";
import { Board } from "./board";

// The Durable Object class must be exported from the Worker entry module.
export { Board };

export interface Env {
  /** One Durable Object per room; routed at /parties/main/:roomId. */
  Main: DurableObjectNamespace<Board>;
  /** R2 bucket for uploaded images (bytes; the Yjs doc only holds the key). */
  UPLOADS: R2Bucket;
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

  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  const ext = ALLOWED_TYPES[type];
  if (!ext)
    return Response.json({ error: "unsupported image type" }, { status: 415, headers: CORS });

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "image too large or empty" }, { status: 413, headers: CORS });
  }

  // Content-addressed key: identical images dedup, and the immutable cache is always safe.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `${hash}.${ext}`;
  await env.UPLOADS.put(key, bytes, {
    httpMetadata: { contentType: type, cacheControl: IMMUTABLE },
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
