# Coboard — Localization & Internationalization (i18n)

> _How Coboard ships translatable, runtime-switchable UI strings across the 2D chrome, the Konva canvas, and the VR scene — without adopting a UI framework. React is **not** required._

**Related documents:** [README](../README.md) · [01 — Product Vision & References](./01-product-vision-and-references.md) · [02 — Features & Scope](./02-features-and-scope.md) · [03 — Visual Design / UI-UX](./03-visual-design-ui-ux.md) · [04 — Technical Architecture](./04-technical-architecture.md) · [05 — Scaling & Cost](./05-scaling-and-cost.md) · [06 — Implementation Roadmap](./06-implementation-roadmap.md) · [07 — Engineering Quality, Performance, Security & Accessibility](./07-engineering-quality-security-accessibility.md) · [ADR-0005 — UI chrome is Web Components](./adr/0005-ui-chrome-web-components.md)

> **Status:** Planning note (not yet implemented). No locale/i18n mechanism exists in the code as of this writing — all user-facing strings are hardcoded English literals. This document captures the recommended approach so the extraction can be done as one deliberate pass.

---

## 1. The question, answered

**Can we add dynamic (runtime-switchable) localization strings without introducing React? Yes — and React would not even help the parts that are hardest here.**

Localization is a **data + lookup + change-notification** problem, not a rendering-framework problem:

1. **A string table** — keyed messages per locale (`{ en: { "tool.pen": "Pen" }, es: { "tool.pen": "Lápiz" } }`).
2. **A lookup function** — `t("tool.pen")` reads the current locale's table.
3. **A way to re-apply strings when the locale changes at runtime** — the "dynamic" part.

Only step 3 is where a framework _might_ contribute, and only because React bundles "re-render on state change." That single slice is ~30 lines of pub/sub to replicate for the narrow case of "the language just changed, re-translate the UI." Everything else — the table, the lookup, plurals, number/date formatting — is framework-agnostic standard-library work.

### Why React is not required (and would not help)

| Localization need                  | Needs React? | How we do it instead                                                                    |
| ---------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| String table + `t()` lookup        | No           | Plain TS module + keyed objects                                                         |
| Runtime language switch (re-apply) | No           | A `data-i18n` attribute sweep + a tiny pub/sub (`onLocaleChange`)                       |
| Plurals / number / date formatting | No           | `Intl.PluralRules`, `Intl.NumberFormat`, `Intl.DateTimeFormat`                          |
| Konva canvas text (board labels)   | No           | Imperative `.text(...)` re-set on locale change — **outside** React's reconciler anyway |
| A-Frame / WebXR text entities      | No           | Imperative attribute update — **outside** React's reconciler anyway                     |

The two surfaces that would be _most_ awkward to localize — the Konva 2D canvas and the A-Frame VR scene — are drawn by libraries that React does not reconcile. You update them imperatively in **any** architecture, so React buys nothing there. Adopting it solely for i18n would add a renderer to maintain while leaving the hard surfaces exactly as manual as they are today.

This is consistent with the project's stated stack posture — **"React optional, not canonical"** ([04 §9], [README](../README.md)) — and with [ADR-0005](./adr/0005-ui-chrome-web-components.md), which builds the chrome from native Web Components in light DOM.

---

## 2. Current state (survey of `packages/client-web`)

A survey of the client confirms the architecture that shapes the recommendation:

- **Vanilla Web Components (custom elements), light DOM, no framework.** `<co-tool-dock>`, `<co-draw-bar>`, `<co-zoombar>`, `<co-avatar-presence-row>`, `<co-color-picker>`, `<co-dialog>`. The 2D board is **Konva.js**; VR is **A-Frame**. Light DOM (no Shadow DOM) per [ADR-0005](./adr/0005-ui-chrome-web-components.md) — components share the global stylesheet and a single ARIA tree.
- **Text reaches the screen three ways:**
  1. **Template literals + `innerHTML`** built once in `connectedCallback` (e.g. `tool-dock.ts` `TOOLS.map(...).join("")`; `draw-bar.ts` brush bar + popovers; `main.ts` shell).
  2. **`textContent`** for dynamic values (`main.ts` status / sync / zoom `${pct}%`; `draw-bar.ts` stroke width; `avatar-presence-row.ts` initials).
  3. **Attributes** — `aria-label`, `title`, `data-tip`, `placeholder` (e.g. `aria-label="Menu"`, tool labels, `title="connection status"`).
