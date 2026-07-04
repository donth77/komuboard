import { expect, test } from "@playwright/test";

import { connectPeer, objectIds, uniqueRoom } from "./helpers";

// Regression guard for the stamp wheel's keyboard operability (docs/07 §5, a11y audit #1): the outer
// mark/avatar ring used to be mouse-only. It must now be focus → arrow-navigate → Enter to arm.
test("stamp wheel is keyboard-operable: focus, arrow-navigate, Enter to arm, then place", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("stampkb"));
  const before = (await objectIds(a.page)).length;

  // Opening the Stamp tool reveals the wheel and lands focus on its first slot (a named control).
  await a.page.locator('komu-tool-dock [data-tool="stamp"]').click();
  const focusedLabel = () =>
    a.page.evaluate(() => {
      const el = document.activeElement;
      return el && el.closest("komu-stamp-wheel") ? el.getAttribute("aria-label") : null;
    });
  await expect.poll(focusedLabel).toBeTruthy();

  // Arrow keys move focus around the ring (roving tabindex) — the focused control changes …
  const first = await focusedLabel();
  await a.page.keyboard.press("ArrowRight");
  const second = await focusedLabel();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  // … and back.
  await a.page.keyboard.press("ArrowLeft");
  expect(await focusedLabel()).toBe(first);

  // Enter arms the focused stamp → the wheel closes.
  await a.page.keyboard.press("Enter");
  await expect(a.page.locator("komu-stamp-wheel")).toBeHidden();

  // The armed stamp places on a canvas click → a new object appears in the doc.
  await a.page.locator("#board").click({ position: { x: 400, y: 300 } });
  await expect.poll(async () => (await objectIds(a.page)).length).toBeGreaterThan(before);

  await a.close();
});
