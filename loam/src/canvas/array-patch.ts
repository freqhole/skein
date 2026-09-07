/**
 * shared, automerge-op-aware array-mutation helpers for doc-owned arrays
 * (widget clips/tracks/segments) — never reassign a doc array outright
 * (throws in automerge if it's built from that array's own proxied
 * elements, and even when it doesn't throw, a full splice-replace forces
 * automerge to fully delete+recreate every element every call, generating
 * ops proportional to the WHOLE list instead of whatever actually
 * changed). always mutate the existing array in place instead.
 */

/**
 * patches a doc-owned array to match `next`, item-by-item via `patchOne`,
 * instead of unconditionally splice-replacing the whole thing — falls
 * back to a full splice-replace only when the item set itself changed
 * shape (add/remove/reorder), since there's no cheaper way to represent
 * that. `patchOne`'s per-field writes are no-ops for identical values
 * either way, so the fast path is never less correct, only cheaper for
 * what's unchanged. shared by animaniac's `onClipsChange`/undo-redo and
 * stfu's undo-redo.
 */
export function patchOrReplaceArray<T extends { id: string }>(
  docArr: T[],
  next: readonly T[],
  patchOne: (current: T, next: T) => void
): void {
  const sameShape = docArr.length === next.length && docArr.every((c, i) => c.id === next[i].id);
  if (sameShape) {
    for (let i = 0; i < next.length; i++) patchOne(docArr[i], next[i]);
  } else {
    docArr.splice(0, docArr.length, ...next.map((x) => ({ ...x })));
  }
}

/**
 * removes every element matching `predicate` from a doc-owned array, in
 * place, without touching the ones that stay — splices only the removed
 * indices (reverse order, so earlier indices don't shift under later
 * splices) rather than reassigning the whole array from a `.filter()`
 * result, which both throws in automerge (reassigning an array built from
 * that array's own proxied elements — see automerge-gotchas memory notes)
 * and would otherwise cost ops for every surviving element too.
 */
export function removeMatchingInPlace<T>(docArr: T[], predicate: (item: T) => boolean): void {
  for (let i = docArr.length - 1; i >= 0; i--) {
    if (predicate(docArr[i])) docArr.splice(i, 1);
  }
}
