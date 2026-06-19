# Architecture Decision Records (ADRs)

This folder holds Coboard's **Architecture Decision Records** — short documents
that capture an architecturally significant decision, its context, and its
consequences. The practice is referenced in
[07 — Engineering Quality §3.5](../07-engineering-quality-security-accessibility.md).

The canonical decisions in the planning package (`docs/01`–`07`) are the current
source of record; each becomes a numbered ADR here as it is ratified. Planned
initial set:

| ADR      | Decision                                                                             | Source                                                                                                   |
| -------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| ADR-0001 | Yjs as the single source of truth (one document per room)                            | [04 §2](../04-technical-architecture.md)                                                                 |
| ADR-0002 | Konva (Canvas 2D) first, with a documented PixiJS / WebGL migration trigger          | [04 §9](../04-technical-architecture.md), [07 §2.1](../07-engineering-quality-security-accessibility.md) |
| ADR-0003 | Dimension-agnostic canvas-space + per-user viewport-rect model (shared by 2D & VR)   | [04 §2.5, §6.5](../04-technical-architecture.md)                                                         |
| ADR-0004 | One room === one Durable Object (PartyServer + Y-PartyServer), WebSocket Hibernation | [04 §4](../04-technical-architecture.md), [05](../05-scaling-and-cost.md)                                |

## Ratified

Written and accepted (decisions taken during implementation, beyond the planned set above):

| ADR                                                      | Decision                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [ADR-0005](0005-ui-chrome-web-components.md)             | UI chrome is built from native Web Components (light-DOM custom elements)     |
| [ADR-0006](0006-selection-ownership-last-writer-wins.md) | Selection ownership is last-writer-wins on the awareness channel (clock-free) |

> **Format:** one file per ADR, `NNNN-short-title.md`, with sections
> **Context · Decision · Status · Consequences**. Status ∈ {Proposed, Accepted,
> Superseded}. An ADR is immutable once Accepted — supersede it with a new ADR
> rather than editing the old one.
