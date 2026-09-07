// ---------------------------------------------------------------------------
// forensic analysis of an automerge doc's own change history — answers "of
// the huge op count this doc has piled up, WHICH field is actually noisy"
// (a whole-list splice-replace vs. legitimate per-item field edits look very
// different once broken down by which object each op actually touched) and
// "was this bloat one runaway burst, or slow organic growth over real usage".
// purely observational: decodes changes and reports, never mutates the doc.
// see doc-history-stats.ts for the simpler "just the totals" version this
// builds on.
// ---------------------------------------------------------------------------

import type { DocHandle } from "@automerge/automerge-repo";
import { next as A } from "@automerge/automerge/slim";

export interface FieldOpBreakdown {
  label: string;
  opCount: number;
  /** how many distinct changes touched this field at all (vs. opCount,
   *  which counts every individual op) — a field with a high opCount but
   *  low changeCount is exactly the "one change rewrote the whole list"
   *  signature; high changeCount with modest opCount-per-change is
   *  ordinary per-item editing. */
  changeCount: number;
}

export interface LargeChangeEntry {
  seq: number;
  time: number;
  ops: number;
  message: string | null;
  /** op action -> count within just this one change (e.g. `{makeMap: 40,
   *  set: 200}`) — a change dominated by makeMap+set pairs is the "whole
   *  list rewritten, every element recreated as a brand-new object"
   *  signature, distinguishable from other write patterns even though the
   *  recreated objects themselves may since have been deleted (so
   *  `byField` alone can't see them — see `buildObjectLabelMap()`'s own
   *  doc comment). */
  actionCounts: Record<string, number>;
}

export interface DocChangeAnalysis {
  totalChanges: number;
  totalOps: number;
  byField: FieldOpBreakdown[];
  /** op action -> count across EVERY op in the whole doc — the doc-wide
   *  version of `LargeChangeEntry.actionCounts`. a doc dominated by
   *  makeMap+set (roughly N makeMap for every ~fieldsPerItem*N set) means
   *  the bulk of history is object creation, i.e. list elements being
   *  recreated wholesale rather than edited in place — true regardless of
   *  whether those elements still exist in the current doc. */
  actionTotals: Record<string, number>;
  /** the biggest individual changes by op count, worst first — cross-
   *  reference against `byField` to see whether the same field dominates
   *  every outlier or whether it's spread around. */
  largestChanges: LargeChangeEntry[];
  opCountHistogram: { bucket: string; count: number }[];
  /** `time` is seconds-since-epoch per automerge's own DecodedChange
   *  shape — spans real wall-clock usage, not a proxy for "how long ago
   *  in wasm decode time". a short `totalSpanSec` with a huge
   *  `changesWithinTwoSecondsOfPrev` count means the bloat arrived in one
   *  tight burst (a retry loop, a busted throttle) rather than organic
   *  growth spread over normal editing sessions. changes with a
   *  non-positive/missing `time` (a peer with an unset system clock, or a
   *  synthetic change) are excluded from the span so one bad timestamp
   *  can't blow it out to a bogus multi-decade number. */
  burstiness: { totalSpanSec: number; changesWithinTwoSecondsOfPrev: number; excludedInvalidTimes: number };
}

const OP_COUNT_BUCKETS = [10, 100, 1_000, 10_000, 100_000];

function bucketLabel(ops: number): string {
  for (let i = 0; i < OP_COUNT_BUCKETS.length; i++) {
    if (ops <= OP_COUNT_BUCKETS[i]) return i === 0 ? `<= ${OP_COUNT_BUCKETS[i]}` : `${OP_COUNT_BUCKETS[i - 1] + 1}-${OP_COUNT_BUCKETS[i]}`;
  }
  return `> ${OP_COUNT_BUCKETS[OP_COUNT_BUCKETS.length - 1]}`;
}

