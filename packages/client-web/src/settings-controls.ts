// Shared settings controls — the Grid style (dots/lines) segmented control and the
// two-way Theme switch (sun ↔ moon). Rendered in two places: the desktop gear → Settings
// dialog, and the mobile drawer. Everything is light DOM, so main.ts keeps every rendered
// instance in step with one delegated click handler + syncSettingsControls() — no
// per-instance wiring, no IDs (which would collide across the two copies).

import { icon } from "./icons";

/** Markup for the settings rows (Grid + Theme). Wired by delegation in main.ts. */
export function settingsControlsHTML(): string {
  return (
    '<div class="set-row">' +
    '<span class="set-label" data-i18n="settings.grid"></span>' +
    '<div class="seg" role="group" data-i18n-aria="settings.gridStyle">' +
    '<button class="seg-opt" type="button" data-grid-opt="dots" data-i18n="settings.dots"></button>' +
    '<button class="seg-opt" type="button" data-grid-opt="lines" data-i18n="settings.lines"></button>' +
    "</div>" +
    "</div>" +
    '<div class="set-row">' +
    '<span class="set-label" data-i18n="settings.theme"></span>' +
    '<button class="theme-switch" type="button" role="switch" data-theme-toggle data-i18n-aria="settings.darkTheme">' +
    `<span class="theme-switch-ic sun">${icon("sun")}</span>` +
    `<span class="theme-switch-ic moon">${icon("moon")}</span>` +
    '<span class="theme-switch-knob"></span>' +
    "</button>" +
    "</div>"
  );
}

/** Reflect the current state across every rendered settings instance (dialog + drawer). */
export function syncSettingsControls(theme: "light" | "dark", grid: "dots" | "lines"): void {
  document.querySelectorAll<HTMLElement>("[data-grid-opt]").forEach((b) => {
    const on = b.dataset.gridOpt === grid;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll<HTMLElement>("[data-theme-toggle]").forEach((b) => {
    b.dataset.theme = theme; // drives the knob position + active-icon highlight (CSS)
    b.setAttribute("aria-checked", String(theme === "dark"));
  });
}
