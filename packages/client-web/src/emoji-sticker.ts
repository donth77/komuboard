// Shared "emoji → white-outlined sticker" renderer. The raw Noto emoji has no border; here we build a
// white silhouette and stamp it around a ring of offsets (a uniform outline), then the emoji on top —
// so an emoji reads like the colour mark stickers both in the wheel (<img src=dataURL>) and, via
// canvas.ts, on the board. Results are cached per codepoint (and it's far cheaper than a 9-pass CSS
// drop-shadow filter, which re-rasterised on every repaint and tanked the wheel).
const cache = new Map<string, string>(); // codepoint → outlined PNG data URL
const pending = new Map<string, Promise<string>>();

function render(img: HTMLImageElement): string {
  const S = 120;
  const pad = 7;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S + pad * 2;
  const ctx = cv.getContext("2d");
  if (!ctx) return "";
  const sil = document.createElement("canvas");
  sil.width = sil.height = S;
  const sctx = sil.getContext("2d");
  if (sctx) {
    sctx.drawImage(img, 0, 0, S, S);
    sctx.globalCompositeOperation = "source-in"; // keep only the emoji's alpha, fill it white
    sctx.fillStyle = "#ffffff";
    sctx.fillRect(0, 0, S, S);
  }
  const t = 3.5; // outline thickness
  for (let a = 0; a < Math.PI * 2 - 0.01; a += Math.PI / 8) {
    ctx.drawImage(sil, pad + Math.cos(a) * t, pad + Math.sin(a) * t, S, S);
  }
  ctx.drawImage(img, pad, pad, S, S);
  return cv.toDataURL("image/png");
}

/** Outlined-sticker PNG data URL for an emoji codepoint (cached). Falls back to the raw svg on error. */
export function emojiStickerUrl(cp: string): Promise<string> {
  const hit = cache.get(cp);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(cp);
  if (inflight) return inflight;
  const p = new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const url = render(img) || `/emoji/${cp}.svg`;
      cache.set(cp, url);
      resolve(url);
    };
    img.onerror = () => resolve(`/emoji/${cp}.svg`);
    img.src = `/emoji/${cp}.svg`;
  });
  pending.set(cp, p);
  return p;
}

/** The already-generated outlined sticker, if any (synchronous — for instant first paint). */
export function cachedEmojiSticker(cp: string): string | null {
  return cache.get(cp) ?? null;
}
