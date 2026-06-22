import { type Page, expect, test } from "@playwright/test";
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
 * Group/ungroup (⌘G / ⇧⌘G) and lock/unlock (⌘L / ⇧⌘L) — the last of the M1 select/transform story.
 * Group: members share a groupId, select as one, move as one. Lock: a locked object can't be moved /
 * resized / edited / deleted but stays selectable (to unlock).
 */

const mod = process.platform === "darwin" ? "Meta" : "Control";
const selCount = (page: Page): Promise<number> =>
  page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.canvas!.textLayer.selectedCount(),
  );

test("group: ⌘G groups a multi-selection; clicking one member selects the whole group; it moves as one", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("group"));
  await injectShape(a.page, { id: "A", x: 0, y: 0, width: 160, height: 120, bg: "#a5d8ff" });
  await injectShape(a.page, { id: "B", x: 240, y: 0, width: 160, height: 120, bg: "#b2f2bb" });
  await expect.poll(() => a.page.locator('[data-id="B"]').count()).toBe(1);
  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");

  // Shift-click both, then ⌘G.
  const ca = worldToScreen(cal, 80, 60);
  const cb = worldToScreen(cal, 320, 60);
  await a.page.mouse.click(ca.x, ca.y);
  await a.page.keyboard.down("Shift");
  await a.page.mouse.click(cb.x, cb.y);
  await a.page.keyboard.up("Shift");
  await expect.poll(() => selCount(a.page)).toBe(2);
  await a.page.keyboard.press(`${mod}+g`);
  const gA = (await objJSON(a.page, "A"))!.groupId as string | undefined;
  const gB = (await objJSON(a.page, "B"))!.groupId as string | undefined;
  expect(gA).toBeTruthy();
  expect(gB).toBe(gA); // same group

  // Deselect, then click just A → the whole group (2) is selected.
  await a.page.keyboard.press("Escape");
  await expect.poll(() => hasSelection(a.page)).toBe(false);
  await a.page.mouse.click(ca.x, ca.y);
  await expect.poll(() => selCount(a.page)).toBe(2);

  // Drag A → B moves too (group cohesion).
  const bx0 = (await objJSON(a.page, "B"))!.x as number;
  await a.page.mouse.move(ca.x, ca.y);
  await a.page.mouse.down();
  await a.page.mouse.move(ca.x + 120, ca.y, { steps: 10 });
  await a.page.mouse.up();
  await expect
    .poll(async () => Math.round(((await objJSON(a.page, "B"))!.x as number) - bx0))
    .toBeGreaterThan(90);

  // ⇧⌘G ungroups: clicking A now selects only A. (Hold Shift explicitly — see the lock test note.)
  await a.page.mouse.click(ca.x + 120, ca.y); // re-select the moved A
  await a.page.keyboard.down("Shift");
  await a.page.keyboard.press(`${mod}+g`);
  await a.page.keyboard.up("Shift");
  expect((await objJSON(a.page, "A"))!.groupId ?? null).toBeNull();
  await a.page.keyboard.press("Escape");
  await a.page.mouse.click(ca.x + 120, ca.y);
  await expect.poll(() => selCount(a.page)).toBe(1);
  await a.close();
});

test("lock: ⌘L toggles lock (locked can't move/delete; ⌘L again unlocks)", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("lock"));
  await injectShape(a.page, { id: "A", x: 0, y: 0, width: 160, height: 120, bg: "#ffd8a8" });
  await expect.poll(() => a.page.locator('[data-id="A"]').count()).toBe(1);
  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");
  const c = worldToScreen(cal, 80, 60);

  // Select + lock (⌘L) → locked, selection KEPT (so ⌘L toggles it back), badge shown.
  await a.page.mouse.click(c.x, c.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  await a.page.keyboard.press(`${mod}+l`);
  await expect.poll(async () => (await objJSON(a.page, "A"))!.locked === true).toBe(true);
  await expect.poll(() => hasSelection(a.page)).toBe(true); // stays selected after locking
  expect(await a.page.locator('[data-id="A"][data-locked]').count()).toBe(1);

  // ⌘L again toggles it back to unlocked — no ⇧⌘L needed (extensions often grab ⇧⌘L).
  await a.page.keyboard.press(`${mod}+l`);
  await expect.poll(async () => (await objJSON(a.page, "A"))!.locked ?? null).toBeNull();

  // Re-lock (⌘L toggle), then verify the protections: can't move, can't delete.
  await a.page.keyboard.press(`${mod}+l`);
  await expect.poll(async () => (await objJSON(a.page, "A"))!.locked === true).toBe(true);
  const x0 = (await objJSON(a.page, "A"))!.x as number;
  await a.page.mouse.move(c.x, c.y);
  await a.page.mouse.down();
  await a.page.mouse.move(c.x + 120, c.y, { steps: 8 });
  await a.page.mouse.up();
  expect((await objJSON(a.page, "A"))!.x as number).toBe(x0); // locked → didn't move
  await a.page.mouse.click(c.x, c.y); // re-select (the failed drag re-selected it anyway)
  await a.page.keyboard.press("Delete");
  expect(await objJSON(a.page, "A")).not.toBeNull(); // locked → survived delete
  await a.close();
});

