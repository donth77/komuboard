import { expect, test } from "@playwright/test";

import { connectPeer, uniqueRoom } from "./helpers";

// Minimal structural types for the browser-side Yjs doc used inside page.evaluate (types are erased).
interface YMapLike {
  set(key: string, value: unknown): void;
}
interface YDocLike {
  getMap(name: string): YMapLike;
  getArray(name: string): { push(items: unknown[]): void };
  transact(fn: () => void): void;
}

// Security regression (audit HIGH): a text run's `color`/`highlight` are interpolated into a style
// attribute and innerHTML'd. A hostile peer that writes the run directly (bypassing the toolbar) must
// not be able to smuggle a CSS beacon or markup out of it. Benign hex colours must still apply.
test("a malicious text-run colour is sanitized — no CSS/markup injection", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("xss"));

  await a.page.evaluate(() => {
    const doc = (window as unknown as { __komuboard: { doc: YDocLike } }).__komuboard.doc;
    const m = new (doc.getMap("objects").constructor as new () => YMapLike)();
    doc.transact(() => {
      doc.getMap("objects").set("t1", m);
      m.set("id", "t1");
      m.set("type", "text");
      m.set("x", 120);
      m.set("y", 120);
      m.set("fontFamily", "Inter, sans-serif");
      m.set("fontSize", 24);
      m.set("align", "left");
      m.set("authorId", "u1");
      m.set("runs", [
        // hostile colour (CSS beacon breakout) + a legitimate highlight
        {
          text: "hello",
          color: '#000;background:url(https://evil.example/beacon)"',
          highlight: "#ffec99",
        },
      ]);
      doc.getArray("order").push(["t1"]);
    });
  });

  const el = a.page.locator('[data-id="t1"]');
  await expect(el).toBeVisible();

  // The injected beacon must be gone from the rendered markup entirely …
  const html = await el.evaluate((n) => n.innerHTML);
  expect(html).not.toContain("evil");
  expect(html).not.toContain("url(");

  // … while the benign highlight still renders (proves we dropped only the unsafe value).
  const bg = await el
    .locator("span")
    .first()
    .evaluate((n) => getComputedStyle(n).backgroundColor);
  expect(bg).toBe("rgb(255, 236, 153)");

  await a.close();
});
