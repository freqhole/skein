/// <reference types="vitest/config" />
import path from "path";
import { defineConfig, type Plugin } from "vite";

import wasm from "vite-plugin-wasm";

const isTauriBuild = !!process.env.VITE_TAURI;

// resolves the bare "midden" specifier that reliquary's blob worker
// dynamically imports (see @freqhole/reliquary/worker's midden-blake3.ts).
// a plain `resolve.alias` entry does not reach this import: it's inside a
// worker's own module graph, which vite builds through a separate plugin
// pipeline from the main app - `resolve.alias` only applies to the graph
// it's declared against, so the alias has to be re-declared as an actual
// plugin and included in both the main `plugins` and `worker.plugins` lists
// below for it to apply to both.
function middenBareSpecifierPlugin(target: string): Plugin {
  return {
    name: "midden-bare-specifier",
    resolveId(source) {
      if (source === "midden") return this.resolve(target, undefined, { skipSelf: true });
      return null;
    },
  };
}

const middenTarget = isTauriBuild ? path.resolve(__dirname, "src/stubs/midden-stub.ts") : "@freqhole/midden";

export default defineConfig({
  plugins: [wasm(), middenBareSpecifierPlugin(middenTarget)],
  // worker bundles need wasm too — the blob worker pulls in @freqhole/midden (wasm) for blake3.
  worker: {
    format: "es",
    plugins: () => [wasm(), middenBareSpecifierPlugin(middenTarget)],
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
  // when building for Tauri, alias @freqhole/midden to a stub that throws on use.
  // the bare "midden" specifier (see middenBareSpecifierPlugin above) is
  // handled by a plugin instead of resolve.alias so it also reaches worker
  // bundles. tauri builds point both at the same local stub @freqhole/midden
  // itself is aliased to (midden-worker.ts's own stub, which is fuller than
  // the package's - it has create_with_options/MiddenNodeOptions/CancelToken,
  // which midden-worker.ts needs).
  resolve: {
    alias: isTauriBuild
      ? {
          "@freqhole/midden": path.resolve(__dirname, "src/stubs/midden-stub.ts"),
        }
      : {},
  },
  // dev server serves test-harness.html for playwright tests.
  // allow serving the @freqhole/midden package (../../midden/pkg) and the
  // @freqhole/reliquary package (../../reliquary/ts) - both sibling repos of
  // skein, two levels above loam, linked in via a file: dependency. without
  // this, the browser's worker import of reliquary's blob-worker.js (which
  // resolves through the node_modules symlink to the real path outside
  // loam's project root) is rejected by vite's dev-server fs allow list.
  server: {
    port: 5897,
    fs: {
      allow: ["..", "../../midden", "../../reliquary"],
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
    setupFiles: ["src/test-setup.ts"],
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
