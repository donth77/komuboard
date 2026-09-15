import { expect, test, type Page } from "@playwright/test";

import { connectPeer, objectIds, uniqueRoom } from "./helpers";

/**
 * VR comfort on an emulated Quest (iwer): what a real headset user needs to reach the board from a
 * small or seated play space — seated height calibration, stick walking, snap turn, teleport, "go
 * to the board", manual height — and the marker held like a marker: taken into the hand tip-first
 * along the laser, drawing by TOUCHING the board, B putting it down, grip near-grab.
 */

interface XYZ {
  x: number;
  y: number;
  z: number;
}
interface PropDebug extends XYZ {
  state: string;
  hand: string | null;
  tip: XYZ | null;
  axis: XYZ | null;
}
interface KomuVR {
  rig(): XYZ & { yaw: number };
  head(): XYZ | null;
  fit(): XYZ & { width: number; height: number };
  propState(): Record<string, PropDebug>;
  getTool(): string;
  boardShown(): boolean;
  controller(hand: Hand): HTMLElement;
  teleport(): {
    aiming: boolean;
    valid: boolean;
    target: XYZ | null;
    hit: string | null;
    end: XYZ | null;
    blink: number;
  };
}
type Hand = "left" | "right";
type Vec = [number, number, number];

const komu = (page: Page) => ({
  rig: () => page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.rig()),
  head: () => page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.head()),
  fit: () => page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.fit()),
  teleport: () =>
    page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.teleport()),
  prop: (tool: "pen" | "eraser") =>
    page.evaluate(
      (t) => (window as unknown as { __komuvr: KomuVR }).__komuvr.propState()[t] as PropDebug,
      tool,
    ),
});

/** Drive the fake device installed by /src/vr/test-xr.ts. */
const xr = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, aa]) =>
      (
        window as unknown as {
          __xrTest: Record<string, (...a: unknown[]) => unknown>;
        }
      ).__xrTest[f as string](...(aa as unknown[])),
    [fn, args] as const,
  );

const press = async (page: Page, hand: Hand, id: "a" | "b" | "x" | "y") => {
  await xr(page, "button", hand, id, true);
  await page.waitForTimeout(150);
  await xr(page, "button", hand, id, false);
  await page.waitForTimeout(150);
};

