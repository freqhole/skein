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

const GIT_TAG = "v0.2.3";
const GIT_SOURCE = `git = "https://github.com/freqhole/tomb", tag = "${GIT_TAG}"`;

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// each entry names a crate's dependency prefix (the literal text right
// before its source spec, e.g. `haruspex = { ` or `freqhole-reliquary = {
// package = "reliquary", `) plus its local sibling-repo path. only the
// prefix + source substring gets swapped, never the whole dependency line
// - that way this survives however the trailing `features = [...]` array
// happens to be formatted (single-line or wrapped across lines) and, via
// the "g" regex flag, fixes every occurrence of the same crate in one pass
// (e.g. both a [dependencies] and a [dev-dependencies] entry).
const files = {
    "tumulus/Cargo.toml": [
        {
            prefix: `freqhole-reliquary = { package = "reliquary", `,
            localPath: "../../tomb/lib/reliquary/rust",
        },
        { prefix: `haruspex = { `, localPath: "../../tomb/lib/haruspex/rust" },
    ],
    "tauri/Cargo.toml": [
        {
            prefix: `freqhole-reliquary = { package = "reliquary", `,
            localPath: "../../tomb/lib/reliquary/rust",
        },
    ],
};

const mode = process.argv[2];
if (mode !== "local" && mode !== "git") {
    console.error("usage: node scripts/toggle-cargo-deps.mjs <local|git>");
    process.exit(1);
}

let changedAny = false;
for (const [relPath, deps] of Object.entries(files)) {
    const filePath = path.join(root, relPath);
    let content = readFileSync(filePath, "utf8");
    let changed = false;

    for (const { prefix, localPath } of deps) {
        const localSource = `path = "${localPath}"`;
        const target = mode === "local" ? localSource : GIT_SOURCE;
        const other = mode === "local" ? GIT_SOURCE : localSource;

        const pattern = new RegExp(escapeRegExp(prefix) + escapeRegExp(other), "g");
        if (!pattern.test(content)) {
            if (!content.includes(prefix + target)) {
                console.warn(
                    `warning: could not find a "${prefix.trim()}" dependency line in ${relPath}`
                );
            }
            continue;
        }

        content = content.replace(pattern, prefix + target);
        changed = true;
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