- **~80–100 distinct user-facing string literals**, clustered in `main.ts`, `tool-dock.ts`, and `draw-bar.ts` (see §8 for the inventory).
- **No i18n mechanism exists.** No `locale` / `i18n` / `translat` / `lang` references. The only reusable string map is `COLOR_NAMES` in `draw-bar.ts` — a precedent for the keyed-table pattern.
- **Re-render model: imperative, build-once.** Components build their DOM a single time (`if (this.#wired) return` guard) and then do **surgical** updates (`#sync()` toggles classes; `#renderSwatches()` rebuilds only the swatch container; `#paint()` mutates `style`/`textContent`). **There is no full `render()` method**, and the `#wired` guard exists specifically to avoid re-running the build (which would re-wire event listeners).

That last point is decisive for picking the strategy (§4).

---

## 3. Two ways to do the "dynamic" re-apply

**Option A — re-render the component on locale change.** Each component subscribes in `connectedCallback`; on a `locale-changed` event it re-runs its own `render()` to rebuild DOM with fresh strings. Clean _if_ components already have an idempotent `render()`.

> **Why Option A fights our architecture:** our components have **no `render()`** — they build once and the `#wired` guard blocks rebuilds precisely so listeners are not re-bound. Adopting Option A means adding teardown + rebuild + re-wire logic to every component. That is the work React would normally hide — and the reason one might be tempted to reach for it — but it is avoidable here.

**Option B — attribute sweep (recommended).** Tag elements with `data-i18n` / `data-i18n-aria` / `data-i18n-title` instead of hardcoding text, then a single function walks the DOM and rewrites text/attributes on locale change. Decoupled from component lifecycle; no re-wiring.

> **Why Option B fits:** our **light DOM** (no Shadow DOM, [ADR-0005](./adr/0005-ui-chrome-web-components.md)) means one `document.querySelectorAll("[data-i18n]")` reaches **every** component — no shadow-root traversal. Components keep their build-once model untouched; the sweep owns translation.

The real implementation is a **hybrid**: Option B for static labels (the majority), plus direct `t()` calls for the handful of dynamic/interpolated strings (§6).

---

## 4. Recommended architecture

### 4.1 The i18n core (`packages/shared` or `client-web/src/i18n.ts`)

Framework-free. The `listeners` set _is_ the "what React does" slice — locale change fan-out.

```ts
// i18n.ts — no dependencies
type Dict = Record<string, string>;

const tables: Record<string, Dict> = { en: {}, es: {} }; // lazy-loaded per locale
let locale = "en";
const listeners = new Set<() => void>();

/** Look up a key in the active locale, falling back to en, then the key itself. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = tables[locale]?.[key] ?? tables.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function getLocale(): string {
  return locale;
}

export function setLocale(next: string): void {
  locale = next;
  document.documentElement.lang = next;
  document.documentElement.dir = RTL_LOCALES.has(next) ? "rtl" : "ltr";
  listeners.forEach((fn) => fn()); // ← the only thing React's re-render would have given us
}

/** Subscribe to locale changes; returns an unsubscribe fn. */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const RTL_LOCALES = new Set(["ar", "he", "fa", "ur"]);
```

> `shared` is the framework-agnostic package ([04 §9]); putting the core there lets the VR renderer (`packages/vr`) consume the **same** `t()` and locale state as the web chrome, which matters for the cross-reality "one identity, three realities" principle ([03 §1]).

### 4.2 Static strings — the `data-i18n` sweep

Tag templates with keys instead of literals, then sweep:

```ts
export function applyTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria!));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.dataset.i18nTitle!));
  });
}

// Wire once at startup:
applyTranslations();
onLocaleChange(() => applyTranslations());
```

In the component templates, the change is mechanical — replace the literal with a key:

```ts
// tool-dock.ts — today:   `aria-label="${label}"`
//                becomes: `data-i18n-aria="tool.pen"`
// dialog ✕ "Close", "Solid"/"Dashed"/"Highlight", "Black".."Pink", "Zoom in" … each gets a data-i18n key
```

The existing data tables become key tables rather than English tables:

