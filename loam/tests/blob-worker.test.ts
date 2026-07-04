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
  // blake3 is the canonical blob id (sha256 is legacy metadata)
  expect(processed.blob_id).toBe(processed.blake3);

  // confirm the bytes actually landed in OPFS via the worker's own read path
  // (files are keyed by the canonical blake3 id)
  const opfsBytesLength = await page.evaluate(async (blobId: string) => {
    const helpers = (window as any).__skeinHelpers;
    const worker = await helpers.getBlobWorker();
    const buf = await worker.readBlobFromOpfs(blobId);
    return buf ? buf.byteLength : null;
  }, processed.blake3);

  expect(opfsBytesLength).toBe(28);
});

test("streaming upload session: chunked blake3 + OPFS write matches the one-shot path", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();

  const result = await page.evaluate(async () => {
    const helpers = (window as any).__skeinHelpers;

    // ~2.5MB of deterministic bytes, in a File so streamFileToOpfs can
    // consume file.stream() exactly like a real picker upload
    const size = 2_500_000;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
    const file = new File([bytes], "stream-test.bin", { type: "application/octet-stream" });

    const streamed = await helpers.streamFileToOpfs(file);

    // one-shot hash of the same content for comparison
    const worker = await helpers.getBlobWorker();
    const oneShotHash = await worker.hashBlake3(bytes);
    const opfsBytes = await worker.readBlobFromOpfs(streamed.blake3);

    return {
      streamedHash: streamed.blake3,
      streamedSize: streamed.size,
      oneShotHash,
      opfsByteLength: opfsBytes ? opfsBytes.byteLength : null,
    };
  });

  // incremental blake3 must agree with the one-shot hash
  expect(result.streamedHash).toBe(result.oneShotHash);
  expect(result.streamedHash).toHaveLength(64);
  expect(result.streamedSize).toBe(2_500_000);
  // and the bytes must have landed under the blake3 content address
  expect(result.opfsByteLength).toBe(2_500_000);
});

// stage-0 opfs-store spike (docs/opfs-store-implementation-plan.md phase C):
// midden's out-of-crate iroh-blobs store actor persisting to real OPFS via
// sync access handles. the selftest runs inside the blob worker (dedicated
// worker context) and exercises the REAL iroh-blobs api surface:
// add_bytes -> get_bytes -> status -> export_bao -> import_bao_bytes into a
// second store -> get_bytes. any mismatch throws.
test("opfs store spike: full import/export round trip through the real iroh-blobs api", async ({
  canvasPage,
}) => {
  test.setTimeout(90_000);
  const { page } = await canvasPage();

  const summary = await page.evaluate(async () => {
    const helpers = (window as any).__skeinHelpers;
    const worker = await helpers.getBlobWorker();
    return worker.opfsStoreSelftest() as Promise<string>;
  });

  expect(summary).toContain("opfs store selftest OK");
  expect(summary).toContain("1500000 bytes");
});

// phase C: blobs + tags must survive a store shutdown/reopen over the same
// OPFS directory — the cross-reload persistence the store exists for.
test("opfs store: blobs and tags survive a store restart (persistence)", async ({
  canvasPage,
}) => {
  test.setTimeout(90_000);
  const { page } = await canvasPage();

  const summary = await page.evaluate(async () => {
    const helpers = (window as any).__skeinHelpers;
    const worker = await helpers.getBlobWorker();
    return worker.opfsStoreSelftestPersistence() as Promise<string>;
  });

  expect(summary).toContain("persistence selftest OK");
});
