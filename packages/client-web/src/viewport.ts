import Konva from "konva";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const GRID = 24; // dot-grid spacing in world units

/**
 * ViewportController — owns the board *camera*: the Konva stage's scale + position
 * (pan/zoom), wheel-zoom, hand-pan grid tracking, the dot-grid background sync, and
 * the zoom-readout plumbing. It deliberately does NOT touch content or interaction —
 * BoardCanvas supplies an `onTransform` callback so its viewport-dependent chrome
 * (cursors, transform box, selection outlines) re-syncs after any camera change.
 *
 * The stage is created and shared by BoardCanvas; this controller only mutates its
 * transform. The single source of truth for "screen px ↔ world units at this zoom" is
 * `screenPx()`, replacing the `1 / stage.scaleX()` idiom that used to be scattered around.
 */
export class ViewportController {
  private zoomListener: ((pct: number) => void) | null = null;

  constructor(
    private readonly stage: Konva.Stage,
    private readonly container: HTMLElement,
    /** Re-sync viewport-dependent chrome owned by BoardCanvas (cursors, transformer, outlines). */
    private readonly onTransform: () => void,
  ) {
    this.bindWheel();
    this.stage.on("dragmove", () => this.syncGrid()); // hand-pan: keep the grid under the camera
    this.syncGrid();
  }

  /** Current uniform zoom (1 = 100%). */
  scale(): number {
    return this.stage.scaleX();
  }
  /** A screen-pixel length expressed in world units at the current zoom (the old `1/scale` idiom). */
  screenPx(n: number): number {
    return n / this.stage.scaleX();
  }
  getZoomPercent(): number {
    return Math.round(this.stage.scaleX() * 100);
  }
  setZoomListener(cb: (pct: number) => void): void {
    this.zoomListener = cb;
    this.notifyZoom();
  }
  /** Clamp a raw scale into the supported zoom range. */
  clamp(scale: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  }

  zoomBy(factor: number): void {
    this.zoomAroundCenter(this.clamp(this.stage.scaleX() * factor));
  }
  resetZoom(): void {
    this.zoomAroundCenter(0.5); // default zoom: 50%
  }
  /** Set an absolute zoom (1 = 100%), clamped to the supported range. */
  zoomTo(scale: number): void {
    this.zoomAroundCenter(this.clamp(scale));
  }
  /** Frame a world-space box in view (or reset when the box is empty). */
  zoomToFitBox(box: { x: number; y: number; width: number; height: number }): void {
    if (!box.width || !box.height) {
      this.resetZoom();
      return;
    }
    const pad = 96;
    const sw = this.stage.width();
    const sh = this.stage.height();
    const scale = this.clamp(Math.min((sw - pad) / box.width, (sh - pad) / box.height));
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({
      x: (sw - box.width * scale) / 2 - box.x * scale,
      y: (sh - box.height * scale) / 2 - box.y * scale,
    });
    this.afterTransform();
  }

  /** Low-level: set the camera transform directly (used by pinch), then re-sync. */
  applyTransform(scale: number, position: { x: number; y: number }): void {
    this.stage.scale({ x: scale, y: scale });
    this.stage.position(position);
    this.afterTransform();
  }

  /** Resize the stage to the container (called from BoardCanvas's ResizeObserver). */
  resize(): void {
    this.stage.size({ width: this.container.clientWidth, height: this.container.clientHeight });
  }

  /** Keep the CSS dot grid locked to the camera (pans + scales with zoom). */
  syncGrid(): void {
    const size = GRID * this.stage.scaleX();
    this.container.style.backgroundSize = `${size}px ${size}px`;
    this.container.style.backgroundPosition = `${this.stage.x()}px ${this.stage.y()}px`;
  }

  private notifyZoom(): void {
    this.zoomListener?.(this.getZoomPercent());
  }

  private afterTransform(): void {
    this.onTransform(); // BoardCanvas re-syncs cursors / transform box / selection outlines
    this.syncGrid();
    this.stage.batchDraw();
    this.notifyZoom();
  }

  private zoomAroundCenter(newScale: number): void {
    const old = this.stage.scaleX();
    const cx = this.stage.width() / 2;
    const cy = this.stage.height() / 2;
    const origin = { x: (cx - this.stage.x()) / old, y: (cy - this.stage.y()) / old };
    this.stage.scale({ x: newScale, y: newScale });
    this.stage.position({ x: cx - origin.x * newScale, y: cy - origin.y * newScale });
    this.afterTransform();
  }

  private bindWheel(): void {
    this.stage.on("wheel", (e) => {
      e.evt.preventDefault();
      const oldScale = this.stage.scaleX();
      const pointer = this.stage.getPointerPosition();
      if (!pointer) return;
      const origin = {
        x: (pointer.x - this.stage.x()) / oldScale,
        y: (pointer.y - this.stage.y()) / oldScale,
      };
      const newScale = this.clamp(e.evt.deltaY > 0 ? oldScale / 1.08 : oldScale * 1.08);
      this.stage.scale({ x: newScale, y: newScale });
      this.stage.position({
        x: pointer.x - origin.x * newScale,
        y: pointer.y - origin.y * newScale,
      });
      this.afterTransform();
    });
  }
}