test("emulated headset: seated user can get to the board, turn, teleport, and adjust height", async ({
  browser,
}) => {
  test.setTimeout(240_000); // CI runners render VR at a crawl
  const a = await connectPeer(browser, uniqueRoom("vrcomfort"));
  const page = a.page;
  const k = komu(page);

  // A SEATED user: the headset sits at a seated eye height before the session starts.
  await page.evaluate(async () => {
    const mod = (await import("/src/vr/test-xr.ts")) as {
      installFakeXR(): { head(x: number, y: number, z: number): void };
    };
    const handle = mod.installFakeXR();
    handle.head(0, 1.1, 0);
    (window as unknown as { __xrTest?: unknown }).__xrTest = handle;
  });
  await enterImmersive(page);

  // SEATED: lifted so the eyes sit where the scene is designed to be seen from — a standing adult's
  // 1.6 m, looking slightly down at the middle of the board — instead of level with its tray.
  const DESIGN_EYE = 1.6;
  const fit = await k.fit();
  await expect
    .poll(async () => (await k.head())?.y ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(DESIGN_EYE - 0.05);
  expect((await k.rig()).y).toBeGreaterThan(0.4);
  // The controller tips are shown in-headset.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const img = document.querySelector("[laser-controls] a-image") as unknown as {
          getAttribute(n: string): unknown;
        } | null;
        return img?.getAttribute("visible");
      }),
    )
    .toBe(true);

  // WALK: left stick forward → the head moves toward the board (−z).
  const h0 = (await k.head())!;
  await xr(page, "stick", "left", 0, -1);
  await page.waitForTimeout(700);
  await xr(page, "stick", "left", 0, 0);
  const h1 = (await k.head())!;
  expect(h1.z).toBeLessThan(h0.z - 0.2);

  // TELEPORT: right stick up aims an arc; a valid floor landing is offered, and releasing blinks
  // the head onto it — and the blink always clears. (The emulated pointer ray carries the Quest
  // profile's angled offset, so steer by the traced result rather than assumed geometry.)
  const r1 = await k.rig();
  await xr(page, "stick", "right", 0, -1);
  let aimed = await k.teleport();
  for (const to of [
    [0.2, 0, -0.45],
    [0.9, 0, -0.3],
    [-0.5, 0, -0.3],
    [0.2, 0, 0.5],
  ]) {
    await xr(page, "aim", "right", [0.2, 1.0, -0.2], to);
    await page.waitForTimeout(350);
    aimed = await k.teleport();
    if (aimed.valid) break;
  }
  expect(aimed).toMatchObject({ aiming: true, valid: true, hit: "floor" });
  expect(aimed.end).toEqual(aimed.target);
  // The jump happens behind a blink: sample its opacity in-page (frames can be slower than any
  // round-trip here) to prove it closes fully, then clears.
  await page.evaluate(() => {
    const w = window as unknown as { __komuvr: KomuVR; __blinkMax?: number };
    w.__blinkMax = 0;
    const id = setInterval(() => {
      w.__blinkMax = Math.max(w.__blinkMax ?? 0, w.__komuvr.teleport().blink);
    }, 4);
    setTimeout(() => clearInterval(id), 5000);
  });
  await xr(page, "stick", "right", 0, 0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __blinkMax: number }).__blinkMax))
    .toBeGreaterThan(0.9);
  await expect.poll(async () => (await k.teleport()).blink).toBe(0);
  const h2 = (await k.head())!;
  expect(Math.hypot(h2.x - aimed.target!.x, h2.z - aimed.target!.z)).toBeLessThan(0.05);
  expect(Math.hypot(h2.x - h1.x, h2.z - h1.z)).toBeGreaterThan(0.1);
  expect((await k.rig()).y).toBeCloseTo(r1.y, 5); // teleport never changes your height
  expect(await k.teleport()).toMatchObject({ aiming: false, blink: 0 });

  // INVALID: an arc flung off the platform turns red, and a release goes nowhere.
  await xr(page, "aim", "right", [0.3, 1.2, -0.1], [3, 1.6, -0.3]);
  await xr(page, "stick", "right", 0, -1);
  await page.waitForTimeout(400);
  expect(await k.teleport()).toMatchObject({ aiming: true, valid: false, target: null });
  await xr(page, "stick", "right", 0, 0);
  await page.waitForTimeout(400);
  const h2b = (await k.head())!;
  expect(Math.hypot(h2b.x - h2.x, h2b.z - h2.z)).toBeLessThan(0.01);

  // SNAP TURN: flick the right stick → the rig yaws 45° about the head, which stays put.
  const yaw0 = (await k.rig()).yaw;
  await xr(page, "stick", "right", 1, 0);
  await page.waitForTimeout(300);
  await xr(page, "stick", "right", 0, 0);
  await page.waitForTimeout(200);
  expect((await k.rig()).yaw).toBeCloseTo(yaw0 - Math.PI / 4, 3);
  const h3 = (await k.head())!;
  expect(Math.hypot(h3.x - h2.x, h3.z - h2.z)).toBeLessThan(0.02);

  // GO TO THE BOARD (A): facing it at writing distance, still at the design eye height.
  await press(page, "right", "a");
  await expect
    .poll(async () => {
      const h = await k.head();
      return h ? Math.abs(h.z - (fit.z + 0.55)) + Math.abs(h.x - fit.x) : 9;
    })
    .toBeLessThan(0.03);
  expect(Math.abs((await k.rig()).yaw) % (2 * Math.PI)).toBeLessThan(0.01);
  expect((await k.head())!.y).toBeCloseTo(DESIGN_EYE, 1);

  // HEIGHT: Y raises the view 10 cm, X lowers it again.
  const y0 = (await k.rig()).y;
  await press(page, "left", "y");
  expect((await k.rig()).y).toBeCloseTo(y0 + 0.1, 5);
  await press(page, "left", "x");
  expect((await k.rig()).y).toBeCloseTo(y0, 5);

  await a.close();
});

