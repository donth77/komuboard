// Teleport aiming + visuals (docs/02 §3.9). Locomotion owns the input and the rig; this module
// traces, draws, and fades:
//   • the arc — a smooth ribbon from the controller whose dashes flow toward the target, fading in
//     at the hand; it stops at whatever it meets (the platform, the whiteboard, or the void);
//   • the landing reticle — a soft footprint disc, a pulsing ring, and a chevron showing which way
//     you'll face (a teleport keeps your heading); the walkable boundary glows while aiming;
//   • invalid targets (off the platform, past its wall, into the whiteboard) turn the arc red and a
//     release does nothing; a valid jump happens behind a short blink, with a haptic tick.

import { pulse } from "./haptics";
import { onSceneTick, type AframeNS, type Obj3D, type XYZ } from "./three-types";
import type { BoardFit } from "./whiteboard-model";

export interface TeleportOptions {
  aframe: AframeNS | undefined;
  scene: HTMLElement;
  /** The aiming controller — its laser line is hidden while the arc shows. */
  controller: HTMLElement;
  panelFit(): BoardFit;
  /** How far from the platform centre the head may stand (the invisible wall). */
  radius: number;
}

export type TeleportHit = "floor" | "board" | "void";

export interface TeleportState {
  aiming: boolean;
  valid: boolean;
  /** Where a release would land (null when invalid or not aiming). */
  target: XYZ | null;
  /** What the arc ended on, and where (valid or not). */
  hit: TeleportHit | null;
  end: XYZ | null;
  /** The blink overlay's opacity (0 when no jump is in progress). */
  blink: number;
  /** The highest opacity the blink reached during the current / most recent jump (0 = none yet).
   *  Lets a test prove the blink closed fully without sampling frames it can't keep up with. */
  blinkPeak: number;
}

export interface Teleport {
  /** Trace + draw the arc from the controller's ray this frame; returns the landing spot if valid. */
  aim(): XYZ | null;
  /** Stop aiming (hide the arc, give the laser back) without moving; ends any blink at once. */
  cancel(): void;
  /** Stop aiming and jump: fade out, run `move` at full black, fade back in. */
  jump(move: () => void): void;
  state(): TeleportState;
  destroy(): void;
}

// The slice of THREE this module builds with — raw meshes, because the arc is a ribbon rebuilt
// every frame and the reticle is a few flat shapes (A-Frame primitives can't do either cheaply).
interface Attr {
  needsUpdate: boolean;
}
interface Geo {
  setAttribute(name: string, attr: Attr): void;
  setIndex(attr: Attr): void;
  setDrawRange(start: number, count: number): void;
  rotateX(rad: number): Geo;
  dispose(): void;
}
interface Mat {
  color: { set(c: string): void };
  opacity: number;
  dispose(): void;
}
interface Mesh3 extends Obj3D {
  renderOrder: number;
  frustumCulled: boolean;
}
interface DashTex {
  wrapS: number;
  offset: { x: number };
  colorSpace?: string;
  dispose(): void;
}
interface MeshKit {
  BufferGeometry: new () => Geo;
  BufferAttribute: new (array: Float32Array | Uint16Array, itemSize: number) => Attr;
  Mesh: new (geometry: Geo, material: Mat) => Mesh3;
  Group: new () => Obj3D;
  MeshBasicMaterial: new (params: Record<string, unknown>) => Mat;
  RingGeometry: new (inner: number, outer: number, segments: number) => Geo;
  CircleGeometry: new (radius: number, segments: number) => Geo;
  PlaneGeometry: new (width: number, height: number) => Geo;
  SphereGeometry: new (radius: number, widthSegments: number, heightSegments: number) => Geo;
  CanvasTexture: new (canvas: HTMLCanvasElement) => DashTex;
  Vector3: new () => { x: number; y: number; z: number };
  DoubleSide: number;
  BackSide: number;
  RepeatWrapping: number;
  SRGBColorSpace?: string;
}

