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
 * Placement tools (sticky / shapes) must ALWAYS create a new object — even when the tap lands on top
 * of an existing object — and stack it on top (FigJam). The bug: `shapeAt`/`stickyAt` hit-tested first
 * and dropped into the underlying box's text (or no-op'd over a non-editable stamp), so you could never
 * place a shape over a sticky/shape/stamp.
 */

const orderIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as BoardWindow).__komuboard.doc.getArray("order").toArray());

const runsText = (o: { runs?: unknown } | null): string =>
  Array.isArray(o?.runs) ? (o!.runs as { text?: string }[]).map((r) => r.text ?? "").join("") : "";

test("shapes tool: tapping on a sticky places a NEW shape on top (does not edit the sticky)", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("placeshape"));
  await injectSticky(a.page, { id: "sticky1", x: 0, y: 0, size: 180 });
  await expect.poll(() => a.page.locator('[data-id="sticky1"]').count()).toBe(1);

  const cal = await calibrate(a.page);
  await a.page.evaluate(() => {
    const c = (window as unknown as BoardWindow).__komuboard.canvas!;
    c.setShape("rectangle");
    c.setTool("shapes");
  });

  // Tap inside the sticky → a new shape's editor opens; type a label, then commit by leaving the tool.
  const at = worldToScreen(cal, 90, 90);
  await a.page.mouse.move(at.x, at.y);
  await a.page.mouse.down();
  await a.page.mouse.up();
  await a.page.keyboard.type("SHAPE");
  await a.page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.canvas!.setTool("select"),
  );

  // Two objects now: the sticky (still empty) + a NEW rectangle on top carrying the typed label.
  await expect.poll(async () => (await orderIds(a.page)).length).toBe(2);
  const order = await orderIds(a.page);
  expect(order[0]).toBe("sticky1");
  const newId = order[1]!;
  expect(newId).not.toBe("sticky1");

  const created = await objJSON(a.page, newId);
  expect(created!.type).toBe("text");
  expect(created!.shape).toBe("rectangle");
  expect(runsText(created)).toContain("SHAPE");

  // The sticky was NOT edited — its text stays empty.
  expect(runsText(await objJSON(a.page, "sticky1"))).toBe("");

  await a.close();
});

test("shapes tool: tapping on a stamp still places a shape (no silent no-op)", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("placeoverstamp"));
  await injectStamp(a.page, { id: "stamp1", x: 90, y: 90, size: 64 });
  await expect.poll(() => a.page.locator(".co-stamp").count()).toBe(1);

  const cal = await calibrate(a.page);
  await a.page.evaluate(() => {
    const c = (window as unknown as BoardWindow).__komuboard.canvas!;
    c.setShape("ellipse");
    c.setTool("shapes");
  });
  const at = worldToScreen(cal, 90, 90);
  await a.page.mouse.move(at.x, at.y);
  await a.page.mouse.down();
  await a.page.mouse.up();
  await a.page.keyboard.type("OVER");
  await a.page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.canvas!.setTool("select"),
  );

  await expect.poll(async () => (await orderIds(a.page)).length).toBe(2);
  const order = await orderIds(a.page);
  const newId = order[order.length - 1]!;
  expect(newId).not.toBe("stamp1");
  const created = await objJSON(a.page, newId);
  expect(created!.type).toBe("text");
  expect(created!.shape).toBe("ellipse");

  await a.close();
});

test("sticky tool: tapping on a shape places a NEW sticky on top (does not edit the shape)", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("placesticky"));
  await injectShape(a.page, { id: "shape1", x: 0, y: 0, width: 200, height: 160, bg: "#a5d8ff" });
  await expect.poll(() => a.page.locator('[data-id="shape1"]').count()).toBe(1);

  const cal = await calibrate(a.page);
  await a.page.evaluate(() => {
    const c = (window as unknown as BoardWindow).__komuboard.canvas!;
    c.setTool("sticky");
  });
  const at = worldToScreen(cal, 100, 80);
  await a.page.mouse.move(at.x, at.y);
  await a.page.mouse.down();
  await a.page.mouse.up();
  await a.page.keyboard.type("NOTE");
  await a.page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.canvas!.setTool("select"),
  );

  await expect.poll(async () => (await orderIds(a.page)).length).toBe(2);
  const order = await orderIds(a.page);
  const newId = order[order.length - 1]!;
  expect(newId).not.toBe("shape1");
  const created = await objJSON(a.page, newId);
  expect(created!.shape ?? null).toBeNull(); // a sticky, not a shape
  expect(runsText(created)).toContain("NOTE");
  // The shape was NOT edited.
  expect(runsText(await objJSON(a.page, "shape1"))).toBe("");

  await a.close();
});