- `TOOLS` (`tool-dock.ts`) — store keys (`"tool.select"`, `"tool.pen"`, …) and resolve with `t()` at render.
- `COLOR_NAMES` (`draw-bar.ts`) — already a lookup; values become keys (`"color.black"`, …).

### 4.3 Dynamic / interpolated strings

A small set are recomputed by their own triggers and so can't be owned by a static sweep. Call `t()` at the assignment point, **and** register the updater with `onLocaleChange` so it also re-fires on a language switch:

```ts
// main.ts status line (~main.ts:341 / :543)
function refreshStatus() {
  statusEl.textContent = t(`status.${state.status}`);
} // status.connecting, status.synced …
refreshStatus();
onLocaleChange(refreshStatus);

// zoom pill "${pct}%" (~main.ts:517) — format the number too
zoomPill.textContent = new Intl.NumberFormat(getLocale(), { style: "percent" }).format(pct / 100);

// presence "{name} (you)" and "+{extra}" (avatar-presence-row.ts)
el.title = t("presence.you", { name: p.name }); // "{name} (you)" / "{name} (tú)"
moreEl.textContent = t("presence.more", { count: extra });
```

The known dynamic spots: connection/sync status (`main.ts`), zoom percent (`main.ts`), avatar `"{name} (you)"` + `"+{extra}"` counter (`avatar-presence-row.ts`), and the pen stroke-width readout (`draw-bar.ts`). All but a few are pure numbers (locale-independent) — only the ones with words need `onLocaleChange`.

### 4.4 Canvas (Konva) & VR (A-Frame) text

Any user-authored board content (sticky text, text shapes) is **document data** in Yjs — it is **not** translated; it is whatever the author typed. Only **app-chrome** text rendered into those surfaces (e.g. an empty-state hint drawn on the canvas, VR menu labels) is localized. Those nodes are updated imperatively and so subscribe to `onLocaleChange`:

```ts
onLocaleChange(() => {
  hintNode.text(t("canvas.empty-hint"));
  layer.batchDraw();
});
// VR: onLocaleChange(() => menuLabel.setAttribute("text", "value", t("vr.menu.pen")));
```

This is identical effort with or without React — these are outside any DOM reconciler.

---

## 5. Plurals, number & date formatting

Hand-roll the table and lookup, but **do not** hand-roll grammar — use the platform `Intl` APIs:

- **Plurals:** `Intl.PluralRules` selects `one` / `other` / `few` / `many` per locale; store plural variants under sub-keys (`presence.more.one`, `presence.more.other`) and pick with the rule. This is the one area where a library (below) earns its keep via ICU `{count, plural, ...}` syntax.
- **Numbers / percentages:** `Intl.NumberFormat` (zoom %, counts).
- **Dates / relative time:** `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat` (e.g. "joined 2 min ago" if/when presence shows timestamps).

---

## 6. Optional: framework-agnostic libraries

If we'd rather not hand-roll the core, two libraries are **framework-agnostic** (no React binding needed) and drop straight into the same sweep:

| Library                   | Why                                                                                                                       | Cost                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **`i18next`** (core only) | Mature, ICU-ish via plugins, namespaces, lazy locale loading, `languageChanged` event → drives our `applyTranslations()`. | ~40 KB; large ecosystem   |
| **`@lingui/core`**        | Compile-time message extraction + ICU MessageFormat, very small runtime, CLI to manage catalogs.                          | Tiny runtime (~3 KB core) |

Either replaces §4.1 only; §4.2–4.4 (the sweep + dynamic re-apply + canvas/VR) stay the same. Given ~80–100 strings and the "no heavy framework" ethos, **hand-rolled core + `Intl` is a reasonable starting point**; adopting `@lingui/core` is the natural upgrade if ICU plurals/extraction tooling become painful. Bundle budget is ≤250 KB core ([07 §2.7]) — all options fit.

---

## 7. Locale selection, persistence & `lang`

- **Detection:** default from `navigator.languages` on first load, intersected with shipped locales (fall back to `en`).
- **Persistence:** store the chosen locale in `localStorage` — a **per-viewer preference, never synced into the Yjs doc**, exactly like the theme preference ([03 §1]: theme is persisted in `localStorage`, not the shared doc). Two people in the same room can read it in different languages.
- **`<html lang>` / `dir`:** `setLocale` keeps `document.documentElement.lang` correct (screen-reader pronunciation, an [07 §5] / WCAG 2.2 concern) and flips `dir` for RTL locales. Prefer CSS **logical properties** (`margin-inline-start`, etc.) in `styles.css` so RTL is mostly free; treat full RTL as a follow-up, not part of the first extraction.
- **UI affordance:** a language picker in the Menu/settings sheet, emitting the locale into `setLocale`.

