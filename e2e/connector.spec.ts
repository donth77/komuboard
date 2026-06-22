import { expect, test } from "@playwright/test";
import {
  type BoardWindow,
  calibrate,
  connectPeer,
  hasSelection,
  injectConnector,
  injectShape,
  objJSON,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/**
 * Connector interaction coverage (ADR-0009 Phase 3: connectors render as DOM <svg> and interact
 * through the text-layer chrome). These guard the Konva-teardown — they exercise the connector
 * hit-test, body-move with bound-end detach, and the bound-shape reroute, none of which any other
 * spec covers. Shapes/connectors are injected via the doc (the flyout is flaky under synthetic input).
 */

const connRectY = (page: import("@playwright/test").Page): Promise<number | null> =>
  page.evaluate(() => {
    const r = (window as unknown as BoardWindow).__komuboard.canvas!.nodeContentRect("cn1");
    return r ? r.y : null;
  });

test("connector: shaft-click selects; body-move detaches a bound end", async ({ browser }) => {
  const room = uniqueRoom("connector");
  const a = await connectPeer(browser, room);

  // Shape at world (0,0) 160×120 → its right-side midpoint is (160, 60).
  await injectShape(a.page, { id: "rc1", x: 0, y: 0, width: 160, height: 120 });
  // Connector from rc1's right side to a free point; shaft runs (160,60)→(360,60), midpoint (260,60).
  await injectConnector(a.page, {
    id: "cn1",
    from: { x: 160, y: 60, shapeId: "rc1", side: "right" },
    to: { x: 360, y: 60 },
  });
  await expect.poll(() => a.page.locator("svg.komu-connector").count()).toBe(1);
  expect((await objJSON(a.page, "cn1"))!.from).toMatchObject({ shapeId: "rc1" });

  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");

  // Shaft-click selects the connector; a click well off the shaft deselects (precise hit-test).
  const mid = worldToScreen(cal, 260, 60);
  await a.page.mouse.click(mid.x, mid.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  const off = worldToScreen(cal, 260, 220);
  await a.page.mouse.click(off.x, off.y);
  await expect.poll(() => hasSelection(a.page)).toBe(false);

  // Re-select and drag the body → the bound `from` end detaches to a free point.
  await a.page.mouse.click(mid.x, mid.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  await a.page.mouse.move(mid.x, mid.y);
  await a.page.mouse.down();
  await a.page.mouse.move(mid.x - 40, mid.y + 70);
  await a.page.mouse.up();
  await expect
    .poll(
      async () => ((await objJSON(a.page, "cn1"))!.from as { shapeId?: string }).shapeId ?? null,
    )
    .toBeNull();

  await a.close();
});

test("connector: a bound end follows its shape (reroute)", async ({ browser }) => {
  const room = uniqueRoom("connreroute");
  const a = await connectPeer(browser, room);

  await injectShape(a.page, { id: "rc1", x: 0, y: 0, width: 160, height: 120 });
  await injectConnector(a.page, {
    id: "cn1",
    from: { x: 160, y: 60, shapeId: "rc1", side: "right" },
    to: { x: 360, y: 60 },
  });
  await expect.poll(() => a.page.locator("svg.komu-connector").count()).toBe(1);
  await expect.poll(() => a.page.locator('[data-id="rc1"]').count()).toBe(1);

  const y0 = await connRectY(a.page);
  expect(y0).not.toBeNull();

  // Select the shape and drag it up ~100px; the connector's bound end must follow it up.
  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");
  const shapeCentre = worldToScreen(cal, 80, 60);
  await a.page.mouse.click(shapeCentre.x, shapeCentre.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  await a.page.mouse.move(shapeCentre.x, shapeCentre.y);
  await a.page.mouse.down();
  await a.page.mouse.move(shapeCentre.x, shapeCentre.y - 100);
  await a.page.mouse.up();

  await expect
    .poll(async () => {
      const y = await connRectY(a.page);
      return y !== null && y0 !== null ? Math.round(y0 - y) : 0;
    })
    .toBeGreaterThan(30);

  await a.close();
});

const connectorCount = (page: import("@playwright/test").Page): Promise<number> =>
  page.evaluate(() => {
    let c = 0;
    for (const v of (
      window as unknown as {
        __komuboard: {
          doc: { getMap(n: string): { values(): Iterable<{ toJSON(): { type?: string } }> } };
        };
      }
    ).__komuboard.doc
      .getMap("objects")
      .values())
      if (v.toJSON().type === "connector") c++;
    return c;
  });

async function drawConnector(page: import("@playwright/test").Page): Promise<void> {
  const board = (await page.locator("#board").boundingBox())!;
  await page.getByRole("button", { name: /shapes/i }).click();
  await page.waitForTimeout(250);
  await page.getByText("Arrow", { exact: true }).first().click();
  await page.waitForTimeout(200);
  const cx = board.x + board.width / 2;
  const cy = board.y + board.height / 2;
  await page.mouse.move(cx - 100, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 20, cy + 12, { steps: 6 });
  await page.mouse.move(cx + 100, cy, { steps: 6 });
  await page.mouse.up();
}

test("connector: draw with the arrow tool creates a connector (local draft → commit)", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("conndraw"));
  await drawConnector(a.page);
  await expect.poll(() => connectorCount(a.page)).toBe(1);
  await a.close();
});

test("connector: a peer's drawn connector arrives (remote handoff)", async ({ browser }) => {
  const room = uniqueRoom("conndrawremote");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);
  await drawConnector(a.page);
  await expect.poll(() => connectorCount(b.page), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => b.page.locator("svg.komu-connector").count()).toBe(1);
  await a.close();
  await b.close();
});

test("connector: dragging an endpoint moves that end", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("connendpoint"));
  await injectConnector(a.page, { id: "cn1", from: { x: 0, y: 0 }, to: { x: 200, y: 0 } });
  await expect.poll(() => a.page.locator("svg.komu-connector").count()).toBe(1);
  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");
  // select via the shaft midpoint (100,0)
  const mid = worldToScreen(cal, 100, 0);
  await a.page.mouse.click(mid.x, mid.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  // drag the `to` endpoint (200,0) down-right
  const end = worldToScreen(cal, 200, 0);
  await a.page.mouse.move(end.x, end.y);
  await a.page.mouse.down();
  await a.page.mouse.move(end.x + 60, end.y + 50, { steps: 8 });
  await a.page.mouse.up();
  await expect
    .poll(async () => {
      const t = (await objJSON(a.page, "cn1"))!.to as { y: number };
      return Math.round(t.y);
    })
    .toBeGreaterThan(25);
  await a.close();
});

