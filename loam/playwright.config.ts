import { defineConfig, devices } from "@playwright/test";

// resource-intensive spec files: multi-page BroadcastChannel meshes (3-5
// browser pages/contexts in a single test) or real-network tests that spawn
// an actual reliquary hub child process and/or real iroh endpoints. running
// several of these concurrently (either against each other or against the
// rest of the suite) causes contention-driven flakiness — cpu/memory
// pressure from many simultaneous browser contexts, iroh relay dial races,
// hub process startup races — that doesn't reproduce when the same file is
// run in isolation. keeping them in their own project with a hard worker
// cap of 1 means at most one of these ever runs at a time, regardless of
// how many workers the rest of the suite is using.
const HEAVY_TEST_FILES = [
  "multi-peer-mesh.spec.ts",
  "p2p-sync.spec.ts",
  "reliquary-hub.spec.ts",
  "blob-sync.spec.ts",
  "blob-acl.spec.ts",
  "blob-acl-gate-prototype.spec.ts",
  "friendz-hub.spec.ts",
  "hub-admin.spec.ts",
  "hub-profile-panel.spec.ts",
];

const chromiumUse = {
  ...devices["Desktop Chrome"],
  viewport: { width: 1280, height: 800 },
  // required for wasm + SharedArrayBuffer
  launchOptions: {
    args: ["--enable-features=SharedArrayBuffer"],
  },
};

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // overall worker pool cap for the whole run. per-project `workers` below
  // further restricts how much of this pool the heavy project may use at
  // once — it doesn't add extra workers on top of this.
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
      testIgnore: HEAVY_TEST_FILES,
      use: chromiumUse,
    },
    {
      name: "chromium-heavy",
      testMatch: HEAVY_TEST_FILES,
      // serialize all resource-intensive tests against each other — never
      // more than one multi-page mesh / real-hub / real-iroh test running
      // at the same time.
      workers: 1,
      use: chromiumUse,
    },
  ],
  webServer: {
    command: "npx vite --port 5897",
    port: 5897,
    reuseExistingServer: !process.env.CI,
  },
});
