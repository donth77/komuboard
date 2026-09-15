// VR locomotion + comfort (docs/02 §3.9). The camera and both controllers ride one RIG entity, and
// everything here moves that rig — never board content:
//   • left stick walks (head-relative); right stick ←/→ snap-turns; right stick ↑ aims a teleport
//     arc, released to jump; A goes to the board (writing distance, facing it); B puts down the
//     held marker/eraser; Y / X raise / lower your view.
//   • seated calibration: a head well below the scene's design eye height (a seated user) is lifted
//     once on entry — standing users keep a true floor, and nobody is ever lowered into it. A
//     re-measures; Y / X adjust by hand.
//   • the platform's invisible wall: the HEAD stays on the pedestal whatever moved it (sticks,
//     teleport, room-scale steps, or the preview's WASD).

import { onLocaleChange, t } from "../i18n";
import { createTeleport, type TeleportState } from "./teleport";
import { textCard } from "./text-card";
import { onSceneTick, type AframeNS, type Obj3D, type XYZ } from "./three-types";
import type { BoardFit } from "./whiteboard-model";

export type Hand = "left" | "right";

export interface LocomotionOptions {
  aframe: AframeNS | undefined;
  scene: HTMLElement;
  /** #vr-rig — parent of the camera and both controllers. */
  rig: HTMLElement;
  controller(hand: Hand): HTMLElement;
  panelFit(): BoardFit;
  /** B: put down whatever prop is held. */
  onDrop(): void;
}

export interface RigPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface Locomotion {
  /** Stand in front of the board at writing distance, facing it, and re-calibrate seated height. */
  goToBoard(): void;
  /** Manually raise (+) / lower (−) the view, in metres. */
  nudgeHeight(dy: number): void;
  rig(): RigPose;
  /** World-space head position (null before the scene camera exists). */
  head(): XYZ | null;
  /** Teleport aim / blink state (tests + debugging). */
  teleport(): TeleportState;
  destroy(): void;
}

const PLATFORM_R = 2.1; // the pedestal (r 2.4) minus a margin
const WALK_SPEED = 1.4; // m/s at full stick
const DEADZONE = 0.25;
const SNAP_TURN = Math.PI / 4;
/** Eyes-to-board distance for "go to the board": arm's reach with a marker in hand. */
const WRITE_DIST = 0.55;
/** The eye height the scene is laid out for — a standing adult, looking slightly down at the middle
 *  of the whiteboard. A seated head is lifted to see it the same way. */
const DESIGN_EYE = 1.6;
/** A head at least this far BELOW the design height is treated as seated and lifted to it. Heads
 *  above it are never lowered: pushing the virtual floor up through a standing user's legs is worse
 *  than a tall user looking slightly down at the board. */
const SEATED_GAP = 0.2;
const HEIGHT_STEP = 0.1;
const MIN_LIFT = -0.8;
const MAX_LIFT = 1.2;
/** Keep trying the entry calibration this long — the first XR pose can lag the enter-vr event. */
const CALIBRATE_DELAY_MS = 600;
const CALIBRATE_GIVE_UP_MS = 8000;

const HELP_KEYS = [
  "vr.help.move",
  "vr.help.turn",
  "vr.help.board",
  "vr.help.drop",
  "vr.help.height",
  "vr.help.grab",
  "vr.help.hide",
];

