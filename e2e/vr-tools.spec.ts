import { expect, test } from "@playwright/test";

import { connectPeer, injectSticky, objectIds, uniqueRoom } from "./helpers";

/**
 * VR interaction (M4 stage 3) in the headless magic-window preview: the mouse drives the SAME
 * pointer pipeline controller lasers use, so select / hand-pan / pen / eraser / zoom are all
 * testable without WebXR. Tools switch via the __komuvr hook (projecting the 3D dock's buttons to
 * screen px is brittle; the dock's click path is the same entity-event pipeline as the panel's).
 */

interface KomuVR {
  setTool(t: string): void;
  getTool(): string;
  rect(): { x: number; y: number; width: number; height: number };
  selection(): string[];
  penOptions(): { color: string; width: number; style: string };
  propState(): Record<string, { state: string; x: number; y: number }>;
}
test("VR tools: select, pan, zoom, pen, eraser all work in the preview", async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await connectPeer(browser, uniqueRoom("vrtools"));
  // The default camera viewport is centred on world (0,0). Screen (640,340) maps to roughly world
  // (0,107) on the panel, so size the sticky generously around that.
  await injectSticky(a.page, { id: "s1", x: -150, y: -150, size: 300, bg: "#ffd43b" });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  await a.page.locator("#nav-toggle").click();
  await a.page.locator('.app-menu [data-act="vr"]').click();
  await expect(a.page.locator("a-scene")).toBeVisible({ timeout: 30_000 });
  await a.page.waitForFunction(() => !!(window as { __komuvr?: unknown }).__komuvr);
  await a.page.waitForTimeout(2000); // model fit + first draw settle

  // The floating dock exists (4 tools + 3 zoom keys).
  await expect(a.page.locator("#vr-dock a-plane")).toHaveCount(9); // 4 tools + zoom −/+/fit + undo/redo

  // SELECT: click the panel centre (the sticky) → selection broadcast + hook agrees. The mouse
  // cursor re-raycasts on the frame after a move, so settle briefly between move and press.
  const panelCentre = { x: 640, y: 340 };
  await a.page.mouse.move(panelCentre.x, panelCentre.y);
  await a.page.waitForTimeout(150);
  await a.page.mouse.down();
  await a.page.mouse.up();
  await expect
    .poll(() =>
      a.page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.selection()),
    )
    .toEqual(["s1"]);
  // …and the same ids ride the normal awareness selection field (web peers see it).
  await expect
    .poll(() =>
      a.page.evaluate(
        () =>
          (
            window as unknown as {
              __komuboard: { awareness: { getLocalState(): { selection?: string[] } | null } };
            }
          ).__komuboard.awareness.getLocalState()?.selection ?? null,
      ),
    )
    .toEqual(["s1"]);

  // Cross-reality cursor: hovering the panel published a world-coord cursor for web peers.
  const cursor = await a.page.evaluate(
    () =>
      (
        window as unknown as {
          __komuboard: { awareness: { getLocalState(): { cursor?: unknown } | null } };
        }
      ).__komuboard.awareness.getLocalState()?.cursor ?? null,
  );
  expect(cursor).not.toBeNull();

  // DELETE: the VR selection is removable from the keyboard.
  await a.page.keyboard.press("Delete");
  await expect.poll(async () => (await objectIds(a.page)).length).toBe(0);
  await expect
    .poll(() =>
      a.page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.selection()),
    )
    .toEqual([]);
  // Refill the board for the tool steps below (same geometry the flow expects).
  await injectSticky(a.page, { id: "s2", x: -350, y: -350, size: 700, bg: "#ffd43b" });
  await expect.poll(async () => (await objectIds(a.page)).length).toBe(1);

  // HAND: drag the panel → the viewport rect pans.
  const rect0 = await a.page.evaluate(() =>
    (window as unknown as { __komuvr: KomuVR }).__komuvr.rect(),
  );
  await a.page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.setTool("hand"));
  await a.page.mouse.move(panelCentre.x, panelCentre.y);
  await a.page.waitForTimeout(150);
  await a.page.mouse.down();
  await a.page.mouse.move(panelCentre.x + 120, panelCentre.y + 40, { steps: 8 });
  await a.page.mouse.up();
  await expect
    .poll(async () => {
      const r = await a.page.evaluate(() =>
        (window as unknown as { __komuvr: KomuVR }).__komuvr.rect(),
      );
      return Math.abs(r.x - rect0.x);
    })
    .toBeGreaterThan(20);

  // ZOOM: wheel over the panel shrinks the rect (zoom in).
  await a.page.mouse.move(panelCentre.x, panelCentre.y);
  await a.page.mouse.wheel(0, -240);
  await expect
    .poll(async () => {
      const r = await a.page.evaluate(() =>
        (window as unknown as { __komuvr: KomuVR }).__komuvr.rect(),
      );
      return r.width;
    })
    .toBeLessThan(rect0.width - 1);

  // PEN: a drag draws a stroke into the SAME doc (web peers get it via normal sync).
  await a.page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.setTool("pen"));
  await a.page.mouse.move(panelCentre.x - 100, panelCentre.y + 80);
  await a.page.waitForTimeout(150);
  await a.page.mouse.down();
  await a.page.mouse.move(panelCentre.x + 60, panelCentre.y + 110, { steps: 10 });
  await a.page.mouse.up();
  await expect.poll(async () => (await objectIds(a.page)).length).toBe(2);

  // ERASER: press on the sticky → it's deleted from the doc.
  await a.page.evaluate(() =>
    (window as unknown as { __komuvr: KomuVR }).__komuvr.setTool("eraser"),
  );
  const ids = await objectIds(a.page);
  // The view panned/zoomed above, so erase by sweeping a wide band across the panel.
  await a.page.mouse.move(400, 250);
  await a.page.waitForTimeout(150);
  await a.page.mouse.down();
  await a.page.mouse.move(900, 420, { steps: 25 });
  await a.page.mouse.up();
  await expect
    .poll(async () => (await objectIds(a.page)).length, { timeout: 10_000 })
    .toBeLessThan(ids.length);

  // TRAY PROPS: the marker + eraser models sit on the whiteboard's tray; clicking one (laser or
  // mouse — same entity-event pipeline as the panel/dock) switches to its tool.
  await expect(a.page.locator("#vr-props [gltf-model]")).toHaveCount(2);
  await a.page.evaluate(() => {
    document
      .querySelectorAll("#vr-props [gltf-model]")[0]
      ?.dispatchEvent(new CustomEvent("click", { detail: {} }));
  });
  await expect
    .poll(() =>
      a.page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.getTool()),
    )
    .toBe("pen");

  // PEN SUBMENU: appears with the pen tool; picking a colour updates the stroke options AND tints
  // the marker asset itself.
  await expect(a.page.locator("#vr-penmenu a-plane[data-opt]")).toHaveCount(15, { timeout: 5000 });
  await a.page.evaluate(() => {
    document
      .querySelector('[data-opt="color:#DC2626"]')
      ?.dispatchEvent(new CustomEvent("click", { detail: {} }));
  });
  await expect
    .poll(() =>
      a.page.evaluate(
        () => (window as unknown as { __komuvr: KomuVR }).__komuvr.penOptions().color,
      ),
    )
    .toBe("#DC2626");
  await expect
    .poll(() =>
      a.page.evaluate(() => {
        const ent = document.querySelectorAll("#vr-props [gltf-model]")[0] as unknown as {
          getObject3D?: (k: string) => { traverse(fn: (n: unknown) => void): void } | undefined;
        };
        let hex = "";
        ent?.getObject3D?.("mesh")?.traverse((n) => {
          const m = n as { isMesh?: boolean; material?: { color?: { getHexString(): string } } };
          if (!hex && m.isMesh && m.material?.color) hex = m.material.color.getHexString();
        });
        return hex;
      }),
    )
    .toBe("dc2626");

  // HELD MARKER is a physical object: it rides the pointer across the board…
  const penProp = () =>
    a.page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.propState().pen);
  await a.page.mouse.move(520, 300);
  await a.page.waitForTimeout(250);
  const held1 = await penProp();
  await a.page.mouse.move(760, 300);
  await a.page.waitForTimeout(250);
  const held2 = await penProp();
  expect(held1.state).toBe("held");
  expect(held2.x).toBeGreaterThan(held1.x + 0.1);

  // …and G lets go: it falls under gravity, hits the platform, and returns to the tray.
  await a.page.keyboard.press("g");
  await expect.poll(() => penProp().then((s) => s.state), { timeout: 2000 }).not.toBe("held");
  await expect.poll(() => penProp().then((s) => s.state), { timeout: 8000 }).toBe("resting");

  // KEYBOARD (preview): the 2D letters drive VR tools; other keys are swallowed (the 2D dock
  // must NOT react underneath); Escape exits back to 2D; ⌘Z passes through and undoes the VR stroke.
  await a.page.keyboard.press("p");
  await expect
    .poll(() =>
      a.page.evaluate(() => (window as unknown as { __komuvr: KomuVR }).__komuvr.getTool()),
    )
    .toBe("pen");
  await a.page.keyboard.press("s"); // a 2D hotkey (sticky) — must not arm the hidden 2D tool
  await a.page.waitForTimeout(200);
  await expect(a.page.locator('komu-tool-dock [data-tool="sticky"]')).not.toHaveClass(/active/);
  const beforeUndo = (await objectIds(a.page)).length;
  await a.page.keyboard.press("Control+z"); // pass-through undo — reverts the eraser's deletion
  await expect.poll(async () => (await objectIds(a.page)).length).toBeGreaterThan(beforeUndo);

  // DOCK history buttons (mobile-parity): redo re-applies the deletion, undo reverts it again.
  await a.page.evaluate(() =>
    document
      .querySelector('#vr-dock [data-act="redo"]')
      ?.dispatchEvent(new CustomEvent("click", { detail: {} })),
  );
  await expect.poll(async () => (await objectIds(a.page)).length).toBe(beforeUndo);
  await a.page.evaluate(() =>
    document
      .querySelector('#vr-dock [data-act="undo"]')
      ?.dispatchEvent(new CustomEvent("click", { detail: {} })),
  );
  await expect.poll(async () => (await objectIds(a.page)).length).toBeGreaterThan(beforeUndo);
  // WASD movement (A-Frame's wasd-controls, deliberately not swallowed): walk forward.
  const camZ0 = await a.page.evaluate(
    () =>
      (
        document.querySelector("a-scene") as unknown as {
          camera: { el: { object3D: { position: { z: number } } } };
        }
      ).camera.el.object3D.position.z,
  );
  await a.page.keyboard.down("w");
  await a.page.waitForTimeout(450);
  await a.page.keyboard.up("w");
  const camZ1 = await a.page.evaluate(
    () =>
      (
        document.querySelector("a-scene") as unknown as {
          camera: { el: { object3D: { position: { z: number } } } };
        }
      ).camera.el.object3D.position.z,
  );
  expect(camZ1).toBeLessThan(camZ0 - 0.05);

  await a.page.keyboard.press("Escape");
  await expect(a.page.locator("a-scene")).toHaveCount(0);

  await a.close();
});
