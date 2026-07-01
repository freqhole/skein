import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // p2p tests open multiple browser contexts — keep workers=1 in CI to
  // avoid saturating the iroh relay with too many concurrent connections.
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { outputFolder: "playwright-report" }], ["list"]],
  use: {
    baseURL: "http://localhost:5897",
    trace: "on-first-retry",
    // generous timeouts: pixi init + automerge sync can be slow in CI
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  expect: {
    // default assertion timeout — most canvas assertions are fast (JS state checks)
    timeout: 5_000,
  },
  // default per-test timeout. @p2p tests call test.setTimeout() to override.
  timeout: 30_000,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // required for wasm + SharedArrayBuffer
        launchOptions: {
          args: ["--enable-features=SharedArrayBuffer"],
        },
      },
    },
  ],
  webServer: {
    command: "npx vite --port 5897",
    port: 5897,
    reuseExistingServer: !process.env.CI,
  },
});
