// in-memory registry for "retry a blob fetch once its owning peer becomes a
// friend" — backs the UI hint shown when `snatchBlob()`/`resolveAudioBytes()`
// throws `BlobAccessDeniedError` (see file-utils.ts): a peer has the blob but
// isn't a friend yet, so we don't attempt a fetch that's expected to be
// denied. instead a widget can send a friend request and register a retry
// here, which fires automatically once the social doc reports that peer as
// a friend.
//
// deliberately session/memory-only, same tradeoff as friendz-bridge.ts's
// `knockAckedCanvasIds` — nothing is persisted, so a pending retry is
// silently dropped if the browser/app closes or the widget navigates away
// before the friend request resolves. that's the desired behavior: there's
// nothing to "resume" (the widget itself is gone), and the friend request
// keeps going through the normal friends flow regardless.

import { isFriend, onFriendsChange } from "./friendz-bridge";

type RetryFn = () => void;

const pending = new Map<string, Set<RetryFn>>();
let unsubscribe: (() => void) | null = null;

function ensureSubscription(): void {
  if (unsubscribe) return;
  unsubscribe = onFriendsChange(() => {
    for (const [peerNodeId, retries] of [...pending]) {
      if (!isFriend(peerNodeId)) continue;
      pending.delete(peerNodeId);
      for (const retry of retries) retry();
    }
  });
}

/**
 * register `retry` to fire the next time `peerNodeId` becomes a friend.
 * returns an unregister function — call it if the widget is destroyed or
 * the user navigates away before the friend request is accepted, so a
 * stale retry never fires against a torn-down widget.
 */
export function registerPendingBlobRetry(peerNodeId: string, retry: RetryFn): () => void {
  ensureSubscription();
  let retries = pending.get(peerNodeId);
  if (!retries) {
    retries = new Set();
    pending.set(peerNodeId, retries);
  }
  retries.add(retry);
  return () => {
    retries!.delete(retry);
    if (retries!.size === 0) pending.delete(peerNodeId);
  };
}
