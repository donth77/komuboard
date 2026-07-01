import Konva from "konva";

const MIN_ZOOM = 0.01; // 1% — the first ZOOM_STOPS rung
const MAX_ZOOM = 5; // 500% — the last ZOOM_STOPS rung
const GRID = 24; // world units between the finest dots at 100% zoom
const GRID_TARGET_PX = 24; // ideal on-screen dot spacing; the LOD steps keep the grid near this
// Discrete zoom rungs (percent) the +/- buttons snap through.
const ZOOM_STOPS = [1, 5, 10, 15, 20, 33, 50, 75, 100, 125, 150, 200, 250, 300, 350, 400, 450, 500];
// One MediaQueryList, read per zoom-step (cheaper than constructing one each click).
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

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
  // Last-applied dot-grid LOD values, so a pan (position-only change) skips the
  // gradient-size/opacity writes and only nudges background-position.
  private gridFine = -1;
  private gridFade = -1;
  // In-flight smooth zoom-step animation: rAF handle + destination scale.
  private zoomAnim: number | null = null;
  private zoomTarget: number | null = null;
  // Coalesces the downstream camera sync (chrome + text relayout + grid + Konva draw) to once per
  // animation frame. Wheel/pointer events fire far faster than frames (hundreds/s on a trackpad),
  // and the sync work is O(mounted objects) — running it per EVENT multiplied frame cost by the
  // event rate and froze dense boards. The stage transform itself stays synchronous per event (so
  // gesture math always reads fresh values); only the visual re-sync is deferred, and everything
  // it drives (Konva draw, CSS grid, DOM boxes) updates atomically in the same frame.
  private syncScheduled = false;

  // Debounced persistence of the camera (pan/zoom), keyed by storageKey, so a reload restores
  // exactly where the user was instead of resetting + auto-fitting.
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly stage: Konva.Stage,
    private readonly container: HTMLElement,
    /** Re-sync viewport-dependent chrome owned by BoardCanvas (cursors, transformer, outlines). */
    private readonly onTransform: () => void,
    /** localStorage key to persist this board's camera across reloads; omitted = no persistence. */
    private readonly storageKey?: string,
  ) {
    this.bindWheel();
    this.stage.on("dragmove", () => {
      this.scheduleSync(); // hand-pan: keep the grid + chrome + text under the camera (per frame)
      this.scheduleSave();
    });
    this.syncGrid();
  }

  /** Run the full downstream camera sync at most once per animation frame (see syncScheduled). */
  scheduleSync(): void {
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    requestAnimationFrame(() => {
      this.syncScheduled = false;
      this.onTransform(); // BoardCanvas re-syncs cursors / transform box / selection outlines
      this.syncGrid();
      this.stage.batchDraw();
      this.notifyZoom();
    });
  }

  /** Current uniform zoom (1 = 100%). */
  scale(): number {
    return this.stage.scaleX();
  }
  /** A screen-pixel length expressed in world units at the current zoom (the old `1/scale` idiom). */
  screenPx(n: number): number {
    return n / this.stage.scaleX();
  }
  /** The on-screen viewport mapped into world coords (used for viewport culling). */
  worldViewport(): { x: number; y: number; width: number; height: number } {
    const s = this.stage.scaleX();
    return {
      x: -this.stage.x() / s,
      y: -this.stage.y() / s,
      width: this.stage.width() / s,
      height: this.stage.height() / s,
    };
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
  /** Snap zoom to the next discrete rung — dir > 0 = in, dir < 0 = out (ZOOM_STOPS),
      tweened so it glides like a scroll-wheel landing exactly on the value. */
  zoomStep(dir: number): void {
    // Step from the pending animation target (if any) so rapid clicks chain rung-by-rung.
    const pct = (this.zoomTarget ?? this.stage.scaleX()) * 100;
    const max = ZOOM_STOPS[ZOOM_STOPS.length - 1] ?? 500;
    const min = ZOOM_STOPS[0] ?? 1;
    const next =
      dir > 0
        ? (ZOOM_STOPS.find((s) => s > pct + 0.5) ?? max)
        : ([...ZOOM_STOPS].reverse().find((s) => s < pct - 0.5) ?? min);
    this.animateZoomToCenter(next / 100);
  }

  /** Stop any in-flight zoom-step animation (other zoom gestures call this to take over). */
  stopZoomAnim(): void {
    if (this.zoomAnim !== null) cancelAnimationFrame(this.zoomAnim);
    this.zoomAnim = null;
    this.zoomTarget = null;
  }

  /** Tween the zoom to `target` (scale) about the viewport centre — a wheel-like glide
      that lands exactly on the value. Cancellable; instant under reduced-motion. */
  private animateZoomToCenter(target: number): void {
    this.stopZoomAnim();
    const start = this.stage.scaleX();
    if (REDUCED_MOTION.matches || Math.abs(target - start) < 1e-4) {
      this.zoomAroundCenter(target);
      return;
    }
    this.zoomTarget = target;
    const t0 = performance.now();
    const DUR = 180;
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3); // ease-out cubic
    const tick = (now: number): void => {
      const t = Math.min(1, (now - t0) / DUR);
      // geometric (log-space) interpolation → perceptually even zoom
      this.zoomAroundCenter(start * Math.pow(target / start, ease(t)));
      if (t < 1) {
        this.zoomAnim = requestAnimationFrame(tick);
      } else {
        this.zoomAnim = null;
        this.zoomTarget = null;
      }
    };
    this.zoomAnim = requestAnimationFrame(tick);
  }
  resetZoom(): void {
    // Reset to the initial view: 100% zoom AND recenter the canvas (world origin at
    // the viewport center) — returns to exactly where the board opened.
    this.applyTransform(1, { x: this.stage.width() / 2, y: this.stage.height() / 2 });
  }
  /** Set an absolute zoom (1 = 100%), clamped to the supported range. */
  zoomTo(scale: number): void {
    this.stopZoomAnim();
    this.zoomAroundCenter(this.clamp(scale));
  }
  /** Frame a world-space box in view (or reset when the box is empty). `maxScale` caps how far it
   *  may zoom IN — the on-load auto-fit passes 1 (100%) so a small/sparse board lands at natural
   *  size + centred rather than slamming to the 500% zoom cap. */
  zoomToFitBox(
    box: { x: number; y: number; width: number; height: number },
    maxScale = MAX_ZOOM,
  ): void {
    if (!box.width || !box.height) {
      this.resetZoom();
      return;
    }
    const pad = 96;
    const sw = this.stage.width();
    const sh = this.stage.height();
    const fit = Math.min((sw - pad) / box.width, (sh - pad) / box.height);
    const scale = this.clamp(Math.min(fit, maxScale));
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({
      x: (sw - box.width * scale) / 2 - box.x * scale,
      y: (sh - box.height * scale) / 2 - box.y * scale,
    });
    this.afterTransform();
  }

  /** Low-level: set the camera transform directly (used by pinch), then re-sync. */
  applyTransform(scale: number, position: { x: number; y: number }): void {
    this.stopZoomAnim();
    this.stage.scale({ x: scale, y: scale });
    this.stage.position(position);
    this.afterTransform();
  }

  /** Resize the stage to the container (called from BoardCanvas's ResizeObserver). */
  resize(): void {
    this.stage.size({ width: this.container.clientWidth, height: this.container.clientHeight });
  }

  /**
   * Keep the CSS grid locked to the camera. A level-of-detail (LOD) scheme keeps the
   * on-screen spacing near GRID_TARGET_PX: zoomed out it draws every 2ⁿᵗʰ line/dot (and
   * subdivides when zoomed in), so the grid never crowds into a solid fill. A fine +
   * coarse tier crossfade — the coarse tier is solid, the fine tier's opacity
   * (--grid-fade) drops to 0 exactly as its in-between lines/dots would be dropped — so
   * the LOD steps are seamless rather than popping.
   *
   * This only computes the LOD numbers and feeds them to CSS custom properties; styles.css
   * `.canvas` turns them into either a dot grid (default) or a line grid ([data-grid="lines"]).
   * Positions are emitted as --gx/--gy props (not background-position) so the dot mode
   * (2 layers) and line mode (4 layers) can each compose their own background-position.
   */
  syncGrid(): void {
    const scale = this.stage.scaleX();
    const lod = Math.log2(GRID_TARGET_PX / (GRID * scale)); // continuous level; > 0 when zoomed out
    const step = Math.floor(lod);
    const fine = GRID * scale * 2 ** step; // fine spacing on screen, always in (GRID_TARGET_PX/2, GRID_TARGET_PX]
    const coarse = fine * 2;
    const fade = 1 - (lod - step); // 1 at the start of an octave → 0 as it steps to the next

    const s = this.container.style;
    // Spacing + fade only change with zoom; guard the writes so a pan touches positions alone.
    if (fine !== this.gridFine) {
      this.gridFine = fine;
      s.setProperty("--grid-fine", `${fine}px`);
      s.setProperty("--grid-coarse", `${coarse}px`);
    }
    if (fade !== this.gridFade) {
      this.gridFade = fade;
      s.setProperty("--grid-fade", fade.toFixed(3));
    }
    // Offset each tier by half its own tile so a line/dot lands on the world origin — this
    // keeps the fine + coarse tiers aligned and glues the grid to world coordinates (no
    // drift while zooming within an octave).
    const x = this.stage.x();
    const y = this.stage.y();
    s.setProperty("--gx-fine", `${x - fine / 2}px`);
    s.setProperty("--gy-fine", `${y - fine / 2}px`);
    s.setProperty("--gx-coarse", `${x - coarse / 2}px`);
    s.setProperty("--gy-coarse", `${y - coarse / 2}px`);
  }

  private notifyZoom(): void {
    this.zoomListener?.(this.getZoomPercent());
  }

  private afterTransform(): void {
    this.scheduleSync();
    this.scheduleSave();
  }

  /** Persist the camera (debounced) so a reload restores exactly where the user was. */
  private scheduleSave(): void {
    const key = this.storageKey;
    if (!key) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        localStorage.setItem(
          key,
          JSON.stringify({ s: this.stage.scaleX(), x: this.stage.x(), y: this.stage.y() }),
        );
      } catch {
        /* storage disabled/full → silently skip persistence */
      }
    }, 250);
  }

  /** Apply this board's persisted camera if one exists. Returns whether a view was restored — the
   *  caller uses that to skip the on-load auto-fit (a restored view is already "framed"). */
  restoreSavedView(): boolean {
    const key = this.storageKey;
    if (!key) return false;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return false;
    }
    if (!raw) return false;
    try {
      const v = JSON.parse(raw) as { s?: unknown; x?: unknown; y?: unknown };
      if (
        typeof v.s !== "number" ||
        typeof v.x !== "number" ||
        typeof v.y !== "number" ||
        !Number.isFinite(v.s) ||
        !Number.isFinite(v.x) ||
        !Number.isFinite(v.y)
      ) {
        return false;
      }
      this.applyTransform(this.clamp(v.s), { x: v.x, y: v.y });
      return true;
    } catch {
      return false;
    }
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
      this.stopZoomAnim();
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
