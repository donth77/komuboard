# ADR-0008 — UI stays framework-free for now; the framework/Lit adoption ladder & triggers

- **Status:** Accepted (2026-06-20)
- **Deciders:** Komuboard maintainers
- **Related:** [ADR-0005 — UI chrome is Web Components](0005-ui-chrome-web-components.md) · [04 §9 library table](../04-technical-architecture.md) · [07 §2.7 bundle budget](../07-engineering-quality-security-accessibility.md) · [09 §Organization — O1/O3](../09-tech-debt-and-audit-backlog.md) · [README "React optional, not canonical"](../../README.md)

## Context

A recurring question: should Komuboard's UI move to a framework (React/Svelte/Solid), or at least adopt **Lit**? [ADR-0005](0005-ui-chrome-web-components.md) chose native Web Components in light DOM and named Lit as an _optional_ escape hatch — but never said **when**. This ADR makes the answer criteria-driven rather than vibe-driven.

Two facts frame it:

1. **A framework would not touch Komuboard's two hardest layers.** The 2D board is a **Konva canvas** (pixels, not DOM) and VR is **A-Frame/WebXR** (its own scene graph) — both imperative renderers bound to Yjs. React/Svelte/Solid render/diff DOM, so they only ever apply to the **DOM chrome** (top bar, tool dock, draw-bar, panels, dialogs, presence facepile). The board, VR, and the perf-sensitive hot paths (the awareness tick, render loop) are untouched by a UI framework.
2. **The chrome is already sound; the real debt is organizational.** Audits rated the `<co-*>` Web Components good (consistent, injection-safe, no leaks, guarded hot paths). What hurts is `main.ts` being a ~677-line god-module and a few **patterns** copy-pasted across components (swatch render, floating popover, mobile sheet-handle) — see [09 O1/O3](../09-tech-debt-and-audit-backlog.md). Those are fixed by plain extraction, **not** by a framework or by Lit.

## Decision

**Stay framework-free now, and do not adopt Lit yet either.** Adoption is governed by an explicit ladder; you climb a rung only when its trigger fires.

| Rung  | Approach                                                                    | Adopt when (trigger)                                                                                                                                                                                                                                                        |
| ----- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **Vanilla Web Components** _(current)_                                      | — baseline                                                                                                                                                                                                                                                                  |
| **2** | **Vanilla + shared helpers + a tiny `LightElement` base** _(no dependency)_ | The immediate step — it _is_ the [O1/O3](../09-tech-debt-and-audit-backlog.md) work: extract `main.ts` into the existing empty `src/ui/`, pull repeated patterns into helper functions, standardize the `#wired`/build/setter shape in a ~30-line base class.               |
| **3** | **Lit (~6 KB gzip)**                                                        | Only _after_ rung 2, if per-component **reactive-state** boilerplate (manual `#render()` orchestration) still bites — or a genuinely state-heavy chrome surface lands. Keeps the Web-Components architecture, light DOM, single ARIA tree, and framework-agnostic `shared`. |
| **4** | **Full framework (React / Svelte / Solid), confined to the chrome**         | A genuinely complex DOM surface (comments/threads, templates gallery, multi-control settings), **collaborative rich-text** (where editor-binding ecosystems pay off), or a team/hiring reality where contributors expecting React measurably slow velocity.                 |

Notes on rung 4: it stays at the **chrome edge** — the Konva board, A-Frame VR, Yjs/awareness core never move into it. If forced to pick, **Svelte or Solid** fit the lean, "no heavy framework" ethos better than React (React's main draw, ecosystem, mostly matters only if rich-text lands).

**Hard constraints any rung must preserve:** the ≤250 KB core-bundle budget ([07 §2.7](../07-engineering-quality-security-accessibility.md)); a **framework-agnostic `shared`** package; a **single light-DOM ARIA tree** (the a11y-heavy offscreen semantic mirror + live-region announcer depend on it — [ADR-0005](0005-ui-chrome-web-components.md)); and both renderers staying imperative.

## Consequences

**Good**

- No premature dependency or second authoring model; the **free** organizational wins (rung 2) land first and remove most of the felt pain.
- The decision is criteria-driven and **reversible** — each rung is incremental, and Web Components interop with React 19 (per ADR-0005) keeps rung 4 open without lock-in.

**Trade-offs**

- Hand-rolled component boilerplate persists until rung 2/3.
- Contributors who expect React work in vanilla Web Components for now.

**Supersede this ADR** with a new one when a rung-3 or rung-4 trigger fires (record which trigger, and confine the change to the chrome).