---

## 8. String inventory (where the ~80–100 literals live)

| File                     | Kind                                                       | Examples                                                                                            |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `main.ts`                | Dialog titles, status, labels, hints                       | "Keyboard shortcuts", "Your profile", "connecting…", "synced", "Menu", "connection status"          |
| `tool-dock.ts`           | Tool names + shortcut hints (`TOOLS`)                      | Select (V), Hand (H), Pen (P), Sticky note (S), Text (T), Rectangle (R), Ellipse (O)                |
| `draw-bar.ts`            | Brush / style / colour names (`COLOR_NAMES`), ARIA, labels | Pen, Highlighter; Solid / Dotted; Black…Pink, White, Custom; "Line style", "Colour", "Stroke width" |
| `zoombar.ts`             | Button labels, input hints                                 | Zoom in / out / to fit, Toggle fullscreen, Zoom percent, "Type a zoom % and press Enter"            |
| `color-picker.ts`        | Input labels                                               | "Pick from screen", "Hex colour", "Eyedropper"                                                      |
| `avatar-presence-row.ts` | Dynamic titles + counters                                  | "{name} (you)", "+{extra}"                                                                          |
| `dialog.ts`              | Button label                                               | "Close" (✕)                                                                                         |

**Clusters:** the keyboard-shortcut grid and profile dialog (`main.ts`), the pen palette (`draw-bar.ts`), and the `TOOLS` array (`tool-dock.ts`). Extracting these into a keyed `en` catalog is the bulk of the work — and it is **mechanical**, not architectural.

---

## 9. Implementation plan (one deliberate pass)

1. **Add the i18n core** (§4.1) in `shared` (or `client-web/src/i18n.ts`) with `en` populated.
2. **Extract strings** — sweep the six files in §8 into `locales/en.json` keyed messages; replace literals in `textContent`/template/attribute sites with `t(key)` or `data-i18n*` tags. Keep `en` as the source of truth.
3. **Add the sweep** (§4.2) and call it once at startup + on `onLocaleChange`.
4. **Wire the dynamic spots** (§4.3) — status, zoom %, presence — with `t()` + `onLocaleChange`.
5. **Canvas/VR chrome text** (§4.4) — subscribe the handful of library-drawn labels.
6. **Add a second locale** (e.g. `es` or pseudo-locale `[Ḷǿřêm…]`) to prove runtime switching and catch hardcoded leftovers; a pseudo-locale also surfaces layout/truncation bugs.
7. **Language picker** in the Menu sheet → `setLocale`; persist to `localStorage` (§7).
8. **(Optional)** swap the hand-rolled core for `@lingui/core` / `i18next` if ICU plurals/extraction tooling are wanted (§6).
9. **Lint guard** — an ESLint rule (e.g. `no-literal-string` / a custom rule) to flag new hardcoded user-facing strings in `client-web`, so the codebase doesn't regress after extraction.

**Effort:** small and mostly mechanical — no architectural change, no new renderer, no framework. The risk is _coverage_ (missing a string), which the pseudo-locale + lint guard mitigate.

---

## 10. Open questions / decisions to ratify

- **Where does the core live** — `shared` (so `vr` reuses it) vs `client-web` only? Recommend `shared`.
- **Hand-rolled vs `@lingui/core`** from day one? Recommend hand-rolled + `Intl`, upgrade later.
- **Which locales ship first**, and is RTL in scope for v1? Recommend `en` + one LTR locale + a pseudo-locale; RTL as a follow-up.
- **Ratify as an ADR?** If adopted, this approach (vanilla i18n core + `data-i18n` sweep, no React) is a good candidate for a short ADR alongside [ADR-0005](./adr/0005-ui-chrome-web-components.md).

---

> _Localization here is extraction + a string table + a 30-line change-notifier — not a framework decision. The surfaces React can't reconcile (Konva, WebXR) stay imperative either way, so the vanilla path is both lighter and a better fit for "one identity, three realities."_
