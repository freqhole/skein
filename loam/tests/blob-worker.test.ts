import { expect, test } from "./fixtures/canvas-page";

// exercises the real blob worker path directly (no widget UI involved) to
// confirm the worker's midden WASM init completes and doesn't hang. see
// docs/skein-runtime-plan.md ("blob worker in tests") for background — this
// test is the regression guard for the COOP/COEP header fix in vite.config.ts.

test("blob worker initialises and hashes + writes to OPFS", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  const processed = await page.evaluate(async () => {
    const helpers = (window as any).__skeinHelpers;
    const bytes = new TextEncoder().encode("skein blob worker smoke test").buffer;
    return helpers.processBlobBytes(bytes, "smoke.txt", "text/plain");
  });

  expect(processed.blake3).not.toBe("");
  expect(processed.sha256).not.toBe("");
  expect(processed.size).toBe(28);

  // confirm the bytes actually landed in OPFS via the worker's own read path
  const opfsBytesLength = await page.evaluate(async (blobId: string) => {
    const helpers = (window as any).__skeinHelpers;
    const worker = await helpers.getBlobWorker();
    const buf = await worker.readBlobFromOpfs(blobId);
    return buf ? buf.byteLength : null;
  }, processed.sha256);

  expect(opfsBytesLength).toBe(28);
});
