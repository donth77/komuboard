// The panel's viewport window (docs/04): the board shows a movable, zoomable world rect. Pure math —
// callers own the rect and re-render on change. The rect's aspect always matches the panel's, so
// every operation preserves it.

import type { WorldRect } from "./board-raster";

/** Zoom bounds expressed as the rect's world WIDTH (small = zoomed in). */
const MIN_W = 240;
const MAX_W = 40000;

/** Expand `r` (centred) to `aspect` so the texture isn't distorted. */
export function fitAspect(r: WorldRect, aspect: number): WorldRect {
  let { width, height } = r;
  if (width / height > aspect) height = width / aspect;
  else width = height * aspect;
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
}

export function pan(r: WorldRect, dx: number, dy: number): WorldRect {
  return { ...r, x: r.x + dx, y: r.y + dy };
}

/** Zoom by `factor` about the panel point `(u, v01)` (v01 = 0 at the TOP, like the texture), so the
 *  world point under the pointer stays under it. factor < 1 zooms in. */
export function zoomAt(r: WorldRect, u: number, v01: number, factor: number): WorldRect {
  const w = Math.min(MAX_W, Math.max(MIN_W, r.width * factor));
  const f = w / r.width;
  const h = r.height * f;
  const wx = r.x + u * r.width;
  const wy = r.y + v01 * r.height;
  return { x: wx - u * w, y: wy - v01 * h, width: w, height: h };
}

/** Frame `bounds` (padded) at the panel's aspect; falls back to a 100%-ish default view. */
export function zoomToFit(bounds: WorldRect | null, aspect: number): WorldRect {
  if (!bounds || !bounds.width || !bounds.height) {
    return fitAspect({ x: -640, y: -384, width: 1280, height: 768 }, aspect);
  }
  const pad = Math.max(48, Math.max(bounds.width, bounds.height) * 0.06);
  const r = fitAspect(
    {
      x: bounds.x - pad,
      y: bounds.y - pad,
      width: bounds.width + 2 * pad,
      height: bounds.height + 2 * pad,
    },
    aspect,
  );
  if (r.width < MIN_W) return zoomAt(r, 0.5, 0.5, MIN_W / r.width);
  return r;
}
