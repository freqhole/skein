import { describe, expect, it } from "vitest";
import { COMPACT_CHANGES_THRESHOLD, shouldOfferCompaction, type DocHistoryStats } from "./doc-history-stats";

function stats(numChanges: number): DocHistoryStats {
  return { numChanges, numOps: 0, maxChangeOps: null, savedBytes: null };
}

describe("shouldOfferCompaction", () => {
  it("is false at and below the threshold", () => {
    expect(shouldOfferCompaction(stats(0))).toBe(false);
    expect(shouldOfferCompaction(stats(COMPACT_CHANGES_THRESHOLD - 1))).toBe(false);
    expect(shouldOfferCompaction(stats(COMPACT_CHANGES_THRESHOLD))).toBe(false);
  });

  it("is true once numChanges exceeds the threshold", () => {
    expect(shouldOfferCompaction(stats(COMPACT_CHANGES_THRESHOLD + 1))).toBe(true);
    expect(shouldOfferCompaction(stats(259))).toBe(true);
  });

  it("stays false for huge numOps if numChanges is still low — a doc can already be", () => {
    // history-free (numChanges: 1) yet have a huge numOps purely from
    // legitimate current content (e.g. a detailed doodle) — compacting it
    // again would produce an identical op count, so it must not be
    // offered here regardless of how large numOps is.
    expect(shouldOfferCompaction({ numChanges: 1, numOps: 209_424, maxChangeOps: null, savedBytes: null })).toBe(false);
  });
});
