#!/usr/bin/env node
// bumps skein's pinned tomb/lib dependency versions (the git tag the rust
// crates track, and the npm version range loam's @freqhole/* deps track) in
// one go. run this once a new tomb/lib version has actually been published
// (tagged on github + published to npm) - it only updates the version
// strings skein points at, it doesn't publish anything itself.
//
// usage: node scripts/bump-tomb-deps.mjs <new-version>   (e.g. 0.2.2)

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");

const newVersion = process.argv[2];
if (!newVersion) {
    console.error("usage: node scripts/bump-tomb-deps.mjs <new-version>");
    process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error(`error: "${newVersion}" doesn't look like a semver version (expected x.y.z)`);
    process.exit(1);
}

// toggle-cargo-deps.mjs's GIT_TAG constant is the source of truth for the
// currently-pinned version - reading it back out means this script never
// needs its own hardcoded "old version" to search for.
const toggleScriptPath = path.join(root, "scripts/toggle-cargo-deps.mjs");
const toggleScript = readFileSync(toggleScriptPath, "utf8");
const currentTagMatch = toggleScript.match(/const GIT_TAG = "v([^"]+)";/);
if (!currentTagMatch) {
    console.error(`error: could not find "const GIT_TAG = ..." in ${toggleScriptPath}`);
    process.exit(1);
}
const currentVersion = currentTagMatch[1];

if (currentVersion === newVersion) {
    console.log(`tomb/lib deps are already pinned to ${newVersion}`);
    process.exit(0);
}

console.log(`bumping tomb/lib dep versions: ${currentVersion} -> ${newVersion}`);

// scripts/toggle-cargo-deps.mjs's GIT_TAG constant (used whenever `make
// deps-npm` switches back to the tagged git dependency).
{
    const updated = toggleScript.replace(
        `const GIT_TAG = "v${currentVersion}";`,
        `const GIT_TAG = "v${newVersion}";`
    );
    writeFileSync(toggleScriptPath, updated);
    console.log("updated scripts/toggle-cargo-deps.mjs");
}

// tumulus/Cargo.toml + tauri/Cargo.toml: only rewrite the tag string when a
// crate is currently pinned to it (a crate left in local-path mode has no
// tag string to bump - that's fine, `make deps-npm` will pick up the new
// tag next time it switches back).
for (const relPath of ["tumulus/Cargo.toml", "tauri/Cargo.toml"]) {
    const filePath = path.join(root, relPath);
    const content = readFileSync(filePath, "utf8");
    const oldTag = `tag = "v${currentVersion}"`;
    const newTag = `tag = "v${newVersion}"`;
    if (!content.includes(oldTag)) {
        console.warn(`warning: "${oldTag}" not found in ${relPath} (in local-path mode? skipping)`);
        continue;
    }
    writeFileSync(filePath, content.split(oldTag).join(newTag));
    console.log(`updated ${relPath}`);
}

// loam/package.json: the three @freqhole/* npm deps
{
    const pkgPath = path.join(root, "loam/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const name of ["@freqhole/haruspex", "@freqhole/midden", "@freqhole/reliquary"]) {
        if (pkg.dependencies?.[name]) {
            pkg.dependencies[name] = `^${newVersion}`;
        }
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log("updated loam/package.json");
}

console.log("");
console.log(`done - tomb/lib deps now point at ${newVersion}`);