const SPEED = 5; // launch speed (m/s): pointing level lands near the far rim of this small platform
const GRAVITY = 9.8;
const STEP = 0.025; // seconds of flight per traced segment
const MAX_PTS = 90;
const VOID_Y = -2; // stop tracing an arc that fell past the platform
const PLATFORM_EDGE = 2.4; // the visible pedestal
const BOARD_MARGIN = 0.06; // the frame around the writing surface blocks too
const FACE_CLEAR = 0.2; // no landing closer than this in front of the board face…
const STAND_MARGIN = 0.15; // …or within the stand's footprint
const HALF_WIDTH = 0.011; // ribbon half-width (m)
const DASH = 0.09; // dash period along the arc (m)
const FLOW = 0.7; // dashes flow toward the target (m/s)
const FADE_IN = 0.3; // the arc fades in over its first metres from the hand
const FADE_OUT = 0.35; // an arc falling off the platform fades away toward its end
const BLINK_OUT_MS = 90;
const BLINK_IN_MS = 180;
const ACCENT = "#5aa8ff";
const INVALID = "#ff5c5c";

interface RayLike {
  origin: XYZ;
  direction: XYZ;
}

/** A controller's WORLD-space pointer ray, as its raycaster last computed it. */
function rayOf(el: HTMLElement): RayLike | null {
  const ray = (
    el as unknown as {
      components?: { raycaster?: { raycaster?: { ray?: RayLike } } };
    }
  ).components?.raycaster?.raycaster?.ray;
  return ray?.origin && ray.direction ? ray : null;
}

/** One dash of the arc (repeated along the ribbon's length): a capsule on a transparent ground. */
function dashCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 16;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(12, 8, 6, Math.PI / 2, (3 * Math.PI) / 2);
    g.arc(40, 8, 6, (3 * Math.PI) / 2, Math.PI / 2);
    g.closePath();
    g.fill();
  }
  return c;
}

const IDLE: TeleportState = {
  aiming: false,
  valid: false,
  target: null,
  hit: null,
  end: null,
  blink: 0,
  blinkPeak: 0,
};