const visibleConnectors = (page: import("@playwright/test").Page): Promise<number> =>
  page.evaluate(
    () =>
      [...document.querySelectorAll("svg.komu-connector")].filter((e) => {
        const s = getComputedStyle(e);
        return (
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          parseFloat(s.opacity) > 0.01 &&
          e.getBoundingClientRect().width > 1
        );
      }).length,
  );

test("connector: a peer's body-move shows exactly one connector (no double-draw)", async ({
  browser,
}) => {
  const room = uniqueRoom("conndouble");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);
  await injectConnector(a.page, { id: "cn1", from: { x: 0, y: 0 }, to: { x: 200, y: 0 } });
  await expect
    .poll(() => b.page.locator("svg.komu-connector").count(), { timeout: 10_000 })
    .toBe(1);

  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");
  const mid = worldToScreen(cal, 100, 0);
  await a.page.mouse.click(mid.x, mid.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);

  // A holds a body-move mid-drag; on B exactly ONE connector must be visible (committed hidden
  // while the peer's live draft shows — guards the double-draw the migration fixed).
  await a.page.mouse.move(mid.x, mid.y);
  await a.page.mouse.down();
  await a.page.mouse.move(mid.x - 30, mid.y + 90, { steps: 12 });
  await a.page.waitForTimeout(150);
  await expect.poll(() => visibleConnectors(b.page)).toBe(1);
  await a.page.mouse.up();
  await expect.poll(() => visibleConnectors(b.page)).toBe(1);

  await a.close();
  await b.close();
});
