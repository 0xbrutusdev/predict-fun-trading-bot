import { test, expect } from "@playwright/test";

const dashboardKey = "integration-dashboard-key-0000000000000000";

test("language selection persists and translates the operator workflow", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "EN" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect to your trading workspace" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Connect to your trading workspace" }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("predict_locale"))).toBe(
    "en",
  );

  await page.getByLabel("Dashboard access key").fill(dashboardKey);
  await page.getByRole("button", { name: "Enter control room" }).click();
  await expect(page.getByText("Worker connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Strategies" }).click();
  await expect(page.getByRole("heading", { name: "Strategy slots" })).toBeVisible();
  await page.getByRole("button", { name: "Markets" }).click();
  await expect(page.getByRole("heading", { name: "Approved markets" })).toBeVisible();
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(
    page.getByRole("heading", { name: "Recent runtime events" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("button", { name: "运行监控" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