test("emulated headset: the marker is held tip-first and draws by touching the board", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const a = await connectPeer(browser, uniqueRoom("vrmarker"));
  const page = a.page;
  const k = komu(page);
  await page.evaluate(async () => {
    const mod = (await import("/src/vr/test-xr.ts")) as { installFakeXR(): unknown };
    (window as unknown as { __xrTest?: unknown }).__xrTest = mod.installFakeXR();
  });
  await enterImmersive(page);
  await press(page, "right", "a"); // stand at the board
  await expect.poll(async () => (await k.head())?.z ?? 0).toBeLessThan(-0.8);
  const fit = await k.fit();
  const rig = await k.rig(); // yawed to face the board → rig-local = world − rig position
  const local = (w: XYZ): Vec => [w.x - rig.x, w.y - rig.y, w.z - rig.z];

  // TRIGGER-GRAB (the laser click a trigger produces on the marker): it goes INTO the right hand.
  await expect.poll(() => k.prop("pen").then((p) => p.state), { timeout: 8_000 }).toBe("resting");
  const start: XYZ = { x: fit.x + 0.15, y: fit.y - 0.35, z: fit.z + 0.4 };
  const dir: Vec = [0, 0.45, -1]; // tilted up: the Quest's pointer ray angles down from the grip
  // Where aim() last put the controller — iwer's TARGET-RAY pose; the grip A-Frame tracks (and the
  // prop rides) is a fixed offset from it, so translations must be applied to this point.
  let handAt: XYZ = start;
  const aimFrom = (c: XYZ) => {
    handAt = c;
    return xr(page, "aim", "right", local(c), [
      local(c)[0] + dir[0],
      local(c)[1] + dir[1],
      local(c)[2] + dir[2],
    ]);
  };
  await aimFrom(start);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const right = (window as unknown as { __komuvr: KomuVR }).__komuvr.controller("right");
    document
      .querySelectorAll("#vr-props [gltf-model]")[0]
      ?.dispatchEvent(new CustomEvent("click", { bubbles: true, detail: { cursorEl: right } }));
  });
  await expect.poll(() => k.prop("pen").then((p) => p.hand)).toBe("right");
  expect(
    await page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.getTool()),
  ).toBe("pen");

  // HELD LIKE A MARKER: the tip points along the laser (not sideways across the hand), and it is
  // the model's real tip end.
  await page.waitForTimeout(200);
  const held = await k.prop("pen");
  const ray = await page.evaluate(() => {
    const right = (window as unknown as { __komuvr: KomuVR }).__komuvr.controller(
      "right",
    ) as unknown as {
      components: { raycaster: { raycaster: { ray: { origin: XYZ; direction: XYZ } } } };
    };
    const r = right.components.raycaster.raycaster.ray;
    return {
      origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z },
      direction: { x: r.direction.x, y: r.direction.y, z: r.direction.z },
    };
  });
  const dot =
    held.axis!.x * ray.direction.x +
    held.axis!.y * ray.direction.y +
    held.axis!.z * ray.direction.z;
  expect(dot).toBeGreaterThan(0.98);
  const ahead =
    (held.tip!.x - ray.origin.x) * ray.direction.x +
    (held.tip!.y - ray.origin.y) * ray.direction.y +
    (held.tip!.z - ray.origin.z) * ray.direction.z;
  expect(ahead).toBeGreaterThan(0.05); // the tip leads, out past the controller
  const glbTip = await page.evaluate(() => {
    let out: XYZ | null = null;
    const ent = document.querySelectorAll("#vr-props [gltf-model]")[0] as unknown as {
      object3D: { traverse(fn: (n: unknown) => void): void };
    };
    ent.object3D.traverse((n) => {
      const m = n as {
        isMesh?: boolean;
        material?: { name?: string };
        geometry?: {
          computeBoundingBox(): void;
          boundingBox: {
            min: { clone(): { add(v: unknown): { multiplyScalar(s: number): unknown } } };
            max: unknown;
          };
        };
        localToWorld(v: unknown): XYZ;
      };
      if (out || !m.isMesh || m.material?.name !== "AlmostTip" || !m.geometry) return;
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      const c = m.localToWorld(b.min.clone().add(b.max).multiplyScalar(0.5));
      out = { x: c.x, y: c.y, z: c.z };
    });
    return out as XYZ | null;
  });
  expect(glbTip).not.toBeNull();
  const tipGap = Math.hypot(
    glbTip!.x - held.tip!.x,
    glbTip!.y - held.tip!.y,
    glbTip!.z - held.tip!.z,
  );
  expect(tipGap).toBeLessThan(0.03);

  // TOUCH-DRAW: press the tip against the board and sweep — no trigger — then pull away.
  const before = (await objectIds(page)).length;
  /** Translate the hand (orientation unchanged) so the marker tip lands on `target`. */
  const moveTipTo = async (target: XYZ) => {
    const now = await k.prop("pen");
    await aimFrom({
      x: handAt.x + target.x - now.tip!.x,
      y: handAt.y + target.y - now.tip!.y,
      z: handAt.z + target.z - now.tip!.z,
    });
    await page.waitForTimeout(120);
  };
  const liftOff = { x: fit.x - 0.2, y: fit.y - 0.1, z: fit.z + 0.08 };
  await moveTipTo(liftOff);
  for (const dx of [-0.2, -0.1, 0, 0.1, 0.2]) {
    await moveTipTo({ x: fit.x + dx, y: fit.y - 0.1, z: fit.z - 0.004 });
  }
  await moveTipTo({ x: fit.x + 0.2, y: fit.y - 0.1, z: fit.z + 0.1 });
  await expect
    .poll(async () => (await objectIds(page)).length, { timeout: 10_000 })
    .toBe(before + 1);

  // B puts it down: it falls, lands, and returns to the tray.
  await press(page, "right", "b");
  await expect.poll(() => k.prop("pen").then((p) => p.state), { timeout: 2_000 }).not.toBe("held");
  await expect.poll(() => k.prop("pen").then((p) => p.state), { timeout: 8_000 }).toBe("resting");

  // GRIP NEAR-GRAB: squeeze with the hand beside the resting marker → held while squeezed.
  const rest = await k.prop("pen");
  await aimFrom({ x: rest.x + 0.03, y: rest.y + 0.05, z: rest.z + 0.06 });
  await page.waitForTimeout(300);
  await xr(page, "grip", "right", true);
  await expect.poll(() => k.prop("pen").then((p) => p.hand)).toBe("right");
  await xr(page, "grip", "right", false);
  await expect.poll(() => k.prop("pen").then((p) => p.state), { timeout: 8_000 }).toBe("resting");

  await a.close();
});

async function enterImmersive(page: Page): Promise<void> {
  await page.locator("#nav-toggle").click();
  await page.locator('.app-menu [data-act="vr"]').click();
  await expect(page.locator("a-scene")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => !!(window as { __komuvr?: unknown }).__komuvr);
  // The auto-enter can be rejected (user activation expires during the lazy load); enter like a
  // user would, through A-Frame's VR button — it only renders because the fake device exists.
  await page.waitForTimeout(1500);
  const inVR = () =>
    page.evaluate(() =>
      (document.querySelector("a-scene") as unknown as { is(s: string): boolean }).is("vr-mode"),
    );
  if (!(await inVR())) await page.locator(".a-enter-vr-button").click({ timeout: 10_000 });
  await expect.poll(inVR, { timeout: 15_000 }).toBe(true);
  // The board assembly appears once the whiteboard model is fitted.
  await page.waitForFunction(
    () => (window as unknown as { __komuvr: KomuVR }).__komuvr.boardShown(),
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(800); // first draw + calibration settle
}
