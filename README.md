# Coboard — README

> _One whiteboard. Every screen — desktop, mobile, and VR._

**Coboard** is a free-to-run, realtime, online collaborative whiteboard that works everywhere: desktop (mouse), mobile/tablet (touch), and VR headsets (WebXR). Anyone opens a link, lands in an anonymous room, and draws together with live multiplayer cursors and presence — no signup. The same board document is the single source of truth shared by both the 2D web renderer and the immersive 3D VR renderer, so what you sketch on a phone shows up on a headset and vice versa, in real time.

> Note: "Coboard" is a working/placeholder name — feel free to rename it before launch.

## What is this?

This repository is currently a **planning package**, not yet code. It holds the canonical design and architecture documents that define what Coboard is, how it looks, how it's built, how it stays free, and how it gets shipped. Use it to align on scope and architecture before the first line of product code lands. `docs/index.html` is an **interactive combined view of all the documents** — open it in a browser to read the whole package with navigation, rather than opening each Markdown file individually. The document text renders fully offline; the embedded architecture/sequence **diagrams fetch a renderer from a CDN, so they need an internet connection on first load**.

## Documents

Read in numeric order; each doc cross-links the others.

| # | Document | What it covers |
|---|----------|----------------|
| — | [README.md](./README.md) | This index: pitch, doc map, stack, repo plan, quickstart. |
| 01 | [docs/01-product-vision-and-references.md](./docs/01-product-vision-and-references.md) | Vision, problem, target users + jobs-to-be-done, the 4 reference products, competitive comparison, guiding principles, glossary. |
| 02 | [docs/02-features-and-scope.md](./docs/02-features-and-scope.md) | Full feature catalog, MoSCoW, the 3 phases with user stories + acceptance criteria, non-goals, feature-to-reference traceability. |
| 03 | [docs/03-visual-design-ui-ux.md](./docs/03-visual-design-ui-ux.md) | Design language + tokens, component inventory, desktop/mobile/VR layouts + wireframes, keyboard shortcuts, cursor/presence UX, accessibility. |
| 04 | [docs/04-technical-architecture.md](./docs/04-technical-architecture.md) | System + component diagrams, Yjs data model, sync + awareness protocol, Durable Object design, persistence, R2, VR rendering, sequence diagrams. |
| 05 | [docs/05-scaling-and-cost.md](./docs/05-scaling-and-cost.md) | Free-tier limit tables, the cost-model math (20:1 rule, hibernation), concurrency/capacity estimates, partysub sharding, the "$0 today" upgrade path. |
| 06 | [docs/06-implementation-roadmap.md](./docs/06-implementation-roadmap.md) | Milestones M0–M5, granular task checklists, repo layout, CI/CD, testing strategy, risk register, KPIs, definition-of-done. |
| 07 | [docs/07-engineering-quality-security-accessibility.md](./docs/07-engineering-quality-security-accessibility.md) | Performance & optimization, code maintainability, security & privacy, deep accessibility (WCAG 2.2 AA + XR), and a potential-issues / challenges register. |

## UI mockups

The [`mockups/`](./mockups/) folder holds clickable, high-fidelity **HTML mockups** and matching **PNG screenshots** of the interface: **desktop** canvas + toolbar, **mobile/tablet** touch layout, **VR window mode**, the first-run **onboarding** flow, and the **design-token** style tile — plus an **aidesigner-generated alternative** mockup. `docs/index.html` includes a **Mockups gallery** so you can browse them all (and the screenshots) alongside the documents in one view.

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
- **2D renderer:** custom renderer bound to the Yjs doc, drawn with Konva.js (Canvas 2D), with a documented migration path to PixiJS (WebGL).
- **Realtime backend:** Cloudflare Workers + Durable Objects; PartyServer (one room per DO) + Y-PartyServer (per-room Yjs doc); PartySocket on the client; partysub to shard very large rooms.
- **Persistence:** Yjs update log + compacted snapshots in DO SQLite storage; uploaded assets in Cloudflare R2; optional D1 for a room index.
- **VR layer:** A-Frame + Three.js (WebXR) — board as a textured 3D surface, strokes written into the same Yjs doc, avatars + cursors synced via awareness.
- **Hosting:** SPA + VR assets on Cloudflare Pages (free CDN); realtime + API on Workers + Durable Objects (free tier).
- **Auth:** anonymous-first (room id in URL); optional named accounts later.
- **Client libs + tooling:** Lucide icons; light state store (Zustand/signals), React acceptable for toolbar/panels; Vitest (unit), Playwright (e2e + multiplayer); GitHub Actions → `wrangler deploy` + Pages deploy.

