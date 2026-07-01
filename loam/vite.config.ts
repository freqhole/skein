/// <reference types="vitest/config" />
import path from "path";
import { defineConfig } from "vite";

import wasm from "vite-plugin-wasm";

const isTauriBuild = !!process.env.VITE_TAURI;

export default defineConfig({
  plugins: [wasm()],
  // worker bundles need wasm too — the blob worker pulls in midden (wasm) for blake3.
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
      external: isTauriBuild ? ["pixi.js", "@pixi/ui", "midden"] : ["pixi.js", "@pixi/ui"],
    },
    sourcemap: true,
  },
  // when building for Tauri, alias midden to a stub that throws on use
  ...(isTauriBuild
    ? {
        resolve: {
          alias: {
            midden: path.resolve(__dirname, "src/stubs/midden-stub.ts"),
          },
        },
      }
    : {}),
  // dev server serves test-harness.html for playwright tests.
  // allow serving the midden package which lives at ../midden/pkg (outside project root).
  server: {
    port: 5897,
    fs: {
      allow: [".."],
    },
  },
  // exclude midden from esbuild pre-bundling — it contains a .wasm file that
  // esbuild can't handle; vite-plugin-wasm takes care of it instead.
  optimizeDeps: {
    exclude: ["midden"],
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
