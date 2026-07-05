// Post-build: turn the single built SPA shell (dist/index.html) into one crawlable, localized page
// per shipped locale — distinct subpath URLs (Google's recommended multilingual model), each with a
// localized <title>/description, hreflang alternates + canonical, Open Graph, SoftwareApplication
// JSON-LD, and a localized intro block the app removes on boot. Also emits sitemap.xml/robots.txt/
// llms.txt so search engines AND LLM crawlers (which read pre-JS HTML) get language-matched content.
// See docs/08. Runs after `vite build`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "../dist");
const SITE = "https://komuboard.app";
const seo = JSON.parse(readFileSync(join(HERE, "../src/seo/seo-content.json"), "utf8"));

// locale → { path: URL subpath ("" = root/en), lang: BCP-47 for <html lang>/hreflang, og: og:locale }
const LOCALES = {
  en: { path: "", lang: "en", og: "en_US" },
  es: { path: "es", lang: "es", og: "es_ES" },
  fr: { path: "fr", lang: "fr", og: "fr_FR" },
  de: { path: "de", lang: "de", og: "de_DE" },
  "pt-BR": { path: "pt-br", lang: "pt-BR", og: "pt_BR" },
  ja: { path: "ja", lang: "ja", og: "ja_JP" },
  zh: { path: "zh", lang: "zh-Hans", og: "zh_CN" },
  ko: { path: "ko", lang: "ko", og: "ko_KR" },
};

const urlFor = (loc) => (LOCALES[loc].path ? `${SITE}/${LOCALES[loc].path}/` : `${SITE}/`);
const escAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function hreflangLinks() {
  const links = Object.keys(LOCALES).map(
    (loc) => `<link rel="alternate" hreflang="${LOCALES[loc].lang}" href="${urlFor(loc)}" />`,
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${SITE}/" />`);
  return links.join("\n    ");
}

function jsonLd(loc) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Komuboard",
    description: seo[loc].description,
    applicationCategory: "DesignApplication",
    operatingSystem: "Web browser, VR",
    inLanguage: LOCALES[loc].lang,
    url: urlFor(loc),
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  });
}

const base = readFileSync(join(DIST, "index.html"), "utf8");

function pageFor(loc) {
  const c = seo[loc];
  const { lang, og } = LOCALES[loc];
  let html = base
    .replace(/<html lang="[^"]*">/, `<html lang="${lang}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escText(c.title)}</title>`);

  const head =
    `<meta name="description" content="${escAttr(c.description)}" />\n` +
    `    <link rel="canonical" href="${urlFor(loc)}" />\n` +
    `    ${hreflangLinks()}\n` +
    `    <meta property="og:type" content="website" />\n` +
    `    <meta property="og:site_name" content="Komuboard" />\n` +
    `    <meta property="og:title" content="${escAttr(c.title)}" />\n` +
    `    <meta property="og:description" content="${escAttr(c.description)}" />\n` +
    `    <meta property="og:url" content="${urlFor(loc)}" />\n` +
    `    <meta property="og:locale" content="${og}" />\n` +
    `    <meta name="twitter:card" content="summary_large_image" />\n` +
    `    <meta name="twitter:title" content="${escAttr(c.title)}" />\n` +
    `    <meta name="twitter:description" content="${escAttr(c.description)}" />\n` +
    `    <script type="application/ld+json">${jsonLd(loc)}</script>\n` +
    `    <script>window.__komuboardLocale=${JSON.stringify(loc)}</script>\n  `;
  html = html.replace("</head>", `  ${head}</head>`);

  // Localized, crawlable intro — visible only until the SPA boots (main.ts removes #seo-intro). Inline
  // styles so it renders as a clean splash before the CSS bundle loads. This is the text LLMs + non-JS
  // crawlers actually index for language-matched queries.
  const intro =
    `<div id="seo-intro" style="position:fixed;inset:0;display:grid;place-items:center;text-align:center;padding:2rem;font-family:system-ui,-apple-system,sans-serif;color:#1f2933;background:#fff">` +
    `<div><h1 style="font-size:1.5rem;margin:0 0 .5rem">Komuboard — ${escText(c.tagline)}</h1>` +
    `<p style="max-width:38rem;margin:0 auto;color:#52606d">${escText(c.about)}</p></div></div>`;
  return html.replace('<div id="app"></div>', `${intro}\n    <div id="app"></div>`);
}

let count = 0;
for (const loc of Object.keys(LOCALES)) {
  const { path } = LOCALES[loc];
  const html = pageFor(loc);
  if (path) {
    mkdirSync(join(DIST, path), { recursive: true });
    writeFileSync(join(DIST, path, "index.html"), html);
  } else {
    writeFileSync(join(DIST, "index.html"), html); // overwrite the built en shell
  }
  count++;
}

// sitemap.xml — every locale URL, cross-linked with hreflang so search engines associate them.
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
  Object.keys(LOCALES)
    .map(
      (loc) =>
        `  <url>\n    <loc>${urlFor(loc)}</loc>\n` +
        Object.keys(LOCALES)
          .map(
            (alt) =>
              `    <xhtml:link rel="alternate" hreflang="${LOCALES[alt].lang}" href="${urlFor(alt)}" />`,
          )
          .join("\n") +
        `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/" />\n  </url>`,
    )
    .join("\n") +
  `\n</urlset>\n`;
writeFileSync(join(DIST, "sitemap.xml"), sitemap);

// robots.txt — allow everyone (LLM crawlers included; discoverability is the goal) + point to sitemap.
writeFileSync(
  join(DIST, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`,
);

// llms.txt — the emerging convention: a concise markdown summary for LLMs, with per-locale pointers.
const llms =
  `# Komuboard\n\n> ${seo.en.description}\n\n${seo.en.about}\n\n` +
  `Free and open. No signup — share a link to collaborate. Available in ${Object.keys(LOCALES)
    .map((l) => LOCALES[l].lang)
    .join(", ")}.\n\n## Localized pages\n` +
  Object.keys(LOCALES)
    .map((loc) => `- [${seo[loc].title}](${urlFor(loc)})`)
    .join("\n") +
  `\n`;
writeFileSync(join(DIST, "llms.txt"), llms);

console.log(`[prerender] ${count} locale pages + sitemap.xml + robots.txt + llms.txt → dist/`);
