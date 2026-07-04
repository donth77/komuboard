// Physical tool props — the user-provided marker + eraser GLBs living on the whiteboard's tray.
// They behave like objects, not buttons: grab one (click in the preview, laser/trigger on device)
// and it rides your pointer against the board — press to draw/erase with it; scroll while holding
// it off-board to flip it; press G (or drop() on device) to let go, and it FALLS under gravity,
// tumbles, hits the platform, and hops back to its tray spot. Switching back to select/hand returns
// it to the tray politely. The marker's body is tinted live to the selected pen colour.
//
// State machine per prop: resting → held → (falling → grounded → returning →) resting.

import { onSceneTick, type AframeNS, type Vec3 } from "./three-types";
import type { VRTool } from "./tool-dock-3d";
import type { BoardFit } from "./whiteboard-model";

export interface TrayPropsOptions {
  aframe: AframeNS | undefined;
  scene: HTMLElement;
  onTool(tool: VRTool): void;
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
  /** Test/debug snapshot. */
  debugState(): Record<string, { state: string; x: number; y: number; z: number }>;
  destroy(): void;
}

type PropState = "resting" | "held" | "falling" | "grounded" | "returning";

interface PropRotation {
  x: number;
  y: number;
  z: number;
}

interface Prop {
  tool: VRTool;
  ent: HTMLElement & {
    object3D?: { scale: Vec3; position: Vec3; rotation?: PropRotation };
    getObject3D?: (k: string) => { traverse(fn: (n: unknown) => void): void } | undefined;
  };
  holder: HTMLElement & { object3D?: { position: Vec3; rotation?: PropRotation } };
  xOffset: number;
  targetLen: number;
  state: PropState;
  rest: { x: number; y: number; z: number };
  vel: number; // falling speed (m/s, downward positive)
  spin: number; // flip impulse (rad/s, decays)
  groundedAt: number;
  /** When the current state was entered — every transient state is wall-clock-bounded so slow
   *  (CI/software-rendered) frame rates can't stretch the physics past test/UX budgets. */
  stateSince: number;
  lastFollow: { x: number; y: number; z: number } | null;
  /** Controller entity this prop is palm-attached to (grip-grabbed) — null in pointer mode. */
  palmEl: HTMLElement | null;
}

const GRAVITY = 9.8;
const GROUND_Y = 0.02; // platform top + a hair
const HOLD_TILT = -0.7; // writing tilt (rad about z) while held