/** best-effort objectId -> friendly label map for the CURRENT doc shape —
 *  root-level fields get their own name (e.g. "clips"), and list-of-object
 *  fields additionally get a "clips[*]" bucket covering every current
 *  element's own object id (aggregated, not per-index, since indices shift
 *  over a doc's lifetime and a historical op's index rarely still matches
 *  anything live). an op against an object this map doesn't know about
 *  (already-removed elements, deeper nesting) falls into "other/unrecognized"
 *  rather than being dropped — still counted in totals, just not attributable. */
function buildObjectLabelMap(doc: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of Object.keys(doc)) {
    const fieldId = A.getObjectId(doc, key);
    if (!fieldId) continue;
    map.set(fieldId, key);
    const value = doc[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const itemId = A.getObjectId(value, i);
        if (itemId) map.set(itemId, `${key}[*]`);
      }
    }
  }
  return map;
}

/** decodes every change in `handle`'s doc and breaks its ops down by which
 *  field they actually touched, plus size/burst stats — `null` if the
 *  handle isn't ready or has no content. see this module's own doc comment
 *  for how to read the result. */
export function analyzeDocChanges(handle: DocHandle<any> | null | undefined, options?: { topFields?: number; topChanges?: number }): DocChangeAnalysis | null {
  if (!handle?.isReady()) return null;
  const doc = handle.doc();
  if (!doc) return null;

  const topFields = options?.topFields ?? 20;
  const topChanges = options?.topChanges ?? 10;

  const labelMap = buildObjectLabelMap(doc);
  const fieldOps = new Map<string, { opCount: number; changes: Set<string> }>();
  const actionTotals: Record<string, number> = {};
  const largest: LargeChangeEntry[] = [];
  const times: number[] = [];
  let totalOps = 0;
  let totalChanges = 0;
  const histogram = new Map<string, number>();

  for (const change of A.getAllChanges(doc)) {
    const decoded = A.decodeChange(change);
    totalChanges++;
    totalOps += decoded.ops.length;
    times.push(decoded.time);
    const bucket = bucketLabel(decoded.ops.length);
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    const actionCounts: Record<string, number> = {};

    for (const op of decoded.ops) {
      const label = labelMap.get(op.obj) ?? "other/unrecognized";
      const entry = fieldOps.get(label) ?? { opCount: 0, changes: new Set() };
      entry.opCount++;
      entry.changes.add(decoded.hash);
      fieldOps.set(label, entry);
      actionCounts[op.action] = (actionCounts[op.action] ?? 0) + 1;
      actionTotals[op.action] = (actionTotals[op.action] ?? 0) + 1;
    }

    largest.push({ seq: decoded.seq, time: decoded.time, ops: decoded.ops.length, message: decoded.message, actionCounts });
  }

  const validTimes = times.filter((t) => t > 0).sort((a, b) => a - b);
  let changesWithinTwoSecondsOfPrev = 0;
  for (let i = 1; i < validTimes.length; i++) {
    if (validTimes[i] - validTimes[i - 1] <= 2) changesWithinTwoSecondsOfPrev++;
  }
  const totalSpanSec = validTimes.length > 1 ? validTimes[validTimes.length - 1] - validTimes[0] : 0;
  const excludedInvalidTimes = times.length - validTimes.length;

  const byField = [...fieldOps.entries()]
    .map(([label, { opCount, changes }]) => ({ label, opCount, changeCount: changes.size }))
    .sort((a, b) => b.opCount - a.opCount)
    .slice(0, topFields);

  largest.sort((a, b) => b.ops - a.ops);

  return {
    totalChanges,
    totalOps,
    byField,
    actionTotals,
    largestChanges: largest.slice(0, topChanges),
    opCountHistogram: [...histogram.entries()].map(([bucket, count]) => ({ bucket, count })),
    burstiness: { totalSpanSec, changesWithinTwoSecondsOfPrev, excludedInvalidTimes },
  };
}
