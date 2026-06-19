# Coboard — Product Vision & References

> _Why Coboard exists, who it serves, and the products that inspired it: a free-to-run, realtime, cross-reality collaborative whiteboard._

**Related documents:** [README](../README.md) · [02 — Features & Scope](./02-features-and-scope.md) · [03 — Visual Design / UI-UX](./03-visual-design-ui-ux.md) · [04 — Technical Architecture](./04-technical-architecture.md) · [05 — Scaling & Cost](./05-scaling-and-cost.md) · [06 — Implementation Roadmap](./06-implementation-roadmap.md) · [07 — Engineering Quality, Performance, Security & Accessibility](./07-engineering-quality-security-accessibility.md)

> **Naming note:** "Coboard" is a working placeholder. The user may rename the product; treat every occurrence as a stand-in for the final name.

---

## 1. Vision statement

**One whiteboard. Every screen — desktop, mobile, and VR.**

Coboard is a free-to-run, realtime, online collaborative whiteboard. Anyone opens a link, instantly lands in a room, and draws together with no signup. The exact same board document is rendered by a 2D web canvas (mouse + touch) and an immersive 3D WebXR scene — a single source of truth shared across realities. Live labeled cursors, presence, and avatar poses are first-class, so a room always feels inhabited. The entire system is designed to be **hosted and operated for $0** on free edge tiers, at meaningful concurrency.

---

## 2. The problem

Collaborative whiteboards are everywhere, yet every mainstream option fails at least one thing that matters to us. They are typically **one or more of**:

| Pain | What today's tools do | Why it hurts |
| --- | --- | --- |
| **Not free to self-host** | Closed SaaS (FigJam, Miro, Canva); you rent, you cannot run your own instance at $0. | No ownership, recurring cost, vendor lock-in, data lives elsewhere. |
| **Not cross-reality** | 2D-only canvas; VR is a separate product (or absent). VR tools rarely share one document with the 2D web. | A VR participant and a laptop participant cannot truly be on the _same_ board. |
| **Gated behind accounts** | Signup/login walls, seat limits, time-boxed guest access. | Friction kills spontaneous "open a link and draw" collaboration. |

The open-source predecessor closest to our spirit (Whiteboard VR) nailed _no-signup + cross-reality_ but is a smaller-scale prototype on an older realtime stack. Coboard's wedge is to combine **all three** missing properties — **free-to-self-host, cross-reality with a single shared document, and anonymous no-signup rooms** — on modern edge infrastructure that stays inside free tiers at real concurrency.

---

## 3. Target users & jobs-to-be-done

| User / segment | Job-to-be-done ("When I…, I want to…, so I can…") |
| --- | --- |
| **Remote teams** | When we kick off async, I want to drop a link in chat and have everyone sketching in seconds, so we can think visually without scheduling or installs. |
| **Classrooms / educators** | When I teach a concept, I want students to join a code-only room from any device they have (Chromebook, phone, tablet, a spare headset), so no one is blocked by accounts or hardware. |
| **Workshops & retros** | When I run a sprint retro, I want sticky notes, voting, and a timer in a board everyone can edit live, so the session stays energetic and inclusive. |
| **Design sprints** | When we diverge/converge on ideas, I want shapes, connectors, frames, and freehand on an infinite canvas with live cursors, so the whole team co-creates in real time. |
| **VR meetups / spatial collab** | When we gather in headsets, I want to draw on a shared 3D board with embodied avatars and laser pointers, so remote people feel co-present, not just on a call. |
| **Casual sketching / "napkin" ideas** | When inspiration hits, I want to open a board with zero setup and maybe share it with a friend, so capturing an idea costs nothing and no login. |

**Common thread:** every segment benefits from _zero-friction entry_, _realtime presence_, and _device freedom_ — the three things Coboard optimizes for.

---

## 4. Guiding principles

1. **Free-to-run.** The whole stack must be hostable _and_ operable for $0 on free tiers (Cloudflare Pages + Workers + Durable Objects + R2), and tuned to maximize concurrent users within those limits. Cost-awareness (e.g. the 20:1 inbound-WS billing rule, WebSocket hibernation) is a design constraint, not an afterthought. See [05 — Scaling & Cost](./05-scaling-and-cost.md).
2. **No-signup by default.** A room id lives in the URL; opening a link drops you straight onto the board, like the reference Whiteboard VR. Named accounts are optional and additive, never a gate.
3. **Cross-reality, single source of truth.** One Yjs document per room is _the_ board. The 2D web renderer and the 3D WebXR renderer both bind to it — never to forked copies. See [04 — Technical Architecture](./04-technical-architecture.md).
4. **Realtime-presence-first.** Live labeled cursors, join/leave presence, selections, and VR avatar head+hands poses are must-have, carried by `y-protocols/awareness` (ephemeral, broadcast, never persisted). A room should always feel _inhabited_.
5. **Progressive across input modalities.** Full power on desktop (mouse + keyboard), fully usable on mobile/tablet (touch), and _immersive_ — not merely viewable — in VR (controller raycast drawing, embodied avatars). No modality is a second-class citizen.
6. **Open.** Open-source, TypeScript everywhere, self-hostable on a single Cloudflare account. Inspired by the open Whiteboard VR project; we intend to be forkable and inspectable.

