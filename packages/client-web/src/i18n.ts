// Framework-free i18n core (see docs/08). A keyed string table per locale, a `t()` lookup, a DOM
// `data-i18n` sweep for static strings, and a tiny locale-change pub/sub for the dynamic ones — no
// UI framework (the surfaces React couldn't reconcile — Konva, WebXR — are imperative either way).

import de from "./locales/de";
import en from "./locales/en";
import es from "./locales/es";
import fr from "./locales/fr";
import ja from "./locales/ja";
import ko from "./locales/ko";
import ptBR from "./locales/pt-BR";
import zh from "./locales/zh";

export type Dict = Record<string, string>;

/** Shipped UI locales. Regional browser variants collapse onto these (resolveLocale). */
export const LOCALES = ["en", "es", "fr", "de", "pt-BR", "ja", "zh", "ko"] as const;
export type Locale = (typeof LOCALES)[number];

const tables: Record<Locale, Dict> = { en, es, fr, de, "pt-BR": ptBR, ja, zh, ko };

/** Endonyms for the language picker — each language named in its own language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  "pt-BR": "Português",
  ja: "日本語",
  zh: "中文",
  ko: "한국어",
};

/** BCP-47 tag for `<html lang>` + hreflang (zh ships Simplified → zh-Hans). */
export const LOCALE_LANG: Record<Locale, string> = {
  en: "en",
  es: "es",
  fr: "fr",
  de: "de",
  "pt-BR": "pt-BR",
  ja: "ja",
  zh: "zh-Hans",
  ko: "ko",
};

const STORAGE_KEY = "komuboard-locale";
let current: Locale = "en";
const listeners = new Set<() => void>();

/** Collapse any BCP-47 browser tag onto a shipped locale by its PRIMARY subtag — every `zh-*` (CN/TW/
 *  HK/Hans/Hant) → zh, every `es-*` → es, every `pt-*` → pt-BR, etc. null if the language isn't shipped. */
export function resolveLocale(tag: string): Locale | null {
  const primary = tag.toLowerCase().split("-")[0];
  switch (primary) {
    case "en":
      return "en";
    case "es":
      return "es";
    case "fr":
      return "fr";
    case "de":
      return "de";
    case "pt":
      return "pt-BR";
    case "ja":
      return "ja";
    case "zh":
      return "zh";
    case "ko":
      return "ko";
    default:
      return null;
  }
}

/** Locale for this load: a stored manual choice if still shipped, else the first browser language that
 *  maps to a shipped locale, else English. */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale;
  } catch {
    /* localStorage blocked (private mode) → fall through to browser languages */
  }
  // A prerendered per-locale page (/es/, /ja/, …) injects its locale — honor it over browser
  // detection so a deep SEO link boots in that language even for a differently-configured browser.
  const injected = (globalThis as { __komuboardLocale?: string }).__komuboardLocale;
  if (injected && (LOCALES as readonly string[]).includes(injected)) return injected as Locale;

  const langs =
    typeof navigator !== "undefined"
      ? (navigator.languages?.length ? navigator.languages : [navigator.language]).filter(Boolean)
      : [];
  for (const tag of langs) {
    const m = resolveLocale(tag);
    if (m) return m;
  }
  return "en";
}

export function getLocale(): Locale {
  return current;
}

/** Look up a key in the active locale, falling back to English, then the key itself. Supports
 *  `{name}`-style params for interpolated strings. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = tables[current][key] ?? tables.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Plural-aware lookup: selects `key.<category>` (one / other / few / many …) via the locale's
 *  Intl.PluralRules, then interpolates (count is always available as `{count}`). */
export function tc(key: string, count: number, params?: Record<string, string | number>): string {
  const cat = new Intl.PluralRules(LOCALE_LANG[current]).select(count);
  const table = tables[current];
  const template =
    table[`${key}.${cat}`] ??
    table[`${key}.other`] ??
    tables.en[`${key}.${cat}`] ??
    tables.en[`${key}.other`] ??
    key;
  let s = template;
  for (const [k, v] of Object.entries({ count, ...params })) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Subscribe to locale changes; returns an unsubscribe fn. Dynamic/interpolated strings register here
 *  so they re-render on a language switch (the one slice a UI framework would otherwise own). */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Rewrite text + attributes on every tagged element. Static (no-param) strings only; interpolated
 *  ones call t() at their update site and subscribe via onLocaleChange. */
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
  root.querySelectorAll<HTMLElement>("[data-i18n-tip]").forEach((el) => {
    el.setAttribute("data-tip", t(el.dataset.i18nTip!));
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  });
}

/** Switch locale at runtime: persist the choice, update `<html lang>`, re-run the DOM sweep, and
 *  notify subscribers (status line, canvas hints, VR labels, …). */
export function setLocale(next: Locale, persist = true): void {
  current = next;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }
  if (typeof document !== "undefined") document.documentElement.lang = LOCALE_LANG[next];
  applyTranslations();
  listeners.forEach((fn) => fn());
}

/** Call once at startup: apply the detected locale WITHOUT persisting it (auto-detection isn't a
 *  deliberate user choice — only the picker persists). */
export function initI18n(): void {
  setLocale(detectLocale(), false);
}
