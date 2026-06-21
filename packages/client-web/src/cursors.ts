// Single source for the per-corner "rotate" cursor (a curved double-arrow), shared by EVERY node so
// they all rotate with the same affordance: the HTML text/sticky/shape boxes (text-layer) AND the
// Konva strokes/stamps (canvas). Previously the HTML boxes had this in CSS and the canvas used a
// different circular-arrow cursor — they're unified here. Hotspot centred (12 12); falls back to a
// crosshair. The SVG is rotated per corner so the arrows point "around" that corner.
export type RotateCorner = "nw" | "ne" | "sw" | "se";

const DEG: Record<RotateCorner, number> = { nw: -45, ne: 45, sw: -135, se: 135 };

function rotateCursor(deg: number): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' ` +
    `stroke-linecap='round' stroke-linejoin='round'><g transform='rotate(${deg} 12 12)'>` +
    `<path d='M6 13 Q12 6.5 18 13' fill='none' stroke='white' stroke-width='5'/>` +
    `<path d='M2.88 16.38 L3.72 10.9 L8.28 15.1 Z' fill='white' stroke='white' stroke-width='2.5'/>` +
    `<path d='M21.12 16.38 L15.72 15.1 L20.28 10.9 Z' fill='white' stroke='white' stroke-width='2.5'/>` +
    `<path d='M6 13 Q12 6.5 18 13' fill='none' stroke='%231e1e1e' stroke-width='2.2'/>` +
    `<path d='M2.88 16.38 L3.72 10.9 L8.28 15.1 Z' fill='%231e1e1e'/>` +
    `<path d='M21.12 16.38 L15.72 15.1 L20.28 10.9 Z' fill='%231e1e1e'/></g></svg>`;
  return `url("data:image/svg+xml,${svg}") 12 12, crosshair`;
}

export const ROTATE_CURSORS: Record<RotateCorner, string> = {
  nw: rotateCursor(DEG.nw),
  ne: rotateCursor(DEG.ne),
  sw: rotateCursor(DEG.sw),
  se: rotateCursor(DEG.se),
};
