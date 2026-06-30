import { expect, test } from "@playwright/test";

import {
  calibrate,
  connectPeer,
  hasSelection,
  injectImage,
  objectIds,
  objJSON,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

// A 1×1 transparent PNG — the smallest valid image we can round-trip through R2.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const WORKER = "http://127.0.0.1:8787";

async function uploadPng(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const res = await request.post(`${WORKER}/upload`, {
    headers: { "content-type": "image/png" },
    data: Buffer.from(PNG_1x1, "base64"),
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).key as string;
}

test("POST /upload stores bytes in R2; GET /img/:key round-trips them with an immutable cache", async ({
  request,
}) => {
  const png = Buffer.from(PNG_1x1, "base64");
  const up = await request.post(`${WORKER}/upload`, {
    headers: { "content-type": "image/png" },
    data: png,
  });
  expect(up.ok()).toBeTruthy();
  const { key } = await up.json();
  expect(key).toMatch(/^[a-f0-9]{64}\.png$/); // content-addressed: sha256 + ext

  const served = await request.get(`${WORKER}/img/${key}`);
  expect(served.ok()).toBeTruthy();
  expect(served.headers()["cache-control"]).toContain("immutable");
  expect(Buffer.from(await served.body())).toEqual(png); // exact bytes back

  // The same content uploaded again dedups to the same key.
  expect(await uploadPng(request)).toBe(key);
});

test("upload rejects a non-image content-type and an empty body", async ({ request }) => {
  const bad = await request.post(`${WORKER}/upload`, {
    headers: { "content-type": "text/plain" },
    data: "not an image",
  });
  expect(bad.status()).toBe(415);

  const empty = await request.post(`${WORKER}/upload`, {
    headers: { "content-type": "image/png" },
    data: Buffer.alloc(0),
  });
  expect(empty.status()).toBe(413);
});

test("an uploaded image renders as a .komu-image box and the <img> loads from the worker", async ({
  browser,
  request,
}) => {
  const key = await uploadPng(request);
  const a = await connectPeer(browser, uniqueRoom("img"));

  // Place a 200×150 image centred on the board so it isn't viewport-culled.
  const box = (await a.page.locator("#board").boundingBox())!;
  const cal = await calibrate(a.page);
  const cx = (box.x + box.width / 2 - cal.ox) / cal.scale;
  const cy = (box.y + box.height / 2 - cal.oy) / cal.scale;
  await injectImage(a.page, {
    id: "i1",
    x: cx - 100,
    y: cy - 75,
    width: 200,
    height: 150,
    src: key,
  });

  await expect.poll(() => objectIds(a.page)).toContain("i1");
  await expect(a.page.locator(".komu-image")).toBeVisible();
  // naturalWidth > 0 only once the bytes actually decoded — proves the serve URL resolved.
  await expect
    .poll(() =>
      a.page.locator(".komu-image img").evaluate((el) => {
        const img = el as HTMLImageElement;
        return img.complete && img.naturalWidth > 0;
      }),
    )
    .toBe(true);

  await a.page.screenshot({ path: "test-results/image-render.png" });
  await a.close();
});

/** Inject a 200×150 image (id "i1") centred on the board; returns the screen point at its centre. The
 *  `.komu-image` div is pointer-events:none, so a click there selects via the canvas hit-test. */
async function centredImage(
  page: import("@playwright/test").Page,
  key: string,
): Promise<{ x: number; y: number }> {
  const box = (await page.locator("#board").boundingBox())!;
  const cal = await calibrate(page);
  const cx = (box.x + box.width / 2 - cal.ox) / cal.scale;
  const cy = (box.y + box.height / 2 - cal.oy) / cal.scale;
  await injectImage(page, { id: "i1", x: cx - 100, y: cy - 75, width: 200, height: 150, src: key });
  await expect(page.locator(".komu-image")).toBeVisible();
  return worldToScreen(cal, cx, cy);
}

test("an image resizes aspect-locked — it scales proportionally without distorting", async ({
  browser,
  request,
}) => {
  const key = await uploadPng(request);
  const a = await connectPeer(browser, uniqueRoom("imgresize"));
  const centre = await centredImage(a.page, key);
  const before = (await objJSON(a.page, "i1"))!;
  const ratio0 = (before.width as number) / (before.height as number); // 200 / 150 = 4:3

  await a.page.mouse.click(centre.x, centre.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);

  // Drag the SE corner outward unevenly (more across than down) — aspect-lock should ignore the skew.
  const h = (await a.page.locator(".komu-text-handle.h-se").boundingBox())!;
  await a.page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await a.page.mouse.down();
  await a.page.mouse.move(h.x + 180, h.y + 40, { steps: 10 });
  await a.page.mouse.up();

  const after = (await objJSON(a.page, "i1"))!;
  expect(after.width as number).toBeGreaterThan((before.width as number) + 5); // it grew…
  expect(after.height as number).toBeGreaterThan((before.height as number) + 5);
  // …and kept its 4:3 ratio despite the lopsided drag (the whole point — object-fit never crops).
  expect((after.width as number) / (after.height as number)).toBeCloseTo(ratio0, 1);
  await a.close();
});

test("an image rotates via the keyboard nudge (] = +15° about its centre)", async ({
  browser,
  request,
}) => {
  const key = await uploadPng(request);
  const a = await connectPeer(browser, uniqueRoom("imgrotate"));
  const centre = await centredImage(a.page, key);

  await a.page.mouse.click(centre.x, centre.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  await a.page.keyboard.press("]");

  await expect.poll(async () => ((await objJSON(a.page, "i1"))!.rotation as number) ?? 0).toBe(15);
  await a.close();
});

test("the photo tool uploads a picked file and places it as a selected image", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("imgpick"));
  const before = await objectIds(a.page);

  // Clicking the dock photo button opens the (hidden) file input's chooser; feed it a PNG.
  const [chooser] = await Promise.all([
    a.page.waitForEvent("filechooser"),
    a.page.locator('komu-tool-dock [data-tool="image"]').click(),
  ]);
  await chooser.setFiles({
    name: "pic.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1, "base64"),
  });

  // A new image object lands in the doc with a real content-hash key, and selection follows it.
  await expect.poll(async () => (await objectIds(a.page)).length).toBe(before.length + 1);
  const newId = (await objectIds(a.page)).find((id) => !before.includes(id))!;
  const obj = (await objJSON(a.page, newId))!;
  expect(obj.type).toBe("image");
  expect(obj.src as string).toMatch(/^[a-f0-9]{64}\.png$/);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  await a.close();
});

/** Inject id "i1" (200×150) centred on A's board (syncs to B); returns A's screen point at its centre
 *  and the image's world top-left x. Used by the two-peer realtime tests. */
async function sharedCentredImage(
  a: { page: import("@playwright/test").Page },
  key: string,
): Promise<{ centre: { x: number; y: number }; worldX: number }> {
  const box = (await a.page.locator("#board").boundingBox())!;
  const cal = await calibrate(a.page);
  const cx = (box.x + box.width / 2 - cal.ox) / cal.scale;
  const cy = (box.y + box.height / 2 - cal.oy) / cal.scale;
  await injectImage(a.page, {
    id: "i1",
    x: cx - 100,
    y: cy - 75,
    width: 200,
    height: 150,
    src: key,
  });
  return { centre: worldToScreen(cal, cx, cy), worldX: cx - 100 };
}

test("a peer sees an image MOVE live (streamed before release), then committed", async ({
  browser,
  request,
}) => {
  const key = await uploadPng(request);
  const room = uniqueRoom("imgmove");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);
  const { centre, worldX } = await sharedCentredImage(a, key);

  await expect(b.page.locator(".komu-image")).toBeVisible();
  const bBefore = (await b.page.locator(".komu-image").boundingBox())!;

  // A selects + drags the image in ONE gesture (down selects + begins the move), holding mid-drag.
  await a.page.mouse.move(centre.x, centre.y);
  await a.page.mouse.down();
  await a.page.mouse.move(centre.x + 160, centre.y + 110, { steps: 10 });

  // ★ B's image glides live — before A releases — so it must be streaming over awareness, not the doc.
  await expect
    .poll(async () => {
      const r = await b.page.locator(".komu-image").boundingBox();
      return r ? Math.round(r.x - bBefore.x) : 0;
    })
    .toBeGreaterThan(60);

  // Release → commit; B's doc now holds the new world position.
  await a.page.mouse.up();
  await expect
    .poll(async () => (await objJSON(b.page, "i1"))!.x as number)
    .toBeGreaterThan(worldX + 60);

  await a.close();
  await b.close();
});

test("a peer sees an image RESIZE live (streamed before release), then committed", async ({
  browser,
  request,
}) => {
  const key = await uploadPng(request);
  const room = uniqueRoom("imgresize2");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);
  const { centre } = await sharedCentredImage(a, key);

  await expect(b.page.locator(".komu-image")).toBeVisible();
  const bBefore = (await b.page.locator(".komu-image").boundingBox())!;

  // A selects the image, then drags its SE handle outward, holding mid-resize.
  await a.page.mouse.click(centre.x, centre.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  const h = (await a.page.locator(".komu-text-handle.h-se").boundingBox())!;
  await a.page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await a.page.mouse.down();
  await a.page.mouse.move(h.x + 130, h.y + 95, { steps: 10 });

  // ★ B's image grows live, before A releases.
  await expect
    .poll(async () => {
      const r = await b.page.locator(".komu-image").boundingBox();
      return r ? Math.round(r.width - bBefore.width) : 0;
    })
    .toBeGreaterThan(40);

  await a.page.mouse.up();
  await expect
    .poll(async () => (await objJSON(b.page, "i1"))!.width as number)
    .toBeGreaterThan(240);

  await a.close();
  await b.close();
});
