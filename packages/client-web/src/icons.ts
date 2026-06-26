// Lucide-style inline SVG icons, shared across the chrome (main shell +
// <komu-*> components). Kept framework-free: `icon(name)` returns an SVG string
// that inherits color via `currentColor`, so it themes with the surrounding CSS.

export const ICONS: Record<string, string> = {
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  select:
    '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 8 8a8 8 0 0 0 8-8v-3a2 2 0 0 0-4 0"/>',
  pen: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  eraser:
    '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  stamp:
    '<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-3-3 3 3 0 0 0-3 3c0 2 1 2 1 3.5V13"/>',
  highlighter:
    '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  lineSolid: '<path d="M4 12h16"/>',
  lineDotted: '<path d="M4 12h16" stroke-dasharray="1.5 3.5"/>',
  weight: '<path d="M4 7h16M6 12h12M8 17h8"/>',
  sticky:
    '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  rect: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  ellipse: '<circle cx="12" cy="12" r="9"/>',
  // "Shapes and lines" tool: a 2×2 cluster — square, circle, triangle, diagonal arrow.
  shapes:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="1.2"/><circle cx="17.5" cy="6.8" r="3.7"/><path d="M6.8 13.5 3 20.5h7.5z"/><path d="M13.5 20.5 20 14M14.5 14H20v5.5"/>',
  fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  // Share — three connected nodes (Lucide share-2).
  share:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  // Duplicate (Lucide copy) — overlapping rounded squares.
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  // Delete (Lucide trash-2).
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  // Lock / unlock (Lucide lock / lock-open).
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock:
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  // Group / ungroup (Lucide group / ungroup).
  group:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect width="7" height="5" x="7" y="7" rx="1"/><rect width="7" height="5" x="10" y="12" rx="1"/>',
  ungroup:
    '<rect width="8" height="6" x="5" y="4" rx="1"/><rect width="8" height="6" x="11" y="14" rx="1"/>',
  // Rotate (Lucide rotate-cw).
  rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
};

export function icon(name: string, cls = "ico"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;
}

// Filled silhouette icons (rendered with `fill`, not stroke) — e.g. imported Flaticon UIcons
// glyphs that ship as solid shapes rather than outlines.
export const FILLED_ICONS: Record<string, string> = {
  // Flaticon "pen-clip" (UIcons) — a freehand ballpoint pen, distinct from the dock's fountain
  // nib (`pen`). Source SVG kept at src/assets/pen-clip.svg. Flaticon free license → attribution.
  penClip:
    '<path d="M24,3.46c-.05-1.03-.54-1.99-1.34-2.64-1.43-1.17-3.61-1.01-4.98,.36l-1.67,1.67c-.81-.54-1.77-.84-2.77-.84-1.34,0-2.59,.52-3.54,1.46l-3.03,3.03c-.39,.39-.39,1.02,0,1.41s1.02,.39,1.41,0l3.03-3.03c.89-.89,2.3-1.08,3.42-.57L2.07,16.79c-.69,.69-1.07,1.6-1.07,2.57,0,.63,.16,1.23,.46,1.77l-1.16,1.16c-.39,.39-.39,1.02,0,1.41,.2,.2,.45,.29,.71,.29s.51-.1,.71-.29l1.16-1.16c.53,.3,1.14,.46,1.77,.46,.97,0,1.89-.38,2.57-1.07L22.93,6.21c.73-.73,1.11-1.73,1.06-2.76ZM5.8,20.52c-.62,.62-1.7,.62-2.32,0-.31-.31-.48-.72-.48-1.16s.17-.85,.48-1.16L16.08,5.61l2.32,2.32L5.8,20.52ZM21.52,4.8l-1.71,1.71-2.32-2.32,1.6-1.6c.37-.37,.85-.56,1.32-.56,.36,0,.7,.11,.98,.34,.37,.3,.58,.72,.61,1.19,.02,.46-.15,.92-.48,1.24Z"/>',
};

