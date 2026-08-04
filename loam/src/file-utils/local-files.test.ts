// ---------------------------------------------------------------------------
// unit tests for subscribeToLocalFiles's on-demand query/race-guard logic —
// mocks `listLocalBlobs` (the upstream data source), mirroring
// pending-transfers.test.ts's vi.mock-with-factory style.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ListLocalBlobsOptions, ListLocalBlobsPage } from "./local-blobs";

const mockListLocalBlobs = vi.fn<(options: ListLocalBlobsOptions) => Promise<ListLocalBlobsPage>>(
  async () => ({ items: [], totalCount: 0, totalSize: 0 })
);
vi.mock("./local-blobs", () => ({
  listLocalBlobs: (...args: any[]) => mockListLocalBlobs(...args),
}));

import { subscribeToLocalFiles, type LocalFilesResult } from "./local-files";

describe("subscribeToLocalFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a successful page to the listener", async () => {
    mockListLocalBlobs.mockResolvedValue({
      items: [{ blobId: "b1", blake3: "b1", size: 10, createdAt: 1, external: false }],
      totalCount: 1,
      totalSize: 10,
    });
    const results: LocalFilesResult[] = [];
    const sub = subscribeToLocalFiles((r) => results.push(r));

    await sub.query({ sort: "size" });

    expect(mockListLocalBlobs).toHaveBeenCalledWith({ sort: "size" });
    expect(results).toEqual([
      {
        ok: true,
        items: [{ blobId: "b1", blake3: "b1", size: 10, createdAt: 1, external: false }],
        totalCount: 1,
        totalSize: 10,
      },
    ]);
  });

  it("reports an error result when listLocalBlobs rejects", async () => {
    mockListLocalBlobs.mockRejectedValue(new Error("boom"));
    const results: LocalFilesResult[] = [];
    const sub = subscribeToLocalFiles((r) => results.push(r));

    await sub.query({});

    expect(results).toEqual([{ ok: false, error: "failed to load local files" }]);
  });

  it("only delivers the latest of two overlapping queries (race guard)", async () => {
    let resolveFirst: ((page: ListLocalBlobsPage) => void) | undefined;
    mockListLocalBlobs
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(async () => ({
        items: [{ blobId: "second", blake3: "second", size: 2, createdAt: 2, external: false }],
        totalCount: 1,
        totalSize: 2,
      }));

    const results: LocalFilesResult[] = [];
    const sub = subscribeToLocalFiles((r) => results.push(r));

    const firstQuery = sub.query({ search: "a" });
    const secondQuery = sub.query({ search: "ab" });

    await secondQuery;
    // now resolve the first (stale) query after the second already landed
    resolveFirst?.({
      items: [{ blobId: "first", blake3: "first", size: 1, createdAt: 1, external: false }],
      totalCount: 1,
      totalSize: 1,
    });
    await firstQuery;

    expect(results).toEqual([
      {
        ok: true,
        items: [{ blobId: "second", blake3: "second", size: 2, createdAt: 2, external: false }],
        totalCount: 1,
        totalSize: 2,
      },
    ]);
  });

  it("stops delivering results after unsubscribe", async () => {
    mockListLocalBlobs.mockResolvedValue({
      items: [{ blobId: "b1", blake3: "b1", size: 10, createdAt: 1, external: false }],
      totalCount: 1,
      totalSize: 10,
    });
    const results: LocalFilesResult[] = [];
    const sub = subscribeToLocalFiles((r) => results.push(r));

    sub.unsubscribe();
    await sub.query({});

    expect(results).toEqual([]);
  });
});
