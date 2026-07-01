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
  // only midden (iroh P2P transport) is stubbed in tauri builds.
  plugins: [wasm()],
  // worker bundles need the same plugin — blob-worker imports midden (WASM) for blake3.
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  base: isTauriBuild ? "./" : deployBase || "/",
  build: {
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
  // in tauri builds, alias midden to a stub (P2P transport is handled by the rust backend)
  ...(isTauriBuild
    ? {
        resolve: {
          alias: {
            midden: path.resolve(dirname, "src/stubs/midden-stub.ts"),
          },
        },
      }
    : {}),
});
