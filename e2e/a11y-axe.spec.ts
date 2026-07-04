import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { connectPeer, injectSticky, uniqueRoom } from "./helpers";

// Automated WCAG 2.1 A/AA gate (docs/07 §5.5) — fails CI on any accessibility regression.
//
// The single baseline exception is `meta-viewport` (user-scalable=no): a canvas whiteboard sets it
// deliberately because browser pinch-zoom would fight the board's own two-finger pan/zoom, and the
// board provides its own content zoom (so text IS resizable, just not via page zoom). Every OTHER
// WCAG A/AA rule must pass.
test("no axe-core WCAG A/AA violations on the loaded board", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("axe"));
  await injectSticky(a.page, { id: "s1", x: 100, y: 100, bg: "#ffd43b" });
  await a.page.waitForTimeout(500);
  const results = await new AxeBuilder({ page: a.page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(["meta-viewport"])
    .analyze();
  expect(results.violations).toEqual([]);
  await a.close();
});
