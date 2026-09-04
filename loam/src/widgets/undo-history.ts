/**
 * generic linear undo/redo stack — direct port of trek-minus-paris's
 * `editor.js` `history`/`historyPointer`/`pushHistory()`/`undo()`/`redo()`,
 * generalized over whatever snapshot shape a caller wants to track (stfu
 * uses it for `{ editableSegments, audioClips }` together — see index.ts).
 *
 * kept a plain, dependency-free module (no pixi/automerge imports) so it's
 * trivially unit-testable on its own.
 */

export interface UndoHistory<T> {
  /** record a new snapshot as the current state, discarding any redo
   *  entries beyond the current pointer (same "branch on new edit"
   *  behavior as editor.js). a snapshot equal (per `isEqual`) to the one
   *  already at the top of the stack is silently ignored — avoids piling
   *  up no-op entries from e.g. a drag that ends where it started. */
  push(snapshot: T): void;
  /** step back one entry and return it, or `null` if there's nothing to
   *  undo (mirrors editor.js's `historyPointer <= 0` guard). */
  undo(): T | null;
  /** step forward one entry and return it, or `null` if there's nothing to
   *  redo. */
  redo(): T | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** replace the whole stack with a single baseline entry (used once at
   *  startup so the first real edit has something to diff against/undo
   *  back to — mirrors editor.js's own one-time `history = [snapshot()]`
   *  init). */
  reset(initial: T): void;
}

/** @param limit max stack size — oldest entries are dropped once exceeded
 *    (mirrors editor.js's `HISTORY_LIMIT`).
 *  @param isEqual used to dedupe a push against the current top entry. */
export function createUndoHistory<T>(limit: number, isEqual: (a: T, b: T) => boolean): UndoHistory<T> {
  let stack: T[] = [];
  let pointer = -1;

  return {
    push(snapshot: T): void {
      if (pointer >= 0 && isEqual(snapshot, stack[pointer])) return;
      stack = stack.slice(0, pointer + 1);
      stack.push(snapshot);
      if (stack.length > limit) stack.shift();
      pointer = stack.length - 1;
    },
    undo(): T | null {
      if (pointer <= 0) return null;
      pointer--;
      return stack[pointer];
    },
    redo(): T | null {
      if (pointer >= stack.length - 1) return null;
      pointer++;
      return stack[pointer];
    },
    canUndo(): boolean {
      return pointer > 0;
    },
    canRedo(): boolean {
      return pointer >= 0 && pointer < stack.length - 1;
    },
    reset(initial: T): void {
      stack = [initial];
      pointer = 0;
    },
  };
}