export function createTrayProps(opts: TrayPropsOptions): TrayProps {
  const rootEnt = document.createElement("a-entity");
  rootEnt.id = "vr-props";
  opts.scene.appendChild(rootEnt);

  let markerTint = "#0E1116";

  const defs: { tool: VRTool; src: string; xOffset: number; targetLen: number }[] = [
    { tool: "pen", src: "/models/whiteboard_marker.glb", xOffset: -0.25, targetLen: 0.16 },
    { tool: "eraser", src: "/models/whiteboard_eraser.glb", xOffset: 0.25, targetLen: 0.13 },
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
      state: "resting",
      rest: { x: d.xOffset, y: 1.0, z: -1.3 },
      vel: 0,
      spin: 0,
      groundedAt: 0,
      stateSince: 0,
      lastFollow: null,
      palmEl: null,
    };
    ent.addEventListener("model-loaded", () => {
      const THREE = opts.aframe?.THREE;
      const o3 = ent.object3D;
      if (!THREE || !o3) return;
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(o3).getSize(size);
      const longest = Math.max(size.x, size.y, size.z);
      if (!longest) return;
      // Lay the longest axis horizontally (along x, like a pen resting on a tray).
      if (size.y === longest && o3.rotation) o3.rotation.z = Math.PI / 2;
      else if (size.z === longest && o3.rotation) o3.rotation.y = Math.PI / 2;
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
      applyMarkerTint(prop);
    });
    ent.addEventListener("click", () => {
      // Clicking a resting prop = grabbing it (which IS selecting its tool). Clicks while held
      // land on the panel instead (the prop stops intercepting rays — see hold()).
      if (prop.state === "resting") opts.onTool(d.tool);
    });
    holder.appendChild(ent);
    rootEnt.appendChild(holder);
    return prop;
  });

  const setHolderPos = (p: Prop, x: number, y: number, z: number): void => {
    p.holder.setAttribute("position", `${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
  };
  const holderRot = (p: Prop): PropRotation | undefined => p.holder.object3D?.rotation ?? undefined;

  const rest = (p: Prop): void => {
    p.state = "resting";
    p.stateSince = performance.now();
    p.vel = 0;
    p.spin = 0;
    p.lastFollow = null;
    p.palmEl = null;
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
    const r = holderRot(p);
    if (r) r.z = HOLD_TILT;
    // Until the pointer touches the board, present it just above its tray spot.
    if (!p.lastFollow) setHolderPos(p, p.rest.x, p.rest.y + 0.12, p.rest.z + 0.06);
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
      if (p.state === "held" && p.palmEl && pos) {
        // Palm-attached: ride the controller's pose 1:1 (grip-grab on device).
        const c = (p.palmEl as { object3D?: { position: Vec3; rotation?: PropRotation } }).object3D;
        if (c) {
          pos.x = c.position.x;
          pos.y = c.position.y;
          pos.z = c.position.z;
          if (r && c.rotation) {
            r.x = c.rotation.x;
            r.y = c.rotation.y;
            r.z = c.rotation.z + HOLD_TILT;
          }
        }
      } else if (p.state === "held" && p.spin !== 0 && r) {
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

  // Grip-grab (device): squeezing the grip with the controller's ray on a RESTING prop palm-
  // attaches it to that hand; releasing the grip drops it (fall → tray reset). Listeners sit on
  // the scene — A-Frame entity events bubble, so this works for controllers created at any time.
  // Grabbing a 2-cm-tall prop with a laser needs forgiveness: an exact mesh hit counts, and so
  // does the ray passing within a small radius of the prop (point-at-it-roughly semantics).
  const GRAB_RADIUS = 0.12;
  const rayHits = (ctrl: HTMLElement, p: Prop): boolean => {
    try {
      const rc = (
        ctrl as {
          components?: {
            raycaster?: {
              getIntersection(e: Element): unknown;
              raycaster?: {
                ray?: {
                  origin: { x: number; y: number; z: number };
                  direction: { x: number; y: number; z: number };
                };
              };
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
  const onGripDown = (evt: Event): void => {
    const ctrl = evt.target as HTMLElement;
    if (!ctrl.hasAttribute?.("laser-controls")) return;
    for (const p of props) {
      if (p.state === "resting" && rayHits(ctrl, p)) {
        opts.onTool(p.tool); // grabbing IS selecting its tool (hold() runs via setActive)
        p.palmEl = ctrl;
        return;
      }
    }
  };
  const onGripUp = (evt: Event): void => {
    const held = props.find((p) => p.state === "held" && p.palmEl === evt.target);
    if (held) {
      held.state = "falling";
      held.stateSince = performance.now();
      held.vel = 0;
      held.lastFollow = null;
      held.palmEl = null;
    }
  };
  opts.scene.addEventListener("gripdown", onGripDown);
  opts.scene.addEventListener("gripup", onGripUp);

  // Flip interaction (preview): scrolling while holding a prop OFF the board flips it. (Scrolling
  // over the board keeps meaning zoom — interaction.ts owns that path.)
  const onWheel = (e: Event): void => {
    const held = props.find((p) => p.state === "held");
    if (!held || held.lastFollow) return;
    held.spin += ((e as WheelEvent).deltaY > 0 ? 1 : -1) * Math.PI * 2.2;
    e.preventDefault();
  };
  opts.scene.addEventListener("wheel", onWheel, { passive: false });

  return {
    place(fit) {
      // Rest spots: the model's real marker tray when detected, else a line under the board face.
      const y = fit.tray ? fit.tray.y + 0.002 : fit.y - fit.height / 2 + 0.015;
      const z = fit.tray ? fit.tray.z : fit.z + 0.3;
      for (const p of props) {
        p.rest = { x: fit.x + p.xOffset, y, z };
        if (p.state === "resting") setHolderPos(p, p.rest.x, p.rest.y, p.rest.z);
      }
    },
    setActive(tool) {
      for (const p of props) {
        if (p.tool === tool && p.state === "resting") hold(p);
        else if (p.tool !== tool && p.state === "held") {
          // Switched away politely → straight back to the tray (no drama, no drop).
          p.state = "returning";
          p.stateSince = performance.now();
        }
      }
    },
    follow(world, drawing) {
      const held = props.find((p) => p.state === "held");
      if (!held || held.palmEl) return; // palm attachment (grip-grab) overrides pointer riding
      held.lastFollow = world;
      if (!world) return; // off-board: hover where it was
      // Ride the board surface: tip against it while drawing, a small hover otherwise.
      setHolderPos(held, world.x, world.y, world.z + (drawing ? 0.012 : 0.05));
      const r = holderRot(held);
      if (r && held.spin === 0) {
        r.z = HOLD_TILT;
        r.x = drawing ? -0.25 : 0;
      }
    },
    drop() {
      const held = props.find((p) => p.state === "held");
      if (!held) return;
      held.state = "falling";
      held.stateSince = performance.now();
      held.vel = 0;
      held.lastFollow = null;
      held.palmEl = null;
    },
    tint(color) {
      markerTint = color;
      const marker = props.find((p) => p.tool === "pen");
      if (marker) applyMarkerTint(marker);
    },
    debugState() {
      const out: Record<string, { state: string; x: number; y: number; z: number }> = {};
      for (const p of props) {
        const pos = p.holder.object3D?.position;
        out[p.tool] = { state: p.state, x: pos?.x ?? 0, y: pos?.y ?? 0, z: pos?.z ?? 0 };
      }
      return out;
    },
    destroy() {
      offTick();
      opts.scene.removeEventListener("wheel", onWheel);
      opts.scene.removeEventListener("gripdown", onGripDown);
      opts.scene.removeEventListener("gripup", onGripUp);
      rootEnt.remove();
    },
  };
}