export function createTeleport(opts: TeleportOptions): Teleport {
  const K = opts.aframe?.THREE as unknown as MeshKit | undefined;
  const sceneEl = opts.scene as HTMLElement & { object3D?: Obj3D; camera?: Obj3D };
  const sceneRoot = sceneEl.object3D;
  if (!K || !sceneRoot) {
    return {
      aim: () => null,
      cancel() {},
      jump: (move) => move(),
      state: () => IDLE,
      destroy() {},
    };
  }
  const tmp = new K.Vector3() as unknown as Parameters<Obj3D["getWorldPosition"]>[0];

  // Everything shown while aiming hangs off one group in world space.
  const root = new K.Group();
  root.visible = false;
  sceneRoot.add(root);

  // ---- the arc: a camera-facing ribbon, preallocated and refilled each frame ------------------------
  const pts = new Float32Array(MAX_PTS * 3);
  const pos = new Float32Array(MAX_PTS * 6);
  const uvs = new Float32Array(MAX_PTS * 4);
  const cols = new Float32Array(MAX_PTS * 8);
  const idx = new Uint16Array((MAX_PTS - 1) * 6);
  for (let i = 0; i < MAX_PTS - 1; i++) {
    idx.set([2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2], i * 6);
  }
  const posAttr = new K.BufferAttribute(pos, 3);
  const uvAttr = new K.BufferAttribute(uvs, 2);
  const colAttr = new K.BufferAttribute(cols, 4);
  const arcGeo = new K.BufferGeometry();
  arcGeo.setAttribute("position", posAttr);
  arcGeo.setAttribute("uv", uvAttr);
  arcGeo.setAttribute("color", colAttr);
  arcGeo.setIndex(new K.BufferAttribute(idx, 1));
  const dashTex = new K.CanvasTexture(dashCanvas());
  dashTex.wrapS = K.RepeatWrapping;
  if (K.SRGBColorSpace) dashTex.colorSpace = K.SRGBColorSpace;
  const arcMat = new K.MeshBasicMaterial({
    map: dashTex,
    color: ACCENT,
    vertexColors: true, // RGBA: the alpha fades the arc in at the hand
    transparent: true,
    depthWrite: false,
    side: K.DoubleSide,
  });
  const arc = new K.Mesh(arcGeo, arcMat);
  arc.frustumCulled = false; // rebuilt every frame — its bounds are always stale
  arc.renderOrder = 2;
  root.add(arc);

  // ---- the reticle: footprint disc + pulsing ring + facing chevron --------------------------------
  const flat = (g: Geo): Geo => g.rotateX(-Math.PI / 2);
  const tint = (color: string, opacity: number): Mat =>
    new K.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: K.DoubleSide,
    });
  const discMat = tint(ACCENT, 0.18);
  const ringMat = tint(ACCENT, 0.95);
  const chevronMat = tint(ACCENT, 0.95);
  const discGeo = flat(new K.CircleGeometry(0.2, 40));
  const ringGeo = flat(new K.RingGeometry(0.165, 0.2, 48));
  const chevronGeo = new K.BufferGeometry();
  // An arrowhead just beyond the ring, pointing along −z (rotated to your heading).
  chevronGeo.setAttribute(
    "position",
    new K.BufferAttribute(
      new Float32Array([
        0, 0, -0.3, -0.07, 0, -0.22, 0, 0, -0.245, 0, 0, -0.3, 0, 0, -0.245, 0.07, 0, -0.22,
      ]),
      3,
    ),
  );
  const disc = new K.Mesh(discGeo, discMat);
  const ring = new K.Mesh(ringGeo, ringMat);
  const chevron = new K.Mesh(chevronGeo, chevronMat);
  const reticle = new K.Group();
  reticle.add(disc);
  reticle.add(ring);
  reticle.add(chevron);
  root.add(reticle);

  // ---- the no-entry sign: a red ⊘ where an arc is refused (on the floor, or on the board) ----------
  const stopMat = tint(INVALID, 0.95);
  const stopRingGeo = new K.RingGeometry(0.075, 0.1, 40);
  const stopBarGeo = new K.PlaneGeometry(0.17, 0.025);
  const stopBar = new K.Mesh(stopBarGeo, stopMat);
  stopBar.rotation.z = Math.PI / 4;
  const stop = new K.Group();
  stop.add(new K.Mesh(stopRingGeo, stopMat));
  stop.add(stopBar);
  root.add(stop);

  // ---- the walkable boundary (the invisible wall, made visible while aiming) ------------------------
  const boundaryMat = tint(ACCENT, 0.3);
  const boundaryGeo = flat(new K.RingGeometry(opts.radius - 0.015, opts.radius, 128));
  const boundary = new K.Mesh(boundaryGeo, boundaryMat);
  boundary.position.set(0, 0.004, 0);
  root.add(boundary);

  // ---- the blink: a black sphere around the head, faded out/in around the jump --------------------
  const blinkMat = new K.MeshBasicMaterial({
    color: "#000000",
    transparent: true,
    opacity: 0,
    side: K.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const blinkGeo = new K.SphereGeometry(0.2, 16, 12);
  const blinkMesh = new K.Mesh(blinkGeo, blinkMat);
  blinkMesh.renderOrder = 10_000;
  blinkMesh.visible = false;
  let blinkParent: Obj3D | null = null;

  const px = (i: number): number => pts[i * 3] ?? 0;
  const py = (i: number): number => pts[i * 3 + 1] ?? 0;
  const pz = (i: number): number => pts[i * 3 + 2] ?? 0;

  /** Inside the whiteboard's stand, or pressed up against its face. */
  const blocked = (x: number, z: number, fit: BoardFit): boolean => {
    const f = fit.footprint;
    const minX = (f ? f.minX : fit.x - fit.width / 2) - STAND_MARGIN;
    const maxX = (f ? f.maxX : fit.x + fit.width / 2) + STAND_MARGIN;
    const minZ = (f ? f.minZ : fit.z - 0.4) - STAND_MARGIN;
    return x > minX && x < maxX && z > minZ && z < fit.z + FACE_CLEAR;
  };

  interface Traced {
    n: number;
    hit: TeleportHit;
    valid: boolean;
    end: XYZ;
  }
  /** Fly the arc in small steps until it meets the whiteboard, lands on the platform, or falls away. */
  const trace = (o: XYZ, d: XYZ, fit: BoardFit): Traced => {
    let n = 0;
    const push = (x: number, y: number, z: number): void => {
      pts[n * 3] = x;
      pts[n * 3 + 1] = y;
      pts[n * 3 + 2] = z;
      n++;
    };
    push(o.x, o.y, o.z);
    const vx = d.x * SPEED;
    const vy = d.y * SPEED;
    const vz = d.z * SPEED;
    const halfW = fit.width / 2 + BOARD_MARGIN;
    const halfH = fit.height / 2 + BOARD_MARGIN;
    let ax = o.x;
    let ay = o.y;
    let az = o.z;
    for (let i = 1; n < MAX_PTS; i++) {
      const t = i * STEP;
      const bx = o.x + vx * t;
      const by = o.y + vy * t - 0.5 * GRAVITY * t * t;
      const bz = o.z + vz * t;
      // The whiteboard blocks the arc (from either side).
      if ((az - fit.z) * (bz - fit.z) <= 0 && az !== bz) {
        const s = (fit.z - az) / (bz - az);
        const hx = ax + (bx - ax) * s;
        const hy = ay + (by - ay) * s;
        if (Math.abs(hx - fit.x) <= halfW && Math.abs(hy - fit.y) <= halfH) {
          push(hx, hy, fit.z);
          return { n, hit: "board", valid: false, end: { x: hx, y: hy, z: fit.z } };
        }
      }
      // The platform floor: a landing — valid inside the wall and clear of the stand.
      if (by <= 0 && ay > 0) {
        const s = ay / (ay - by);
        const hx = ax + (bx - ax) * s;
        const hz = az + (bz - az) * s;
        const r = Math.hypot(hx, hz);
        if (r <= PLATFORM_EDGE) {
          push(hx, 0, hz);
          const valid = r <= opts.radius && !blocked(hx, hz, fit);
          return { n, hit: "floor", valid, end: { x: hx, y: 0, z: hz } };
        }
      }
      push(bx, by, bz);
      ax = bx;
      ay = by;
      az = bz;
      if (by < VOID_Y) break;
    }
    return { n, hit: "void", valid: false, end: { x: ax, y: ay, z: az } };
  };

  /** Refill the ribbon: widened across the arc, square to the view, dashed along its length. */
  const drawArc = (n: number, ex: number, ey: number, ez: number, fadeEnd: boolean): void => {
    let total = 0;
    for (let i = 1; i < n; i++) {
      total += Math.hypot(px(i) - px(i - 1), py(i) - py(i - 1), pz(i) - pz(i - 1));
    }
    let len = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) len += Math.hypot(px(i) - px(i - 1), py(i) - py(i - 1), pz(i) - pz(i - 1));
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const tx = px(b) - px(a);
      const ty = py(b) - py(a);
      const tz = pz(b) - pz(a);
      const vx = ex - px(i);
      const vy = ey - py(i);
      const vz = ez - pz(i);
      let sx = ty * vz - tz * vy;
      let sy = tz * vx - tx * vz;
      let sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx = (sx / sl) * HALF_WIDTH;
      sy = (sy / sl) * HALF_WIDTH;
      sz = (sz / sl) * HALF_WIDTH;
      const j = i * 6;
      pos[j] = px(i) - sx;
      pos[j + 1] = py(i) - sy;
      pos[j + 2] = pz(i) - sz;
      pos[j + 3] = px(i) + sx;
      pos[j + 4] = py(i) + sy;
      pos[j + 5] = pz(i) + sz;
      const u = len / DASH;
      uvs[i * 4] = u;
      uvs[i * 4 + 1] = 0;
      uvs[i * 4 + 2] = u;
      uvs[i * 4 + 3] = 1;
      let alpha = Math.min(1, len / FADE_IN);
      if (fadeEnd) alpha *= Math.min(1, (total - len) / FADE_OUT);
      for (let k = 0; k < 8; k++) cols[i * 8 + k] = k % 4 === 3 ? alpha : 1;
    }
    arcGeo.setDrawRange(0, Math.max(0, n - 1) * 6);
    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  };

  // The laser line would double up with the arc — hide it while aiming, restore after.
  const laser = opts.controller as unknown as {
    components?: { raycaster?: { data?: { showLine?: boolean } } };
    setAttribute(component: string, prop: string, value: unknown): void;
  };
  let savedLine: boolean | null = null;
  const hideLaser = (): void => {
    if (savedLine !== null) return;
    savedLine = !!laser.components?.raycaster?.data?.showLine;
    if (savedLine) laser.setAttribute("raycaster", "showLine", false);
  };
  const restoreLaser = (): void => {
    if (savedLine) laser.setAttribute("raycaster", "showLine", true);
    savedLine = null;
  };

  let aiming = false;
  let valid = false;
  let target: XYZ | null = null;
  let hit: TeleportHit | null = null;
  let end: XYZ | null = null;
  let lastValidTick = 0;
  const stopAiming = (): void => {
    aiming = false;
    valid = false;
    target = null;
    hit = null;
    end = null;
    root.visible = false;
    restoreLaser();
  };

  const aim = (): XYZ | null => {
    const ray = rayOf(opts.controller);
    const cam = sceneEl.camera;
    if (!ray || !cam) return null;
    if (!aiming) {
      aiming = true;
      root.visible = true;
      hideLaser();
    }
    const res = trace(ray.origin, ray.direction, opts.panelFit());
    const eye = cam.getWorldPosition(tmp);
    drawArc(res.n, eye.x, eye.y, eye.z, res.hit === "void");
    arcMat.color.set(res.valid ? ACCENT : INVALID);
    const now = performance.now();
    dashTex.offset.x = -((now / 1000) * FLOW) / DASH;
    // A valid landing gets the reticle, turned to your heading; a refused one gets the no-entry
    // sign where the arc stopped — flat on the floor, or upright on the side of the board it hit.
    reticle.visible = res.valid;
    if (res.valid) {
      reticle.position.set(res.end.x, 0.006, res.end.z);
      const f = cam.getWorldDirection(tmp);
      reticle.rotation.y = Math.atan2(-f.x, -f.z);
      ring.scale.setScalar(1 + 0.06 * Math.sin(now * 0.008));
    }
    stop.visible = !res.valid && res.hit !== "void";
    if (res.hit === "board") {
      const side = Math.sign(pz(Math.max(0, res.n - 2)) - res.end.z) || 1;
      stop.position.set(res.end.x, res.end.y, res.end.z + 0.01 * side);
      stop.rotation.x = 0;
    } else if (stop.visible) {
      stop.position.set(res.end.x, 0.008, res.end.z);
      stop.rotation.x = -Math.PI / 2;
    }
    // "You can land here" — a light tick as the target turns valid (rate-limited: an aim wobbling
    // along the platform's edge must not buzz continuously).
    if (res.valid && !valid && now - lastValidTick > 250) {
      lastValidTick = now;
      pulse(opts.controller, 0.12, 12);
    }
    valid = res.valid;
    hit = res.hit;
    end = res.end;
    target = res.valid ? { x: res.end.x, y: 0, z: res.end.z } : null;
    return target;
  };

  // ---- blink -----------------------------------------------------------------------------------
  let blink: { phase: "out" | "in"; t0: number; move: (() => void) | null } | null = null;
  let blinkPeak = 0;
  const endBlink = (): void => {
    const pending = blink?.move;
    blink = null;
    pending?.();
    blinkMat.opacity = 0;
    blinkMesh.visible = false;
  };
  const jump = (move: () => void): void => {
    stopAiming();
    if (blink) endBlink();
    const cam = sceneEl.camera;
    if (!cam) {
      move();
      return;
    }
    if (blinkParent !== cam) {
      blinkParent?.remove(blinkMesh);
      cam.add(blinkMesh); // rides the head, whatever the rig does
      blinkParent = cam;
    }
    blink = { phase: "out", t0: performance.now(), move };
    blinkPeak = 0;
    blinkMesh.visible = true;
  };
  const tick = (): void => {
    if (!blink) return;
    const now = performance.now();
    if (blink.phase === "out") {
      const k = (now - blink.t0) / BLINK_OUT_MS;
      blinkMat.opacity = Math.min(1, k);
      blinkPeak = Math.max(blinkPeak, blinkMat.opacity);
      if (k >= 1) {
        const move = blink.move;
        blink = { phase: "in", t0: now, move: null };
        move?.();
        pulse(opts.controller, 0.35, 30);
      }
    } else {
      const k = (now - blink.t0) / BLINK_IN_MS;
      blinkMat.opacity = Math.max(0, 1 - k);
      if (k >= 1) endBlink();
    }
  };
  const offTick = onSceneTick(tick);

  return {
    aim,
    cancel() {
      stopAiming();
      endBlink();
    },
    jump,
    state: () => ({ aiming, valid, target, hit, end, blink: blinkMat.opacity, blinkPeak }),
    destroy() {
      offTick();
      stopAiming();
      endBlink();
      blinkParent?.remove(blinkMesh);
      sceneRoot.remove(root);
      const geos = [arcGeo, discGeo, ringGeo, chevronGeo, stopRingGeo, stopBarGeo, boundaryGeo];
      for (const g of [...geos, blinkGeo]) g.dispose();
      const mats = [arcMat, discMat, ringMat, chevronMat, stopMat, boundaryMat, blinkMat];
      for (const m of mats) m.dispose();
      dashTex.dispose();
    },
  };
}
