// <komu-lang-picker> — the language chooser for the app menu. A native <select> (fully keyboard- +
// screen-reader-accessible for free), its options the endonym of each shipped locale. Selecting one
// calls setLocale, which persists the choice, re-sweeps the DOM, and re-fires the dynamic updaters.

import { getLocale, LOCALE_NAMES, LOCALES, onLocaleChange, setLocale, type Locale } from "../i18n";

export class CoLangPicker extends HTMLElement {
  #wired = false;

  connectedCallback(): void {
    this.classList.add("komu-lang-picker");
    if (this.#wired) return;
    this.#wired = true;
    const id = "komu-lang-select";
    // Same .set-row (label | control column) as the Grid + Theme rows, so it lines up with them.
    this.innerHTML =
      `<div class="set-row">` +
      `<label class="set-label" for="${id}" data-i18n="menu.language">Language</label>` +
      `<select id="${id}" class="lang-select">` +
      LOCALES.map((l) => `<option value="${l}">${LOCALE_NAMES[l]}</option>`).join("") +
      `</select>` +
      `</div>`;
    const sel = this.querySelector<HTMLSelectElement>("select")!;
    sel.value = getLocale();
    sel.addEventListener("change", () => setLocale(sel.value as Locale));
    // Keep the control in sync if the locale is changed elsewhere.
    onLocaleChange(() => {
      if (sel.value !== getLocale()) sel.value = getLocale();
    });
  }
}

if (!customElements.get("komu-lang-picker"))
  customElements.define("komu-lang-picker", CoLangPicker);

declare global {
  interface HTMLElementTagNameMap {
    "komu-lang-picker": CoLangPicker;
  }
}