---

## 5. References & inspiration

Four reference products and one open-source repository shape Coboard. For each we list the link, a short description, and **exactly which ideas Coboard adopts**. (Feature claims below are kept consistent with the project research; exact figures for any product can change and should be re-verified against current sources.)

### 5.1 Whiteboard VR — Online Collaboration _(closest spiritual predecessor)_

- **Devpost:** <https://devpost.com/software/whiteboard-vr-online-collaboration>
- **Source (open):** <https://github.com/marlon360/whiteboard-vr>

A web-based collaborative whiteboard that is platform independent — touch on phones/tablets, mouse on desktop, and VR headsets in the browser. Opening the site auto-places you in a room with a room code; share the code and others draw on the same board, with no signup. It is built on A-Frame + Three.js with realtime via Socket.io, and it is open source.

**Coboard adopts:**
- The **room-code / no-signup** model — land in a room instantly, share a code/URL.
- **Cross-reality from one site** — the same board reachable on touch, mouse, and VR.
- **A-Frame + Three.js (WebXR)** as the VR rendering foundation.
- The ethos of being **open source** and small enough to self-host.
- _Coboard's evolution beyond it:_ swap Socket.io for a **Yjs CRDT + Cloudflare Durable Objects** backbone so 2D and VR share one persistent document at edge scale, instead of a single-server broadcast prototype.

### 5.2 Figma FigJam

- **Link:** <https://www.figma.com/figjam/>

FigJam is Figma's collaborative whiteboard for ideation: sticky notes, shapes and connectors with snapping, sections, and freehand drawing on a clean infinite canvas. It is known for delightful social presence — live multi-user cursors, **cursor chat**, stamps/emotes and high-fives, audio + live chat, comments, spotlight mode, and a large template library, plus AI helpers.

**Coboard adopts:**
- **Cursor chat** (type right at your cursor) and **stamps / reactions / high-five** as lightweight social presence.
- **Spotlight / follow mode** for guiding a room's attention.
- A **clean, uncluttered infinite canvas** aesthetic.
- **Connectors with snapping** and **sections/frames** as organizing primitives.

### 5.3 Miro

- **Link:** <https://miro.com/online-whiteboard/>

Miro is a broad infinite-canvas collaboration platform: a pen tool with color/thickness and stylus support, selection, undo/redo, copy/paste, text, file upload (images/PDF/Office), sticky notes, a rich shape set, connection lines, and an extensive template catalog (flowchart, retro, roadmap, business model canvas, user-story map, and more). It also offers voting, timers, reactions, and presentation mode.

**Coboard adopts:**
- **Shape + connector breadth** (rectangles, ellipses, lines, arrows, brackets, quote bubbles) and connection lines.
- A **template catalog** (kanban, retro, mindmap, flowchart) to make rooms instantly useful.
- **Voting (dot voting), timer, reactions, and presentation mode** as workshop tooling.
- **Image/file upload** (stored in R2 in our stack) and **export** (PNG/SVG/PDF).

### 5.4 Canva Whiteboards

- **Link:** <https://www.canva.com/online-whiteboard/>

Canva's whiteboard offers an infinite/expanding canvas with real-time collaboration shown through **colorful, labeled cursors**, comments, a large template gallery (Kanban, roadmaps, diagrams), a rich media/graphics library, and AI helpers. A standout is **sticky-note Sort** — reorganize stickies by color, author, reactions, or AI-detected themes — plus real-time reactions on stickies.

**Coboard adopts:**
- **Colorful, labeled cursors** as the default presence treatment.
- **Sticky-note Sort** (by color / author / reactions / theme) for fast clustering.
- **AI "summarize the board"** and auto-cluster stickies as a cross-cutting stretch goal.
- Real-time **reactions on objects**.

### 5.5 Synthesis — what makes Coboard distinct

Coboard borrows the **room-code / no-signup + cross-reality** model from Whiteboard VR; **cursor chat, stamps, spotlight, and a clean infinite canvas** from FigJam; **shape/connector/template breadth plus voting/timer/presentation** from Miro; and **sticky Sort, colorful labeled cursors, and AI summarize** from Canva. Its **differentiator** is being **truly free to self-host on edge infrastructure** while serving a **single shared document across both 2D and immersive VR**. Feature-to-reference traceability is detailed in [02 — Features & Scope](./02-features-and-scope.md).