test("lock: a locked connector can't be moved (endpoint-drag is a no-op)", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("lockconn"));
  await injectConnector(a.page, { id: "cn", from: { x: 0, y: 0 }, to: { x: 200, y: 0 } });
  await expect.poll(() => a.page.locator("svg.komu-connector").count()).toBe(1);
  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");

  // Select via the shaft midpoint, then lock.
  const midpt = worldToScreen(cal, 100, 0);
  await a.page.mouse.click(midpt.x, midpt.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  await a.page.keyboard.press(`${mod}+l`);
  await expect.poll(async () => (await objJSON(a.page, "cn"))!.locked === true).toBe(true);
  // Locked connector exposes no endpoint handles.
  expect(await a.page.locator(".komu-connector-handle:visible").count()).toBe(0);

  // Try to drag the `to` endpoint (200,0) — the mutator guard makes it a no-op.
  const to0 = (await objJSON(a.page, "cn"))!.to as { x: number; y: number };
  const end = worldToScreen(cal, 200, 0);
  await a.page.mouse.move(end.x, end.y);
  await a.page.mouse.down();
  await a.page.mouse.move(end.x + 80, end.y + 60, { steps: 8 });
  await a.page.mouse.up();
  expect((await objJSON(a.page, "cn"))!.to as { x: number; y: number }).toMatchObject({
    x: to0.x,
    y: to0.y,
  }); // unchanged — locked
  await a.close();
});

test("group: a grouped selection shows the Group chip + distinct box; a multi-select does not", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("groupchip"));
  await injectShape(a.page, { id: "A", x: 0, y: 0, width: 160, height: 120, bg: "#a5d8ff" });
  await injectShape(a.page, { id: "B", x: 240, y: 0, width: 160, height: 120, bg: "#b2f2bb" });
  await expect.poll(() => a.page.locator('[data-id="B"]').count()).toBe(1);
  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");
  const ca = worldToScreen(cal, 80, 60);
  const cb = worldToScreen(cal, 320, 60);

  // Loose multi-select (NOT grouped) → plain box, no chip.
  await a.page.mouse.click(ca.x, ca.y);
  await a.page.keyboard.down("Shift");
  await a.page.mouse.click(cb.x, cb.y);
  await a.page.keyboard.up("Shift");
  await expect.poll(() => selCount(a.page)).toBe(2);
  expect(await a.page.locator(".komu-group-box.is-group").count()).toBe(0);
  expect(await a.page.locator(".komu-group-ungroup:visible").count()).toBe(0);

  // Group them → distinct (.is-group) box + visible "Group" chip.
  await a.page.keyboard.press(`${mod}+g`);
  await expect.poll(() => a.page.locator(".komu-group-box.is-group").count()).toBe(1);
  await expect.poll(() => a.page.locator(".komu-group-ungroup:visible").count()).toBe(1);

  // Clicking the chip ungroups.
  await a.page.locator(".komu-group-ungroup").click();
  await expect.poll(async () => (await objJSON(a.page, "A"))!.groupId ?? null).toBeNull();
  await a.close();
});

test("group: a peer sees a 'Group' badge on a grouped selection (but not a multi-select)", async ({
  browser,
}) => {
  const room = uniqueRoom("groupremote");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);
  await injectShape(a.page, { id: "A", x: 0, y: 0, width: 160, height: 120, bg: "#a5d8ff" });
  await injectShape(a.page, { id: "B", x: 240, y: 0, width: 160, height: 120, bg: "#b2f2bb" });
  await expect.poll(() => b.page.locator('[data-id="B"]').count(), { timeout: 10_000 }).toBe(1);

  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");
  const ca = worldToScreen(cal, 80, 60);
  const cb = worldToScreen(cal, 320, 60);
  const labelCount = (): Promise<number> =>
    b.page.evaluate(() =>
      (window as unknown as BoardWindow).__komuboard.canvas!.remoteGroupLabelCount(),
    );

  // A loose multi-select on A → B sees A's union box but NO "Group" badge.
  await a.page.mouse.click(ca.x, ca.y);
  await a.page.keyboard.down("Shift");
  await a.page.mouse.click(cb.x, cb.y);
  await a.page.keyboard.up("Shift");
  await expect.poll(() => selCount(a.page)).toBe(2);
  await expect.poll(() => labelCount()).toBe(0);

  // A groups them → B now sees the "Group" badge on A's selection.
  await a.page.keyboard.press(`${mod}+g`);
  await expect.poll(() => labelCount(), { timeout: 5_000 }).toBe(1);

  await a.close();
  await b.close();
});