export function createLocomotion(opts: LocomotionOptions): Locomotion {
  const THREE = opts.aframe?.THREE;
  const tmp = THREE ? new THREE.Vector3() : null;
  const rig3 = (opts.rig as HTMLElement & { object3D?: Obj3D }).object3D;
  const sceneEl = opts.scene as HTMLElement & { camera?: Obj3D; is?(state: string): boolean };
  const left = opts.controller("left");
  const right = opts.controller("right");

  const head = (): XYZ | null => {
    const cam = sceneEl.camera;
    if (!cam || !tmp) return null;
    const p = cam.getWorldPosition(tmp);
    return { x: p.x, y: p.y, z: p.z };
  };
  /** The head's world yaw — 0 faces −z (the board); positive turns left. Looking straight down (at
   *  the tray, the floor while teleporting) leaves the forward vector nearly vertical and its yaw
   *  meaningless, so the last well-defined yaw holds until the head comes back up. */
  let lastYaw = 0;
  const headYaw = (): number => {
    const cam = sceneEl.camera;
    if (!cam || !tmp) return lastYaw;
    const f = cam.getWorldDirection(tmp);
    if (Math.hypot(f.x, f.z) > 0.15) lastYaw = Math.atan2(-f.x, -f.z);
    return lastYaw;
  };

  const shift = (dx: number, dz: number): void => {
    if (!rig3) return;
    rig3.position.x += dx;
    rig3.position.z += dz;
  };
  /** Rotate the rig about the HEAD — turning in place rather than orbiting the rig origin. */
  const turn = (delta: number): void => {
    const h = head();
    if (!rig3 || !h) return;
    const px = rig3.position.x - h.x;
    const pz = rig3.position.z - h.z;
    const c = Math.cos(delta);
    const s = Math.sin(delta);
    rig3.position.x = h.x + px * c + pz * s;
    rig3.position.z = h.z - px * s + pz * c;
    rig3.rotation.y += delta;
  };
  const clampToPlatform = (): void => {
    const h = head();
    if (!h) return;
    const d = Math.hypot(h.x, h.z);
    if (d > PLATFORM_R) shift((h.x / d) * (PLATFORM_R - d), (h.z / d) * (PLATFORM_R - d));
  };

  // ---- height ---------------------------------------------------------------------------------
  let autoLift = 0;
  let manualLift = 0;
  const applyLift = (): void => {
    if (rig3) rig3.position.y = autoLift + manualLift;
  };
  /** Measure the head against the design height and lift a seated user; false if there's no real
   *  head pose to measure yet. */
  const calibrate = (): boolean => {
    const h = head();
    if (!h || !rig3) return false;
    const eye = h.y - rig3.position.y; // head height above the tracked floor
    if (eye < 0.3) return false; // no real pose yet
    const need = DESIGN_EYE - eye;
    autoLift = need > SEATED_GAP ? Math.min(MAX_LIFT, need) : 0;
    manualLift = Math.min(MAX_LIFT - autoLift, Math.max(MIN_LIFT - autoLift, manualLift));
    applyLift();
    return true;
  };
  const nudgeHeight = (dy: number): void => {
    manualLift = Math.min(MAX_LIFT - autoLift, Math.max(MIN_LIFT - autoLift, manualLift + dy));
    applyLift();
  };
  const goToBoard = (): void => {
    const fit = opts.panelFit();
    turn(-headYaw());
    const h = head();
    if (!h) return;
    shift(fit.x - h.x, fit.z + WRITE_DIST - h.z);
    calibrate();
  };

  // ---- teleport (teleport.ts traces, draws, and blinks; the rig stays ours) ---------------------
  const teleport = createTeleport({
    aframe: opts.aframe,
    scene: opts.scene,
    controller: right,
    panelFit: opts.panelFit,
    radius: PLATFORM_R,
  });

  // ---- controller tips (left hand) --------------------------------------------------------------
  const help = document.createElement("a-image");
  const renderHelp = (): void => {
    const tips = textCard(HELP_KEYS.map((k) => t(k)));
    help.setAttribute("src", tips.url);
    help.setAttribute("width", "0.22");
    help.setAttribute("height", (0.22 * tips.aspect).toFixed(3));
  };
  renderHelp();
  const offLocale = onLocaleChange(renderHelp);
  help.setAttribute("position", "0 0.09 0.02");
  help.setAttribute("rotation", "-40 0 0");
  help.setAttribute("visible", "false");
  left.appendChild(help);
  let helpOn = true;
  const inVR = (): boolean => !!sceneEl.is?.("vr-mode");
  const syncHelp = (): void => help.setAttribute("visible", String(helpOn && inVR()));

  // ---- input -----------------------------------------------------------------------------------
  const stick: Record<Hand, { x: number; y: number }> = {
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
  };
  const onStick = (e: Event): void => {
    const hand: Hand | null = e.target === left ? "left" : e.target === right ? "right" : null;
    if (!hand) return;
    const d = (e as CustomEvent<{ x?: number; y?: number }>).detail;
    stick[hand] = { x: d?.x ?? 0, y: d?.y ?? 0 };
  };
  // A controller that drops out mid-push must not leave its last stick value driving the rig.
  const onDisconnect = (e: Event): void => {
    if (e.target === left) stick.left = { x: 0, y: 0 };
    if (e.target === right) stick.right = { x: 0, y: 0 };
  };
  const onA = (): void => goToBoard();
  const onB = (): void => opts.onDrop();
  const onY = (): void => nudgeHeight(HEIGHT_STEP);
  const onX = (): void => nudgeHeight(-HEIGHT_STEP);
  const onLeftStickClick = (): void => {
    helpOn = !helpOn;
    syncHelp();
  };
  left.addEventListener("thumbstickmoved", onStick);
  right.addEventListener("thumbstickmoved", onStick);
  left.addEventListener("controllerdisconnected", onDisconnect);
  right.addEventListener("controllerdisconnected", onDisconnect);
  right.addEventListener("abuttondown", onA);
  right.addEventListener("bbuttondown", onB);
  left.addEventListener("ybuttondown", onY);
  left.addEventListener("xbuttondown", onX);
  left.addEventListener("thumbstickdown", onLeftStickClick);

  let pendingCalibration = false;
  let enteredAt = 0;
  let aiming = false;
  let target: XYZ | null = null;
  const onEnter = (): void => {
    pendingCalibration = true;
    enteredAt = performance.now();
    syncHelp();
  };
  const onExit = (): void => {
    // Back to the magic-window preview: reset the rig so the desktop view is where it started.
    pendingCalibration = false;
    aiming = false;
    target = null;
    autoLift = 0;
    manualLift = 0;
    stick.left = { x: 0, y: 0 };
    stick.right = { x: 0, y: 0 };
    teleport.cancel();
    if (rig3) {
      rig3.position.set(0, 0, 0);
      rig3.rotation.y = 0;
    }
    syncHelp();
  };
  opts.scene.addEventListener("enter-vr", onEnter);
  opts.scene.addEventListener("exit-vr", onExit);

  // ---- per frame ---------------------------------------------------------------------------------
  let snapArmed = true;
  let lastT = 0;
  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0);
    lastT = now;
    // Seated check once the headset's pose has settled after entry (kept pending until a real pose
    // is there to measure, within reason).
    if (pendingCalibration && inVR() && now - enteredAt > CALIBRATE_DELAY_MS) {
      if (calibrate() || now - enteredAt > CALIBRATE_GIVE_UP_MS) pendingCalibration = false;
    }
    // Walk: left stick, relative to where the head faces (stick up is y = −1).
    const l = stick.left;
    const mag = Math.hypot(l.x, l.y);
    if (mag > DEADZONE && dt > 0) {
      const yaw = headYaw();
      const k = (WALK_SPEED * dt * (mag - DEADZONE)) / (1 - DEADZONE) / mag;
      const fwd = -l.y * k;
      const side = l.x * k;
      shift(
        -Math.sin(yaw) * fwd + Math.cos(yaw) * side,
        -Math.cos(yaw) * fwd - Math.sin(yaw) * side,
      );
    }
    // Right stick: push up to aim a teleport (release to jump), or flick sideways to snap-turn.
    const r = stick.right;
    if (!aiming && r.y < -0.6 && Math.abs(r.y) > Math.abs(r.x)) aiming = true;
    if (aiming) {
      if (r.y > -0.3) {
        // Released: jump (behind a short blink) if the arc found somewhere valid; else nothing.
        aiming = false;
        const dest = target;
        target = null;
        if (dest) {
          teleport.jump(() => {
            const h = head();
            if (h) shift(dest.x - h.x, dest.z - h.z);
          });
        } else {
          teleport.cancel();
        }
      } else {
        target = teleport.aim();
      }
    } else if (snapArmed && Math.abs(r.x) > 0.7) {
      snapArmed = false;
      turn(r.x > 0 ? -SNAP_TURN : SNAP_TURN);
    }
    if (Math.abs(r.x) < 0.3) snapArmed = true;
    clampToPlatform();
  };
  const offTick = onSceneTick(tick);

  return {
    goToBoard,
    nudgeHeight,
    rig: () => ({
      x: rig3?.position.x ?? 0,
      y: rig3?.position.y ?? 0,
      z: rig3?.position.z ?? 0,
      yaw: rig3?.rotation.y ?? 0,
    }),
    head,
    teleport: () => teleport.state(),
    destroy() {
      offTick();
      left.removeEventListener("thumbstickmoved", onStick);
      right.removeEventListener("thumbstickmoved", onStick);
      left.removeEventListener("controllerdisconnected", onDisconnect);
      right.removeEventListener("controllerdisconnected", onDisconnect);
      right.removeEventListener("abuttondown", onA);
      right.removeEventListener("bbuttondown", onB);
      left.removeEventListener("ybuttondown", onY);
      left.removeEventListener("xbuttondown", onX);
      left.removeEventListener("thumbstickdown", onLeftStickClick);
      opts.scene.removeEventListener("enter-vr", onEnter);
      opts.scene.removeEventListener("exit-vr", onExit);
      teleport.destroy();
      offLocale();
      help.remove();
    },
  };
}
