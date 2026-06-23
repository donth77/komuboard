import { expect, test } from "@playwright/test";
import { connectPeer, uniqueRoom } from "./helpers";

/**
 * First-run identity nudge (M2 onboarding): a brand-new, auto-named visitor gets a small,
 * dismissible card pointing them at the profile editor — never a blocking pre-join modal. It shows
 * at most once per browser. Other suites suppress it via `connectPeer` (see helpers.ts).
 */
test("identity nudge: a first-time visitor is invited to set their name, opens the editor, shows once", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("nudge"), { showNudge: true });

  // It appears with the auto-assigned name and a "Set name" action.
  const nudge = a.page.locator(".identity-nudge");
  await expect(nudge).toBeVisible();
  await expect(nudge.locator(".identity-nudge-line b")).not.toBeEmpty();
  await a.page.screenshot({ path: "test-results/identity-nudge.png" });

  // "Set name" opens the profile editor (its name field) and dismisses the nudge.
  await nudge.locator(".identity-nudge-edit").click();
  await expect(a.page.locator("#profile-name")).toBeVisible();
  await expect(nudge).toBeHidden();

  // One-shot: closing the editor and reloading does not bring it back.
  await a.page.keyboard.press("Escape");
  await a.page.reload();
  await a.page.waitForFunction(
    () =>
      (window as unknown as { __komuboard?: { provider?: { wsconnected?: boolean } } }).__komuboard
        ?.provider?.wsconnected,
  );
  await expect(a.page.locator(".identity-nudge")).toHaveCount(0);

  await a.close();
});

test("identity nudge: dismissing with × is also one-shot", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("nudge2"), { showNudge: true });

  const nudge = a.page.locator(".identity-nudge");
  await expect(nudge).toBeVisible();
  await nudge.locator(".identity-nudge-close").click();
  await expect(nudge).toBeHidden();

  await a.page.reload();
  await a.page.waitForFunction(
    () =>
      (window as unknown as { __komuboard?: { provider?: { wsconnected?: boolean } } }).__komuboard
        ?.provider?.wsconnected,
  );
  await expect(a.page.locator(".identity-nudge")).toHaveCount(0);

  await a.close();
});
