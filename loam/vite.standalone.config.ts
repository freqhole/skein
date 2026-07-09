import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

import wasm from "vite-plugin-wasm";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const isTauriBuild = !!process.env.VITE_TAURI;

// custom base path for deployment (e.g. VITE_SKEIN_BASE=/skein/ for cloudflare)
const deployBase = process.env.VITE_SKEIN_BASE;

export default defineConfig({
  // wasm plugin is needed (automerge uses WASM internally).
  // only @freqhole/midden (iroh P2P transport) is stubbed in tauri builds.
  plugins: [wasm()],
  // worker bundles need the same plugin — blob-worker imports @freqhole/midden (WASM) for blake3.
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  base: isTauriBuild ? "./" : deployBase || "/",
  // target esnext — the app requires modern browsers (wasm, top-level await, etc.)
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      input: {
        skein: path.resolve(dirname, "index.html"),
        ...(isTauriBuild
          ? { settings: path.resolve(dirname, "settings.html") }
          : { gallery: path.resolve(dirname, "widget-gallery.html") }),
      },
    },
    sourcemap: true,
  },
  // in tauri builds, alias @freqhole/midden to a stub (P2P transport is handled by the rust backend).
  // also alias the bare "midden" specifier - reliquary's blob worker dynamically
  // imports it by that literal name (see @freqhole/reliquary/worker's
  // midden-blake3.ts). browser builds point it at the real package; tauri
  // builds point it at the same local stub @freqhole/midden is aliased to.
  resolve: {
    alias: isTauriBuild
      ? {
          "@freqhole/midden": path.resolve(dirname, "src/stubs/midden-stub.ts"),
          midden: path.resolve(dirname, "src/stubs/midden-stub.ts"),
        }
      : {
          midden: "@freqhole/midden",
        },
  },
  // exclude @freqhole/midden from esbuild pre-bundling — it contains a .wasm
  // file that esbuild can't handle; vite-plugin-wasm takes care of it instead.
  optimizeDeps: {
    exclude: ["@freqhole/midden"],
  },
  // allow serving the @freqhole/midden package (../../midden/pkg) and the
  // @freqhole/reliquary package (../../reliquary/ts) - both sibling repos of
  // skein, two levels above loam, linked in via a file: dependency. without
  // this, the browser's worker import of reliquary's blob-worker.js (which
  // resolves through the node_modules symlink to the real path outside
  // loam's project root) is rejected by vite's dev-server fs allow list.
  server: {
    fs: {
      allow: ["..", "../../midden", "../../reliquary"],
    },
  },
});
