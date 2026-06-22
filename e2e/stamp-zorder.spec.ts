import { type Page, expect, test } from "@playwright/test";
import {
  type BoardWindow,
  calibrate,
  connectPeer,
  injectShape,
  injectStamp,
  injectSticky,
  objJSON,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/**
 * Stamp z-order coverage (ADR-0009): a stamp placed AFTER a sticky + a shape must stack ON TOP
 * (FigJam placement order), and so must its translucent placement PREVIEW. The preview regressed
 * because the ghost was drawn on the Konva overlay (beneath the DOM object layer) while the committed
 * stamp is a DOM `.komu-stamp` (above) — so the preview appeared under the sticky, then popped on top.
 */

/** A sticky at (0,0) 180² + a rectangle overlapping it — the scene both placement + preview test. */
async function stickyAndShape(page: Page): Promise<void> {
  await injectSticky(page, { id: "sticky1", x: 0, y: 0, size: 180, bg: "#ffec99" });
  await injectShape(page, { id: "shape1", x: 40, y: 40, width: 160, height: 120, bg: "#a5d8ff" });
  await expect.poll(() => page.locator('[data-id="shape1"]').count()).toBe(1);
}

const stampTypeCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      [...(window as unknown as BoardWindow).__komuboard.doc.getMap("objects").values()].filter(
        (m) => m.get("type") === "stamp",
      ).length,
  );

test("stamp placed last stacks on top of an overlapping sticky + shape (DOM order)", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("stampz"));
  await injectSticky(a.page, { id: "sticky1", x: 0, y: 0, size: 180 });
  await injectShape(a.page, { id: "shape1", x: 40, y: 40, width: 160, height: 120, bg: "#a5d8ff" });
  await injectStamp(a.page, { id: "stamp1", x: 90, y: 90, size: 64 }); // centre over both, placed last
  await expect.poll(() => a.page.locator(".komu-stamp").count()).toBe(1);

  const idx = await a.page.evaluate(() => {
    const layer = document.querySelector(".text-layer")!;
    const kids = [...layer.children].map((el) => (el as HTMLElement).dataset?.id ?? null);
    return {
      sticky: kids.indexOf("sticky1"),
      shape: kids.indexOf("shape1"),
      stamp: kids.indexOf("stamp1"),
    };
  });
  // Later in DOM source order = painted on top.
  expect(idx.stamp).toBeGreaterThan(idx.sticky);
  expect(idx.stamp).toBeGreaterThan(idx.shape);

  await a.close();
});

test("REAL stamp tool: tap on an overlapping sticky+shape places the stamp on top", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("stampzreal"));
  await stickyAndShape(a.page);

  const cal = await calibrate(a.page);
  // Arm + activate the REAL stamp tool exactly as the app does, then tap over the overlap (~world 90,90).
  await a.page.evaluate(() => {
    const c = (window as unknown as BoardWindow).__komuboard.canvas!;
    c.setStamp("emoji:2705"); // ✅
    c.setTool("stamp");
  });
  const at = worldToScreen(cal, 90, 90);
  await a.page.mouse.move(at.x, at.y);
  await a.page.mouse.down();
  await a.page.mouse.up();

  // A stamp object is created and lands LAST in orderArray. Count only COMMITTED stamps (they carry a
  // data-id) — the armed tool also keeps a `.komu-stamp.komu-text-ghost` preview onscreen.
  await expect.poll(() => a.page.locator(".komu-stamp[data-id]").count()).toBe(1);
  const order = await a.page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.doc.getArray("order").toArray(),
  );
  const stampId = order[order.length - 1]!;
  expect((await objJSON(a.page, stampId))!.type).toBe("stamp");

  // DOM: the committed stamp is the last data-id child of the text-layer (painted on top).
  const lastIsStamp = await a.page.evaluate((id) => {
    const layer = document.querySelector(".text-layer")!;
    const objKids = [...layer.children].filter((e) => (e as HTMLElement).dataset?.id);
    const last = objKids[objKids.length - 1] as HTMLElement;
    return last?.dataset.id === id && last.classList.contains("komu-stamp");
  }, stampId);
  expect(lastIsStamp).toBe(true);

  await a.page.screenshot({ path: "test-results/stamp-on-top.png" });
  await a.close();
});

test("REAL stamp tool: the PREVIEW ghost renders above the sticky + shape (not just the commit)", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("stampghost"));
  await stickyAndShape(a.page);

  const cal = await calibrate(a.page);
  await a.page.evaluate(() => {
    const c = (window as unknown as BoardWindow).__komuboard.canvas!;
    c.setStamp("emoji:2705"); // ✅
    c.setTool("stamp");
  });

  // Hover (no click) over the overlap → the translucent preview ghost appears, with NO commit yet.
  const at = worldToScreen(cal, 90, 90);
  await a.page.mouse.move(at.x - 25, at.y - 25);
  await a.page.mouse.move(at.x, at.y, { steps: 4 });

  await expect.poll(() => a.page.locator(".komu-stamp.komu-text-ghost").count()).toBe(1);
  expect(await stampTypeCount(a.page)).toBe(0); // it's only a preview — nothing committed

  // The ghost is the LAST child of the text-layer → painted above the sticky + shape (the bug was it
  // drew on the Konva overlay BENEATH the DOM layer, so the preview appeared under them).
  const ghostIsLast = await a.page.evaluate(() => {
    const layer = document.querySelector(".text-layer")!;
    const last = layer.children[layer.children.length - 1] as HTMLElement;
    return last?.classList.contains("komu-stamp") && last.classList.contains("komu-text-ghost");
  });
  expect(ghostIsLast).toBe(true);

  await a.page.screenshot({ path: "test-results/stamp-ghost-on-top.png" });
  await a.close();
});