---

## 6. Competitive comparison

Legend: ✅ yes · ⚠️ partial / limited · ❌ no. Cells reflect the project research; SaaS feature sets and limits evolve, so re-verify before quoting externally.

| Product | Realtime cursors | VR / WebXR | Free self-host | No-signup rooms | Open source | Templates | Voice |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Coboard** | ✅ | ✅ (immersive, shared doc) | ✅ ($0 edge tiers) | ✅ (room code/URL) | ✅ | ✅ | ⚠️ (WebRTC, optional P2/P3) |
| **FigJam** | ✅ | ❌ | ❌ | ⚠️ (24h guest access) | ❌ | ✅ | ✅ (audio + chat) |
| **Miro** | ✅ | ❌ | ❌ | ⚠️ (guest links) | ❌ | ✅ | ⚠️ (via integrations) |
| **Canva Whiteboards** | ✅ (labeled) | ❌ | ❌ | ⚠️ (share links) | ❌ | ✅ | ❌ |
| **Whiteboard VR** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

**Reading the table:** the mainstream SaaS products win on polish and breadth but lose on _self-host_, _open source_, and _true VR_. Whiteboard VR matches Coboard on the hard constraints (VR, free self-host, no-signup, open) but lacks templates, voice, and modern scale. Coboard aims to keep the full hard-constraint column **and** close the feature-breadth gap.

---

## 7. What success looks like

**Experience success**
- A first-time visitor goes from clicking a link to drawing a visible stroke that a second person sees, in **under ~10 seconds**, with **no account**.
- Any participant can **enter VR from the same room** and draw on the same board as the laptop users — strokes and cursors flow both ways.
- A room **always feels alive**: labeled cursors, presence, and join/leave are immediately legible.
- A board **survives reconnects** — closing the tab and reopening the link restores the content from edge persistence.

**Operational success**
- A maintainer can deploy the whole system to a **single Cloudflare account and pay $0**, while supporting **meaningful concurrency** (target capacity quantified in [05 — Scaling & Cost](./05-scaling-and-cost.md)).
- Cursor/presence traffic stays within the free request/WS budget via throttling, binary encoding, and hibernation.

**Adoption success**
- The repo is **forkable and self-hostable** by a solo developer in an afternoon.
- Coboard is a credible, modern successor to Whiteboard VR — cited by it, improving on it.

---

## 8. Glossary

| Term | Definition |
| --- | --- |
| **Room** | A shareable, anonymous collaboration space. The share URL carries a high-entropy **room id** (the capability); a short, human-typable **join code** is a rate-limited alias for entering the same room from another device (see [04 §8](./04-technical-architecture.md)). One room maps to one backend Durable Object and one board document. |
| **Board** | The visual document of a room — strokes, sticky notes, shapes, text, connectors, frames. Rendered identically by the 2D web and 3D VR renderers because both read the same Yjs doc. |
| **CRDT** (Conflict-free Replicated Data Type) | A data structure that lets many clients edit concurrently and converge to the same state without a central lock. Coboard uses **Yjs**, which ships tiny binary updates. |
| **Awareness** | Yjs's `y-protocols/awareness` channel for **ephemeral** presence — cursors, selections, user color/name, cursor-chat text, and VR avatar head+hands poses. Broadcast to peers but **never persisted**. |
| **Awareness vs. document** | The **document** is durable, persisted board _content_ (Yjs updates saved to DO storage). **Awareness** is throwaway _presence_ that vanishes when a user leaves. Keeping them separate is what lets cursors update at high frequency without bloating saved history. |
| **Durable Object (DO)** | A Cloudflare primitive: a single-threaded, globally-addressable, stateful instance with co-located storage. Coboard runs **one DO per room**, holding the room's WebSocket connections and persisting its Yjs doc. |
| **Party** | A PartyServer concept that wraps a Durable Object as an easy realtime "room" (connection lifecycle + broadcasting), routed by an arbitrary room-id string. **One Party === one Durable Object.** |
| **WebXR** | The browser API for VR/AR experiences. Coboard's VR mode uses **A-Frame + Three.js** over WebXR so it runs on Quest/Vive and other headsets, with desktop/mobile fallback. |
| **Hibernation** | Cloudflare's WebSocket Hibernation API: clients stay connected while the Durable Object is evicted from memory, so duration (GB-s) charges stop accruing during idle periods — essential for $0 operation. |

---

_Next: see [02 — Features & Scope](./02-features-and-scope.md) for the full feature catalog, MoSCoW prioritization, phased acceptance criteria, and feature-to-reference traceability._
