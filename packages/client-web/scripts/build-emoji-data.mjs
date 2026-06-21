// Generates src/emoji-data.json (the stamp tool's emoji picker index) from unicode-emoji-json's
// grouped data, keyed to the locally-fetched Noto SVGs (public/emoji/<codepoint>.svg). Only emojis
// whose Noto SVG actually exists are kept, so the picker never shows a broken tile.
//
//   1. scripts/fetch-emoji.sh   → populates public/emoji/ (the Noto SVGs, git-ignored)
//   2. node scripts/build-emoji-data.mjs → writes src/emoji-data.json (committed)
//
// Run from packages/client-web. Needs Node 18+ (global fetch).
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const emojiDir = join(root, "public", "emoji");
const out = join(root, "src", "emoji-data.json");

if (!existsSync(emojiDir)) {
  console.error(`Missing ${emojiDir}. Run scripts/fetch-emoji.sh first.`);
  process.exit(1);
}

/** Noto names a file by its codepoints (lowercase hex, joined by "_"), dropping the FE0F variation
 *  selector — e.g. ❤️ (2764 FE0F) → "2764", #️⃣ (0023 FE0F 20E3) → "0023_20e3". */
function notoStem(emoji) {
  return [...emoji]
    .map((c) => c.codePointAt(0))
    .filter((cp) => cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join("_");
}

const have = new Set(readdirSync(emojiDir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)));

const SRC = "https://cdn.jsdelivr.net/npm/unicode-emoji-json@latest/data-by-group.json";
const groups = await fetch(SRC).then((r) => r.json());

let kept = 0,
  dropped = 0;
const result = groups.map((g) => ({
  name: g.name,
  emojis: g.emojis
    .map((e) => ({ c: e.emoji, u: notoStem(e.emoji), n: e.name }))
    .filter((e) => {
      const ok = have.has(e.u);
      ok ? kept++ : dropped++;
      return ok;
    }),
}));

writeFileSync(out, JSON.stringify(result));
console.log(`Wrote ${out}: ${kept} emojis kept across ${result.length} groups (${dropped} without a Noto SVG).`);
