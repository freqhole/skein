// ---------------------------------------------------------------------------
// best-effort friend directory lookup, for widgets that need "let the user
// pick one of their friends" but have no other way to reach the social doc.
//
// this exists for the "friend canvas bin" narthex widget
// (widgets/narthex/friend-canvas-bin.ts) — a real, palette-placeable
// `WidgetFactory`. unlike the social overlay's tabs (friends-tab.ts,
// profile-tab.ts), which are hand-mounted by boot.ts with a `TabContext`
// carrying the live social doc, a generically-registered `WidgetFactory` is
// mounted by `widget-manager.ts` with no access to the social doc at all
// (see `WidgetMountContext` — no `socialDoc` field, and widget-manager.ts
// itself is out of scope to change for this feature). the only thing every
// mounted widget reliably has is `ctx.canvasStore?.repo` (a `Repo`), so this
// module re-derives "where's the local peer's own social doc" the same way
// `boot.ts` does for browser mode — read the same meta-db singleton-doc-id
// key, then `repo.find()` it directly.
//
// **known limitation, deliberate**: this only works in browser mode. tauri
// mode's friend list lives in a completely separate backend
// (`p2p/sqlite-social-doc.ts`, IPC into reliquary's sqlite tables — see
// `docs/hub-and-profile-plan.md`'s notes on the two independent social-doc
// backends), which isn't reachable from a plain `Repo`. `getFriendsForPicker()`
// returns `[]` in that case rather than throwing — matches this codebase's
// existing "best effort, no error UI" convention for gaps like this.
// ---------------------------------------------------------------------------

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { getMetaValue } from "../storage/meta-db";
import { isTauriMode } from "../p2p/tauri-transport";
import { friendEntrySchema } from "../../widgets/narthex/social/schema";

/** meta-db key for the standalone (browser-mode) social doc id — mirrors
 *  `src/standalone/boot.ts`'s exported `SOCIAL_DOC_KEY` constant exactly
 *  (kept as a literal here rather than importing boot.ts itself, to avoid
 *  pulling the whole `SkeinRouter` module — a large, singleton-heavy class
 *  — into every widget that just needs a friend list). */
const SOCIAL_DOC_KEY = "skein-social-doc-id";

/** one friend candidate for a "pick a friend" picker UI — just the fields
 *  needed to point a widget at that friend's profile doc. */
export interface FriendPickerCandidate {
  nodeId: string;
  profileDocId: string;
  displayName: string;
}

/**
 * best-effort list of the local peer's own friends that have a known,
 * gossip-relayed `profileDocId` (friends without one yet can't be pinned —
 * there'd be nothing to open). returns `[]` on any failure (no social doc
 * yet, doc unreachable, tauri mode) rather than throwing — this is a
 * convenience picker, not a critical path.
 */
export async function getFriendsForPicker(repo: Repo): Promise<FriendPickerCandidate[]> {
  if (isTauriMode()) return [];
  try {
    const docId = await getMetaValue(SOCIAL_DOC_KEY);
    if (!docId) return [];
    const handle = await repo.find<{ friends?: unknown[] }>(docId as DocumentId);
    const raw = handle.doc()?.friends ?? [];
    const candidates: FriendPickerCandidate[] = [];
    for (const entry of raw) {
      const parsed = friendEntrySchema.safeParse(entry);
      if (!parsed.success) continue;
      const friend = parsed.data;
      const nodeEntry = friend.nodeIds.find((n) => n.profileDocId);
      if (!nodeEntry) continue;
      const displayName = friend.alias || friend.username || nodeEntry.username || "friend";
      candidates.push({
        nodeId: nodeEntry.nodeId,
        profileDocId: nodeEntry.profileDocId,
        displayName,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}
