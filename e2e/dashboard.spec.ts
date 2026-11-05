import { test, expect } from "@playwright/test";
test("authenticated operator flow through Next.js and worker", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "连接你的交易工作台" }),
  ).toBeVisible();
  await page
    .getByLabel("控制台访问密钥")
    .fill("integration-dashboard-key-0000000000000000");
  await page.getByRole("button", { name: "进入控制台" }).click();
  await expect(page.getByText("Worker 已连接", { exact: true })).toBeVisible();
  await page.getByLabel("账户名称").fill("浏览器测试账户");
  await page.getByRole("button", { name: "创建暂停账户" }).click();
  await expect(
    page.getByRole("button", { name: "启动模拟账户" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "启动模拟账户" }).click();
  await expect(
    page.getByRole("button", { name: "暂停账户", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "策略配置" }).click();
  await expect(
    page.getByRole("checkbox", { name: "策略 13", exact: true }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: "策略 1", exact: true }).uncheck();
  await page.getByRole("button", { name: "保存策略" }).click();
  await expect(
    page.getByText("策略已保存；仅影响新意图。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "策略配置" }).click();
  await expect(
    page.getByRole("checkbox", { name: "策略 1", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "运行监控" }).click();
  await expect(
    page.getByRole("heading", { name: "最近运行事件" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "总览" }).click();
  await page.route("**/api/bot/observability", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "worker_error" } }),
    }),
  );
  await page.getByRole("button", { name: "刷新", exact: false }).click();
  await expect(page.getByText("worker_error", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "暂停全部账户" }),
  ).toBeEnabled();
  await page.unroute("**/api/bot/observability");
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "暂停全部账户" }).click();
  await expect(
    page.getByRole("button", { name: "启动模拟账户" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(
    page.getByRole("heading", { name: "连接你的交易工作台" }),
  ).toBeVisible();
  expect((await page.request.get("/api/bot/accounts")).status()).toBe(401);
  expect(errors).toEqual([]);
});
