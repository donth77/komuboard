import { expect, test } from "@playwright/test";

import {
  calibrate,
  connectPeer,
  hasSelection,
  injectImage,
  injectSticky,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function uploadPng(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const res = await request.post("http://127.0.0.1:8787/upload", {
    headers: { "content-type": "image/png" },
    data: Buffer.from(PNG_1x1, "base64"),
  });
  return (await res.json()).key as string;
}

/** Run canvas.exportImage() in-page and decode the resulting blob (blobs can't cross the CDP boundary). */
async function exportDims(
  page: import("@playwright/test").Page,
  selectionOnly: boolean,
): Promise<{ size: number; type: string; w: number; h: number } | null> {
  return page.evaluate(async (sel) => {
    const c = (
      window as unknown as {
        __komuboard: { canvas: { exportImage(s: boolean): Promise<Blob | null> } };
      }
    ).__komuboard.canvas;
    const blob = await c.exportImage(sel);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);
    return { size: blob.size, type: blob.type, w: img.naturalWidth, h: img.naturalHeight };
  }, selectionOnly);
}

test("export: the whole board rasterizes to a sensible PNG (incl. a cross-origin image)", async ({
  browser,
  request,
}) => {
  const key = await uploadPng(request);
  const a = await connectPeer(browser, uniqueRoom("export"));
  await injectImage(a.page, { id: "i1", x: 120, y: 120, width: 200, height: 150, src: key });
  await expect(a.page.locator(".komu-image")).toBeVisible();

  const d = await exportDims(a.page, false);
  expect(d).not.toBeNull();
  expect(d!.type).toBe("image/png"); // untainted → toBlob succeeded (the /img CORS header did its job)
  expect(d!.size).toBeGreaterThan(1000);
  expect(d!.w).toBeGreaterThan(200); // captured a real region, not a 0×0 / blank canvas
  expect(d!.h).toBeGreaterThan(150);
  await a.close();
});

test("export: a selection exports just the selected object", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("exportsel"));
  const box = (await a.page.locator("#board").boundingBox())!;
  const cal = await calibrate(a.page);
  const cx = (box.x + box.width / 2 - cal.ox) / cal.scale;
  const cy = (box.y + box.height / 2 - cal.oy) / cal.scale;
  await injectSticky(a.page, { id: "s1", x: cx - 90, y: cy - 90 }); // centred
  await injectSticky(a.page, { id: "s2", x: cx + 600, y: cy + 600 }); // far away
  await expect.poll(() => a.page.locator(".komu-text").count()).toBeGreaterThan(1);

  const whole = await exportDims(a.page, false);
  // Select just the centred sticky, then export the selection.
  const c = worldToScreen(cal, cx, cy);
  await a.page.mouse.click(c.x, c.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  const sel = await exportDims(a.page, true);

  expect(sel).not.toBeNull();
  expect(sel!.type).toBe("image/png");
  // The two stickies are ~850px apart, so the selection-only crop is much smaller than the whole board.
  expect(sel!.w).toBeLessThan(whole!.w);
  await a.close();
});

test("export dialog: ⇧⌘E opens it; Export downloads a .png, PDF a .pdf", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("exportdl"));
  await injectSticky(a.page, { id: "s1", x: 200, y: 200 });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  // ⇧⌘E opens the Export dialog (it no longer exports directly).
  await a.page.keyboard.press("Control+Shift+E"); // the app accepts ctrl or meta
  await a.page.locator(".export-row").first().waitFor();

  // PNG is the default → Export → .png download.
  const [png] = await Promise.all([
    a.page.waitForEvent("download"),
    a.page.locator(".export-go").click(),
  ]);
  expect(png.suggestedFilename()).toMatch(/\.png$/);

  // Re-open, choose PDF → Export → .pdf download.
  await a.page.keyboard.press("Control+Shift+E");
  await a.page.locator('input[value="pdf"]').check();
  const [pdf] = await Promise.all([
    a.page.waitForEvent("download"),
    a.page.locator(".export-go").click(),
  ]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  await a.close();
});

test("export dialog: the background dropdown picks Grid / Transparent / Solid", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("exportbg"));
  await injectSticky(a.page, { id: "s1", x: 200, y: 200 });
  await expect(a.page.locator(".komu-text")).toBeVisible();
  await a.page.keyboard.press("Control+Shift+E");
  await a.page.locator(".export-bg-btn").click();
  await a.page.locator('.export-bg-opt[data-bg="grid"]').click();
  await expect(a.page.locator(".export-bg-current")).toHaveText("Grid"); // selection reflected on the button
  const [dl] = await Promise.all([
    a.page.waitForEvent("download"),
    a.page.locator(".export-go").click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.png$/); // still PNG; grid captured via #board
  await a.close();
});
