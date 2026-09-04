/**
 * undo/redo history for animaniac — same shape as `stfu/history-
 * controller.ts` (snapshots the whole doc-relevant state together, not
 * per-entry diffs), widened to `{tracks, clips}` instead of stfu's
 * `{editableSegments, audioClips}`. see that file's own doc comment for
 * why a whole-state snapshot beats per-entry diffing here.
 */

import { createUndoHistory, type UndoHistory } from "../../src/widgets/undo-history";
import type { AnimaniacState, Clip, Track } from "./types";

export interface HistorySnapshot {
  tracks: Track[];
  clips: Clip[];
}

export interface HistoryControllerOptions {
  getDocState: () => AnimaniacState;
  changeDoc: (fn: (d: AnimaniacState) => void) => void;
  /** called after undo/redo applies a snapshot back to the doc — refresh
   *  whichever tracks/panels are currently mounted. */
  onApplied: () => void;
  /** called after the undo/redo stack itself changes — refresh any
   *  undo/redo button enabled-state. */
  onHistoryChanged: () => void;
}

export interface HistoryControllerHandle {
  /** call once, right after the doc's `tracks`/`clips` are known to
   *  reflect the real starting state — safe to call more than once, only
   *  the first call does anything. */
  init(): void;
  /** record the current doc state as a new undoable entry — call after any
   *  local edit to `tracks`/`clips` completes. never call this from the
   *  doc's own "change" subscription (that also fires for remote peers'
   *  edits, which shouldn't sneak into this session's own undo stack). */
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
      tracks: state.tracks.map((t) => ({ ...t })),
      clips: state.clips.map((c) => ({ ...c })),
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

  /** applies a history snapshot back to the doc — splices doc arrays in
   *  place rather than reassigning them outright (reassigning a doc array
   *  built from that array's own proxied elements throws in automerge;
   *  splicing in plain-value copies from a snapshot is safe — see
   *  automerge-gotchas memory notes). */
  function applyHistorySnapshot(snap: HistorySnapshot): void {
    changeDoc((d) => {
      d.tracks.splice(0, d.tracks.length, ...snap.tracks.map((t) => ({ ...t })));
      d.clips.splice(0, d.clips.length, ...snap.clips.map((c) => ({ ...c })));
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
