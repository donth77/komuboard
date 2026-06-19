# Coboard — Engineering Quality, Performance, Security & Accessibility

> _Purpose: the cross-cutting engineering-quality contract — performance budgets and optimization tactics, code-maintainability rules, the security & privacy threat model for anonymous public rooms, the consolidated accessibility plan, and a risk register with open questions. This doc goes deeper than the surface that 03/04/05/06 establish and cross-references them rather than repeating them._

**Related documents:** [README](../README.md) · [01 — Product Vision & References](./01-product-vision-and-references.md) · [02 — Features & Scope](./02-features-and-scope.md) · [03 — Visual Design / UI / UX](./03-visual-design-ui-ux.md) · [04 — Technical Architecture](./04-technical-architecture.md) · [05 — Scaling & Cost](./05-scaling-and-cost.md) · [06 — Implementation Roadmap](./06-implementation-roadmap.md)

---

## 1. Purpose & scope

This is the **quality spine** of the Coboard planning package. Where:

- [04 — Technical Architecture](./04-technical-architecture.md) defines _what the system is_ (Yjs single source of truth, the Renderer abstraction, the Durable Object room model, the viewport/canvas-space model),
- [05 — Scaling & Cost](./05-scaling-and-cost.md) defines _how many users fit for $0_ (free-tier math, sharding, broadcast fanout),
- [06 — Implementation Roadmap](./06-implementation-roadmap.md) defines _the build order_ (milestones M0–M5, the test pyramid, CI/CD),

…**this document defines _how good it has to be and how we keep it that way_**: the performance budgets we hold the line on, the maintainability invariants that stop `client-web`, `vr`, and `worker` from drifting apart, the security posture for rooms that anyone can join from a link, and the accessibility commitment that the 2D experience is a _complete_ equivalent of VR. It is deliberately cross-cutting: every section points back into 03/04/05/06 for the foundational model and only adds the engineering depth.

A single guiding principle ties the four pillars together:

> **One document, two realities, zero divergence.** The Yjs doc is dimension-agnostic canvas-space ([04](./04-technical-architecture.md)). Performance, correctness, security, and accessibility are all judged against that invariant: a stroke drawn in VR and a sticky typed on a phone are the _same kind of object at the same coordinate_, and every pillar below must hold for both.

---

## 2. Performance & optimization

