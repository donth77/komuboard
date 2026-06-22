import { routePartykitRequest } from "partyserver";
import { Board } from "./board";

// The Durable Object class must be exported from the Worker entry module.
export { Board };

export interface Env {
  /** One Durable Object per room; routed at /parties/main/:roomId. */
  Main: DurableObjectNamespace<Board>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // PartyServer routes /parties/<binding>/<room> to the matching Durable Object
    // (here the "Main" binding => /parties/main/:roomId). Returns null on no match.
    const routed = await routePartykitRequest(request, env as unknown as Record<string, unknown>);
    if (routed) return routed;

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "komuboard-worker", party: "main" });
    }

    return new Response("Not found — connect a WebSocket to /parties/main/:roomId", {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
