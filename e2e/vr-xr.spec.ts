import { expect, test } from "@playwright/test";

import { connectPeer, injectSticky, objectIds, uniqueRoom } from "./helpers";

/**
 * Emulated-headset smoke (M4): Meta's iwer fakes a Quest + controllers in headless Chromium, so the
 * REAL immersive path runs in CI — session grant via scene.enterVR(), laser-controls binding, and
 * trigger-driven tool events. This is the strongest no-hardware validation we can get; real-device
 * checks remain for comfort/perf only.
 */

test("emulated headset: immersive session + laser select + laser draw", async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await connectPeer(browser, uniqueRoom("vrxr"));
  a.page.on("console", (m) => {
    if (m.text().includes("[xr]")) console.log(m.text());
  });
  // Big target: the emulated pointer ray carries the Quest profile's angled-pointer offset, so
  // give the select tap a generous landing zone.
  await injectSticky(a.page, { id: "s1", x: -350, y: -350, size: 700, bg: "#ffd43b" });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  // Install the fake XR device BEFORE entering VR, so isSessionSupported() resolves true.
  await a.page.evaluate(async () => {
    const mod = (await import("/src/vr/test-xr.ts")) as {
      installFakeXR(): { describe(): string };
    };
    const handle = mod.installFakeXR();
    (window as unknown as { __xrTest?: unknown }).__xrTest = handle;
    console.log("[xr]", handle.describe());
  });

  await a.page.locator("#nav-toggle").click();
  await a.page.locator('.app-menu [data-act="vr"]').click();
  await expect(a.page.locator("a-scene")).toBeVisible({ timeout: 30_000 });
  await a.page.waitForFunction(() => !!(window as { __komuvr?: unknown }).__komuvr);

  // The auto-enter can be rejected (user-activation expires during the lazy load — the exact
  // reason the goggles button exists). Enter like a real user: click A-Frame's VR button, which
  // only renders because the emulated device made immersive-vr supported.
  await a.page.waitForTimeout(1500);
  const inVR = () =>
    a.page.evaluate(() =>
      (document.querySelector("a-scene") as unknown as { is(s: string): boolean }).is("vr-mode"),
    );
  if (!(await inVR())) {
    await a.page.locator(".a-enter-vr-button").click({ timeout: 10_000 });
  }
  await expect.poll(inVR, { timeout: 15_000 }).toBe(true);

  await a.page.waitForTimeout(2000); // model fit + first draw settle

  // Aim the right laser at the panel and pull the trigger → SELECT the sticky.
  const panelPos = await a.page.evaluate(() => {
    const p = document.getElementById("vr-board") as unknown as {
      object3D: { position: { x: number; y: number; z: number } };
    };
    return { x: p.object3D.position.x, y: p.object3D.position.y, z: p.object3D.position.z };
  });
  const xr = (fn: string, ...args: unknown[]) =>
    a.page.evaluate(
      ([f, aa]) =>
        (
          window as unknown as {
            __xrTest: Record<string, (...a: unknown[]) => unknown>;
          }
        ).__xrTest[f as string](...(aa as unknown[])),
      [fn, args] as const,
    );

  await xr("aim", "right", [0.25, 1.5, 0.2], [panelPos.x, panelPos.y, panelPos.z]);
  await a.page.waitForTimeout(400); // laser raycaster ticks onto the panel
  await xr("trigger", "right", true);
  await a.page.waitForTimeout(150);
  await xr("trigger", "right", false);
  await expect
    .poll(
      () =>
        a.page.evaluate(() =>
          (window as unknown as { __komuvr: { selection(): string[] } }).__komuvr.selection(),
        ),
      { timeout: 10_000 },
    )
    .toEqual(["s1"]);

  // Switch to the pen and DRAW with the laser: hold the trigger while sweeping the aim.
  await a.page.evaluate(() =>
    (window as unknown as { __komuvr: { setTool(t: string): void } }).__komuvr.setTool("pen"),
  );
  await xr("aim", "right", [0.25, 1.5, 0.2], [panelPos.x - 0.5, panelPos.y - 0.2, panelPos.z]);
  await a.page.waitForTimeout(250);
  await xr("trigger", "right", true);
  for (const dx of [-0.3, -0.1, 0.1, 0.3]) {
    await xr("aim", "right", [0.25, 1.5, 0.2], [panelPos.x + dx, panelPos.y - 0.25, panelPos.z]);
    await a.page.waitForTimeout(120);
  }
  await xr("trigger", "right", false);
  await expect.poll(async () => (await objectIds(a.page)).length, { timeout: 10_000 }).toBe(2);

  // GRIP-GRAB: squeeze with the laser on the resting marker → palm-held; release → falls → tray.
  await a.page.evaluate(() =>
    (window as unknown as { __komuvr: { setTool(t: string): void } }).__komuvr.setTool("select"),
  ); // rest both props first
  const propState = () =>
    a.page.evaluate(
      () =>
        (
          window as unknown as {
            __komuvr: {
              propState(): Record<string, { state: string; x: number; y: number; z: number }>;
            };
          }
        ).__komuvr.propState().pen,
    );
  await expect.poll(() => propState().then((s) => s.state), { timeout: 8_000 }).toBe("resting");
  const marker = await propState();
  let grabbed = false;
  for (const dy of [0.03, 0, 0.06, -0.03]) {
    await xr(
      "aim",
      "right",
      [marker.x, marker.y + 0.35, marker.z + 0.55],
      [marker.x, marker.y + dy, marker.z],
    );
    await a.page.waitForTimeout(300);
    await xr("grip", "right", true);
    await a.page.waitForTimeout(250);
    if ((await propState()).state === "held") {
      grabbed = true;
      break;
    }
    await xr("grip", "right", false);
    await a.page.waitForTimeout(150);
  }
  expect(grabbed).toBe(true);
  await xr("grip", "right", false); // let go → gravity → platform → back to the tray
  await expect.poll(() => propState().then((s) => s.state), { timeout: 8_000 }).toBe("resting");

  await a.close();
});
