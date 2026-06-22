# ADR-0009 — Unify the 2D render model on the DOM for per-object z-order (placement stacking)

- **Status:** Accepted (2026-06-21) · **Phases 0–3 Implemented (2026-06-22)** — strokes/connectors/stamps/text/shapes/stickies all render, interact, and transform on the DOM, z-ordered by `orderArray`; the `Konva.Transformer` and every Konva object layer are retired (only the camera/cursor stages + a transient-chrome overlay remain on Konva). Phase 4 (LOD at far zoom, dense-board profiling, a11y) is the only open work.
- **Deciders:** Komuboard maintainers
- **Related:** [ADR-0002 — Konva-first + documented PixiJS/WebGL trigger](README.md) ([04 §9 library table](../04-technical-architecture.md)) · [ADR-0005 — UI chrome is Web Components](0005-ui-chrome-web-components.md) · [ADR-0008 — framework/Lit ladder](0008-ui-framework-adoption-ladder.md) · [04 §1, §9](../04-technical-architecture.md) · [07 §2.1 renderer perf](../07-engineering-quality-security-accessibility.md)

## Context

The goal is **FigJam-style stacking**: draw, place a shape, draw, place a shape — each object stacks above the previous by **creation order, regardless of type**. The data model already supports this — `orderArray` in the Yjs doc stores a single global z-order over all object ids.

The blocker is the **renderer**, not the data. Today the 2D board is a **hybrid**:

- **Konva canvas** renders pen strokes, connectors, and stamps.
- **HTML / DOM** renders text, shapes, and stickies (native `contenteditable` rich text).

A single `<canvas>` is **one element** in the page's stacking context, so everything drawn inside it (all ink + stamps) shares one z-band and **cannot interleave per-object** with sibling DOM nodes. You can't put one stroke above a shape and another stroke below it — which is exactly what FigJam does.

This surfaced through the stamp work: stamps couldn't sit on top of shapes/stickies, and moving stamps onto their own Konva layer (to fix a separate "stamps vanish on a z-order change" bug) still only buys **one more z-band**, not per-object order.

**Per-object interleaving across all types requires one stacking context — i.e. one render model.** The choice of renderer is secondary; the single-context requirement is primary. Three render models can provide it:

| Model                        | Per-object z | Rich text editing                          | Perf ceiling | Rebuild cost / regression risk            |
| ---------------------------- | ------------ | ------------------------------------------ | ------------ | ----------------------------------------- |
| **DOM-unify** _(this ADR)_   | ✅ z-index    | ✅ native `contenteditable` kept            | high (w/ culling) | medium — view layer only, reuses HTML text |
| All-canvas (Konva)           | ✅ node order | ⚠️ rebuild rich text in canvas             | higher       | high — text + display rewrite             |
| All-canvas (PixiJS/WebGL)    | ✅ node order | ⚠️ rebuild rich text + contenteditable overlay | highest  | highest — renderer + interaction + text   |

## Decision

**Unify the 2D render on the DOM.** Every board object becomes a DOM element, z-ordered by its `orderArray` index. Text/shapes/stickies stay HTML; **stamps become `<img>`**; **strokes/connectors render as DOM** (SVG `<path>` first; per-stroke `<canvas>` if profiling demands).