Performance is a **product feature** for Coboard: a whiteboard that stutters at 30 fps or shows a 600 ms cursor lag feels broken regardless of correctness. We optimize across four axes — **client rendering, network, load/startup, memory** — and hold them to the [budget table](#27-performance-budget) at the end of this section.

### 2.1 Client rendering — 2D (Konva / Canvas 2D)

The 2D renderer ([04](./04-technical-architecture.md)) binds Yjs objects to Konva nodes. The expensive thing is redrawing the canvas; everything below exists to redraw _less_.

- **Dirty-rect / layer caching.** Split the stage into a small number of Konva `Layer`s by update cadence: a **static content layer** (committed shapes), a **active/interaction layer** (the shape currently being drawn or dragged), and an **overlay layer** (remote cursors, selection handles, alignment guides, minimap). Only the layer that changed is re-rastered, so a remote cursor moving never forces the static content to redraw. Cache stable, complex groups with `node.cache()` so Konva rasterizes them once to an offscreen canvas and blits the bitmap thereafter; invalidate the cache only when the underlying Yjs object actually changes (driven by the typed observer in §3).
- **Shape virtualization + viewport culling (2D).** On an infinite canvas the doc may hold tens of thousands of objects but only a few hundred are on screen. We maintain a spatial index (a coarse uniform grid or R-tree keyed by each object's canvas-space AABB) and only instantiate / draw Konva nodes whose AABB intersects the current camera rect (plus a margin ring to pre-warm objects just off-screen and avoid edge popping — see the [risk register](#6-potential-issues-challenges--open-questions)). Off-screen objects keep no Konva node at all; they live only as Yjs data + an index entry.
- **Hit-test performance.** Konva's default per-shape hit graph gets expensive with thousands of nodes. We hit-test against our own spatial index first to get the small candidate set under the pointer, then do precise hit detection only on candidates. Disable Konva `listening` on the static content layer and route picking through the index; this keeps pointer-move handlers O(candidates) not O(objects).
- **Image downscale / atlas.** Pasted/uploaded images are downscaled to the maximum on-screen resolution they can occupy at current zoom (mip-like), re-encoded on upload (also a security step — §4), and small images are packed into a texture atlas to cut draw calls. Full-resolution originals stay in R2 and are fetched lazily on deep zoom.
- **PixiJS / WebGL migration trigger.** Konva (Canvas 2D) is the MVP renderer because it is simplest and is **pixel-identical to the texture VR bakes** (§2.2). The migration path to PixiJS/WebGL ([04](./04-technical-architecture.md)) is triggered by a measured threshold, not vibes: when **sustained 2D frame time on a mid-tier laptop exceeds the 16.7 ms budget with a realistic dense board (target ≈ 5k visible objects)** despite culling + caching, we move the static content layer to WebGL. The Renderer abstraction (§3) means this swap does not touch document or app logic.

### 2.2 Client rendering — VR viewport-rect culling, LOD & texture-vs-geometry

VR follows the **canonical VR viewport model** ([04](./04-technical-architecture.md) / shared context): the infinite canvas is shown through a finite physical panel (~2.0 m × 1.2 m, optionally curved); a **viewport rect `{x, y, w, h}` in canvas coords** is mapped onto that panel. Performance is what makes a 50k-object canvas hold 72–90 fps on a standalone headset.

- **Viewport-rect culling.** VR renders only objects whose canvas AABB intersects (or is near) the current viewport rect — the same spatial index as 2D, queried with the VR viewport rect instead of the 2D camera rect. Everything outside the rect is neither drawn nor uploaded to the GPU.
- **Two-tier LOD.**
  - **MVP / far tier — baked `CanvasTexture`.** The visible region is rendered exactly as the 2D Konva renderer would render it, to an offscreen canvas, and uploaded as a single `CanvasTexture` mapped onto the panel. This is **cheap (one textured quad) and pixel-identical to 2D**, which guarantees cross-reality visual parity for free. The texture is re-baked only when the viewport rect changes (pan/zoom) or when visible Yjs objects change, debounced to the headset frame budget.
  - **Fidelity / near tier — native 3D stroke geometry.** For the in-focus sub-region (where the user is pointing/drawing) we render native Three.js stroke geometry (tubes/ribbons) so strokes have real depth and crisp edges at close range; we fall back to the texture tier when zoomed out or off-focus. The boundary between tiers is hysteretic to avoid flip-flopping.
- **Texture hygiene.** Baked textures are sized to the panel's on-screen texel budget (not the full canvas), use `needsUpdate` surgically, and are **disposed** when superseded (§2.6). A pool of reusable canvas/texture pairs avoids per-frame allocation.
- **Draw-on-panel math is the hot path for correctness, not speed.** Controller raycast → panel UV (0..1) → viewport-rect mapping → canvas coords (see [risk register](#6-potential-issues-challenges--open-questions) for the UV/viewport-math bug class). It is cheap per-sample; we just sample at controller rate and simplify the polyline before committing to Yjs.

### 2.3 Network

The wire model is Yjs binary deltas over PartySocket to a per-room Durable Object ([04](./04-technical-architecture.md)); ephemeral presence is `y-protocols/awareness`.

- **Binary Yjs deltas.** Document edits travel as compact binary update messages (not JSON), already minimal because Yjs encodes only the delta. No re-serialization to JSON on the hot path.
- **Cursor coalescing to ~20 Hz + 60 fps interpolation (finding 2).** Local cursor/pointer movement is **broadcast throttled to ~20 Hz** to cap awareness traffic, but remote cursors are **interpolated and animated at 60 fps with `requestAnimationFrame`** so they _glide_ to each new target instead of teleporting. This **decouples send-rate from render-rate** and masks network latency — the single highest-leverage presence-UX technique (cite: Liveblocks multiplayer guide <https://liveblocks.io/multiplayer>; "Building Figma Multiplayer Cursors" <https://mskelton.dev/blog/building-figma-multiplayer-cursors>). Local edits are applied **optimistically** and reconciled through the CRDT, so the local user never waits for the server.
- **Awareness batching.** Awareness updates (cursor, selection, VR avatar pose, cursor-chat, viewport rect) are batched per animation frame and diffed so we only send changed fields. VR avatar poses are quantized (position/rotation to sane precision) before broadcast.
- **Snapshot compaction + debounced persistence.** The DO appends Yjs updates to its SQLite update log and periodically **compacts to a single snapshot** (coalescing the log) so reconnection/late-join cost stays bounded. Persistence is **debounced** (write-behind) rather than per-keystroke, batching a burst of edits into one storage write — this is also a cost lever ([05](./05-scaling-and-cost.md)).
- **Fanout discipline.** Broadcast fanout is the dominant scaling cost ([05](./05-scaling-and-cost.md)); coalescing + batching above directly reduce messages-per-second per room, and `partysub` shards hot rooms.

### 2.4 Load / startup

- **Code-splitting.** The app is split so the first paint needs only the 2D core (Konva + Yjs + Zustand + PartySocket). Heavy/optional features (export, image processing, templates) are dynamic-imported on first use.
- **Lazy-load the A-Frame / VR bundle only on Enter-VR.** A-Frame + Three.js + the VR renderer are a large bundle that **2D users must never pay for**. They are dynamic-imported only when the user clicks **Enter VR** (or a WebXR session is requested). This keeps the initial JS bundle within budget for the 95%+ of sessions that are desktop/mobile.
- **Pages CDN statics + preconnect.** All static assets ship from Cloudflare Pages CDN (off the Worker meter — [05](./05-scaling-and-cost.md)). The HTML `preconnect`s to the Worker/DO WebSocket origin and to R2 so the first sync round-trip and first asset fetch start their TCP/TLS handshakes during parse.
- **Time-to-first-draw.** The room is interactive (you can draw) before full sync completes: we render the local optimistic state immediately and merge server history as it streams. Target **< 3 s** ([budget](#27-performance-budget)).

### 2.5 Memory

- **CRDT tombstone / GC compaction.** Yjs keeps tombstones for deleted content; on long-lived boards this grows unboundedly (a headline risk — see [§6](#6-potential-issues-challenges--open-questions)). We run Yjs GC, and snapshot-compaction in the DO discards superseded log entries so the resident doc stays proportional to _live_ content, not total historical edits.
- **Capped undo history.** The undo/redo stack (`Y.UndoManager`) is capped (depth + age) so an 8-hour session does not accumulate unbounded undo state in every client. Undo history is **per-session and in-memory** — it is cleared on reload/reconnect (the persisted Yjs doc is unaffected); we never replay it from storage.
- **Three.js disposal.** Geometries, materials, and textures created for VR are explicitly `.dispose()`d when objects leave the viewport rect or when LOD tiers swap; the texture/canvas pool (§2.2) bounds allocation. We assert on a leaked-resource counter in dev builds.
- **Konva node lifecycle.** Virtualized-out shapes destroy their Konva nodes (not just hide them) so off-screen content costs zero GPU/DOM.

### 2.6 Instrumentation

We can't hold a budget we don't measure. A lightweight dev HUD reports fps, frame time, visible-object count, awareness msgs/s, and bytes/s; Playwright + the WebXR emulator ([06](./06-implementation-roadmap.md)) assert frame-time and bundle-size budgets in CI so regressions fail the build, not production.

### 2.7 Performance budget

| Metric | Target | Where enforced |
|---|---|---|
| 2D render (desktop, dense board) | **60 fps** (≤ 16.7 ms frame) | Playwright perf assert; dev HUD |
| VR render (standalone headset) | **72 / 90 fps** (≤ 13.9 / 11.1 ms frame) | WebXR emulator + manual on-device |
| Initial JS bundle (2D core, gzipped) | **≤ ~250 KB** (VR bundle excluded, lazy) | CI bundle-size budget |
| Document sync latency (edit → remote apply), p95 | **< 250 ms** | matches [05](./05-scaling-and-cost.md)/[06](./06-implementation-roadmap.md) KPIs |
| Cursor round-trip, p95 | **< 150 ms** | matches [05](./05-scaling-and-cost.md)/[06](./06-implementation-roadmap.md); masked by 60 fps interpolation |
| Time-to-first-draw (room load → can draw) | **< 3 s** | Lighthouse + manual |
| Awareness broadcast rate (cursor) | **~20 Hz** coalesced | client throttle; load test |
| Re-bake cadence (VR texture) | debounced to frame budget | dev HUD |

> Budgets are **CI gates**, not aspirations. A PR that pushes the 2D core bundle over budget or drops dense-board frame time below 60 fps fails review ([06](./06-implementation-roadmap.md)).

---

## 3. Code maintainability & architecture quality

The maintainability strategy has one job: **stop `client-web`, `vr`, and `worker` from diverging**, because divergence between the two realities is the project's defining failure mode.

### 3.1 The `shared` package is the contract

`packages/shared` is the **single typed contract** consumed by `client-web`, `vr`, and `worker`. It exports:

- the **Yjs document schema** — the canonical shape of the root map and every object type (stroke, shape, sticky, text, image, frame), all in **canvas coordinates**, dimension-agnostic ([04](./04-technical-architecture.md));
- the **awareness protocol** — the typed shape of every presence field (cursor, selection, VR avatar pose, cursor-chat, viewport rect);
- the **viewport math** — canvas↔display transforms shared by the 2D camera and the VR viewport rect, so the UV/viewport mapping has exactly one implementation (kills a whole bug class — see [§6](#6-potential-issues-challenges--open-questions));
- shared constants (units, default panel size, color palette tokens, rate-limit values).

Because all three runtimes import the _same_ types and the _same_ helpers, they **cannot diverge by construction** — a schema change is a compile error in every package that hasn't caught up.

### 3.2 TypeScript strict + typed Yjs accessors

- `strict: true` everywhere (`noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`). No `any` on the document path.
- **Typed Yjs accessors.** Raw `Y.Map`/`Y.Array` are untyped; we wrap them in thin typed accessors in `shared` (e.g. `getStroke(map): Stroke`, `setStrokePoints(...)`) so the rest of the codebase never touches an untyped CRDT node. Observers are typed too, so dirty-tracking (§2.1) gets a typed change set.

### 3.3 The Renderer abstraction

A single `Renderer` interface is implemented twice:

- `KonvaRenderer` (2D, Canvas 2D),
- `AFrameRenderer` (VR, A-Frame/Three.js).

Both bind to **the same `(doc, viewport)` pair** and translate it to pixels/geometry. The app, tools, selection, undo, and presence logic are renderer-agnostic; they speak document + viewport, never Konva or A-Frame directly. This is what makes "2D and VR are the same app with two renderers" true in code, and it is the seam the PixiJS migration (§2.1) slides into.

### 3.4 State boundaries (Zustand)

Zustand holds **only ephemeral/local UI state** — current tool, selected ids, camera/viewport, modal open, theme. **Document state lives in Yjs, never duplicated into Zustand** (duplicating it is how 2D/VR drift starts). The boundary is explicit and lint-enforced where feasible: a component reads document data through the typed Yjs accessors + observers, and reads UI state through Zustand.

### 3.5 UI chrome: composition model (Web Components)

The DOM **chrome** — top bar, tool dock, properties panels, dialogs, share/onboarding sheets, minimap, presence facepile — is built from **native Web Components (custom elements)**, no UI framework required (the board itself is Konva canvas; VR is A-Frame). This is the framework-agnostic counterpart to §3.4: document state lives in Yjs, UI state in Zustand, and **chrome lives in `<co-*>` custom elements** with property-in / `CustomEvent`-out interfaces — app glue does the Yjs/awareness wiring, elements are presentation + local interaction. Rationale and trade-offs: **[ADR-0005](./adr/0005-ui-chrome-web-components.md)**.

- **Light DOM, not Shadow DOM.** Elements share Coboard's global design system — CSS tokens **and** utility classes (`.btn-primary`, `.swatches`, `.kbd`, `.avatar`, …). Shadow DOM was rejected: custom properties pierce a shadow boundary but **class selectors do not**, so it would force per-component style duplication (and the global `prefers-reduced-motion` reset would stop applying).
- **A11y bonus of light DOM:** one DOM tree means no cross-root ARIA fragmentation — important for the §5.1 semantic mirror and the live-region announcer — and keeps `axe-core` / Playwright selectors simple. Trade-off: no style encapsulation, so rely on disciplined prefixed class names + the single shared stylesheet.
- **Vanilla now, [Lit](https://lit.dev) (~6 KB, MIT) optional** if boilerplate grows — within the §2.7 bundle budget, not a "heavy framework"; interops with React 19 if the React-optional path ([04 §9](./04-technical-architecture.md)) is taken. Shipped: `<co-dialog>`, `<co-avatar-presence-row>`, `<co-tool-dock>`, `<co-pen-panel>`, `<co-zoombar>` (in `packages/client-web/src/`), over a shared `icons.ts`.

### 3.6 Conventions, automation & decision records

- **ESLint + Prettier** with a shared config across packages; lint + typecheck are required CI checks ([06](./06-implementation-roadmap.md)).
- **Conventional commits**, enabling automated changelogs and clear history.
- **ADRs (Architecture Decision Records)** in `docs/adr/` for irreversible-ish choices (Yjs as SoT, Konva-first then PixiJS, the viewport/canvas-space model, PartyServer/DO room model). The canonical decisions in this package _become_ ADR-0001…; this doc cross-links rather than re-litigates.
- **Dependency hygiene + Renovate.** Renovate raises grouped, automated dependency PRs; the lockfile is committed; versions are pinned (also a supply-chain control — §4). `pnpm audit` runs in CI.
- **Feature flags** for risky/incremental features (native-geometry VR LOD, room-scale mode, export formats) so they ship dark and flip on per-room or per-env without branching.
- **Error-handling patterns.** Typed `Result`/error unions on fallible boundaries (network, storage, asset upload); a top-level error boundary in 2D and a VR-session error path that drops back to 2D rather than crashing; structured logging in the Worker. Never swallow; never `throw` raw strings.
- **Component & module docs.** Each package has a README describing its boundary; public exports in `shared` are TSDoc-commented because they are the contract everyone else builds on.

### 3.7 Testing

The **test pyramid, CI matrix, and coverage targets live in [06 — Implementation Roadmap](./06-implementation-roadmap.md)** (Vitest unit/integration, Playwright E2E, WebXR emulator). We do not repeat it here. The maintainability hook is only this: the `shared` contract (§3.1) and the viewport math (§3.3) carry the **highest-value unit tests** in the repo — a property test that a point round-trips canvas → UV → canvas for arbitrary viewport rects is worth more than any UI test.

---

## 4. Security & privacy

Coboard is **anonymous-first and public-by-link** ([01](./01-product-vision-and-references.md)/[02](./02-features-and-scope.md)): anyone with a room URL can join, draw, and (later) upload. That openness is the product _and_ the threat surface. The model below assumes an attacker who has, or can guess, a room link.

### 4.1 Threat model (anonymous public rooms)

| Asset | Threat | Primary control |
|---|---|---|
| Room content | Unauthorized join / lurking | High-entropy room id; optional passcode; capability URLs |
| Room content | Vandalism / "board-nuke" | CRDT undo + snapshots; rate limits; (later) per-room moderation |
| Clients | Stored/reflected XSS via sticky/text/export | Treat all text as data; DOMPurify on any HTML/SVG render or export |
| DO / Worker | Flood / DoS / oversized messages | Per-connection token bucket; message-size caps; spawn rate-limit |
| Assets (R2) | Malicious upload / EXIF leak / content-type spoof | Signed uploads; re-encode; content-type + size validation |
| Users | PII exposure | PII-minimal anonymous model; retention/deletion posture |
| Supply chain | Compromised CDN/dependency | SRI on CDN scripts; pinned versions; lockfile; `pnpm audit` |

### 4.2 Access control & room secrecy

- **Room-id entropy.** The canonical **room id in the share URL** is high-entropy CSPRNG (**~128-bit class**, e.g. `nanoid(21)`), URL-safe and never sequential — the unguessable capability, so a "secret link" is a meaningful (if soft) access boundary. The short human **join code** ([04 §8](./04-technical-architecture.md)) is a separate **lower-entropy alias** (resolved via the D1 index) for typing on a headset/phone; it is **rate-limited and rotatable**, never the access boundary itself.
- **Optional passcode.** A room can carry an optional passcode; the DO refuses `join` without it. Passcodes are checked server-side in the DO, never trusted from the client.
- **Capability URLs.** The link _is_ the capability ("anyone with the link can edit"). We design for capability degradation later — **view-only vs edit capability tokens** in the URL fragment, distinct caps for the same room — without breaking the anonymous-first default.
- **Authz path to named accounts.** Anonymous edit is the default; the model is built so **named accounts and per-room roles (owner/editor/viewer)** can be layered on later ([02](./02-features-and-scope.md)) without re-architecting — the DO already mediates every join and is the natural policy enforcement point.

### 4.3 Input validation & sanitization

- **Text is data, never markup.** Sticky/text content is rendered as text nodes / canvas text, never as HTML, on the live board. This neutralizes the primary XSS vector.
- **Sanitize HTML/SVG export with DOMPurify.** Any path that produces or ingests HTML or SVG (SVG export, HTML export, rich paste) runs through **DOMPurify** with a strict allow-list. SVG export is the sharp edge: SVG can carry `<script>`/`onload`; we strip event handlers and script elements and re-serialize.
- **Schema validation at the DO boundary.** Incoming Yjs updates and awareness messages are size- and shape-checked against the `shared` schema before being applied/persisted; malformed messages are dropped and the connection penalized.
- **Mermaid/markdown note (relevant to `index.html`).** The planning-doc viewer `index.html` was hardened: it now renders diagrams via `mermaid` with `securityLevel: "strict"` and vendors `marked.js` **inline** (so the document text renders fully offline, no markdown CDN). For any _user-facing_ markdown/diagram surface (not just the internal doc viewer), keep `securityLevel: "strict"` and pass `marked` output through DOMPurify. (The doc viewer is internal/trusted content, but the pattern must not be copied into product surfaces as-is.)

### 4.4 Rate limiting, message caps & abuse/griefing

- **Per-connection rate limiting (token bucket) in the DO.** Each WebSocket connection gets a token bucket for edits and for awareness; bursts are absorbed, sustained floods are throttled or disconnected. Limits live as constants in `shared`.
- **Message-size caps.** Per-message and per-window byte caps reject oversized updates. The DO operates within the **Cloudflare 32 MiB WebSocket message limit**; our product cap is far lower so a single message can never approach it.
- **Board-nuke protection.** A griefer mass-deleting content is mitigated by (a) CRDT **undo** (deletes are reversible — snapshots + the update log let us roll a room back to a pre-vandalism snapshot), (b) rate limits on deletes, and (c) later, per-room moderation/locking. The data model makes destruction recoverable rather than permanent.
- **Flood/cursor-storm mitigation.** Cursor coalescing (§2.3) caps per-user awareness rate; the DO additionally caps aggregate broadcast and sheds the lowest-value messages (cursors before edits) under pressure — ties to fanout in [05](./05-scaling-and-cost.md).

### 4.5 Transport, headers & CORS

- **CSP + security headers on Pages.** Strict `Content-Security-Policy` (no inline script in product surfaces; explicit `connect-src` for the Worker WS + R2; `frame-ancestors 'none'`), plus `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` (gate `xr-spatial-tracking`, camera/mic to self), and HSTS.
- **CORS.** The Worker/DO API sets explicit CORS allow-lists (the Pages origin), not `*`, for any non-WebSocket endpoint.
- **Secure context / WebXR.** WebXR requires HTTPS secure context; everything is HTTPS-only, which WebXR + Pages give us by default. XR session entry requires an explicit user gesture (browser-enforced) and we request only the XR permissions we use.

### 4.6 Assets (R2)

- **Signed uploads.** Clients never get long-lived R2 credentials; the Worker issues short-lived **signed upload URLs** scoped to a single object after validating the requesting connection.
- **Content-type + size validation.** Upload requests declare type/size; the Worker validates against an allow-list (images first) and a **configurable size cap (product default ~30 MB — this is _our_ default, not a Cloudflare limit)** before signing.
- **Re-encode to strip EXIF / payloads.** Uploaded images are **re-encoded server-side/edge-side** to a canonical format, which strips EXIF (privacy/geolocation) and neutralizes polyglot/malicious payloads hidden in metadata. The re-encoded asset, not the original, is what the board references.

### 4.7 DoS via room creation & secrets

- **Spawn rate-limiting.** Room/DO creation is rate-limited per client/IP so an attacker can't spin up unbounded Durable Objects (a cost + DoS vector — [05](./05-scaling-and-cost.md)).
- **Secrets via Wrangler.** All secrets (signing keys, any provider keys) live in Wrangler/Worker secret bindings, **never in client bundles or `index.html`**. The client only ever receives short-lived capability tokens/URLs.

### 4.8 Privacy & data retention (GDPR posture)

- **PII-minimal by design.** Anonymous model: no email, no account required; a session has a random display name + color, no stable identifier beyond the ephemeral connection. We collect essentially no PII.
- **Retention / deletion.** Inactive rooms are eligible for TTL-based deletion ([05](./05-scaling-and-cost.md) drives the economics); room owners (when accounts exist) and a documented request path can trigger deletion of a room's snapshot + log + assets. Awareness/presence data is ephemeral and never persisted.
- **No third-party trackers** on product surfaces; analytics, if any, are privacy-preserving and aggregate.

### 4.9 Supply chain

- **Lockfile + pinned versions + `pnpm audit`** in CI (also §3.6). Renovate keeps pins current with review.
- **Subresource Integrity (SRI) on CDN `<script>`.** `index.html` was updated: `marked` is now **vendored inline** (no CDN), so only `mermaid` still loads from `cdn.jsdelivr.net`. Remaining hardening gap: **add Subresource Integrity (SRI) to the still-CDN-hosted `mermaid` `<script>`** (`integrity="sha384-…" crossorigin="anonymous"`) so a compromised/swapped CDN asset fails to execute, **or bundle `mermaid` too** (vendor it inline like `marked`) to drop the CDN dependency entirely. For product surfaces, prefer **self-hosting/bundling** via the Vite pipeline over CDN.

### 4.10 Security checklist

- [ ] Canonical room id high-entropy CSPRNG (~128-bit class), URL-safe, non-sequential; short join code is a rate-limited, rotatable alias
- [ ] Optional passcode enforced server-side in the DO
- [ ] Capability-URL model (view vs edit) designed in
- [ ] Sticky/text rendered as text, never HTML, on the live board
- [ ] DOMPurify on all HTML/SVG export + rich-paste paths
- [ ] `marked`/`mermaid` use `strict` + DOMPurify on any product surface
- [ ] DO validates message shape/size against `shared` schema; drops malformed
- [ ] Per-connection token-bucket rate limits (edits + awareness)
- [ ] Per-message + per-window size caps; well under 32 MiB WS limit
- [ ] Board-nuke recovery via snapshots + CRDT undo verified
- [ ] CSP + nosniff + Referrer-Policy + Permissions-Policy + HSTS on Pages
- [ ] CORS allow-list (no `*`) on Worker endpoints
- [ ] HTTPS-only; WebXR behind secure context + user gesture
- [ ] R2 signed short-lived upload URLs; clients hold no R2 creds
- [ ] Upload content-type + size validation (configurable ~30 MB default)
- [ ] Server-side image re-encode strips EXIF / payloads
- [ ] Room-creation (DO spawn) rate-limited per client/IP
- [ ] Secrets only in Wrangler bindings; none in client/`index.html`
- [ ] PII-minimal model + room deletion path + ephemeral presence (GDPR)
- [ ] Lockfile committed; versions pinned; `pnpm audit` in CI; Renovate on
- [ ] SRI `integrity` on every CDN `<script>` (or self-host/bundle)

---

## 5. Accessibility

This is the **consolidated, deeper** accessibility plan; [03 — Visual Design / UI / UX](./03-visual-design-ui-ux.md) covers the visual/UX surface, this covers the engineering commitment. **Target: WCAG 2.2 AA.**

### 5.1 The canvas-a11y problem — and the solution

A `<canvas>` is an opaque pixel buffer: screen readers see nothing, keyboards can't reach shapes. Coboard solves this with an **offscreen DOM semantic mirror**:

- **Object list mirror.** A visually-hidden, focusable DOM list mirrors the document — every canvas object becomes a labeled list item ("Sticky: 'Q3 goals', top-left", "Arrow connecting A to B"), generated from the same typed Yjs accessors (§3.2). Screen readers navigate _this_, not the pixels.
- **ARIA live region for presence + remote changes.** A polite `aria-live` region announces presence ("Maya joined", "2 people editing") and salient remote changes ("Sam added a sticky"), so a non-visual user perceives the _multiplayer_ dimension that finding 2 (presence UX) makes central.
- **Keyboard-drivable everything.** Create, select, move, resize, connect, and delete are all reachable from the keyboard (tool hotkeys, arrow-key nudging, tab-through selection, an "add connection" command). The canvas is a real application widget, not a mouse-only surface.

### 5.2 Focus, color & motion

- **Focus management + visible focus.** Logical focus order, focus trapping in modals, and an **always-visible focus indicator** meeting WCAG 2.2 **Focus Appearance**. Entering/exiting tools and dialogs moves focus predictably.
- **Colorblind-safe identity palette + non-color cues (finding 4).** The per-user identity/cursor palette is chosen to be **colorblind-distinguishable** AND **never color-alone**: every cursor carries an always-visible **name label**, and optionally a per-user **shape/pattern token**, so identity survives CVD (≈ 1 in 12 men). (Cite: W3C XAUR <https://www.w3.org/TR/xaur/>; WCAG 2.2 Use of Color + Non-text Contrast.)
- **≥ 3:1 non-text contrast.** UI controls, focus rings, selection handles, cursor markers, and graphical boundaries meet **WCAG 2.2 Non-text Contrast (3:1)**; text meets AA contrast. Tokens (§ design tokens in [03](./03-visual-design-ui-ux.md)) encode the accessible values so contrast is structural, not per-component luck.
- **Reduced motion.** All motion (the 200–300 ms structural micro-interactions, cursor interpolation flourishes, VR transitions) is gated by `prefers-reduced-motion`; reduced mode keeps motion that communicates state and removes decorative motion.

### 5.3 Voice, targets, i18n

- **Captions / transcripts for voice.** If/when voice or cursor-chat audio ships, provide captions/transcripts; text cursor-chat is itself the accessible equivalent of spatial voice.
- **Touch target sizing.** Interactive controls meet WCAG 2.2 **Target Size (Minimum) 24×24 CSS px**, with comfortable larger targets on the mobile/touch tool palette ([03](./03-visual-design-ui-ux.md)).
- **i18n / RTL readiness.** UI strings are externalized for translation; layout is logical-property-based (`inline-start`/`inline-end`) so RTL works without rework. Canvas content is language-neutral by nature.

### 5.4 VR accessibility — and 2D as the complete equivalent

VR accessibility follows spatial-UX + XAUR guidance (finding 3 + 4):

- **Comfort & posture.** Seated-first; one-handed operation possible; tools on the non-dominant-hand/wrist panel in the Personal reach zone to steady aim and reduce fatigue; shared content in the Social zone; **text subtends ≥ 2–3° FOV** (≥ 0.5 m view distance) with optional panel curvature so edges stay focusable.
- **Snap-turn + locomotion comfort** options to reduce vection/nausea; vignette/comfort settings.
- **Subtitles** for any in-VR audio.

**The load-bearing principle:** WebXR is **not yet a fully accessible platform** (XAUR is an emerging standard). Therefore **the 2D experience must be a _complete_ equivalent — there are NO VR-only features.** Anything you can do in VR (draw, move, connect, present, follow, see presence) you can do fully in 2D with keyboard + screen-reader support. VR is an _enhanced_ way to use Coboard, never the _only_ way to use any capability. This is both an accessibility guarantee and an architectural one (the Renderer abstraction, §3.3, makes it true by construction since both renderers bind the same document + commands).

### 5.5 Tooling & process

- **Automated:** `axe-core` runs in Playwright E2E ([06](./06-implementation-roadmap.md)) and fails CI on violations; ESLint a11y plugins on JSX (if React is used for panels — React is **optional**, not part of the canonical renderer stack; see [04 §9](./04-technical-architecture.md)).
- **Manual:** a periodic **screen-reader pass** (VoiceOver/NVDA) over create/select/move/connect + presence announcements, and a keyboard-only pass, are part of release sign-off. Automated tools catch ~30–40%; the manual passes catch the canvas-mirror correctness that tools can't.

### 5.6 Accessibility checklist

- [ ] Offscreen DOM semantic mirror (object list) generated from Yjs accessors
- [ ] `aria-live` region announces presence + salient remote changes
- [ ] Keyboard create/select/move/resize/connect/delete fully reachable
- [ ] Logical focus order; modal focus trap; WCAG 2.2 visible Focus Appearance
- [ ] Identity palette colorblind-distinguishable AND name label (+ optional shape token)
- [ ] ≥ 3:1 non-text contrast on UI/graphics; AA text contrast (token-encoded)
- [ ] `prefers-reduced-motion` gates all motion; structural motion preserved
- [ ] Captions/transcripts for voice; text cursor-chat as accessible equivalent
- [ ] Touch targets ≥ 24×24 CSS px
- [ ] Strings externalized; RTL-ready logical-property layout
- [ ] VR comfort: seated/one-handed, snap-turn, ≥ 2–3° FOV text, subtitles
- [ ] **2D is a complete equivalent — zero VR-only features** (verified per feature)
- [ ] `axe-core` in CI fails on violations
- [ ] Manual SR + keyboard pass in release sign-off

---

## 6. Potential issues, challenges & open questions

### 6.1 Risk / challenge register

| Challenge | Why it's hard | Approach / mitigation | Status |
|---|---|---|---|
| CRDT unbounded memory growth on long-lived boards | Yjs tombstones + update log grow with _total_ edits, not live content; an 8-hour brainstorm bloats every client + the DO | Yjs GC; **snapshot compaction** in the DO discards superseded log entries (§2.5); capped undo; resident size ∝ live content | Planned — compaction is M-critical |
| 2D↔VR coordinate / state divergence; viewport-rect ↔ UV math bugs | Off-by-one/transform bugs put a VR stroke at the wrong canvas coord → "it's in the wrong place for 2D users"; two impls would drift | **One** viewport-math impl in `shared` (§3.1/3.3); property tests round-tripping canvas↔UV↔canvas for arbitrary rects; single doc as SoT | Mitigated by design; needs the property-test suite |
| Viewport-culling correctness (edge popping) | Objects straddling the cull boundary can pop in/out as the camera/viewport moves | Margin/pre-warm ring around the visible rect (§2.1/2.2); hysteresis on LOD tier boundary; AABB-inclusive intersection | Approach known; tune margin empirically |
| Free-tier overrun + hot-room broadcast fanout | Fanout is O(users²)-ish per room; a viral room can blow the $0 budget | `partysub` sharding, coalescing/batching (§2.3), shedding cursors-before-edits under pressure — see **[05](./05-scaling-and-cost.md)** for the math | Cross-ref [05](./05-scaling-and-cost.md); levers identified |
| WebXR browser/device fragmentation + standalone-headset GPU limits | WebXR support + perf vary wildly (Quest browser vs Vision Pro vs desktop); standalone GPUs are weak | Lazy VR bundle (§2.4); two-tier LOD + texture baking (§2.2); feature-detect + graceful 2D fallback; on-device test matrix | Ongoing; needs device-lab pass |
| Large image assets | Big uploads hurt load, memory, and cost | Re-encode + downscale + atlas (§2.1/4.6); lazy full-res on deep zoom; size cap | Planned |
| Reconnect / offline edge cases + buffered awareness | Yjs merges cleanly, but stale buffered _awareness_ (cursors of since-gone users) can ghost; reconnection storms | Awareness timeout/clear on disconnect; resync via snapshot on reconnect; debounced reconnect backoff | Needs explicit reconnect tests |
| Determinism without `Date.now`/`Math.random` in shared logic | Non-deterministic inputs in shared document logic break CRDT convergence + reproducibility | Ban `Date.now`/`Math.random` in `shared` doc logic (lint rule); ids from CSPRNG at the _edge_/client boundary, passed in, not generated inside merge logic | Enforce via lint + review |
| Moderation / abuse at scale | Public anonymous rooms invite spam/NSFW/griefing; no accounts to ban | Rate limits + board-nuke recovery now (§4.4); per-room locking + report path + (later) accounts as the scalable answer | Partial; scales with accounts |
| Cursor storm at high concurrency | Many users × frequent cursor moves = awareness flood | 20 Hz coalescing + 60 fps interpolation (§2.3); DO aggregate cap + cursor shedding; per-room user soft-cap | Mitigated; validate under load test |
| Export fidelity (vector vs raster) | Strokes/text must export crisply; SVG export is also an XSS surface | Vector (SVG) export from canonical geometry where possible, raster (PNG) fallback; DOMPurify-sanitize SVG (§4.3) | Planned |
| Testing multiplayer + VR in CI | Concurrency + WebXR are hard to automate deterministically | Multi-client Playwright sessions; **WebXR emulator** in CI ([06](./06-implementation-roadmap.md)); property tests for CRDT + viewport math; on-device manual for true VR | Framework in [06](./06-implementation-roadmap.md) |
| Eventual-consistency UX (late joiner sees history) | A late joiner must receive full state fast without a janky replay | Serve **compacted snapshot** then live deltas (§2.3); optimistic local render; "syncing…" affordance until caught up | Snapshot path is the answer |

### 6.2 Open questions for the team

- **Capability tokens:** ship view-only vs edit capability URLs in MVP, or defer until named accounts? What's the URL-fragment format and rotation story?
- **Native-geometry VR LOD:** is the texture tier alone good enough for MVP fidelity, deferring native stroke geometry entirely behind a flag? Where exactly is the tier-swap threshold per headset class?
- **Cull margin & LOD hysteresis:** what margin ring / hysteresis values actually eliminate edge popping at target densities — needs empirical tuning, not a guess.
- **Room retention TTL:** what inactivity window deletes a room, and how do we warn the last editor before reaping (ties to [05](./05-scaling-and-cost.md) economics + GDPR posture)?
- **Moderation before accounts:** is rate-limit + board-nuke recovery + per-room lock _sufficient_ for a public launch, or do we gate public rooms until a report/ban path exists?
- **Self-host vs CDN for `marked`/`mermaid`:** bundle them through Vite for the product viewer (drops the SRI question entirely), or keep CDN + SRI?
- **Soft per-room concurrency cap:** what user count triggers sharding vs a "room full" message, and how does that interact with the fanout budget in [05](./05-scaling-and-cost.md)?
- **PixiJS migration trigger:** is ≈ 5k visible objects the right tripwire, or do we migrate earlier to avoid a mid-life rewrite?

---

## 7. Where to go next

- **[03 — Visual Design / UI / UX](./03-visual-design-ui-ux.md)** — the design-token system, identity palette, empty-state/onboarding, and the visual surface this doc holds to WCAG 2.2 AA.
- **[04 — Technical Architecture](./04-technical-architecture.md)** — the Yjs single-source-of-truth model, the Renderer abstraction, the canvas-space/viewport model, and the DO room architecture this doc optimizes, secures, and tests.
- **[05 — Scaling & Cost](./05-scaling-and-cost.md)** — the free-tier capacity math, sharding, and broadcast-fanout economics that the performance + security rate-limit budgets here tie back to.
- **[06 — Implementation Roadmap](./06-implementation-roadmap.md)** — the milestones, the full test pyramid + CI matrix, and the build order that turns these budgets and checklists into CI gates.

> _Quality is not a milestone — it's the budget table, the contract package, the security checklist, and the a11y checklist enforced on **every** PR. One document, two realities, zero divergence._
