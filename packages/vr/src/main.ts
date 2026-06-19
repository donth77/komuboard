import { roomIdFromUrl } from "@coboard/shared";

/**
 * Coboard VR entry — M0 placeholder.
 *
 * M4 builds this out into the A-Frame + Three.js WebXR renderer that shows the
 * infinite canvas through a finite, movable/zoomable board panel (the viewport
 * window), bound to the SAME Yjs document + awareness as the 2D client. See
 * docs/04 §6.5 (viewport-window model) and docs/06 M4.
 */
const room = roomIdFromUrl(new URL(window.location.href));
console.info(`[coboard/vr] placeholder scene for room "${room}" — built out in M4`);

export {};
