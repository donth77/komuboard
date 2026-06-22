# ADR-0005 — UI chrome is built from native Web Components (light-DOM custom elements)

- **Status:** Accepted (2026-06-19)
- **Deciders:** Komuboard maintainers
- **Related:** [07 §3.5](../07-engineering-quality-security-accessibility.md) · [03 §4 component inventory](../03-visual-design-ui-ux.md) · [04 §9 library table](../04-technical-architecture.md)

## Context

The 2D board is a Konva **canvas**; the VR scene is **A-Frame** (already a custom-element system). What's left is the DOM **chrome** — top bar, tool dock, properties panels, share/onboarding sheets, dialogs, minimap, presence facepile — which had no documented component model. `packages/client-web` was building it as one large `innerHTML` template wired up with `getElementById`, which does not scale to the Phase-2 chrome. The stack values are explicit: framework-agnostic `shared`, "no heavy framework," **React optional, not canonical** ([04 §9], README).

## Decision

Build the chrome from **native Web Components (custom elements), in light DOM** — no UI framework, no Shadow DOM.

1. **Custom elements are the unit of chrome** — `<co-*>` (e.g. `<co-dialog>`, `<co-avatar-presence-row>`), with `connectedCallback` / `disconnectedCallback` lifecycle and **property-in / `CustomEvent`-out** interfaces. App glue does the Yjs/awareness wiring; elements are presentation + local interaction.
2. **Light DOM, not Shadow DOM.** Elements render into their own light DOM and **share Komuboard's global design system** — the CSS tokens (`--accent`, `--surface`, …) _and_ the utility classes (`.btn-primary`, `.swatches`, `.kbd`, `.avatar`, …) in `styles.css`. Shadow DOM was considered and **rejected**: CSS custom properties pierce a shadow boundary but **class selectors do not**, so Shadow DOM would force per-component duplication of the shared utilities (and the global `prefers-reduced-motion` reset would stop applying inside each root).
3. **Vanilla now; [Lit](https://lit.dev) optional.** Start dependency-free (see `dialog.ts`, `avatar-presence-row.ts`). If attribute/state boilerplate grows, adopt Lit (~6 KB gzip, MIT) — still within the ≤250 KB core-bundle budget ([07 §2.7]). Custom elements interoperate with React 19 if the React-optional escape hatch is ever taken.

## Consequences

**Good**

- Matches the framework-agnostic ethos and the §3.4 state-boundary discipline (state in Zustand/Yjs, presentation in elements).
- One shared stylesheet and one set of utility classes — no duplication, consistent look, theming/`[data-theme="dark"]` just works.
- **Light DOM keeps a single, fully-queryable DOM and one ARIA tree.** This sidesteps Shadow DOM's cross-root ARIA fragmentation (`aria-labelledby` / `-controls` / `-activedescendant` cannot point across roots), which matters for the a11y-heavy surfaces — the offscreen semantic mirror ([07 §5.1]) and the ARIA live-region announcer — and keeps Playwright / `axe-core` selectors simple (no shadow piercing).

**Trade-offs**

- **No style encapsulation** — global class names can collide. Mitigate with disciplined, prefixed class naming and the single shared stylesheet; lint/review guards it.
- Wrap native form controls (`<dialog>`, `<input>`) directly (as `<co-dialog>` does) rather than reaching for `ElementInternals`.

**Scope:** `packages/client-web` chrome only — not the Konva board, the worker, or `shared`.

## Status of components

- **`<co-dialog>`** — `src/dialog.ts` — wraps the native `<dialog>` (focus-trap / Esc / inert background for free) with fully custom styling + animation; used by the shortcuts overlay and the profile dialog. `[data-dialog-close]` closes; backdrop-click closes; emits `dialogclose`.
- **`<co-avatar-presence-row>`** — `src/avatar-presence-row.ts` — presence avatar stack; data in via the `people` property, "rename me" out via a bubbling `rename` event. The awareness/Yjs → `PresencePerson[]` mapping stays in `main.ts`.
- **`<co-tool-dock>`** — `src/tool-dock.ts` — floating tool dock; owns its button list + active highlight; selection out via `tool-change`, active tool settable back in via the `tool` property (so keyboard shortcuts stay in sync).
- **`<co-draw-bar>`** — `src/draw-bar.ts` — the brush bar (a floating vertical column on desktop, a slide-up bottom mini-sheet with a pull-tab on mobile): pen/highlighter brushes, line style (solid/dotted), a colour palette + `<co-color-picker>`, and stroke width; edits out via a single `pen-change` event (changed field only); swatches + initial colour in via properties. (Replaced the original `<co-pen-panel>`.)
- **`<co-zoombar>`** — `src/zoombar.ts` — zoom + fullscreen widget; actions out via a `zoom` event, live level in via the `percent` property.
- **`<co-topbar>`** — `src/topbar.ts` — the top app bar (brand + menu button, room pill with the connection dot, theme button, dev connection readout, presence row); `room` / `theme` setters + `setStatus` / `setSynced` in, `nav-toggle` / `theme-toggle` out. App state (theme, connection, drawer) stays in `main.ts`.
- **`<co-drawer>`** — `src/drawer.ts` — slide-out menu drawer + scrim; opened via the `open` property (from the topbar's `nav-toggle`), closes itself on scrim click; `room` / `theme` setters in, `theme-toggle` out. A `display: contents` host so the fixed scrim/panel position exactly as before.

Shared util: **`src/icons.ts`** — the Lucide-style inline SVG `icon()` map, used by the shell and the components (no per-component icon duplication).
