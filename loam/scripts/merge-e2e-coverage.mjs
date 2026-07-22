#!/usr/bin/env node
// merges the per-page istanbul coverage maps dumped by
// tests/helpers/e2e-coverage.ts (one json file per page per test, written to
// coverage-e2e/tmp/ during a `COVERAGE_E2E=1` playwright run) into a single
// report under coverage-e2e/. shows how much of src/ + widgets/ the
// blob-transfer/snatch e2e specs actually exercise, complementing (not
// replacing) vitest's unit-test coverage in coverage/.
//
// usage: npm run test:e2e:coverage  (runs the e2e specs then this script)
//     or: node scripts/merge-e2e-coverage.mjs  (report-only, reuses an
//         existing coverage-e2e/tmp/ from a prior COVERAGE_E2E=1 run)

import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const tmpDir = path.join(root, "coverage-e2e", "tmp");
const outDir = path.join(root, "coverage-e2e");

if (!existsSync(tmpDir)) {
    console.error(
        `no coverage data found at ${tmpDir} - run with COVERAGE_E2E=1 first ` +
        `(e.g. \`npm run test:e2e:coverage\`), which instruments src/ + widgets/ ` +
        `via vite-plugin-istanbul before running the specs.`
    );
    process.exit(1);
}

const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
if (files.length === 0) {
    console.error(`${tmpDir} exists but has no coverage json files - nothing to report.`);
    process.exit(1);
}

const map = libCoverage.createCoverageMap({});
for (const file of files) {
    const json = JSON.parse(readFileSync(path.join(tmpDir, file), "utf8"));
    map.merge(json);
}

const context = libReport.createContext({ dir: outDir, coverageMap: map });
for (const name of ["text-summary", "lcov", "html"]) {
    reports.create(name, {}).execute(context);
}

console.log(`merged ${files.length} page coverage files -> ${outDir}/`);
console.log(`open ${outDir}/html/index.html for the detailed report.`);
