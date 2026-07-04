/**
 * chunked import (midden ImportSession over iroh-blobs add_stream): proves
 * the streaming import path produces the same content address as the
 * one-shot import_blob AND that the resulting blob is actually servable to
 * another peer over a real iroh-blobs verified transfer.
 *
 * this is the e2e guard for the phase B "upload streaming" work (see
 * docs/opfs-store-implementation-plan.md): skein-handler's ensure_blob /
 * compute_blake3 use this exact session machinery for large blobs, so a
 * regression here means large-blob serving silently falls back or breaks.
 *
 * uses a deliberately-small payload (256KB chunks over ~1.5MB) — the
 * chunking mechanics are identical at any size, and small fixtures keep
 * this heavy-lane test fast. blob-worker.test.ts covers the worker-side
 * streaming upload (incremental blake3 + OPFS) separately.
 *
 * tag: @p2p
 * run with: npx playwright test tests/blob-stream-import.spec.ts --workers=1
 */

import { test, expect } from "./fixtures/p2p-page";
import type { Page } from "@playwright/test";
import { fromEvaluateArray, randomBlobBytes, toEvaluateArray } from "./helpers/blob-fixtures";

/** import bytes on `page` via the chunked ImportSession bridge method. */
async function importBlobStreaming(page: Page, bytes: Uint8Array): Promise<string> {
  return page.evaluate(async (byteArray: number[]) => {
    const bridge = (window as any).__skeinTest;
    const bytes = Uint8Array.from(byteArray);
    return bridge.p2p.importBlobStreaming(bytes) as Promise<string>;
  }, toEvaluateArray(bytes));
}

/** one-shot import (existing import_blob path) for hash comparison. */
async function importBlobOneShot(page: Page, bytes: Uint8Array): Promise<string> {
  return page.evaluate(async (byteArray: number[]) => {
    const bridge = (window as any).__skeinTest;
    const bytes = Uint8Array.from(byteArray);
    return bridge.p2p.importBlob(bytes) as Promise<string>;
  }, toEvaluateArray(bytes));
}

/** fetch a blob directly from `peerNodeId` by hash, retrying transient dial failures. */
async function fetchBlobWithRetry(
  page: Page,
  peerNodeId: string,
  blake3Hash: string,
  attempts = 4,
  delayMs = 1000
): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.evaluate(
        async ([peerId, hash]) => {
          const bridge = (window as any).__skeinTest;
          const bytes: Uint8Array = await bridge.p2p.fetchBlob(peerId, hash);
          return Array.from(bytes);
        },
        [peerNodeId, blake3Hash] as const
      );
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

test("chunked ImportSession produces the same blake3 as one-shot import_blob @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(120_000);

  const peer = await p2pPage();
  const bytes = randomBlobBytes();

  const streamedHash = await importBlobStreaming(peer.page, bytes);
  const oneShotHash = await importBlobOneShot(peer.page, bytes);

  expect(streamedHash).toHaveLength(64);
  expect(streamedHash).toBe(oneShotHash);
});

test("a blob imported via chunked ImportSession is servable to another peer @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const fetcher = await p2pPage();

  const sourceBytes = randomBlobBytes();
  const blake3 = await importBlobStreaming(owner.page, sourceBytes);

  const fetchedBytes = await fetchBlobWithRetry(fetcher.page, owner.nodeId, blake3);
  expect(fromEvaluateArray(fetchedBytes)).toEqual(sourceBytes);
});

test("a paused download keeps its partial and resumes to a byte-identical blob @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(240_000);

  const owner = await p2pPage();
  const fetcher = await p2pPage();

  // generate the content in-page (24MiB as an evaluate arg would serialize
  // a 24M-element array) — deterministic mulberry32, same seed both pages
  const SIZE = 24 * 1024 * 1024;
  const SEED = 0xc0ffee;

  const blake3 = await owner.page.evaluate(
    async ([size, seed]) => {
      const bridge = (window as any).__skeinTest;
      let state = seed >>> 0;
      const next = (): number => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = Math.floor(next() * 256);
      return bridge.p2p.importBlob(bytes, { filename: "pause-resume.bin" }) as Promise<string>;
    },
    [SIZE, SEED] as const
  );

  // pause at the first progress event, verify the store only has a partial,
  // then resume (fresh downloadId) and byte-compare against regenerated
  // source content — all in-page to avoid hauling 24MiB through evaluate.
  const result = await fetcher.page.evaluate(
    async ([peerId, hash, size, seed]) => {
      const bridge = (window as any).__skeinTest;

      // first attempt, cancelled from the first progress event. transient
      // dial failures (peer discovery still warming) retry; a cancelled
      // result is the success condition here.
      let paused: { completed: boolean; cancelled: boolean } | null = null;
      let lastErr = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          paused = await bridge.p2p.fetchBlobStreamingPausable(
            peerId,
            hash,
            size,
            `dl-pause-${attempt}`,
            0
          );
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!paused) return { error: `pause attempt never ran: ${lastErr}` };

      const completeAfterPause = await bridge.p2p.hasCompleteBlob(hash);

      // resume: no pause fraction — runs to completion. the persisted
      // partial means the downloader only requests the missing ranges.
      const resumed = await bridge.p2p.fetchBlobStreamingPausable(
        peerId,
        hash,
        size,
        "dl-resume"
      );

      // verify content against the regenerated deterministic source
      let mismatches = -1;
      if (resumed.bytes) {
        let state = seed >>> 0;
        const next = (): number => {
          state |= 0;
          state = (state + 0x6d2b79f5) | 0;
          let t = Math.imul(state ^ (state >>> 15), 1 | state);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        mismatches = 0;
        for (let i = 0; i < size; i++) {
          if (resumed.bytes[i] !== Math.floor(next() * 256)) mismatches++;
        }
      }

      return {
        pausedCancelled: paused.cancelled,
        pausedCompleted: paused.completed,
        completeAfterPause,
        resumedCompleted: resumed.completed,
        resumedSize: resumed.bytes ? resumed.bytes.length : 0,
        mismatches,
        completeAfterResume: await bridge.p2p.hasCompleteBlob(hash),
      };
    },
    [owner.nodeId, blake3, SIZE, SEED] as const
  );

  expect(result).not.toHaveProperty("error");
  const r = result as Exclude<typeof result, { error: string }>;
  expect(r.pausedCancelled).toBe(true);
  expect(r.pausedCompleted).toBe(false);
  // the partial survived the pause but the blob is not complete yet
  expect(r.completeAfterPause).toBe(false);
  // resume ran to a complete, byte-identical blob
  expect(r.resumedCompleted).toBe(true);
  expect(r.resumedSize).toBe(SIZE);
  expect(r.mismatches).toBe(0);
  expect(r.completeAfterResume).toBe(true);
});
