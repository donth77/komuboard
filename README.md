# Komuboard — README

> _One whiteboard. Every screen — desktop, mobile, and VR._

**Komuboard** is a free-to-run, realtime, online collaborative whiteboard that works everywhere: desktop (mouse), mobile/tablet (touch), and VR headsets (WebXR). Anyone opens a link, lands in an anonymous room, and draws together with live multiplayer cursors and presence — no signup. The same board document is the single source of truth shared by both the 2D web renderer and the immersive 3D VR renderer, so what you sketch on a phone shows up on a headset and vice versa, in real time.

## Headline features

- **Infinite pan/zoom canvas** with freehand pen/marker (color, thickness), sticky notes, shapes (rectangle, ellipse, line, arrow), and text.
- **Realtime multiplayer** via Yjs CRDT — live labeled cursors, presence avatars, and join/leave.
- **Anonymous rooms** by default — shareable code/URL, no signup, edge persistence so a room survives reconnect.
- **Cross-reality**: the same board renders as a 3D surface in VR, with synced head + hands avatars and laser-pointer cursors; draw in VR via controller raycast.
- **Progressive UX**: full power on desktop mouse, fully usable on mobile/tablet touch, immersive (not merely viewable) in VR.
- **Collaboration polish** (later phases): cursor chat, emoji stamps/reactions, comments, connectors, frames, templates, image upload, export, follow + spotlight mode, timer, dot voting, minimap.

## Tech stack (canonical)

- **Language + build:** TypeScript everywhere; Vite; pnpm workspaces monorepo.
- **Shared document / CRDT:** Yjs (single source of truth) + `y-protocols/awareness` for ephemeral presence (cursors, selections, VR avatar poses, cursor-chat).
- **2D renderer:** custom renderer bound to the Yjs doc (DOM-unified for per-object z-order), with a documented migration path to WebGL.
- **Realtime backend:** Cloudflare Workers + Durable Objects; PartyServer (one room per DO) + Y-PartyServer (per-room Yjs doc); PartySocket on the client; partysub to shard very large rooms.
- **Persistence:** Yjs update log + compacted snapshots in DO SQLite storage; uploaded assets in Cloudflare R2; optional D1 for a room index.
- **VR layer:** A-Frame + Three.js (WebXR) — board as a textured 3D surface, strokes written into the same Yjs doc, avatars + cursors synced via awareness.
- **Hosting:** SPA + VR assets on Cloudflare Pages (free CDN); realtime + API on Workers + Durable Objects (free tier).
- **Auth:** anonymous-first (room id in URL); optional named accounts later.
- **Client libs + tooling:** Lucide icons; light state store (Zustand/signals); **React optional** (acceptable for toolbar/panels, not part of the canonical renderer stack); Vitest (unit), Playwright (e2e + multiplayer); GitHub Actions → `wrangler deploy` + Pages deploy.

## Repo structure

```text
komuboard/
├── README.md                 # this file
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml
└── packages/
    ├── client-web/           # 2D SPA: renderer bound to Yjs, toolbar/panels
    ├── vr/                   # A-Frame + Three.js WebXR renderer (same Yjs doc)
    ├── shared/               # shared types, Yjs schema, awareness protocol, utils
    └── worker/               # Cloudflare Worker + Durable Object (PartyServer / Y-PartyServer)
```

## Dev quickstart

```bash
# Install all workspace dependencies (Node 22+, pnpm 9)
pnpm install

# Run the full local dev stack: worker (wrangler @ :8787) + web (vite @ :5173)
pnpm dev
# then open http://127.0.0.1:5173/?room=demo in two tabs to watch strokes, cursors, and selections sync

# Quality gates
pnpm typecheck && pnpm lint && pnpm test   # vitest unit tests
pnpm test:e2e                              # boots worker + web, asserts realtime sync

# Deploy the realtime backend (requires a Cloudflare account)
# One-time: create the R2 bucket that holds uploaded images (binding "UPLOADS" in worker/wrangler.toml)
pnpm --filter @komuboard/worker exec wrangler r2 bucket create komuboard-uploads
pnpm --filter @komuboard/worker run deploy   # `run` — bare `pnpm deploy` hits pnpm's own deploy cmd

# Build the web client pointed at the deployed worker — VITE_WORKER_HOST (host only, no scheme) drives
# BOTH the realtime WebSocket and image upload/serve. Defaults to 127.0.0.1:8787 for local dev.
VITE_WORKER_HOST=komuboard-worker.<your-subdomain>.workers.dev pnpm --filter @komuboard/client-web build
```

Welcome aboard — `pnpm install && pnpm dev`, then open two tabs on the same room and draw.

## Asset credits

- VR whiteboard: ["Low Poly Whiteboard"](https://sketchfab.com/3d-models/low-poly-whiteboard-1cbf089ec4b741ad9d092d15db6d55ba) via Sketchfab (`public/models/low_poly_whiteboard.glb`).
- VR marker: whiteboard marker model via Sketchfab (`public/models/whiteboard_marker.glb`).

See each model page for the author + license; most Sketchfab downloads are CC Attribution — keep this section in sync with the exact credit line from the download.
