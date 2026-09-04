// ---------------------------------------------------------------------------
// one-time drain of a legacy, never-synced automerge singleton doc (social,
// messagez, canvas-bin — see local-kv-doc.ts's module comment for why these
// don't need CRDT semantics) into the plain local-kv-doc store.
//
// safety order: resolve -> write to new storage -> read back and verify ->
// only THEN delete the old automerge doc's storage. if anything before the
// delete step fails, the legacy doc id is left untouched and the migrated
// flag is never set, so the caller's existing automerge-based fallback path
// keeps working and the next boot just retries.
// ---------------------------------------------------------------------------

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { getMetaValue, setMetaValue } from "./meta-db";
import { resolveDocReadyCached } from "../p2p/doc-ready";
import { log } from "@freqhole/reliquary/utils";

const TAG = "legacy-doc-migration";

// the whole reason this migration exists: on a long-lived install, these
// docs' automerge op-log had grown large enough that decoding them took on
// the order of a minute (see docs/lingering-fixes-2026-08-plan.md's
// boot-stall investigation — measured up to ~60s for social, ~28s for
// messagez). resolveDocReadyCached()'s own default timeout (15s) exists to
// fail fast on a genuinely unreachable *networked* doc — it would abort
// this one-time local decode long before it could ever finish, so this
// migration needs its own much more generous bound. this cost is paid at
// most once per install (the whole point of the migrated-flag), so a long
// wait here is a good trade against paying a smaller version of it forever.
const MIGRATION_RESOLVE_TIMEOUT_MS = 120_000;

export interface MigrateLegacyDocOptions {
  repo: Repo;
  /** meta-db key holding the legacy automerge doc's documentId, if any. */
  legacyDocIdKey: string;
  /** meta-db key marking this migration as done ("1") once complete. */
  migratedFlagKey: string;
  /** meta-db key the drained JSON content is written under (local-kv-doc's own key). */
  localKvKey: string;
}

/**
 * drain `legacyDocIdKey`'s automerge doc into `localKvKey`, then delete the
 * automerge doc's storage. returns true once the caller can safely use the
 * local-kv-doc fast path (either just migrated, already migrated, or no
 * legacy doc ever existed) — false means fall back to the old automerge
 * resolution path for this boot and retry later.
 */
export async function migrateLegacyAutomergeDoc(opts: MigrateLegacyDocOptions): Promise<boolean> {
  const { repo, legacyDocIdKey, migratedFlagKey, localKvKey } = opts;

  if ((await getMetaValue(migratedFlagKey)) === "1") return true;

  const legacyId = await getMetaValue(legacyDocIdKey);
  if (!legacyId) {
    // fresh account, nothing to drain
    await setMetaValue(migratedFlagKey, "1");
    return true;
  }

  const handle = await resolveDocReadyCached<unknown>(repo, legacyId as DocumentId, {
    timeoutMs: MIGRATION_RESOLVE_TIMEOUT_MS,
    context: `legacy-doc-migration: ${legacyDocIdKey}`,
  });
  if (!handle) {
    log.warn(TAG, `migration for ${legacyDocIdKey}: legacy doc never became ready, will retry next boot`);
    return false;
  }

  const content = handle.doc();
  if (!content) {
    log.warn(TAG, `migration for ${legacyDocIdKey}: handle ready but doc() returned nothing`);
    return false;
  }

  const serialized = JSON.stringify(content);
  await setMetaValue(localKvKey, serialized);

  const readBack = await getMetaValue(localKvKey);
  if (readBack !== serialized) {
    log.warn(TAG, `migration for ${legacyDocIdKey}: read-back verification failed, aborting`);
    return false;
  }

  try {
    await new IndexedDBStorageAdapter().removeRange([legacyId]);
  } catch (err) {
    // the drain itself already succeeded and verified — failing to reclaim
    // the old doc's storage isn't worth blocking the migration over.
    log.warn(TAG, `migration for ${legacyDocIdKey}: failed to delete legacy automerge doc:`, err);
  }

  await setMetaValue(migratedFlagKey, "1");
  log.debug(TAG, `migration for ${legacyDocIdKey}: complete`);
  return true;
}
