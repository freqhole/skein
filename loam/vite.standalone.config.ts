import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, type Plugin } from "vite";

import wasm from "vite-plugin-wasm";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const isTauriBuild = !!process.env.VITE_TAURI;

// custom base path for deployment (e.g. VITE_SKEIN_BASE=/skein/ for cloudflare)
const deployBase = process.env.VITE_SKEIN_BASE;

// resolves the bare "midden" specifier reliquary's blob worker dynamically
// imports (see @freqhole/reliquary/worker's midden-blake3.ts). a plain
// `resolve.alias` entry does not reach a worker's own module graph - vite
// builds worker bundles through a separate plugin pipeline from the main
// app, so this has to be a real plugin included in both the main `plugins`
// and `worker.plugins` lists below.
function middenBareSpecifierPlugin(target: string): Plugin {
  return {
    name: "midden-bare-specifier",
    resolveId(source) {
      if (source === "midden") return this.resolve(target, undefined, { skipSelf: true });
      return null;
    },
  };
}

const middenTarget = isTauriBuild ? path.resolve(dirname, "src/stubs/midden-stub.ts") : "@freqhole/midden";

export default defineConfig({
  // wasm plugin is needed (automerge uses WASM internally).
  // only @freqhole/midden (iroh P2P transport) is stubbed in tauri builds.
  plugins: [wasm(), middenBareSpecifierPlugin(middenTarget)],
  // worker bundles need the same plugins — blob-worker imports @freqhole/midden (WASM) for blake3.
  worker: {
    format: "es",
    plugins: () => [wasm(), middenBareSpecifierPlugin(middenTarget)],
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
  // the bare "midden" specifier (see middenBareSpecifierPlugin above) is
  // handled by a plugin instead of resolve.alias so it also reaches worker
  // bundles. tauri builds point both at the same local stub @freqhole/midden
  // is aliased to.
  resolve: {
    alias: isTauriBuild
      ? {
          "@freqhole/midden": path.resolve(dirname, "src/stubs/midden-stub.ts"),
        }
      : {},
  },
  // exclude @freqhole/midden from esbuild pre-bundling — it contains a .wasm
  // file that esbuild can't handle; vite-plugin-wasm takes care of it instead.
  optimizeDeps: {
    exclude: ["@freqhole/midden"],
  },
  // allow serving the @freqhole/midden package (../../tomb/lib/midden/pkg)
  // and the @freqhole/reliquary package (../../tomb/lib/reliquary/ts) -
  // both live under tomb/lib/, linked in via a file: dependency. without
  // this, the browser's worker import of reliquary's blob-worker.js (which
  // resolves through the node_modules symlink to the real path outside
  // loam's project root) is rejected by vite's dev-server fs allow list.
  server: {
    fs: {
      allow: ["..", "../../tomb/lib/midden", "../../tomb/lib/reliquary"],
    },
  },
});
