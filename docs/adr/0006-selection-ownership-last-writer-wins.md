# ADR-0006 — Selection ownership is last-writer-wins on the awareness channel (clock-free, exclusive per node)

- **Status:** Accepted (2026-06-19)
- **Deciders:** Komuboard maintainers
- **Related:** ADR-0001 (Yjs single source of truth, [04 §2](../04-technical-architecture.md)) · ADR-0003 (dimension-agnostic canvas + per-user viewport, shared by 2D & VR, [04 §2.5, §6.5](../04-technical-architecture.md)) · [07 §3.5](../07-engineering-quality-security-accessibility.md)

## Context

Selection is **per-user ephemeral presence**: each peer broadcasts the object ids it has selected on the Yjs **awareness** channel (alongside cursor, color, live `drag`/`resize` transforms), and peers render each other's selections as colored outlines. The geometry itself lives in the Yjs **document** (ADR-0001); awareness is never persisted.

Originally nothing reconciled two users selecting the **same** node. Both kept it selected, each with their own editable transform box. That produced a concrete bug: with users A and B both selecting node X, when B dragged X, B's live drag streamed over awareness and moved X's rendered node on A's screen — but A's Konva `Transformer` stayed pinned at X's **old** position. A's selection box lingered in empty space until B's move committed to the doc. More broadly, there was no answer to "who owns a node when two people grab it," and the intended UX is the familiar one: **the most recent selection wins.**

A server-arbitrated lock was rejected — it conflicts with the free-to-run, CRDT-first model (no authoritative selection state on the server; the Durable Object just relays, per ADR-0004). Wall-clock timestamps to decide "most recent" were rejected too: clients' clocks are unsynchronized, so skew could let an older selection appear newer and leave the node owned by both (the original bug) or neither.

## Decision

**A node's _active selection_ (its editable transform box) belongs to at most one peer at a time; the newest selector wins. Each client enforces this locally on the awareness channel — no server, no lock in the document, no cross-client clocks.**

On every awareness tick, before applying peers' live drags/resizes, a client runs an ownership pass (`yieldSelectionToPeers` in `packages/client-web/src/canvas.ts`) that **drops from my own selection** any node that:

1. **just entered some peer's `selection` this tick** — present in a peer's selection now, absent from the union of peers' selections last tick. A freshly-appeared id was selected _after_ mine, so I yield it. Recency is thus derived from **observation order on the shared awareness stream** (every peer observes the same updates), not from timestamps — clock-free; or
2. **is being actively dragged or resized by a peer** — an in-progress `drag`/`resize` transform unconditionally belongs to the mover, so I yield it (this is what guarantees no stale box can ever linger under a peer's drag).

Releasing a node detaches my transform box from it and rebroadcasts my (now smaller) selection, so the flip is symmetric: the previous owner shows nothing, and instead renders the new owner's presence outline.

Constraints:

- **My own in-progress gesture is never interrupted.** While I am mid-drag or mid-marquee I do not yield; the conflict resolves on the next tick after my gesture ends. Concurrent geometry edits are reconciled by the CRDT (last commit wins), independently of selection.
- **Selection stays out of the document.** Ownership is presence, enforced per client; nothing is written to the Yjs doc, and there is no hard lock — a peer can always take a node over by selecting it (collaborative, not locking).
- **Cross-renderer rule.** Because the 2D board and the VR scene share one document **and one awareness channel** (ADR-0001, ADR-0003), the VR client **must implement the same yield pass** so selection ownership interoperates across renderers: a VR user selecting a node takes it over from a 2D user and vice versa. This rule is a property of the awareness protocol, not of the Konva renderer.

## Consequences

**Good**

- No stale or duplicate transform boxes; "I clicked it, it's mine" matches user expectation.
- No server-side selection state or locking — fits the CRDT-first, free-to-run model; the relay (Durable Object) stays dumb.
- Clock-free, so immune to client clock skew.
- The rule is renderer-agnostic: 2D and VR converge to the same owner as long as both run the pass.

**Trade-offs**

- **Exact same-tick mutual selection** (both users select the same node within one awareness tick) makes each observe the other as "newer," so both yield and the node is briefly deselected for both — rare, and recovered by a re-click. A deterministic `clientID` tiebreak can be added if it proves annoying.
- **Recency = observation order, not a global total order.** Awareness has no strict global clock; "newest" means "the selection I observed most recently." This is adequate for selection UX but is not a linearizable ownership ledger (and intentionally so — geometry, not selection, is the source of truth).
- **Two peers dragging the same node at once** are not interrupted mid-gesture; the final geometry is resolved by the CRDT (last commit wins) and selection settles afterward.

**Scope:** `packages/client-web` selection/awareness handling (`yieldSelectionToPeers`, the `selection`/`drag`/`resize` awareness fields). Verified by `e2e/selection-override.spec.ts` (two real clients: A selects → B selects the same node → A yields, presence flips, A's awareness selection clears), with `e2e/remote-selection.spec.ts` and `e2e/live-drag.spec.ts` guarding the presence-outline and live-drag paths against regression.
