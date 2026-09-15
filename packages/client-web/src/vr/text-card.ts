// Text on a rounded dark card, as an SVG data-URL texture for an <a-image>. System fonts, so every
// locale's script renders (A-Frame's bundled MSDF text font is Latin-only) — the controller help
// card and the loading label both use it.

export interface TextCard {
  url: string;
  /** height / width — size the <a-image> from one dimension. */
  aspect: number;
}

export function textCard(
  lines: string[],
  opts: { align?: "left" | "center"; fontSize?: number; width?: number } = {},
): TextCard {
  const align = opts.align ?? "left";
  const fontSize = opts.fontSize ?? 26;
  // Texture width in px; with the <a-image> width fixed in metres, a narrower texture makes the
  // same font size come out LARGER in the scene (fontSize / width × metres).
  const W = opts.width ?? 720;
  const LH = Math.round(fontSize * 1.7);
  const PAD = 22;
  const H = PAD * 2 + lines.length * LH;
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const x = align === "center" ? W / 2 : PAD;
  const anchor = align === "center" ? ' text-anchor="middle"' : "";
  const text = lines
    .map(
      (l, i) => `<text x="${x}" y="${(PAD + (i + 0.7) * LH).toFixed(1)}"${anchor}>${esc(l)}</text>`,
    )
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="22" fill="#10151c" fill-opacity="0.86"/>` +
    `<g font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="${fontSize}" fill="#e7ecf3">${text}</g></svg>`;
  return { url: `data:image/svg+xml,${encodeURIComponent(svg)}`, aspect: H / W };
}
