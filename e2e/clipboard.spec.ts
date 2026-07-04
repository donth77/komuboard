import { expect, test } from "@playwright/test";

import {
  calibrate,
  connectPeer,
  injectSticky,
  objectIds,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

// Cross-tab copy/paste travels through the SYSTEM clipboard as a tagged JSON payload, so you can copy
// in one tab/room and paste in another. Two isolated browser contexts can't share the OS clipboard
// headlessly, so this validates the two halves in one context: ⌘C writes the real payload, and a
// crafted `paste` event (the shape a cross-tab ⌘V delivers) recreates the objects with fresh ids.
test("copy writes a tagged clipboard payload; a paste event recreates the objects", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("clip"), { clipboard: true });
  await injectSticky(a.page, { id: "s1", x: 200, y: 200, bg: "#ffd43b" });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  // COPY path: select the sticky, ⌘C → the system clipboard holds the tagged payload.
  const cal = await calibrate(a.page);
  const c = worldToScreen(cal, 290, 290);
  await a.page.mouse.click(c.x, c.y);
  await a.page.keyboard.press("Control+c");
  const clip = await a.page.evaluate(() => navigator.clipboard.readText());
  expect(clip.startsWith("komuboard/v1:")).toBe(true);
  const payload = JSON.parse(clip.slice("komuboard/v1:".length));
  expect(typeof payload.n).toBe("string"); // the copy nonce
  expect(payload.o.length).toBe(1);
  expect(payload.o[0].type).toBe("text");

  // PASTE path: deliver a crafted payload with a DIFFERENT nonce — the shape a cross-tab ⌘V delivers
  // (a payload matching our own copy nonce is treated as same-tab and skipped by the event handler).
  const before = (await objectIds(a.page)).length;
  await a.page.evaluate(() => {
    const objs = [
      {
        id: "ext1",
        type: "text",
        x: 500,
        y: 500,
        width: 180,
        height: 180,
        fontSize: 22,
        fontFamily: "Inter, sans-serif",
        align: "left",
        runs: [{ text: "pasted from another tab" }],
        authorId: "x",
      },
    ];
    const dt = new DataTransfer();
    dt.setData("text/plain", "komuboard/v1:" + JSON.stringify({ n: "another-tab", o: objs }));
    window.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect.poll(async () => (await objectIds(a.page)).length).toBe(before + 1);
  const ids = await objectIds(a.page);
  expect(ids).toContain("s1"); // original intact
  expect(ids.some((i) => i !== "s1" && i !== "ext1")).toBe(true); // clone got a fresh id, not "ext1"

  // A non-Komuboard clipboard string must NOT create objects.
  await a.page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "just some text");
    window.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });
  await a.page.waitForTimeout(300);
  expect((await objectIds(a.page)).length).toBe(before + 1); // unchanged
  await a.close();
});
