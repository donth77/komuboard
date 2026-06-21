#!/usr/bin/env bash
# Populate packages/client-web/public/emoji/ with the full Noto emoji SVG set (git-ignored — kept out
# of the repo to avoid committing ~3,700 files; fetched once for offline use). Idempotent.
#
#   bash scripts/fetch-emoji.sh   # run from packages/client-web
#
# Source: googlefonts/noto-emoji (svg/ only, blobless sparse clone). Files are renamed from
# emoji_u<cp>.svg → <cp>.svg so the app can resolve /emoji/<codepoint>.svg directly.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$here/public/emoji"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Cloning googlefonts/noto-emoji (svg/ only)…"
git clone --depth 1 --filter=blob:none --sparse https://github.com/googlefonts/noto-emoji.git "$tmp/noto" >/dev/null 2>&1
git -C "$tmp/noto" sparse-checkout set svg >/dev/null 2>&1

mkdir -p "$dest"
n=0
for f in "$tmp/noto/svg/"emoji_u*.svg; do
  b="$(basename "$f")"
  cp "$f" "$dest/${b#emoji_u}"
  n=$((n + 1))
done
echo "Wrote $n emoji SVGs to $dest"
