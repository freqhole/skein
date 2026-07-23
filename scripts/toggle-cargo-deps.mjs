#!/usr/bin/env node
// switches skein's cargo dependencies on the haruspex and reliquary rust
// crates between a tagged git dependency on tomb (the default, for ci and
// normal builds) and local path dependencies on the sibling repos on disk
// (for developing against unreleased changes in those repos). run `cargo
// check` (or the usual build) afterward to refresh Cargo.lock.
//
// usage: node scripts/toggle-cargo-deps.mjs <local|git>

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");

const GIT_TAG = "v0.2.2";
const GIT_SOURCE = `git = "https://github.com/freqhole/tomb", tag = "${GIT_TAG}"`;

// each file lists the local/git forms of every dependency line to swap between.
const files = {
    "tumulus/Cargo.toml": [
        {
            local: `freqhole-reliquary = { package = "reliquary", path = "../../reliquary/rust" }`,
            git: `freqhole-reliquary = { package = "reliquary", ${GIT_SOURCE} }`,
        },
        {
            local: `haruspex = { path = "../../haruspex/rust", features = ["iroh"] }`,
            git: `haruspex = { ${GIT_SOURCE}, features = ["iroh"] }`,
        },
        {
            local: `haruspex = { path = "../../haruspex/rust", features = ["iroh", "test-utils"] }`,
            git: `haruspex = { ${GIT_SOURCE}, features = ["iroh", "test-utils"] }`,
        },
    ],
    "tauri/Cargo.toml": [
        {
            local: `freqhole-reliquary = { package = "reliquary", path = "../../reliquary/rust" }`,
            git: `freqhole-reliquary = { package = "reliquary", ${GIT_SOURCE} }`,
        },
        {
            local: `freqhole-reliquary = { package = "reliquary", path = "../../reliquary/rust", features = [\n    "test-utils",\n] }`,
            git: `freqhole-reliquary = { package = "reliquary", ${GIT_SOURCE}, features = [\n    "test-utils",\n] }`,
        },
    ],
};

const mode = process.argv[2];
if (mode !== "local" && mode !== "git") {
    console.error("usage: node scripts/toggle-cargo-deps.mjs <local|git>");
    process.exit(1);
}

let changedAny = false;
for (const [relPath, swaps] of Object.entries(files)) {
    const filePath = path.join(root, relPath);
    let content = readFileSync(filePath, "utf8");
    let changed = false;

    for (const { local, git } of swaps) {
        const target = mode === "local" ? local : git;
        const other = mode === "local" ? git : local;

        if (content.includes(target)) continue;
        if (content.includes(other)) {
            content = content.replace(other, target);
            changed = true;
        } else {
            console.warn(`warning: could not find either form of a dependency line in ${relPath}`);
        }
    }

    if (changed) {
        writeFileSync(filePath, content);
        changedAny = true;
        console.log(`updated ${relPath}`);
    }
}

if (changedAny) {
    console.log(`switched cargo deps to ${mode}`);
    console.log("run `cargo check` (or the usual build) to refresh Cargo.lock");
} else {
    console.log(`cargo deps already in ${mode} mode`);
}
