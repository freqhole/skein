#!/usr/bin/env node
// switches loam's @freqhole/haruspex, @freqhole/midden, @freqhole/reliquary
// dependencies between published npm versions (for ci/production builds)
// and file: links to the sibling repos on disk (for local development
// against unreleased changes).
//
// shells out to `npm install <pkg>@<spec>` directly instead of hand-editing
// package.json and node_modules ourselves - a plain `npm install` with no
// args won't replace an existing local file: link (or npm tarball) already
// in node_modules just because package.json's version spec changed (it
// sees the lockfile/tree as already satisfied and no-ops), which leaves a
// stale entry in place. installing each package by name forces npm's own
// resolver to actually replace it, and npm handles updating package.json
// and package-lock.json itself as part of that.
//
// usage: node scripts/toggle-deps.mjs <local|npm>

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const loamDir = path.resolve(dirname, "..");

// local paths are relative to loam/. haruspex, midden, and reliquary all
// live under tomb/lib/ (not their own top-level sibling repos), matching
// their ts/wasm-pack build output dirs there.
const packages = {
    "@freqhole/haruspex": {
        npm: "^0.2.6",
        local: "file:../../tomb/lib/haruspex/ts",
    },
    "@freqhole/midden": {
        npm: "^0.2.6",
        local: "file:../../tomb/lib/midden/pkg",
    },
    "@freqhole/reliquary": {
        npm: "^0.2.6",
        local: "file:../../tomb/lib/reliquary/ts",
    },
};

const mode = process.argv[2];
if (mode !== "local" && mode !== "npm") {
    console.error("usage: node scripts/toggle-deps.mjs <local|npm>");
    process.exit(1);
}

const specs = Object.entries(packages).map(([name, targets]) => `${name}@${targets[mode]}`);

console.log(`installing: ${specs.join(", ")}`);
execFileSync("npm", ["install", ...specs], { cwd: loamDir, stdio: "inherit" });

console.log(`switched @freqhole/{haruspex,midden,reliquary} to ${mode}`);
