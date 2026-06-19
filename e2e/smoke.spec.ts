import { expect, test } from "@playwright/test";

test("board shell renders and the WS echo round-trips", async ({ page }) => {
  await page.goto("/?room=e2e-smoke");

  // Shell renders.
  await expect(page.getByText("Coboard")).toBeVisible();
  await expect(page.getByTestId("room")).toContainText("e2e-smoke");

  // WebSocket connects to the Durable Object...
  await expect(page.getByTestId("status")).toHaveText("connected");

  // ...and the ping/echo round-trips (RTT becomes a real value).
  await expect(page.getByTestId("rtt")).toHaveText(/\d+\s*ms/);

  // Presence: at least this connection is counted.
  await expect(page.getByTestId("peers")).not.toHaveText("0");
});
