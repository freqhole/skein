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
//
// every file here carries (or should carry) a matching doc comment of its
// own — `run with: npx playwright test tests/<file> --workers=1` — since
// that's also the right way to run just this one file in isolation. if a
// spec's header says --workers=1, it belongs in this list; keep both in
// sync.
const HEAVY_TEST_FILES = [
  "multi-peer-mesh.spec.ts",
  "p2p-sync.spec.ts",
  "reliquary-hub.spec.ts",
  "blob-sync.spec.ts",
  "blob-acl.spec.ts",
  "blob-acl-gate-prototype.spec.ts",
  "blob-acl-cross-canvas.spec.ts",
  "blob-acl-live-sync.spec.ts",
  "blob-proxy-friend-gate.spec.ts",
  "blob-stream-import.spec.ts",
  "canvas-first-open-crash.spec.ts",
  "canvas-share-hub.spec.ts",
  "friend-canvas-bin.test.ts",
  "friendz-hub.spec.ts",
  "hub-admin.spec.ts",
  "hub-profile-panel.spec.ts",
  "friends-tab-hub-profile.spec.ts",
  "knock-flow.spec.ts",
  "knock-ui.test.ts",
  "profile-gossip.spec.ts",
  "share-dialog.test.ts",
  "viewer-role-ui.test.ts",
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
  // one local retry: residual contention flakes (multi-context cpu pressure,
  // hub child-process startup races) report as "flaky" instead of failing
  // the run — a clean single-command run is a hard requirement for ci.
  // genuine regressions still fail (they fail the retry too).
  retries: process.env.CI ? 2 : 1,
  // overall worker pool cap for the whole run. per-project `workers` below
  // further restricts how much of this pool the heavy project may use at
  // once — it doesn't add extra workers on top of this. unlimited workers
  // (one per core) causes contention flakes in app-boot-heavy specs; since
  // the midden worker migration every page/reload also spawns a dedicated
  // worker that fetches + compiles the ~19MB wasm, so the cap sits at 3
  // (reload-persistence specs flaked at 4) both locally and in ci - ci
  // runners (ubuntu-24.04, 4 vcpu) have the same headroom as the local cap
  // was tuned against.
  workers: 3,
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
