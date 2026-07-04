// TEST-ONLY — never imported by app code. The e2e suite dynamic-imports this through the dev server
// to install Meta's iwer (Immersive Web Emulation Runtime): a fake WebXR device + Quest controllers,
// so the REAL immersive path — session grant, laser-controls, trigger events — runs headlessly.

import { metaQuest3, XRDevice } from "iwer";

export interface FakeXRHandle {
  /** Point `hand`'s controller from `from` toward `to` (world metres). */
  aim(hand: "left" | "right", from: [number, number, number], to: [number, number, number]): void;
  trigger(hand: "left" | "right", pressed: boolean): void;
  /** Squeeze the grip button (grip-grab). */
  grip(hand: "left" | "right", pressed: boolean): void;
  /** Introspection for debugging API-shape mismatches. */
  describe(): string;
}

interface ControllerLike {
  position?: {
    set?: (x: number, y: number, z: number) => void;
    x?: number;
    y?: number;
    z?: number;
  };
  quaternion?: {
    set?: (x: number, y: number, z: number, w: number) => void;
    x?: number;
    y?: number;
    z?: number;
    w?: number;
  };
  updateButtonValue?: (name: string, value: number) => void;
  gamepad?: unknown;
}

export function installFakeXR(): FakeXRHandle {
  const device = new XRDevice(metaQuest3);
  device.installRuntime();
  (window as unknown as { __xrDevice?: unknown }).__xrDevice = device;

  const controller = (hand: "left" | "right"): ControllerLike | null => {
    const d = device as unknown as {
      controllers?: Record<string, ControllerLike> | Map<string, ControllerLike>;
    };
    const c = d.controllers;
    if (!c) return null;
    if (c instanceof Map) return c.get(hand) ?? null;
    return (c as Record<string, ControllerLike>)[hand] ?? null;
  };

  const setVec = (v: ControllerLike["position"], x: number, y: number, z: number): void => {
    if (!v) return;
    if (v.set) v.set(x, y, z);
    else {
      v.x = x;
      v.y = y;
      v.z = z;
    }
  };

  return {
    aim(hand, from, to) {
      const c = controller(hand);
      if (!c) return;
      // Quaternion rotating the controller's -Z ray onto the from→to direction.
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const dz = to[2] - from[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const d = { x: dx / len, y: dy / len, z: dz / len };
      // a = (0,0,-1) → b = d:  axis = a×b = (d.y, -d.x, 0),  w = 1 + a·b = 1 - d.z
      let qx = d.y;
      let qy = -d.x;
      let qz = 0;
      let qw = 1 - d.z;
      const qlen = Math.hypot(qx, qy, qz, qw);
      if (qlen < 1e-6) {
        // pointing straight backward — rotate 180° about Y
        qx = 0;
        qy = 1;
        qz = 0;
        qw = 0;
      } else {
        qx /= qlen;
        qy /= qlen;
        qz /= qlen;
        qw /= qlen;
      }
      setVec(c.position, from[0], from[1], from[2]);
      if (c.quaternion?.set) c.quaternion.set(qx, qy, qz, qw);
      else if (c.quaternion) {
        c.quaternion.x = qx;
        c.quaternion.y = qy;
        c.quaternion.z = qz;
        c.quaternion.w = qw;
      }
    },
    trigger(hand, pressed) {
      const c = controller(hand);
      c?.updateButtonValue?.("trigger", pressed ? 1 : 0);
    },
    grip(hand, pressed) {
      const c = controller(hand);
      c?.updateButtonValue?.("squeeze", pressed ? 1 : 0);
    },
    describe() {
      const d = device as unknown as Record<string, unknown>;
      const c = controller("right") as unknown as Record<string, unknown> | null;
      return JSON.stringify({
        deviceKeys: Object.keys(d).slice(0, 30),
        rightKeys: c ? Object.keys(c).slice(0, 30) : null,
        hasUpdateButton: !!c?.updateButtonValue,
      });
    },
  };
}