## Reference products

Coboard learns from four products — see [docs/01](./docs/01-product-vision-and-references.md) for what we borrow from each.

1. [Whiteboard VR — Online Collaboration](https://devpost.com/software/whiteboard-vr-online-collaboration) ([source](https://github.com/marlon360/whiteboard-vr)) — our closest spiritual predecessor: cross-reality + room-code, no signup.
2. [Figma FigJam](https://www.figma.com/figjam/) — cursor chat, stamps, spotlight, clean infinite canvas.
3. [Miro](https://miro.com/online-whiteboard/) — shape/connector/template breadth, voting, timer, presentation mode.
4. [Canva Whiteboards](https://www.canva.com/online-whiteboard/) — sticky-note Sort, colorful labeled cursors, AI summarize.

**Coboard's differentiator:** truly free-to-self-host on edge infra, and a single shared document across 2D and immersive VR.

## Run it for $0

Coboard is designed to host **and** run for $0 on a single Cloudflare account at meaningful concurrency. Static assets (the SPA + A-Frame/VR bundles) serve from Cloudflare Pages' global CDN, which does not consume Worker requests. Realtime collaboration runs on Workers + Durable Objects: one Durable Object per room (PartyServer + Y-PartyServer), using the WebSocket Hibernation API so idle rooms stop accruing duration charges while clients stay connected. Cursor/presence traffic is ephemeral awareness, throttled and binary-encoded to respect the 20:1 inbound-WebSocket billing ratio and the free request budget; content edits persist as compact Yjs updates in the DO's SQLite storage, and uploaded images live in R2 (zero egress). See [docs/05-scaling-and-cost.md](./docs/05-scaling-and-cost.md) for the full math, capacity tables, and the upgrade path. _Exact free-tier figures change — verify against current Cloudflare docs._

## Planned repo structure

```text
coboard/
├── README.md                 # this index
├── docs/                     # the planning package (01–07)
│   ├── index.html            # interactive combined view of all docs
│   ├── 01-product-vision-and-references.md
│   ├── 02-features-and-scope.md
│   ├── 03-visual-design-ui-ux.md
│   ├── 04-technical-architecture.md
│   ├── 05-scaling-and-cost.md
│   ├── 06-implementation-roadmap.md
│   └── 07-engineering-quality-security-accessibility.md
├── mockups/                  # high-fidelity HTML UI mockups + PNG screenshots
│   ├── desktop.html          # desktop canvas + toolbar mockup (+ desktop.png)
│   ├── mobile.html           # mobile/tablet touch layout (+ mobile.png)
│   ├── vr.html               # VR window-mode mockup (+ vr.png)
│   ├── onboarding.html       # first-run / room-join onboarding (+ onboarding.png)
│   ├── tokens.html           # design-token style tile (+ tokens.png)
│   ├── tokens.css            # shared design tokens consumed by every mockup
│   ├── img/                  # PNG screenshots of each mockup
│   └── ai/                   # AI-generated alternative mockup (aidesigner, HTML)
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml
└── packages/
    ├── client-web/           # 2D SPA: Konva renderer bound to Yjs, toolbar/panels
    ├── vr/                   # A-Frame + Three.js WebXR renderer (same Yjs doc)
    ├── shared/               # shared types, Yjs schema, awareness protocol, utils
    └── worker/               # Cloudflare Worker + Durable Object (PartyServer / Y-PartyServer)
```

## Dev quickstart (planned)

> These are the **target** developer commands once code exists — this repo is currently planning docs only.

```bash
# Install all workspace dependencies
pnpm install

# Run the full dev environment (client-web, vr, and worker)
pnpm dev

# Deploy the realtime backend (Workers + Durable Objects)
pnpm wrangler deploy

# Deploy the static SPA + VR assets to Cloudflare Pages
pnpm pages deploy
```

Welcome aboard. Start with [docs/01-product-vision-and-references.md](./docs/01-product-vision-and-references.md), or open `docs/index.html` for the full interactive read.
