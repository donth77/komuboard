// Physical tool props — the user-provided marker + eraser GLBs living on the whiteboard's tray.
// They behave like objects, not buttons:
//   • in a headset, squeeze the grip near one (or pointing at it), or pull the trigger on it (or on
//     its dock button), and it jumps into that hand the way you'd hold it — marker tip out along
//     your pointer ray, eraser felt-first. Press it against the board to draw/erase by contact, or
//     keep drawing with the trigger at a distance. Releasing a grip-grab (or B) drops it: it FALLS
//     under gravity, hits the platform, and hops back to its tray spot.
//   • in the desktop preview, clicking one picks up its tool and the prop rides the pointer across
//     the board, tip on the stroke; scroll while holding it off-board to flip it; G lets go.
// Switching back to select/hand returns it to the tray politely. The marker's body is tinted live
// to the selected pen colour.
//
// State machine per prop: resting → held → (falling → grounded → returning →) resting.

import { pulse } from "./haptics";
import { onSceneTick, type AframeNS, type Obj3D, type Vec3, type XYZ } from "./three-types";
import type { VRTool } from "./tool-dock-3d";
import type { BoardFit } from "./whiteboard-model";

export interface TrayPropsOptions {
  aframe: AframeNS | undefined;
  scene: HTMLElement;
  onTool(tool: VRTool): void;
}

export interface PropDebug {
  state: string;
  /** Holder position, world space. */
  x: number;
  y: number;
  z: number;
  /** The controller hand holding it, if any. */
  hand: "left" | "right" | null;
  /** World position of the working end (marker tip / eraser felt) and the direction it faces. */
  tip: XYZ | null;
  axis: XYZ | null;
}

export interface TrayProps {
  place(fit: BoardFit): void;
  /** Tool changed: hold the matching prop (pen→marker, eraser→eraser), rest the others. */
  setActive(tool: VRTool): void;
  /** Per-frame pointer ride-along while held: board-surface point (world), or null off-board. */
  follow(world: { x: number; y: number; z: number } | null, drawing: boolean): void;
  /** Let go of whatever is held — it falls, lands, and returns to the tray. */
  drop(): void;
  /** Tint the marker's body to the selected pen colour. */
  tint(color: string): void;
  /** Panel UV where the hand-held prop's working end touches the board face, else null. Call once
   *  per frame — it runs the touch hysteresis and the contact haptic. */
  contact(): { x: number; y: number } | null;
  /** Hide the props on the tray (a hand-held prop rides its controller and is unaffected). */
  setVisible(v: boolean): void;
  /** Test/debug snapshot. */
  debugState(): Record<string, PropDebug>;
  destroy(): void;
}

type PropState = "resting" | "held" | "falling" | "grounded" | "returning";
type PalmMode = "grip" | "trigger";

interface Prop {
  tool: VRTool;
  ent: HTMLElement & {
    object3D?: Obj3D & { scale: Vec3 };
    getObject3D?: (k: string) => { traverse(fn: (n: unknown) => void): void } | undefined;
  };
  holder: HTMLElement & { object3D?: Obj3D };
  xOffset: number;
  targetLen: number;
  /** Holder-local direction the working end faces (marker tip / eraser felt). */
  workAxis: XYZ;
  /** Holder-local centre of the working end — measured once the model loads. */
  work: XYZ;
  /** Hand-held: how far out along the pointer ray the working end sits (m). */
  lead: number;
  state: PropState;
  rest: { x: number; y: number; z: number };
  vel: number; // falling speed (m/s, downward positive)
  spin: number; // flip impulse (rad/s, decays)
  groundedAt: number;
  /** When the current state was entered — every transient state is wall-clock-bounded so slow
   *  (CI/software-rendered) frame rates can't stretch the physics past test/UX budgets. */
  stateSince: number;
  lastFollow: { x: number; y: number; z: number } | null;
  /** The controller entity holding this prop (its object3D is parented there) — null in pointer
   *  mode. `grip` holds last while squeezed; `trigger` holds until put down or another tool. */
  palmEl: HTMLElement | null;
  palmMode: PalmMode | null;
  touching: boolean;
}

