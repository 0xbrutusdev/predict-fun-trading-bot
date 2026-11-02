import { test, expect } from "@playwright/test";

const dashboardKey = "integration-dashboard-key-0000000000000000";

test("operator authentication rejects an invalid key and supports login/logout", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "EN" }).click();

  await page.getByLabel("Dashboard access key").fill("x".repeat(32));
  await page.getByRole("button", { name: "Enter control room" }).click();
  await expect(page.locator(".alert.error")).toContainText(
    "Invalid dashboard access key",
  );

  await page.getByLabel("Dashboard access key").fill(dashboardKey);
  await page.getByRole("button", { name: "Enter control room" }).click();
  await expect(page.getByText("Worker connected", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect to your trading workspace" }),
  ).toBeVisible();
  expect((await page.request.get("/api/bot/accounts")).status()).toBe(401);
});
