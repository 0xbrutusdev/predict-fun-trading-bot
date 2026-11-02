import { test, expect } from "@playwright/test";

const dashboardKey = "integration-dashboard-key-0000000000000000";

test("paper account creation persists across a browser refresh", async ({
  page,
}) => {
  const accountName = `Persistence ${Date.now()}`;
  await page.goto("/");
  await page.getByLabel("控制台访问密钥").fill(dashboardKey);
  await page.getByRole("button", { name: "进入控制台" }).click();
  await expect(page.getByText("Worker 已连接", { exact: true })).toBeVisible();

  await page.getByLabel("账户名称").fill(accountName);
  await page.getByLabel("初始资金（USDT）").fill("25000");
  await page.getByRole("button", { name: "创建暂停账户" }).click();
  await expect(page.getByRole("option", { name: accountName })).toBeAttached();

  await page.getByLabel("选择账户").selectOption({ label: accountName });
  await expect(
    page.getByRole("button", { name: "启动模拟账户" }),
  ).toBeVisible();

  await page.reload();
  await page.getByLabel("选择账户").selectOption({ label: accountName });
  await expect(
    page.getByRole("button", { name: "启动模拟账户" }),
  ).toBeVisible();
});
