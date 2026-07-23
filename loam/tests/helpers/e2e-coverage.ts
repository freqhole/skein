import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";

/**
 * directory istanbul coverage maps land in during a `COVERAGE_E2E=1` run.
 * one json file per page per test - merged + reported by
 * `scripts/merge-e2e-coverage.mjs` after the full playwright run finishes.
 */
export const E2E_COVERAGE_DIR = join(process.cwd(), "coverage-e2e", "tmp");

/**
 * reads `window.__coverage__` (populated by vite-plugin-istanbul, see
 * `vite.config.ts`'s `COVERAGE_E2E` gate) off a page and writes it to
 * `E2E_COVERAGE_DIR` as its own json file. a no-op when the app wasn't
 * instrumented (plain `npm run test:e2e`), so callers can call this
 * unconditionally without checking the env var themselves.
 *
 * call this right before closing a page - `window.__coverage__` only
 * reflects code paths executed up to that point.
 */
export async function dumpPageCoverage(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  let coverage: unknown;
  try {
    coverage = await page.evaluate(() => (window as any).__coverage__);
  } catch {
    // page already closed/crashed - nothing to collect.
    return;
  }
  if (!coverage || typeof coverage !== "object") return;

  mkdirSync(E2E_COVERAGE_DIR, { recursive: true });
  const safeTitle = testInfo.titlePath.join(" > ").replace(/[^a-z0-9]+/gi, "_");
  const fileName = `${safeTitle}__${label}__${randomUUID()}.json`;
  writeFileSync(join(E2E_COVERAGE_DIR, fileName), JSON.stringify(coverage));
}
