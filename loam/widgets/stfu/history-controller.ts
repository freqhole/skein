/**
 * undo/redo history for the stfu widget — direct port of
 * trek-minus-paris's editor.js `pushHistory()`/`undo()`/`redo()`, widened
 * from editor.js's single `editableSegments` array to cover `audioClips`
 * too. snapshots the whole pair of arrays together rather than tracking
 * per-entry diffs (see index.ts's original doc comment for why). pulled
 * out of index.ts to keep that file from growing further.
 */

import { createUndoHistory, type UndoHistory } from "../../src/widgets/undo-history";
import type { EditableSegment } from "./cut-segments-track";
import type { AudioClip, StfuState } from "./types";

export interface HistorySnapshot {
  editableSegments: EditableSegment[];
  audioClips: AudioClip[];
}

export interface HistoryControllerOptions {
  getDocState: () => StfuState;
  changeDoc: (fn: (d: StfuState) => void) => void;
  /** called after undo/redo applies a snapshot back to the doc — refresh
   *  whichever tracks/panels are currently mounted. */
  onApplied: () => void;
  /** called after the undo/redo stack itself changes (push/undo/redo) —
   *  refresh any undo/redo button enabled-state. */
  onHistoryChanged: () => void;
}

export interface HistoryControllerHandle {
  /** call once, right after the doc's `editableSegments`/`audioClips` are
   *  known to reflect the real starting state — safe to call more than
   *  once, only the first call does anything. */
  init(): void;
  /** record the current doc state as a new undoable entry — call after any
   *  local edit to `editableSegments`/`audioClips` completes. never call
   *  this from the doc's own "change" subscription, which also fires for
   *  remote peers' edits — that would let a peer's edit sneak into this
   *  session's own undo stack. */
  push(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export function createHistoryController(options: HistoryControllerOptions): HistoryControllerHandle {
  const { getDocState, changeDoc, onApplied, onHistoryChanged } = options;

  function snapshotHistoryState(): HistorySnapshot {
    const state = getDocState();
    return {
      editableSegments: state.editableSegments.map((s) => [s[0], s[1]] as EditableSegment),
      audioClips: state.audioClips.map((c) => ({ ...c })),
    };
  }

  const history: UndoHistory<HistorySnapshot> = createUndoHistory(200, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  let historyInitialized = false;

  function init(): void {
    if (historyInitialized) return;
    historyInitialized = true;
    history.reset(snapshotHistoryState());
    onHistoryChanged();
  }

  function push(): void {
    history.push(snapshotHistoryState());
    onHistoryChanged();
  }

  /** applies a history snapshot back to the doc — used by both `undo()` and
   *  `redo()`. mutates the existing doc arrays in place (splice) rather
   *  than reassigning them outright: reassigning a doc array to a new array
   *  built from that array's own (proxied) elements throws in automerge,
   *  but splicing in plain-value copies from a snapshot is safe (see
   *  automerge-gotchas memory notes). */
  function applyHistorySnapshot(snap: HistorySnapshot): void {
    changeDoc((d) => {
      d.editableSegments.splice(0, d.editableSegments.length, ...snap.editableSegments.map((s) => [...s] as EditableSegment));
      d.audioClips.splice(0, d.audioClips.length, ...snap.audioClips.map((c) => ({ ...c })));
    });
    onApplied();
  }

  function undo(): void {
    const snap = history.undo();
    if (!snap) return;
    applyHistorySnapshot(snap);
    onHistoryChanged();
  }

  function redo(): void {
    const snap = history.redo();
    if (!snap) return;
    applyHistorySnapshot(snap);
    onHistoryChanged();
  }

  return {
    init,
    push,
    undo,
    redo,
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
  };
}
