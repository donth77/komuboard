# Coboard — Features and Scope

> _Purpose: the canonical feature catalog — MoSCoW prioritization, the three phased releases with per-feature user stories and testable acceptance criteria, the first-class realtime cursors & presence requirement, feature-to-reference traceability, and explicit v1 non-goals._

Related documents: [README](../README.md) · [01 — Product Vision & References](./01-product-vision-and-references.md) · [03 — Visual Design / UI / UX](./03-visual-design-ui-ux.md) · [04 — Technical Architecture](./04-technical-architecture.md) · [05 — Scaling & Cost](./05-scaling-and-cost.md) · [06 — Implementation Roadmap](./06-implementation-roadmap.md) · [07 — Engineering Quality, Performance, Security & Accessibility](./07-engineering-quality-security-accessibility.md)

---

## How to read this document

- **Phases are fixed.** Phase 1 (MVP) → Phase 2 (Collaboration & polish) → Phase 3 (Cross-reality / VR). Features never move between phases; that mapping is a project invariant.
- **Every feature** carries a one-line user story (`As a … I want … so that …`) and 2–4 **testable** acceptance criteria.
- **Acceptance criteria are verifiable** by automated tests where possible: Vitest (unit), Playwright (e2e + multiplayer with two browser contexts), and a headless WebXR emulator for VR smoke tests. See [06 — Roadmap](./06-implementation-roadmap.md).
- **The single source of truth is one Yjs document per room.** Content edits are persisted Yjs updates; all ephemeral presence (cursors, selections, VR avatar poses, cursor-chat text) rides the **Yjs awareness channel** and is **never persisted**. See [04 — Architecture](./04-technical-architecture.md).

---

## MoSCoW summary

