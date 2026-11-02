import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: "http://localhost:3101",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        "node --import ./tests/tsx-userinfo-shim.mjs --import tsx e2e/worker.ts",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "node web/node_modules/next/dist/bin/next start web -p 3101",
      url: "http://localhost:3101/api/health",
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        BOT_API_URL: "http://127.0.0.1:3100",
        BOT_API_TOKEN: "integration-worker-token-00000000000000000",
        DASHBOARD_ACCESS_KEY: "integration-dashboard-key-0000000000000000",
      },
    },
  ],
});
