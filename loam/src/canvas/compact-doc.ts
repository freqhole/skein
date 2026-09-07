import type { DocHandle, Repo } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import { deepUnwrapAmStrings } from "./automerge-values";

const TAG = "compact-doc";

const DEFAULT_QUIET_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 8_000;

/** structural equality, NOT `JSON.stringify` string equality — a plain
 *  object's key order is insertion order, and automerge reconstructs a
 *  doc's own internal key order from its (possibly heavily-edited-over-
 *  time) op history, not from whatever order a freshly-built plain JS
 *  object happens to enumerate in. two objects holding the exact same
 *  data in a different key order are semantically identical but produce
 *  different `JSON.stringify` output, which `compactDoc()`'s verification
 *  step used to (wrongly) treat as "compaction corrupted the data" and
 *  abort — confirmed live: this only ever showed up on a doc with
 *  "way more ops" (more historical field churn -> more likely to have a
 *  scrambled key order), never on a small/simple one, which is exactly
 *  the signature of a key-order false positive rather than a real data
 *  mismatch. exported for direct unit testing. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export interface WaitForQuietPeriodOptions {
  /** how long with no incoming "change" events before considering the doc
   *  settled enough to compact. */
  quietMs?: number;
  /** hard ceiling regardless of ongoing activity -- a doc that keeps
   *  changing every couple seconds forever must not block compaction
   *  indefinitely. */
  maxWaitMs?: number;
}

/**
 * waits for `handle` to go quiet (no "change" events) for `quietMs`, or
 * until `maxWaitMs` elapses overall, whichever comes first.
 *
 * used before compacting a doc that another peer (especially a hub
 * relaying changes it's tracking on behalf of a currently-offline peer)
 * might still be mid-sync on, so a last-moment burst of incoming changes
 * has a chance to land in the snapshot instead of being silently orphaned
 * on the old, about-to-be-abandoned doc (see docs/animaniac-doc-
 * compaction-plan.md's "who can compact" section for the full scenario).
 * this is a best-effort reduction of that race window, not a guarantee --
 * there's no signal in a P2P CRDT system for "every peer is now caught
 * up," only "nothing has arrived recently."
 */
export function waitForQuietPeriod(handle: DocHandle<any>, options?: WaitForQuietPeriodOptions): Promise<void> {
  const quietMs = options?.quietMs ?? DEFAULT_QUIET_MS;
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    const maxTimer = setTimeout(finish, maxWaitMs);

    function finish() {
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      handle.off("change", onChange);
      resolve();
    }

    function onChange() {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    }

    handle.on("change", onChange);
    quietTimer = setTimeout(finish, quietMs);
  });
}

export interface CompactDocResult {
  newHandle: DocHandle<any>;
  oldDocId: string;
}

/**
 * gives `handle`'s doc a fresh identity with zero history, seeded from its
 * CURRENT state — automerge's op-log is append-only, so this is the only
 * way to actually shrink a bloated doc's footprint (see
 * docs/animaniac-doc-compaction-plan.md). shape-agnostic: works on any
 * doc, not just widget docs.
 *
 * does NOT delete the old doc's storage, and does NOT repoint anything
 * that references the old doc id — that's caller-specific (e.g.
 * `CanvasStore.setDocId()` for a widget doc, a meta-db pointer for
 * narthex) and this primitive has no way to know what to update.
 *
 * returns `null` (does nothing) if the doc isn't ready/has no content, or
 * if read-back verification fails — never hands back a new doc id for the
 * caller to repoint to unless it's confirmed to hold the right content.
 */
export async function compactDoc(repo: Repo, handle: DocHandle<any>): Promise<CompactDocResult | null> {
  if (!handle.isReady()) return null;
  const doc = handle.doc();
  if (!doc) return null;

  // deepUnwrapAmStrings, not structuredClone — any doc a rust peer
  // (tumulus) has ever written into directly contains ImmutableString
  // instances, which structuredClone() can't handle (throws
  // DataCloneError — see automerge-gotchas memory notes). this rebuilds a
  // fully plain object/array tree, safe to feed straight into
  // repo.create() with no separate clone step needed.
  const snapshot = deepUnwrapAmStrings(doc);

  const newHandle = repo.create(snapshot);

  // verify before handing back to the caller — same resolve/write/verify
  // ordering as legacy-doc-migration.ts. structural (deepEqual), not
  // string (JSON.stringify) comparison — see deepEqual's own doc comment.
  const readBack = newHandle.doc();
  if (!deepEqual(snapshot, readBack)) {
    log.warn(TAG, `verification failed compacting ${handle.documentId} -> ${newHandle.documentId}, aborting`);
    repo.delete(newHandle.documentId);
    return null;
  }

  log.debug(TAG, `compacted ${handle.documentId} -> ${newHandle.documentId}`);
  return { newHandle, oldDocId: handle.documentId };
}