// Render a filled silhouette icon (fill = currentColor) instead of the default stroke style.
export function iconFilled(name: string, cls = "ico"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor">${FILLED_ICONS[name] ?? ""}</svg>`;
}

// Line-weight icon (three stacked bars of increasing thickness) — used for the draw stroke width
// AND the shape border-style control. Filled, native 128 viewBox (source: src/assets/line.svg).
const LINE_WEIGHT_PATH =
  "M16.94 25.09c0-1.55 1.25-2.8 2.8-2.8h90.4c1.55 0 2.8 1.25 2.8 2.8v4.4c0 1.55-1.25 2.8-2.8 2.8H19.74c-1.55 0-2.8-1.25-2.8-2.8v-4.4ZM16.94 50.55c0-1.55 1.25-2.8 2.8-2.8h90.4c1.55 0 2.8 1.25 2.8 2.8v10.4c0 1.55-1.25 2.8-2.8 2.8H19.74c-1.55 0-2.8-1.25-2.8-2.8v-10.4ZM16.94 82.02c0-1.55 1.25-2.8 2.8-2.8h90.4c1.55 0 2.8 1.25 2.8 2.8v22.4c0 1.55-1.25 2.8-2.8 2.8H19.74c-1.55 0-2.8-1.25-2.8-2.8v-22.4Z";
export function lineWeightIcon(cls = "ico"): string {
  return `<svg class="${cls}" viewBox="0 0 128 128" fill="currentColor"><path fill-rule="evenodd" d="${LINE_WEIGHT_PATH}"/></svg>`;
}

// Bring-to-front / send-to-back — filled glyphs from the design assets (overlapping squares, the
// active one solid). Native viewBoxes; sources: src/assets/{bring-to-front,send-to-back}.svg.
const BRING_FRONT_PATH =
  "M 6 4 C 4.895 4 4 4.895 4 6 L 4 12 C 4 13.105 4.895 14 6 14 L 8 14 L 8 20 C 8 21.093063 8.9069372 22 10 22 L 16 22 L 16 24 C 16 25.105 16.895 26 18 26 L 24 26 C 25.105 26 26 25.105 26 24 L 26 18 C 26 16.895 25.105 16 24 16 L 22 16 L 22 10 C 22 8.9069372 21.093063 8 20 8 L 14 8 L 14 6 C 14 4.895 13.105 4 12 4 L 6 4 z M 10 10 L 20 10 L 20 20 L 10 20 L 10 10 z";
export function bringFrontIcon(cls = "ico"): string {
  return `<svg class="${cls}" viewBox="0 0 30 30" fill="currentColor"><path d="${BRING_FRONT_PATH}"/></svg>`;
}
const SEND_BACK_PATH =
  "M 5 2 C 3.347656 2 2 3.347656 2 5 L 2 21 C 2 22.652344 3.347656 24 5 24 L 12 24 L 12 35 C 12 36.644531 13.355469 38 15 38 L 26 38 L 26 45 C 26 46.652344 27.347656 48 29 48 L 45 48 C 46.652344 48 48 46.652344 48 45 L 48 29 C 48 27.347656 46.652344 26 45 26 L 38 26 L 38 15 C 38 13.355469 36.644531 12 35 12 L 24 12 L 24 5 C 24 3.347656 22.652344 2 21 2 Z M 24 14 L 35 14 C 35.566406 14 36 14.433594 36 15 L 36 26 L 29 26 C 27.347656 26 26 27.347656 26 29 L 26 36 L 15 36 C 14.433594 36 14 35.566406 14 35 L 14 24 L 21 24 C 22.652344 24 24 22.652344 24 21 Z";
export function sendBackIcon(cls = "ico"): string {
  return `<svg class="${cls}" viewBox="0 0 50 50" fill="currentColor"><path d="${SEND_BACK_PATH}"/></svg>`;
}
