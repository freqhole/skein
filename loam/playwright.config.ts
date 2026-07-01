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
    // generous timeouts: pixi init + automerge sync + midden wasm can be slow
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  expect: {
    // default assertion timeout
    timeout: 5_000,
  },
  // default per-test timeout.
  // narthex/image tests boot the full app (midden wasm + iroh) so need more.
  timeout: 60_000,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
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
