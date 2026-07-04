# Komuboard — README

> Realtime. Collaborative. Everywhere — desktop, mobile, and VR.

**Komuboard** is a realtime, online collaborative whiteboard that works on desktop (mouse), mobile/tablet (touch), and VR (WebXR). Anyone opens a link, lands in an anonymous room, and draws together with live multiplayer cursors and presence, no signup. 

## Features

- **Infinite pan/zoom canvas**: freehand pen + highlighter (color, thickness, solid/dotted), sticky notes, shapes, text, connectors (arrows that bind to objects and re-route), emoji/stamp stickers, and image upload. Eraser, multi-select, grouping, lock, keyboard nudge, and undo/redo.
- **Realtime multiplayer** via Yjs CRDT — live labeled cursors, presence avatars, live drag/resize/rotate/typing shown mid-gesture, and join/leave.
- **Anonymous rooms** by default — shareable code/URL, no signup, edge persistence so a room survives reconnect.
- **Export** the whole board to PNG or PDF (grid, transparent, or solid background).
- **Cross-reality**: the same board renders on a standing 3D whiteboard in VR (WebXR). Peers appear as live 3D cursors with their edits and selections mirrored in realtime. In-headset you get the full toolset — select, pan, pen/highlighter, eraser — via a floating tool dock or grabbable **physics props**: grip the marker/eraser to pick it up, draw on the board, drop it and it falls back to the tray. A desktop "magic-window" preview (mouse + WASD) makes all of it testable without a headset.
- **Progressive UX**: full power on desktop mouse, fully usable on mobile/tablet touch, immersive (not merely viewable) in VR.


## Tech stack 

- **Language + build:** TypeScript everywhere; Vite; pnpm workspaces monorepo.
- **Shared document / CRDT:** Yjs (single source of truth) + `y-protocols/awareness` for ephemeral presence (cursors, selections, VR avatar poses, cursor-chat).
- **2D renderer:** custom renderer bound to the Yjs doc (DOM-unified for per-object z-order), with a documented migration path to WebGL.
- **Realtime backend:** Cloudflare Workers + Durable Objects; PartyServer (one room per DO) + Y-PartyServer (per-room Yjs doc); PartySocket on the client; partysub to shard very large rooms.
- **Persistence:** a single compacted Yjs snapshot (`encodeStateAsUpdate`) per save in DO SQLite — one BLOB row, no growing update log — flushed the moment a room empties; uploaded assets in Cloudflare R2; optional D1 for a room index.
- **VR layer:** A-Frame + Three.js (WebXR) — the Yjs doc is rasterized onto a 3D whiteboard surface; strokes drawn in VR are written into the same doc; peer cursors, live edits, and selections sync via awareness. Ships inside `client-web` as a lazily-loaded chunk (renderer swap on the same session, no reload). Includes an emulated-headset e2e harness (Meta `iwer`) so the controller path is CI-verified without hardware.
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
    │   └── src/vr/           # VR mode: lazy A-Frame renderer on the SAME doc/session
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

`pnpm install && pnpm dev`, then open two tabs on the same room and draw.

## Asset credits

- VR whiteboard: [Low Poly Whiteboard by tankop1](https://sketchfab.com/3d-models/low-poly-whiteboard-1cbf089ec4b741ad9d092d15db6d55ba) (Sketchfab, CC-BY)
- VR marker: [Whiteboard marker by Jimmy Johansson](https://sketchfab.com/3d-models/whiteboard-marker-904951bc3f2048fb83c62bb097958b55) (Sketchfab, CC-BY)
- VR eraser: [Whiteboard eraser by Jimmy Johansson](https://sketchfab.com/3d-models/whiteboard-eraser-ced8b75f6ecc44c9b1503af9aa4f7d06) (Sketchfab, CC-BY)