**Why DOM, and not all-canvas/WebGL** — the deciding factor is the hard constraint "performant **and** no bugs/regressions/UX problems," and those pull opposite ways. The single biggest regression risk in the whole migration is **rich text editing** (cursor, selection, IME, copy/paste, accessibility) — today native and solid. Moving text into a canvas/WebGL scene means re-implementing glyph layout + a contenteditable overlay (Figma's model), which is precisely where UX problems come from. **Keep text in the DOM → that risk disappears.** Once text must stay DOM and interleave with everything, everything else must be DOM too.

Two facts make this safe:

1. **z-order becomes trivial** — `z-index` (or DOM source order) = `orderArray` index. The thing that is hard today is free after unifying.
2. **The Yjs data model does not change at all** — `orderArray`, the object schema, and the awareness drag/resize broadcasts are identical. **Sync, undo, and realtime are untouched.** This is purely a **view-layer** migration.

### Performance approach (non-negotiables, designed in from Phase 0)

Performance comes from **culling + GPU**, not from the renderer choice:

1. **Viewport virtualization (culling)** — mount DOM only for objects in/near the viewport. The #1 lever: on-screen node count ≈ what's visible, so total board size stops mattering. Build it in from the start, not as a bolt-on.
2. **All positioning via CSS `transform`** (translate/scale/rotate) — never `top/left/width` during interaction → GPU-composited, no layout thrash.
3. **Camera = one `transform` on the object container** — pan/zoom is a single GPU transform; everything moves together.
4. **Keyed reconciliation** — recycle DOM nodes by id (what `renderObjects` already does for Konva), add/remove/reorder cheaply.
5. **One unified DOM transform/selection chrome for all types** — generalize the text-layer's resize/rotate to strokes/stamps/shapes (the shared rotate cursor, `src/cursors.ts`, was step one).
6. **Stamps are static `<img>`** — decode-cached, shared `src`; only cost work when they move. Hundreds–low-thousands are a non-issue with culling.
7. **LOD fallback** for the one DOM stress case (hundreds of complex strokes all visible when zoomed far out): simplify or flatten ink to a single background `<canvas>` at low zoom — individual strokes aren't editable there anyway.

### Implementation phases

App stays working and **two-client tested** at every step; the Yjs model never changes.

| Phase | Scope                                                                                                                                                 | Done-when                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **0 ✅** | **Foundation:** object container + camera transform + **viewport culling** + keyed reconcile + a `z-index = orderArray` pass over existing DOM objects. | Culling + camera proven on current objects; no behavior change yet. _(Culling deferred to Phase 4; container/camera/keyed-reconcile/z-order done.)_ |
| **1 ✅** | **Stamps → DOM image-boxes:** retire bespoke Konva stamp nodes; stamps inherit the unified selection/resize/rotate/realtime (like shapes). Net code removal. | Stamp stacks on/under any object by placement; realtime + undo intact.                                 |
| **2 ✅** | **Existing DOM objects under `orderArray` z:** text/shapes/stickies z-index by placement order (not DOM insertion order).                              | Any two DOM objects stack by creation order.                                                          |
| **3 ✅** | **Strokes + connectors → DOM** (riskiest): each a DOM element (SVG path; or per-stroke canvas), z-indexed + culled. Retire the Konva layers + `Konva.Transformer` in favour of the unified DOM chrome. | Per-object interleaving across **all** types; perf holds on dense boards. _(Culling lands in Phase 4.)_ |
| **4** | **Polish:** LOD at low zoom, profiling on dense boards, a11y pass, remove dead Konva paths.                                                            | FigJam-parity stacking, smooth on realistic boards.                                                   |

## WebGL / PixiJS — deferred (revisit triggers)

This continues **ADR-0002** (Konva-first, with a documented Pixi/WebGL migration trigger), now reframed: the next big renderer move is **DOM-unification (this ADR)**; PixiJS/WebGL is the *subsequent*, scale-driven step — not this one.

- **WebGL is not what unlocks the behavior.** Placement-order z comes from a single stacking context (DOM here). WebGL buys **scale headroom** — tens of thousands of objects all visible at once, buttery extreme zoom-out — which culling can't help because everything is on screen.
- **Cost of WebGL now** would be: rebuild the whole render + interaction layer (Pixi has **no Transformer** — selection/marquee/resize/rotate is hand-rolled), **and** re-implement rich text in canvas + a contenteditable overlay. That maximizes perf and **maximizes regression risk** — the opposite of this ADR's constraint.
- **Deferring is safe** because the Yjs model is renderer-agnostic: a future WebGL move is a **view-layer swap**, no data/sync rewrite, no lock-in.
- **Revisit (supersede this ADR) when a trigger fires** — record which:
  - a **profiled** FPS/jank wall on dense real boards that **culling + LOD cannot fix**;
  - a product goal of **Figma-class scale** (tens of thousands of objects, far-zoom smoothness);
  - measured jank from raw **DOM node count after culling**.
  - Renderer choice then: **PixiJS** (pragmatic WebGL/WebGPU, no in-house renderer) vs **custom WebGL** (Figma's path — maximum control, maximum effort).
- **Lit / UI framework** is unaffected — see [ADR-0008](0008-ui-framework-adoption-ladder.md). The unified object renderer is a perf-sensitive hot path → **imperative/manual** updates (keyed reconcile + transforms), not a template framework. Lit, if ever, stays at the **chrome edge**, never the board hot path.

## Consequences

**Good**

- Exact FigJam per-object stacking (any type over any type, by creation order).
- **Native rich-text editing preserved** — the lowest-UX-regression path.
- **Data/sync/undo untouched** — view-layer-only migration on a renderer-agnostic Yjs model.
- Reuses proven code (HTML text editing, text-layer transform chrome, keyed reconcile); stamps become **net-less** code (shed bespoke Konva nodes).
- Keeps **WebGL/PixiJS open** as a later, low-risk, scale-triggered upgrade (ADR-0002 lineage).

**Trade-offs**

- Larger view-layer change than the rejected "ink as one Konva layer" hybrid — which was rejected precisely because it can't interleave *individual* strokes with objects.
- Vector ink in the DOM needs care: SVG paint / per-stroke canvas + culling + LOD; the **zoomed-far-out dense-ink** case is the one to watch.
- Retires the `Konva.Transformer` and the recent Konva-based stamp transform work in favour of one unified DOM chrome (some rework, but consolidates onto a single system).
- The VR path (§ 04) keeps its own renderer; this ADR is the **2D web** render model only. The Yjs doc remains the shared source both bind to.

**Supersede this ADR** with a new one when a WebGL/PixiJS trigger above fires (record the trigger and confine the change to the view layer), or if per-stroke interleaving at extreme scale forces the all-canvas route.
