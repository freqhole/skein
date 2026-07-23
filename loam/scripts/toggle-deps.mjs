#!/usr/bin/env node
// switches loam's @freqhole/haruspex, @freqhole/midden, @freqhole/reliquary
// dependencies between published npm versions (for ci/production builds)
// and file: links to the sibling repos on disk (for local development
// against unreleased changes). run `npm install` afterward to apply.
//
// usage: node scripts/toggle-deps.mjs <local|npm>

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(dirname, "..", "package.json");

// npm version ranges are the checked-in default; local paths are relative
// to loam/, matching the sibling repos' ts/wasm-pack build output dirs.
// midden lives under tomb/lib/midden (not its own top-level sibling repo).
const packages = {
    "@freqhole/haruspex": {
        npm: "^0.2.2",
        local: "file:../../haruspex/ts",
    },
    "@freqhole/midden": {
        npm: "^0.2.2",
        local: "file:../../tomb/lib/midden/pkg",
    },
    "@freqhole/reliquary": {
        npm: "^0.2.2",
        local: "file:../../reliquary/ts",
    },
};

const mode = process.argv[2];
if (mode !== "local" && mode !== "npm") {
    console.error("usage: node scripts/toggle-deps.mjs <local|npm>");
    process.exit(1);
}

const raw = readFileSync(packageJsonPath, "utf8");
const pkg = JSON.parse(raw);

for (const [name, targets] of Object.entries(packages)) {
    if (!pkg.dependencies?.[name]) {
        console.warn(`warning: ${name} not found in dependencies, skipping`);
        continue;
    }
    pkg.dependencies[name] = targets[mode];
}

writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`switched @freqhole/{haruspex,midden,reliquary} to ${mode} in package.json`);
console.log("run `npm install` to apply");
