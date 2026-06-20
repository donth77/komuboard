# ADR-0007 — Stay on Yjs as the CRDT; Loro evaluated and deferred

- **Status:** Accepted (2026-06-20)
- **Deciders:** Coboard maintainers
- **Related:** [04 §2 Yjs data model](../04-technical-architecture.md) · [04 §3 sync + awareness](../04-technical-architecture.md) · [04 §4 Durable Object design](../04-technical-architecture.md) · [05 — Scaling & Cost](../05-scaling-and-cost.md) · [ADR-0006 — selection ownership on awareness](0006-selection-ownership-last-writer-wins.md) · [09 — Tech-debt backlog](../09-tech-debt-and-audit-backlog.md)

## Context

Yjs is Coboard's single source of truth (the intent of ADR-0001 / [04 §2](../04-technical-architecture.md)), and the realtime stack is built on it **end to end**:

- **`y-partyserver`** runs the entire Yjs sync protocol _inside each Durable Object_ — handshake, binary-update relay, awareness relay, hibernation handling (ADR-0004).
- **`y-protocols/awareness`** carries all presence: cursors, selections, the live draw/drag/resize previews, and last-writer-wins selection ownership ([ADR-0006](0006-selection-ownership-last-writer-wins.md)).
- **Persistence** is `Y.encodeStateAsUpdate` / `Y.applyUpdate` → a DO-SQLite BLOB (`worker/src/persistence.ts`).
- The **data model and cost model** (binary updates, the 20:1 inbound-message budget, awareness coalescing) are documented in [04 §2–§4](../04-technical-architecture.md) and [05](../05-scaling-and-cost.md).

The question raised: would **[Loro](https://loro.dev/)** (a Rust-core CRDT with WASM/JS bindings) be a better choice? Loro is genuinely strong — Fugue-based text, a **Movable Tree** CRDT, **Git-like version history / time-travel** with shallow snapshots, an ephemeral/presence store, top benchmark performance, cross-language bindings (Rust/Swift/Python), and a stable 1.0.

## Decision

**Stay on Yjs.** Loro is evaluated and **deferred** — not rejected on technical merit.

The deciding factor is **integration, not the CRDT algorithm**:

1. **No Cloudflare/Durable-Objects story for Loro.** `y-partyserver` gives the server-side sync + awareness relay + hibernation for free; there is no `loro-partyserver` equivalent. Switching means hand-building that layer — the hardest, most-tested part of the system — ourselves.
2. **Loro's headline strengths aren't needs Coboard has.** Movable tree → N/A (flat objects map + a z-order array). Rich-text Fugue → no heavy collaborative rich-text yet (Yjs has `Y.Text` + ProseMirror/Quill/CodeMirror bindings if that changes). Time-travel → not on the roadmap; `Y.UndoManager` + snapshots suffice, and M2 snapshot compaction is already planned. Raw performance → **not the bottleneck** (the M1 audits located the costs in client-side awareness/render hot paths, which a CRDT swap would not fix). Both renderers (Konva 2D, A-Frame VR) run in-browser, so Loro's cross-language edge yields nothing here.
3. **Ecosystem maturity.** Yjs ≈ 920K weekly downloads with the deepest editor-binding and provider ecosystem incl. Cloudflare/PartyServer; Loro ≈ 12K weekly downloads with a nascent server ecosystem.

A migration would touch the server (`y-partyserver` → custom Loro-on-DO sync), the presence/ownership layer, persistence, the schema, and the docs — high risk for benefits the product does not currently need.

## Consequences

**Good**

- Keep `y-partyserver`'s batteries-included Durable-Object integration, the largest binding ecosystem, and all existing code + docs. Zero migration risk; the team stays on one well-understood model.

**Trade-offs (what we forgo)**

- Loro's built-in version-control / time-travel and shallow-snapshot compaction — we will implement persistence compaction ourselves in M2.
- Potential raw-throughput headroom — not currently needed at whiteboard doc sizes.

**Revisit triggers** — supersede this ADR with a new one if any of these become true:

1. **Board time-travel / version history** becomes a headline product feature.
2. We add **native non-JS clients** (e.g. iOS/desktop) that must share the live document.
3. The data model becomes **tree/outline-heavy** (a movable-tree fit).
4. Document sizes grow to where Yjs performance **measurably** bottlenecks.

If revisited, the accepted cost is **owning a Loro sync server on Durable Objects** (plus re-homing presence, persistence, and the schema). Note `yrs` (the Rust port of Yjs) is the lower-risk option if a Rust/native core is ever the actual driver.

## References

- [Loro](https://loro.dev/) · [loro-dev/loro](https://github.com/loro-dev/loro) · [Loro JS/WASM benchmarks](https://loro.dev/docs/performance)
- [Yjs vs Automerge vs Loro, 2026 (PkgPulse)](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026) · [Yjs vs Loro (Yjs community)](https://discuss.yjs.dev/t/yjs-vs-loro-new-crdt-lib/2567)