const GRAVITY = 9.8;
const GROUND_Y = 0.02; // platform top + a hair
const HOLD_TILT = -0.7; // tilt (rad about z) while presented above the tray
const NEAR_GRAB = 0.16; // grip within this distance of a prop picks it up
const GRAB_RADIUS = 0.12; // …or the pointer ray passing this close to it
/** Contact hysteresis: touch down within this of the board face, lift off beyond RELEASE. */
const TOUCH_DOWN = 0.006;
const TOUCH_RELEASE = 0.02;
/** Preview (pointer-riding): the direction the working end points — INTO the board, with the
 *  marker's body angling out down-right like a right hand holding it. */
const PEN_INTO = { x: -0.35, y: 0.35, z: -0.87 };
const ERASER_INTO = { x: 0, y: 0, z: -1 };

export function createTrayProps(opts: TrayPropsOptions): TrayProps {
  const THREE = opts.aframe?.THREE;
  const va = THREE ? new THREE.Vector3() : null;
  const vb = THREE ? new THREE.Vector3() : null;
  const rootEnt = document.createElement("a-entity") as HTMLElement & { object3D?: Obj3D };
  rootEnt.id = "vr-props";
  opts.scene.appendChild(rootEnt);

  let markerTint = "#0E1116";
  let fit: BoardFit | null = null;

  const defs: {
    tool: VRTool;
    src: string;
    xOffset: number;
    targetLen: number;
    workAxis: XYZ;
    lead: number;
  }[] = [
    // Normalized, the marker lies along x with its TIP at −x (the GLB root turns the Collada pen's
    // +z tip to −x); in hand the tip sits 12 cm out along the pointer ray. Both props are REAL
    // size — they're held in a real hand, so unlike the board they never scale with the scene.
    {
      tool: "pen",
      src: "/models/whiteboard_marker.glb",
      xOffset: -0.25,
      targetLen: 0.14, // a chunky dry-erase marker (the model's proportions are an Expo's)
      workAxis: { x: -1, y: 0, z: 0 },
      lead: 0.12,
    },
    // The eraser rests felt-down (−y); in hand the felt leads along the ray.
    {
      tool: "eraser",
      src: "/models/whiteboard_eraser.glb",
      xOffset: 0.25,
      targetLen: 0.13, // a standard felt board eraser
      workAxis: { x: 0, y: -1, z: 0 },
      lead: 0.05,
    },
  ];

  const refreshRaycaster = (): void => {
    // Interactivity classes changed → refresh EVERY raycaster's object list (the scene's mouse ray
    // AND both controller lasers cache theirs).
    const els = [opts.scene, ...Array.from(opts.scene.querySelectorAll("[laser-controls]"))];
    for (const el of els) {
      const ray = (el as unknown as { components?: Record<string, unknown> }).components?.[
        "raycaster"
      ] as { refreshObjects?: () => void } | undefined;
      try {
        ray?.refreshObjects?.();
      } catch {
        /* not initialized yet */
      }
    }
  };

  const applyMarkerTint = (p: Prop): void => {
    if (p.tool !== "pen") return;
    p.ent.getObject3D?.("mesh")?.traverse((n) => {
      const m = n as { isMesh?: boolean; material?: { color?: { set(c: string): void } } };
      if (m.isMesh) m.material?.color?.set(markerTint);
    });
  };

  const props: Prop[] = defs.map((d) => {
    const holder = document.createElement("a-entity") as Prop["holder"];
    const ent = document.createElement("a-entity") as Prop["ent"];
    ent.classList.add("vr-interactive");
    ent.setAttribute("gltf-model", `url(${d.src})`);
    const prop: Prop = {
      tool: d.tool,
      ent,
      holder,
      xOffset: d.xOffset,
      targetLen: d.targetLen,
      workAxis: d.workAxis,
      work: { x: (d.workAxis.x * d.targetLen) / 2, y: 0.012, z: 0 }, // refined on load
      lead: d.lead,
      state: "resting",
      rest: { x: d.xOffset, y: 1.0, z: -1.3 },
      vel: 0,
      spin: 0,
      groundedAt: 0,
      stateSince: 0,
      lastFollow: null,
      palmEl: null,
      palmMode: null,
      touching: false,
    };
    ent.addEventListener("model-loaded", () => {
      const o3 = ent.object3D;
      if (!THREE || !o3) return;
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(o3).getSize(size);
      const longest = Math.max(size.x, size.y, size.z);
      if (!longest) return;
      // Lay the longest axis horizontally (along x, like a pen resting on a tray).
      if (size.y === longest) o3.rotation.z = Math.PI / 2;
      else if (size.z === longest) o3.rotation.y = Math.PI / 2;
      o3.scale.setScalar(d.targetLen / longest);
      // Re-centre onto the HOLDER origin. Box3 measures in WORLD space while position is LOCAL —
      // subtract the holder's world offset or the prop teleports to the world origin.
      const hp = (
        holder as unknown as { getAttribute(n: string): { x: number; y: number; z: number } | null }
      ).getAttribute("position") ?? { x: 0, y: 0, z: 0 };
      const box = new THREE.Box3().setFromObject(o3);
      const c = new THREE.Vector3();
      box.getCenter(c);
      o3.position.set(
        o3.position.x - (c.x - hp.x),
        o3.position.y - (box.min.y - hp.y),
        o3.position.z - (c.z - hp.z),
      );
      // The working end: the centre of the box face the work axis points through (the prop's
      // bottom-centre is now the holder origin).
      const fin = new THREE.Vector3();
      new THREE.Box3().setFromObject(o3).getSize(fin);
      prop.work = {
        x: (prop.workAxis.x * fin.x) / 2,
        y: fin.y / 2 + (prop.workAxis.y * fin.y) / 2,
        z: (prop.workAxis.z * fin.z) / 2,
      };
      applyMarkerTint(prop);
    });
    ent.addEventListener("click", () => {
      // Clicking a resting prop = grabbing it (which IS selecting its tool — a laser click takes
      // it into that hand, see onClickCapture). Clicks while held land on the panel instead.
      if (prop.state === "resting") opts.onTool(d.tool);
    });
    holder.appendChild(ent);
    rootEnt.appendChild(holder);
    return prop;
  });

  const setHolderPos = (p: Prop, x: number, y: number, z: number): void => {
    p.holder.setAttribute("position", `${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
  };
  const holderRot = (p: Prop): XYZ | undefined => p.holder.object3D?.rotation ?? undefined;
  const unit = (v: XYZ): Vec3 | null => {
    if (!THREE) return null;
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return new THREE.Vector3(v.x / len, v.y / len, v.z / len);
  };
  /** Orient `p` so its working end faces `dir`, and return that end's offset from the holder
   *  origin in the holder's PARENT frame. */
  const aim = (p: Prop, dir: XYZ): XYZ | null => {
    const h3 = p.holder.object3D;
    const from = unit(p.workAxis);
    const to = unit(dir);
    if (!THREE || !h3 || !from || !to) return null;
    h3.quaternion.setFromUnitVectors(from, to);
    return new THREE.Vector3(p.work.x, p.work.y, p.work.z).applyQuaternion(h3.quaternion);
  };

  // ---- in the hand -------------------------------------------------------------------------------
  /** The controller that should receive the next held prop (set around a laser click / grip). */
  let pendingHand: { el: HTMLElement; mode: PalmMode } | null = null;

  const attachToHand = (p: Prop, ctrl: HTMLElement, mode: PalmMode): void => {
    const c3 = (ctrl as HTMLElement & { object3D?: Obj3D }).object3D;
    const h3 = p.holder.object3D;
    if (!c3 || !h3) return;
    // The pointer ray in the controller's own frame (laser-controls sets it per controller model):
    // the prop lines up with it, so the laser seems to leave from the marker tip.
    const ray = (
      ctrl as unknown as {
        components?: { raycaster?: { data?: { origin?: XYZ; direction?: XYZ } } };
      }
    ).components?.raycaster?.data;
    const o = ray?.origin ?? { x: 0, y: 0, z: 0 };
    const d = unit(ray?.direction ?? { x: 0, y: 0, z: -1 });
    if (!d) return;
    p.palmEl = ctrl;
    p.palmMode = mode;
    p.touching = false;
    p.lastFollow = null;
    p.spin = 0;
    c3.add(h3);
    const w = aim(p, d);
    if (!w) return;
    h3.position.set(o.x + d.x * p.lead - w.x, o.y + d.y * p.lead - w.y, o.z + d.z * p.lead - w.z);
  };
  /** Back to the world (props root), keeping its world pose — it falls from where the hand was. */
  const releaseFromHand = (p: Prop): void => {
    const h3 = p.holder.object3D;
    if (p.palmEl && h3) rootEnt.object3D?.attach(h3);
    p.palmEl = null;
    p.palmMode = null;
    p.touching = false;
  };

  const rest = (p: Prop): void => {
    releaseFromHand(p);
    p.state = "resting";
    p.stateSince = performance.now();
    p.vel = 0;
    p.spin = 0;
    p.lastFollow = null;
    const r = holderRot(p);
    if (r) {
      r.x = 0;
      r.y = 0;
      r.z = 0;
    }
    setHolderPos(p, p.rest.x, p.rest.y, p.rest.z);
    p.ent.classList.add("vr-interactive");
    refreshRaycaster();
  };

  const hold = (p: Prop): void => {
    p.state = "held";
    p.stateSince = performance.now();
    p.vel = 0;
    // A held prop must NOT intercept the pointer ray — it would sit between pointer and board and
    // swallow every draw/erase gesture.
    p.ent.classList.remove("vr-interactive");
    refreshRaycaster();
    if (pendingHand) {
      attachToHand(p, pendingHand.el, pendingHand.mode);
      pendingHand = null;
      return;
    }
    const r = holderRot(p);
    if (r) r.z = HOLD_TILT;
    // Until the pointer touches the board, present it just above its tray spot.
    if (!p.lastFollow) setHolderPos(p, p.rest.x, p.rest.y + 0.12, p.rest.z + 0.06);
  };

  const fall = (p: Prop): void => {
    releaseFromHand(p);
    p.state = "falling";
    p.stateSince = performance.now();
    p.vel = 0;
    p.lastFollow = null;
  };

  // ---- per-frame physics -------------------------------------------------------------------
  let lastT = 0;
  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min(0.12, lastT ? (now - lastT) / 1000 : 0.016);
    lastT = now;
    for (const p of props) {
      const pos = p.holder.object3D?.position;
      const r = holderRot(p);
      if (p.state === "held" && !p.palmEl && p.spin !== 0 && r) {
        // Flip: a scroll impulse spins the prop end over end, decaying back to steady.
        r.x += p.spin * dt;
        p.spin *= Math.max(0, 1 - 3 * dt);
        if (Math.abs(p.spin) < 0.2) {
          p.spin = 0;
          r.x = 0;
        }
      } else if (p.state === "falling" && pos) {
        p.vel += GRAVITY * dt;
        pos.y -= p.vel * dt;
        if (r) {
          r.x += 5 * dt; // tumble
          r.z += 2.4 * dt;
        }
        if (pos.y <= GROUND_Y || now - p.stateSince > 3000) {
          pos.y = GROUND_Y;
          p.state = "grounded";
          p.groundedAt = now;
          p.stateSince = now;
        }
      } else if (p.state === "grounded") {
        if (now - p.groundedAt > 450) {
          p.state = "returning";
          p.stateSince = now;
        }
      } else if (p.state === "returning" && pos) {
        // Hop back to the tray: TIME-based exponential easing (fps-independent), with a hard
        // wall-clock snap so a slow renderer can never stretch the trip.
        const f = 1 - Math.exp(-6 * dt);
        pos.x += (p.rest.x - pos.x) * f;
        pos.y += (p.rest.y - pos.y) * f;
        pos.z += (p.rest.z - pos.z) * f;
        if (r) {
          r.x *= 1 - f;
          r.y *= 1 - f;
          r.z *= 1 - f;
        }
        const close =
          Math.abs(pos.x - p.rest.x) < 0.005 &&
          Math.abs(pos.y - p.rest.y) < 0.005 &&
          Math.abs(pos.z - p.rest.z) < 0.005;
        if (close || now - p.stateSince > 2500) rest(p);
      }
    }
  };
  const offTick = onSceneTick(tick);

  // ---- grabbing ------------------------------------------------------------------------------
  // A laser click that ends up selecting pen/eraser (on the prop itself or its dock button) hands
  // the prop to THAT controller. Capture phase: runs before the clicked entity's own handler.
  const onClickCapture = (e: Event): void => {
    const el = (e as CustomEvent<{ cursorEl?: HTMLElement }>).detail?.cursorEl;
    if (!el?.hasAttribute?.("laser-controls")) return;
    pendingHand = { el, mode: "trigger" };
    queueMicrotask(() => {
      pendingHand = null; // the click didn't pick anything up
    });
  };
  opts.scene.addEventListener("click", onClickCapture, true);

  // Grip-grab (device): squeezing the grip with the controller NEAR a resting prop, or its ray on
  // it, puts it in that hand; releasing the grip drops it (fall → tray reset). Listeners sit on the
  // scene — A-Frame entity events bubble, so this works for controllers created at any time.
  // Pointing at a 2-cm-tall prop needs forgiveness: an exact mesh hit counts, and so does the ray
  // passing within a small radius of it (point-at-it-roughly semantics).
  const rayHits = (ctrl: HTMLElement, p: Prop): boolean => {
    try {
      const rc = (
        ctrl as {
          components?: {
            raycaster?: {
              getIntersection(e: Element): unknown;
              raycaster?: { ray?: { origin: XYZ; direction: XYZ } };
            };
          };
        }
      ).components?.raycaster;
      if (rc?.getIntersection(p.ent)) return true;
      const ray = rc?.raycaster?.ray;
      const hp = p.holder.object3D?.position;
      if (!ray?.origin || !ray.direction || !hp) return false;
      const ox = hp.x - ray.origin.x;
      const oy = hp.y - ray.origin.y;
      const oz = hp.z - ray.origin.z;
      const t = ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z;
      if (t < 0) return false; // prop is behind the controller
      const dx = ox - t * ray.direction.x;
      const dy = oy - t * ray.direction.y;
      const dz = oz - t * ray.direction.z;
      return Math.hypot(dx, dy, dz) < GRAB_RADIUS;
    } catch {
      return false;
    }
  };
  const isNear = (ctrl: HTMLElement, p: Prop): boolean => {
    const c3 = (ctrl as HTMLElement & { object3D?: Obj3D }).object3D;
    const hp = p.holder.object3D?.position;
    if (!c3 || !hp || !va) return false;
    const c = c3.getWorldPosition(va);
    return Math.hypot(c.x - hp.x, c.y - (hp.y + 0.015), c.z - hp.z) < NEAR_GRAB;
  };
  const onGripDown = (evt: Event): void => {
    const ctrl = evt.target as HTMLElement;
    if (!ctrl.hasAttribute?.("laser-controls")) return;
    const p =
      props.find((q) => q.state === "resting" && isNear(ctrl, q)) ??
      props.find((q) => q.state === "resting" && rayHits(ctrl, q));
    if (!p) return;
    pendingHand = { el: ctrl, mode: "grip" };
    opts.onTool(p.tool); // grabbing IS selecting its tool (hold() takes it into this hand)
    pendingHand = null;
  };
  const onGripUp = (evt: Event): void => {
    const held = props.find(
      (p) => p.state === "held" && p.palmEl === evt.target && p.palmMode === "grip",
    );
    if (held) fall(held);
  };
  opts.scene.addEventListener("gripdown", onGripDown);
  opts.scene.addEventListener("gripup", onGripUp);

  // Flip interaction (preview): scrolling while holding a prop OFF the board flips it. (Scrolling
  // over the board keeps meaning zoom — interaction.ts owns that path.)
  const onWheel = (e: Event): void => {
    const held = props.find((p) => p.state === "held");
    if (!held || held.lastFollow || held.palmEl) return;
    held.spin += ((e as WheelEvent).deltaY > 0 ? 1 : -1) * Math.PI * 2.2;
    e.preventDefault();
  };
  opts.scene.addEventListener("wheel", onWheel, { passive: false });

  const handName = (el: HTMLElement | null): "left" | "right" | null => {
    if (!el) return null;
    const v = el.getAttribute("laser-controls") as unknown;
    const hand = typeof v === "string" ? v : (v as { hand?: string } | null)?.hand;
    return hand?.includes("left") ? "left" : "right";
  };

  return {
    place(f) {
      fit = f;
      // Rest spots: the model's real marker tray when detected, else a line under the board face.
      const y = f.tray ? f.tray.y + 0.002 : f.y - f.height / 2 + 0.015;
      const z = f.tray ? f.tray.z : f.z + 0.3;
      for (const p of props) {
        p.rest = { x: f.x + p.xOffset, y, z };
        if (p.state === "resting") setHolderPos(p, p.rest.x, p.rest.y, p.rest.z);
      }
    },
    setActive(tool) {
      for (const p of props) {
        if (p.tool === tool && p.state === "resting") hold(p);
        else if (p.tool !== tool && p.state === "held") {
          // Switched away politely → straight back to the tray (no drama, no drop).
          releaseFromHand(p);
          p.state = "returning";
          p.stateSince = performance.now();
        }
      }
    },
    follow(world, drawing) {
      const held = props.find((p) => p.state === "held");
      if (!held || held.palmEl) return; // in a hand, the controller carries it
      held.lastFollow = world;
      if (!world) return; // off-board: hover where it was
      // Ride the board surface with the working end ON the pointer: touching while drawing, a
      // small hover otherwise.
      held.spin = 0;
      const w = aim(held, held.tool === "pen" ? PEN_INTO : ERASER_INTO);
      if (!w) return;
      const gap = drawing ? 0.002 : 0.03;
      setHolderPos(held, world.x - w.x, world.y - w.y, world.z + gap - w.z);
    },
    drop() {
      const held = props.find((p) => p.state === "held");
      if (held) fall(held);
    },
    tint(color) {
      markerTint = color;
      const marker = props.find((p) => p.tool === "pen");
      if (marker) applyMarkerTint(marker);
    },
    contact() {
      const p = props.find((q) => q.state === "held" && q.palmEl);
      const h3 = p?.holder.object3D;
      const c3 = (p?.palmEl as (HTMLElement & { object3D?: Obj3D }) | null | undefined)?.object3D;
      if (!p?.palmEl || !fit || !h3 || !c3 || !va || !vb) return null;
      h3.updateWorldMatrix(true, false);
      va.set(p.work.x, p.work.y, p.work.z);
      const tip = h3.localToWorld(va);
      const hand = c3.getWorldPosition(vb);
      // The board face looks down +z; the hand must be in FRONT of it (not reaching from behind).
      const depth = tip.z - fit.z;
      const u = 0.5 + (tip.x - fit.x) / fit.width;
      const v = 0.5 + (tip.y - fit.y) / fit.height;
      const onFace = u >= 0 && u <= 1 && v >= 0 && v <= 1 && hand.z > fit.z;
      // Hysteresis: touch down within a few mm, lift off beyond 2 cm — hand tremor mustn't break a
      // stroke, and there's no physical board to stop the hand pushing through.
      const touching = onFace && depth > -0.1 && depth < (p.touching ? TOUCH_RELEASE : TOUCH_DOWN);
      if (touching && !p.touching) pulse(p.palmEl, 0.3, 25); // a tick as it meets the board
      p.touching = touching;
      return touching ? { x: u, y: v } : null;
    },
    setVisible(v) {
      rootEnt.setAttribute("visible", String(v));
    },
    debugState() {
      const out: Record<string, PropDebug> = {};
      for (const p of props) {
        const h3 = p.holder.object3D;
        let pos: XYZ = { x: 0, y: 0, z: 0 };
        let tip: XYZ | null = null;
        let axis: XYZ | null = null;
        if (h3 && va && vb) {
          const g = h3.getWorldPosition(va);
          pos = { x: g.x, y: g.y, z: g.z };
          vb.set(p.work.x, p.work.y, p.work.z);
          const t = h3.localToWorld(vb);
          tip = { x: t.x, y: t.y, z: t.z };
          vb.set(p.work.x - p.workAxis.x, p.work.y - p.workAxis.y, p.work.z - p.workAxis.z);
          const back = h3.localToWorld(vb);
          const len = Math.hypot(tip.x - back.x, tip.y - back.y, tip.z - back.z) || 1;
          axis = {
            x: (tip.x - back.x) / len,
            y: (tip.y - back.y) / len,
            z: (tip.z - back.z) / len,
          };
        }
        out[p.tool] = { state: p.state, ...pos, hand: handName(p.palmEl), tip, axis };
      }
      return out;
    },
    destroy() {
      offTick();
      for (const p of props) releaseFromHand(p);
      opts.scene.removeEventListener("click", onClickCapture, true);
      opts.scene.removeEventListener("wheel", onWheel);
      opts.scene.removeEventListener("gripdown", onGripDown);
      opts.scene.removeEventListener("gripup", onGripUp);
      rootEnt.remove();
    },
  };
}