Priorities are scoped to **v1 (Phases 1–3 combined)**. "Must" = the product is not Coboard without it; "Should" = high value, shippable slightly later within its phase; "Could" = nice-to-have / stretch within its phase; "Won't (v1)" = explicit non-goal (see [Non-goals](#non-goals-v1)).

| Priority | Feature | Phase |
|---|---|---|
| **Must** | Infinite pan/zoom canvas | 1 |
| **Must** | Freehand pen/marker (color, thickness) | 1 |
| **Must** | Sticky notes (color + text) | 1 |
| **Must** | Basic shapes (rectangle, ellipse, line, arrow) | 1 |
| **Must** | Text tool | 1 |
| **Must** | Select / move / resize / delete | 1 |
| **Must** | Undo / redo | 1 |
| **Must** | Realtime multiplayer sync (Yjs) | 1 |
| **Must** | Live labeled cursors + presence avatars + join/leave | 1 |
| **Must** | Anonymous rooms via shareable code/URL | 1 |
| **Must** | Edge persistence (survives reconnect) | 1 |
| **Must** | Responsive desktop mouse + mobile/tablet touch | 1 |
| **Must** | Enter VR from any WebXR headset | 3 |
| **Must** | Same board rendered as a 3D surface | 3 |
| **Must** | 3D avatars (head + hands) + laser-pointer cursors via awareness | 3 |
| **Must** | Draw in VR via controller raycast | 3 |
| **Should** | Cursor chat (type at cursor) | 2 |
| **Should** | Emoji stamps / reactions + high-five | 2 |
| **Should** | Comments | 2 |
| **Should** | Connectors that snap to shapes | 2 |
| **Should** | Frames / sections | 2 |
| **Should** | Templates (kanban, retro, mindmap, flowchart) | 2 |
| **Should** | Image upload (R2) | 2 |
| **Should** | Eraser | 2 |
| **Should** | Export PNG / SVG / PDF | 2 |
| **Should** | Alignment / snapping guides | 2 |
| **Should** | Follow + spotlight / presentation mode | 2 |
| **Should** | In-VR radial / wrist tool palette | 3 |
| **Should** | VR comfort options (vignette, teleport, board reachability/scaling) | 3 |
| **Could** | Sticky Sort | 2 |
| **Could** | Timer | 2 |
| **Could** | Dot voting | 2 |
| **Could** | Minimap | 2 |
| **Could** | WebRTC voice (small rooms) | 2 |
| **Could** | Spatial voice in VR | 3 |
| **Could** | Shared 3D sticky / object planes | 3 |
| **Could** | AI assist (summarize board, auto-cluster stickies) | 3 (cross-cutting) |
| **Won't (v1)** | Native app-store apps (PWA only) | — |
| **Won't (v1)** | Enterprise SSO / admin console | — |
| **Won't (v1)** | Real-time video tiles | — |
| **Won't (v1)** | Offline-first sync beyond reconnect buffering | — |
| **Won't (v1)** | Fully-3D modeling tools | — |

---

## Phase 1 — MVP "Realtime canvas core"

> Goal: two or more anonymous people open a link, land in the same room, and draw together in realtime on desktop **and** touch, with live labeled cursors. The room survives a reconnect.

### 1.1 Infinite pan/zoom canvas

- **Story:** As a participant I want an unbounded canvas I can pan and zoom so that I never run out of space and can work at any level of detail.
- Panning (space-drag / middle-drag / two-finger drag) and zoom (scroll / pinch) update the viewport without mutating board content; tested via Playwright that viewport transform changes while the Yjs doc is unchanged.
- Zoom range is at least 10%–400%; a "zoom to fit" / "reset view" action frames all content within the viewport.
- Viewport state is **local-only** (not in the Yjs doc, not in awareness-persisted state); a second client's pan/zoom never moves the first client's viewport.
- Pointer-to-world coordinate mapping is correct at all zoom levels (unit-tested: round-trip screen→world→screen is identity within sub-pixel tolerance).

### 1.2 Freehand pen / marker (color, thickness)

- **Story:** As a participant I want a pen with selectable color and thickness so that I can sketch and annotate freely.
- A stroke commits a single Yjs structure capturing an ordered point list, color, and thickness; the stroke appears on all connected clients within the realtime budget (see §1.8).
- At least 8 preset colors and at least 3 thicknesses are selectable; the last-used color/thickness persists for the session.
- Strokes are simplified/coalesced before commit (e.g. point thinning) so a typical stroke is one compact Yjs update, not one-update-per-pointer-move (verifies the cursor/edit budget in [05 — Scaling](./05-scaling-and-cost.md)).
- A stroke drawn under load (rapid input) renders without dropped segments after the input settles.

### 1.3 Sticky notes (color + text)

- **Story:** As a participant I want colored sticky notes with editable text so that I can capture ideas as movable cards.
- Creating a sticky adds a Yjs node with position, size, color, and a collaborative text field; it is visible to all clients.
- Two users editing the **same** sticky's text concurrently converge without lost characters (Yjs text CRDT; tested with two contexts typing simultaneously).
- At least 6 sticky colors are available; default size is consistent; text wraps within the note and the note auto-grows or scrolls per design tokens in [03 — Design](./03-visual-design-ui-ux.md).

### 1.4 Basic shapes (rectangle, ellipse, line, arrow)

- **Story:** As a participant I want rectangles, ellipses, lines, and arrows so that I can diagram structure quickly.
- Each shape type can be created by drag-to-size; each is a Yjs node with geometry + stroke/fill style and syncs to all clients.
- Arrows render a directional head; lines and arrows expose endpoints that are independently movable.
- Shapes honor the same selection/move/resize/delete operations as all other objects (§1.6).

### 1.5 Text tool

- **Story:** As a participant I want to place free-floating text so that I can label and title regions of the board.
- Clicking with the text tool creates an editable text object at the click point; committing adds/updates a Yjs node.
- Concurrent edits to the same text object converge (Yjs text CRDT).
- Text supports at minimum size and color; empty text objects are discarded on blur.

### 1.6 Select / move / resize / delete

- **Story:** As a participant I want to select, move, resize, and delete any object so that I can rearrange the board.
- Click selects a single object; drag-rectangle (marquee) selects multiple; Shift-click toggles membership.
- Move and resize emit Yjs geometry updates; multi-select move applies to all members atomically from the user's perspective.
- Delete removes selected objects from the Yjs doc on all clients; the deletion is undoable (§1.7).
- Selection state is **local/awareness-ephemeral**, not persisted: remote users may see *that* an object is selected (highlight) but reloading the room clears all selections.

### 1.7 Undo / redo

- **Story:** As a participant I want undo/redo so that I can recover from mistakes without disrupting others' work.
- Undo/redo are **scoped to the local user's own changes** via Yjs `UndoManager` (origin filtering); my undo does not revert a teammate's edit.
- Keyboard shortcuts (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`) and toolbar buttons both work; tested with two contexts that interleaved edits undo independently.
- Undo/redo of create, move, resize, style, and delete all restore the prior state correctly.

### 1.8 Realtime multiplayer sync (Yjs)

- **Story:** As a participant I want every edit to appear for everyone almost instantly so that we are truly working on one board.
- A content edit on one client is reflected on a second client in the same room; e2e test asserts convergence of the Yjs doc state across two contexts.
- All content state lives in **one Yjs document per room**, bound to a single Durable Object via Y-PartyServer; no content is stored outside the Yjs doc.
- Transport is binary Yjs updates over PartySocket; updates are batched/coalesced to respect the inbound-WS billing ratio described in [05 — Scaling](./05-scaling-and-cost.md).
- Conflicting concurrent edits never corrupt the document (CRDT guarantee), verified by a randomized concurrent-edit fuzz test that asserts identical end state on all peers.

### 1.9 Live labeled cursors + presence avatars + join/leave

> See the [Realtime cursors & presence callout](#realtime-cursors--presence-first-class) for the cross-cutting spec; the acceptance criteria below are the Phase-1 baseline.

- **Story:** As a participant I want to see where everyone else's cursor is and who is here so that collaboration feels live and I avoid collisions.
- Each remote user shows a colored, name-labeled cursor that moves smoothly (interpolated); a presence list/avatar stack shows everyone currently in the room.
- Joining and leaving update the presence list within ~1–2s; a closed tab removes that user's cursor and avatar.
- Cursor and presence data travel on the **Yjs awareness channel only** and are **never written to persistent storage**; reloading the room shows no stale cursors.
- Cursor position updates are throttled/coalesced to ~20–30 Hz max and binary-encoded (budget compliance, see [05](./05-scaling-and-cost.md)).

### 1.10 Anonymous rooms via shareable code/URL

- **Story:** As anyone I want to open a link and instantly be in a room with no signup so that starting or joining is frictionless.
- Visiting the root auto-creates a room and routes to a URL containing a shareable room code (inspired by Whiteboard VR); opening that URL/code in another browser joins the **same** Yjs doc.
- No authentication, email, or account is required to create or join a room.
- A "copy link" / "share" affordance yields a URL that, when opened by a second context in Playwright, lands in the identical board.

### 1.11 Edge persistence (survives reconnect)

- **Story:** As a participant I want the board to still be there after I refresh or briefly lose connection so that work is never lost to a dropped socket.
- Board content is persisted as a Yjs update log + periodic compacted snapshot in the room Durable Object's SQLite storage; reloading the room restores the latest content.
- After a client disconnect/reconnect, the client re-syncs and converges to the current server state (Playwright: draw → reload → content present).
- When all clients leave and the DO hibernates (WebSocket Hibernation API), the next visitor still loads the persisted board.

### 1.12 Responsive desktop mouse + mobile/tablet touch

- **Story:** As a participant on any device I want the same board fully usable with mouse or touch so that desktop and phone/tablet users collaborate as equals.
- All Phase-1 tools (pen, sticky, shapes, text, select/move/resize) work with mouse **and** with single/multi-touch (pinch-zoom, two-finger pan); verified on an emulated touch viewport.
- Layout adapts responsively (toolbar/panels reflow) across desktop and small touch viewports per [03 — Design](./03-visual-design-ui-ux.md).
- No tool requires a hover-only interaction that is impossible on touch; every action has a touch-reachable path.

---

## Phase 2 — "Collaboration & polish"

> Goal: turn the realtime canvas into a meeting tool — richer expression (chat, stamps, comments), structure (connectors, frames, templates), media (images), and facilitation (follow/spotlight, timer, voting).

### 2.1 Cursor chat (type at cursor)

- **Story:** As a participant I want to type a quick message that floats at my cursor so that I can comment in-context without a separate chat panel.
- Pressing the chat shortcut (e.g. `/`) opens an inline input anchored to my cursor; characters appear by my cursor for others in realtime.
- Cursor-chat text rides the **awareness channel** (ephemeral); it fades after a short timeout and is **never persisted**.
- A second context sees my in-progress typing update live and sees it disappear on dismiss/timeout.

### 2.2 Emoji stamps / reactions + high-five

- **Story:** As a participant I want to drop emoji stamps and react so that I can give fast, lightweight feedback.
- Placing a stamp adds it to the board (persisted Yjs node) at a chosen location.
- Transient reactions/high-fives animate over the canvas and broadcast via awareness/ephemeral events; they are not persisted.
- A high-five gesture between two users produces a visible confirmation for both.

### 2.3 Comments

- **Story:** As a participant I want to leave comments pinned to a spot or object so that we can discuss specifics asynchronously.
- A comment is a persisted Yjs node anchored to a board coordinate or object; it shows author label and timestamp.
- Comments support threaded replies and a resolve/unresolve state; resolved comments can be hidden.
- Comments converge across clients and survive reload (persisted).

### 2.4 Connectors that snap to shapes

- **Story:** As a participant I want connector lines that attach to shapes and stay attached so that diagrams remain correct when I move things.
- A connector can be anchored to a shape's edge/port; moving the shape re-routes the connector to stay attached.
- Connectors are persisted Yjs nodes referencing their endpoint object ids; deleting an endpoint object detaches or removes the connector predictably.
- Snapping highlights candidate anchor points during drag.

### 2.5 Frames / sections

- **Story:** As a facilitator I want frames/sections to group content so that I can organize the board into named regions.
- A frame is a persisted container; objects dropped inside are associated and move with the frame.
- Frames have an editable title; nesting rules are defined and enforced per [03 — Design](./03-visual-design-ui-ux.md).
- Moving a frame moves its contained objects together (single logical operation).

### 2.6 Templates (kanban, retro, mindmap, flowchart)

- **Story:** As a facilitator I want ready-made templates so that I can start a session instantly instead of building structure by hand.
- A template gallery offers at least: kanban, retrospective, mindmap, flowchart.
- Applying a template inserts its frames/shapes/stickies as normal Yjs nodes into the current room (editable, deletable like any content).
- Applying a template is undoable and broadcasts to all clients.

### 2.7 Image upload (R2)

- **Story:** As a participant I want to upload images onto the board so that I can bring in references and screenshots.
- An uploaded image is stored in Cloudflare R2; the board holds a persisted node referencing the asset URL/key (not the bytes in the Yjs doc).
- Upload enforces a max size (**configurable; 30 MB default**, matching [04 — Architecture](./04-technical-architecture.md)) and accepted types; oversized/invalid files are rejected with a clear message.
- The image renders for all clients and persists across reload; uploads go to R2 directly, not through the realtime DO message path.

### 2.8 Eraser

- **Story:** As a participant I want an eraser so that I can remove strokes/marks quickly.
- The eraser removes whole stroke objects it touches (object eraser) and the removal is a normal undoable Yjs deletion.
- Eraser works with mouse and touch.
- Erasing syncs to all clients in realtime.

### 2.9 Alignment / snapping guides

- **Story:** As a participant I want alignment guides and snapping so that objects line up cleanly without manual fiddling.
- Dragging an object shows dynamic guides when its edges/centers align with nearby objects; releasing snaps to the guide.
- Snapping can be temporarily disabled (e.g. hold a modifier).
- Guides are local UI only (not persisted, not in the Yjs doc).

### 2.10 Export PNG / SVG / PDF

- **Story:** As a participant I want to export the board so that I can share or archive results outside Coboard.
- Export produces a PNG, an SVG, and a PDF of the current board (or a selected frame/region).
- Export runs client-side from the rendered scene; output visually matches the canvas within tolerance.
- Export of an empty board produces a valid (blank) file without error.

### 2.11 Follow + spotlight / presentation mode

- **Story:** As a facilitator I want to spotlight my view (and let others follow me) so that I can guide the room through the board.
- "Follow" locks a participant's viewport to a target user's viewport; releasing returns control.
- "Spotlight" (presenter) broadcasts the presenter's viewport so all followers' viewports track it.
- Follow/spotlight state is awareness-ephemeral (not persisted); ending the session clears it.

### 2.12 Sticky Sort *(Could)*

- **Story:** As a facilitator I want to auto-arrange sticky notes by color/author/reaction so that I can cluster ideas fast.
- Sort reorganizes sticky positions by a chosen key (color, author, reaction count); the rearrangement is a normal undoable batch of Yjs updates.
- Sort is non-destructive to sticky content (only positions change).
- Result is consistent across all clients.

### 2.13 Timer *(Could)*

- **Story:** As a facilitator I want a shared countdown timer so that I can time-box activities for everyone.
- Starting/pausing/resetting the timer is reflected on all clients; the displayed remaining time is consistent across clients.
- Timer reaching zero produces a visible (and optionally audible) signal for all.
- Timer state is shared via the room (ephemeral or lightweight shared state) and does not bloat the persisted content doc.

### 2.14 Dot voting *(Could)*

- **Story:** As a facilitator I want dot voting so that the group can prioritize items democratically.
- A voting session grants each user a budget of dots; placing a dot on an object records a vote attributed to the user.
- Vote tallies are visible (e.g. per object) and update in realtime.
- Closing the vote freezes tallies; votes are persisted with the board.

### 2.15 Minimap *(Could)*

- **Story:** As a participant I want a minimap so that I can navigate a large board quickly.
- The minimap shows a scaled overview of all content and the current viewport rectangle.
- Clicking/dragging on the minimap moves the local viewport.
- The minimap is local UI only (reads the Yjs doc; writes nothing).

### 2.16 WebRTC voice (small rooms) *(Could)*

- **Story:** As a participant in a small room I want optional voice chat so that we can talk while we draw.
- Voice uses a WebRTC mesh with the room Durable Object as signaling server (no media through the DO).
- Joining/leaving voice is opt-in with a mute control; presence shows who is in voice.
- Documented degradation: above a small participant count, mesh is not used (note Cloudflare Realtime/Calls as the managed escalation path per [04](./04-technical-architecture.md)).

---

## Phase 3 — "Cross-reality / VR"

> Goal: enter the **same** board from a WebXR headset and collaborate immersively — draw in 3D space onto the board plane, with synced avatars and laser cursors — all bound to the one Yjs doc that 2D users share.

### 3.1 Enter VR from any WebXR headset

> Everyone — including a user inside a headset browser — opens the board URL into the **default 2D canvas core view first**. VR is entered by a **top-right headset toggle** in the top bar (next to Present/Share), labelled **"Enter VR"**. Clicking it is the **required user gesture** for WebXR; on first click the A-Frame/Three.js VR bundle is **lazy-loaded** ("Preparing VR…"). The board then mounts as a curved viewport-window panel ~1.5–2 m ahead (Social reach zone), and **only the renderer swaps (Konva 2D ↔ A-Frame 3D)** — the room, Yjs doc, identity/colour, and viewport region all carry over with **no reload**. The toggle reflects state ("Enter VR" ↔ "Exit VR"). See the canonical session-entry mechanics in [04 — Architecture](./04-technical-architecture.md) and the lazy VR bundle in [07](./07-engineering-quality-security-accessibility.md).

- **Story:** As a headset user I want to enter VR with one tap of a top-right headset toggle in the toolbar so that I step into the same board immersively, with no install and nothing reloading.
- The **headset-icon "Enter VR" toggle** is **always visible** in the top bar's top-right cluster (beside Present/Share); it is **enabled only when** `navigator.xr.isSessionSupported("immersive-vr")` resolves true, and otherwise offers a **fallback** (non-immersive preview or a QR/helper to open the room on a headset). It **reflects state**, toggling "Enter VR" ↔ in-VR/"Exit VR".
- Activating the toggle is a **user gesture** that lazy-loads the VR bundle on first use and calls `requestSession("immersive-vr")` (WebXR comfort fade), then mounts the 3D scene with the board as the panel; entering joins the **same room / Yjs doc / identity** with **no separate document and no reload**, and the **VR viewport rect is initialised from the user's current 2D camera (pan/zoom)** so they step into the same region/view.
- **Exiting** (headset exit gesture or in-scene "Exit VR" button) ends the XR session, fades back, and returns to the 2D view **at the same canvas region** the user left from.
- **Fallbacks are exercised:** desktop without a headset gets a non-immersive **"magic window"** mouse-orbit 3D preview and/or a **QR/helper** to open the room on a headset; mobile gets magic-window/cardboard; a Quest/headset browser gets full `immersive-vr`. A headless WebXR emulator smoke test confirms toggle-driven session entry, viewport carry-over, and scene initialization without error.

### 3.2 Same board rendered as a 3D surface

- **Story:** As a headset user I want the board shown as a surface in 3D so that I see exactly what 2D users see, live.
- The board renders as a textured 3D plane bound to the same Yjs doc; content authored in 2D appears on the VR surface in realtime and vice-versa.
- **MVP path:** render the 2D canvas to a `CanvasTexture` for an instant in-VR view; **fidelity path (documented):** native 3D stroke geometry. (See [04 — Architecture](./04-technical-architecture.md).)
- An edit made by a 2D user appears on the VR surface within the realtime budget (cross-renderer convergence test).

### 3.3 3D avatars (head + hands) + laser-pointer cursors via awareness

- **Story:** As a participant I want to see VR users as head+hands avatars with laser pointers so that mixed 2D/VR collaboration feels co-present.
- VR users broadcast head and two-hand poses + laser-pointer direction over the **awareness channel** (ephemeral, never persisted).
- 2D users see VR participants in the presence list and (where applicable) see their laser/cursor on the board; VR users see other avatars positioned in the scene.
- Avatar/laser pose updates are throttled/coalesced like cursors (~20–30 Hz, binary) to respect the WS budget in [05](./05-scaling-and-cost.md).

### 3.4 Draw in VR via controller raycast

- **Story:** As a headset user I want to draw on the board by pointing my controller so that I can contribute strokes hands-on in VR.
- A controller raycast onto the board plane writes strokes into the **same Yjs doc** using the same stroke structure as the 2D pen; the stroke appears for 2D and VR users alike.
- Trigger press/hold begins a stroke; release commits it (coalesced into a compact Yjs update, like §1.2).
- A stroke drawn in VR is visible to a 2D Playwright client in the same room (cross-reality e2e via WebXR emulator + browser context).

### 3.5 VR viewport navigation

> The infinite canvas is shown through a **finite physical board panel** (default ~2.0 m × 1.2 m, optionally slightly curved) floating in the Social reach zone (~1.5–2 m). The panel size is fixed in the world; what changes is the canvas **region** mapped onto it via a per-user **viewport rect** `{x, y, w, h}` in canvas coords. See the canonical viewport model in [04 — Architecture](./04-technical-architecture.md).

- **Story:** As a headset user I want to slide and zoom the infinite canvas through the fixed board panel so that I can navigate a large board comfortably without losing my place.
- **Slide (pan):** a grip-grab + drag (or thumbstick) translates the viewport rect across canvas-space — content slides behind the fixed panel — while the **Yjs doc is unchanged** and the physical panel stays the same size (verified: viewport rect changes, doc state identical).
- **Zoom:** a two-handed pinch/stretch (or thumbstick) changes how much canvas maps onto the panel (changes viewport `w`/`h`); the physical panel does not resize and content scales accordingly; zoom range matches the 2D canvas (§1.1, same canonical canvas unit system).
- **Wayfinding:** a minimap/overview shows the user's own viewport rect and other users' viewport rects; **zoom-to-fit** frames all content and **go-to-user / find-everyone** jumps the viewport rect to a chosen user's region — fit-to-content, reset-view, and follow behave identically to 2D ([03 — Design](./03-visual-design-ui-ux.md)).
- **Viewport is per-user local view state** (optionally shared via awareness for follow/spotlight), **never** document state; one VR user's slide/zoom never moves another user's viewport.

### 3.6 Cross-reality drawing coherence

- **Story:** As a participant I want a VR-drawn stroke to land at the exact infinite-canvas coordinate so that it appears in the right place for 2D peers (and 2D edits appear correctly in VR).
- A VR controller raycast → panel hit point → **panel UV (0..1)** → mapped through the current viewport rect → **canvas coordinates** is written into the **same Yjs doc** (same stroke structure as §1.2/§3.4); an e2e test asserts a VR stroke drawn at a known viewport appears at the **correct canvas coordinate** for a 2D Playwright client (sub-pixel/within-tolerance position check), independent of the VR user's pan/zoom.
- The inverse holds: a stroke or object authored by a 2D user appears on the VR panel at the correct mapped position within the realtime budget, and stays positionally correct as the VR user slides/zooms the viewport.
- Two users (one VR, one 2D) drawing concurrently in the same canvas region converge with no positional drift and no lost segments (CRDT convergence + coordinate round-trip verified across renderers).

### 3.7 Cross-reality presence

> Presence is dimension-bridging: when a 2D user's scrolled region and a VR user's viewport rect **overlap in canvas-space**, they see each other on the shared surface; when they don't, directional indicators point the way. All of this rides the **awareness channel** (ephemeral, never persisted).

- **Story:** As a participant I want to see where everyone is across 2D and VR so that mixed-reality collaboration feels co-present even when we're looking at different regions.
- **Overlapping viewports:** 2D users' cursors render as labeled dots/markers on the **VR panel surface** at their mapped canvas position; VR users' laser-pointer hit points + avatars render as cursors (with an **"in VR" badge**) for 2D users — verified by a cross-reality e2e (WebXR emulator + 2D browser context) with overlapping regions.
- **Non-overlapping viewports:** users outside each other's region get **directional edge indicators** (e.g. "3 →") plus markers on the minimap (§3.5) pointing toward off-screen peers, so no participant is invisible.
- **Awareness-only, budget-aware:** cursor, laser, and avatar-pose data ride the **Yjs awareness channel** (never persisted) and are throttled/coalesced (~20–30 Hz, binary) per the [Realtime cursors & presence callout](#realtime-cursors--presence-first-class) and [05](./05-scaling-and-cost.md); a room reload shows zero stale cross-reality cursors.

### 3.8 In-VR radial / wrist tool palette *(Should)*

- **Story:** As a headset user I want a wrist/radial tool palette so that I can switch tools and colors without leaving immersion.
- A radial or wrist-anchored palette exposes core tools (pen, color, thickness, eraser) reachable by controller.
- Selecting a tool/color in VR updates the local drawing state; selection feedback is visible in-headset.
- The palette does not occlude the board during drawing (comfort/ergonomics per [03 — Design](./03-visual-design-ui-ux.md)).

### 3.9 VR comfort options *(Should)*

- **Story:** As a headset user I want comfort controls so that I can use Coboard in VR without discomfort.
- Comfort options include vignette during movement, teleport locomotion, and board reachability/scaling (bring the board closer / resize it).
- Settings persist for the session and are local (not shared, not persisted to the board doc).
- Teleport and scaling do not alter the shared board content (only the local view/rig).

### 3.10 Spatial voice in VR *(Could)*

- **Story:** As a headset user I want spatialized voice so that I hear collaborators from their position in the scene.
- Voice is positionally attenuated based on avatar positions (built on the Phase-2 WebRTC path; signaling via the room DO).
- Opt-in with mute; presence reflects who is speaking.
- Documented scaling limits mirror §2.16 (mesh for small groups; managed escalation noted).

### 3.11 Shared 3D sticky / object planes *(Could)*

- **Story:** As a headset user I want sticky notes/objects as placeable 3D planes so that I can arrange ideas in space, shared with everyone.
- 3D sticky/object planes are backed by the **same Yjs nodes** as 2D objects (one source of truth); changes sync both ways.
- Placing/moving a 3D plane in VR updates the 2D board representation and vice-versa.
- Persistence is identical to 2D objects (survives reload/hibernation).

### 3.12 AI assist — summarize board, auto-cluster stickies *(Could, cross-cutting stretch)*

- **Story:** As a facilitator I want AI to summarize the board and auto-cluster sticky notes by theme so that I can synthesize a session quickly.
- "Summarize" produces a text summary of board content; "auto-cluster" groups stickies into themed clusters (rearranges positions as an undoable batch, like §2.12).
- AI actions are explicit/opt-in and attributed; results are editable like any content.
- AI runs server-side (Worker) without blocking realtime sync; failures degrade gracefully with a clear message.

---

## Realtime cursors & presence (first-class)

> **This is a must-have, not a nice-to-have.** Cursors and presence are what make Coboard feel alive across desktop, touch, and VR. They appear in Phase 1 (§1.9), gain cursor chat in Phase 2 (§2.1), and extend to VR avatars + laser pointers in Phase 3 (§3.3).

**Cross-cutting contract (applies in all three phases):**

- **Labeled, colored cursors.** Every connected user has a stable color and a name label; remote cursors render with that color + label so people are distinguishable at a glance (Canva-style colorful labeled cursors).
- **Smooth interpolation.** Remote cursor motion is interpolated between received samples (not teleported), so movement looks fluid even though updates are throttled to ~20–30 Hz.
- **Presence avatars + join/leave.** A presence stack/list shows who is in the room; joins and leaves update it within ~1–2s; closing a tab removes that user's cursor and avatar.
- **Cursor chat (Phase 2).** Type-at-cursor text floats by the user's pointer and fades on timeout/dismiss (FigJam-style).
- **VR laser pointers + avatars (Phase 3).** VR users' head/hands poses and laser-pointer direction are presence too, shown to 2D and VR peers alike.
- **Awareness channel, ephemeral, never persisted.** All of the above ride the **Yjs `y-protocols/awareness`** channel — broadcast but **not** written to the persisted content doc. A room reload shows zero stale cursors/selections/chat.
- **Budget-aware transport.** Cursor/pose updates are throttled, coalesced, and binary-encoded to respect the 20:1 inbound-WS billing ratio and the free request budget. Outbound WS messages are not billed; hibernation pauses idle duration charges. See [05 — Scaling & Cost](./05-scaling-and-cost.md) and [04 — Architecture](./04-technical-architecture.md).
- **Measured send-rate budget (testable).** Under the [05](./05-scaling-and-cost.md)/[06](./06-implementation-roadmap.md) load-test harness, the **measured inbound WebSocket message rate per active user** (cursor + presence/pose traffic during continuous pointer/controller movement) stays at or below the doc-05 per-user budget — i.e. coalesced to **~20–30 Hz**, not one message per raw input event — verified by counting inbound DO messages over a fixed window and asserting `messages/sec/user ≤ 30`. This closes the loop with the doc-05/06 load-test KPI.

---

## Feature → reference traceability

Maps notable features to the reference product(s) that inspired them. See [01 — Product Vision & References](./01-product-vision-and-references.md) for the full writeup and links.

| Feature | Phase | Primary inspiration | Notes |
|---|---|---|---|
| Anonymous rooms via shareable code/URL | 1 | **Whiteboard VR** | Open the site → auto room code → share to draw together, no signup. Our closest predecessor. |
| Same board across 2D web + immersive VR | 3 | **Whiteboard VR** | Cross-reality, one shared document — extended via a single Yjs doc as source of truth. |
| Enter VR / 3D avatars / draw in VR | 3 | **Whiteboard VR** | Platform-independent collaboration (touch / mouse / headset). |
| Infinite pan/zoom canvas | 1 | **Miro** + **Canva** | Infinite/expanding canvas. |
| Pen with color + thickness | 1 | **Miro** | Pen tool (color, thickness, stylus/Apple Pencil). |
| Basic shapes + connectors that snap | 1 / 2 | **Miro** | Shapes + connection lines with snapping. |
| Templates (kanban, retro, mindmap, flowchart) | 2 | **Miro** + **Canva** + **FigJam** | Template galleries across all three. |
| Image upload | 2 | **Miro** | File upload (images/PDF/Office). |
| Export PNG / SVG / PDF | 2 | **Miro** | PDF/JPG export. |
| Frames / sections | 2 | **FigJam** | Sections. |
| Dot voting | 2 | **Miro** | Voting. |
| Timer | 2 | **Miro** | Timer. |
| Follow + spotlight / presentation mode | 2 | **FigJam** + **Miro** | Spotlight mode / presentation mode. |
| Live labeled colored cursors + presence | 1 | **Canva** + **FigJam** | Colorful labeled cursors; live multi-user presence. |
| Cursor chat | 2 | **FigJam** | Type-at-cursor chat. |
| Emoji stamps / reactions + high-five | 2 | **FigJam** + **Canva** | Stamps/emotes + high-fives; real-time reactions. |
| Comments | 2 | **FigJam** + **Canva** | In-context comments. |
| Sticky notes + Sticky Sort | 1 / 2 | **Canva** | Sticky notes with Sort (color/author/reactions/themes). |
| AI assist (summarize, auto-cluster) | 3 | **FigJam** + **Canva** | Summarize board; auto-organize stickies into themes. |

---

## Non-goals (v1)

Explicitly **out of scope** for v1. These are deliberate decisions, not omissions — they keep Coboard shippable on a $0 free-tier footprint and focused on the cross-reality realtime canvas.

| Non-goal | Why it's out of v1 |
|---|---|
| **Native app-store apps** | Coboard ships as a **PWA only**; no iOS/Android/Quest store builds. The web + WebXR path covers all target devices. |
| **Enterprise SSO / admin console** | No SAML/SSO, org management, or admin governance. Anonymous-first rooms are the model; named accounts are an optional *later* add (GitHub OAuth / Clerk free tier), not v1. |
| **Real-time video tiles** | No webcam video grid. Optional **audio-only** WebRTC voice is the ceiling (Phase 2/3, *Could*); video does not fit the free-tier bandwidth/compute budget. |
| **Offline-first sync beyond reconnect buffering** | We guarantee reconnect/resync (§1.11) and short buffering, **not** full offline editing with long-horizon merge. Yjs makes this *possible later*, but it's not a v1 promise. |
| **Fully-3D modeling tools** | VR is for collaborating on the shared **board** (drawing, stickies, avatars) — not a CAD/3D-modeling environment. |

> These align with the canonical non-goals in the project brief and must not be re-scoped into v1 without updating this document and [06 — Roadmap](./06-implementation-roadmap.md).
