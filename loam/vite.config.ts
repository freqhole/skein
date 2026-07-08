/// <reference types="vitest/config" />
import path from "path";
import { defineConfig } from "vite";

import wasm from "vite-plugin-wasm";

const isTauriBuild = !!process.env.VITE_TAURI;

export default defineConfig({
  plugins: [wasm()],
  // worker bundles need wasm too — the blob worker pulls in @freqhole/midden (wasm) for blake3.
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  // target esnext — the app requires modern browsers (wasm, top-level await, etc.)
  // this removes the need for vite-plugin-top-level-await.
  build: {
    target: "esnext",
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "skein",
    },
    rollupOptions: {
      external: isTauriBuild
        ? ["pixi.js", "@pixi/ui", "@freqhole/midden"]
        : ["pixi.js", "@pixi/ui"],
    },
    sourcemap: true,
  },
  // when building for Tauri, alias @freqhole/midden to a stub that throws on use
  ...(isTauriBuild
    ? {
        resolve: {
          alias: {
            "@freqhole/midden": path.resolve(__dirname, "src/stubs/midden-stub.ts"),
          },
        },
      }
    : {}),
  // dev server serves test-harness.html for playwright tests.
  // allow serving the @freqhole/midden package, which lives at ../../midden/pkg
  // (a sibling repo of skein, two levels above loam).
  server: {
    port: 5897,
    fs: {
      allow: ["..", "../../midden"],
    },
    // cross-origin isolation headers — required for the blob worker's WASM
    // (@freqhole/midden) init to complete reliably. without these, the worker's
    // midden init can hang indefinitely in some browsers (see
    // docs/skein-runtime-plan.md: "blob worker in tests").
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  // exclude @freqhole/midden from esbuild pre-bundling — it contains a .wasm
  // file that esbuild can't handle; vite-plugin-wasm takes care of it instead.
  optimizeDeps: {
    exclude: ["@freqhole/midden"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts", "widgets/**/*.test.ts"],
    exclude: ["node_modules", "dist", "tests/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "widgets/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.integration.test.ts",
        "src/test-helpers/**",
        "widgets/**/*.test.ts",
        "**/*.d.ts",
        "**/index.ts",
        "src/widgets/widget-types.ts",
      ],
    },
  },
});
