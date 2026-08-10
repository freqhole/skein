/**
 * global keydown handler for the stfu widget's editing shortcuts (play/
 * pause, seek, zoom, in/out cut marking, delete, trim, snap, undo/redo,
 * shortcuts-help toggle). pulled out of index.ts to keep that file from
 * growing further — matches keyboard-shortcuts-control.ts's SHORTCUTS_LIST,
 * keep the two in sync by hand whenever a shortcut is added/changed/removed.
 */

import type { AudioClipsTrackHandle } from "./audio-clips-track";
import type { CutSegmentsTrackHandle, EditableSegment } from "./cut-segments-track";
import type { KeyboardShortcutsControlHandle } from "./keyboard-shortcuts-control";
import type { StfuState } from "./types";
import type { VideoTimelineHandle } from "./video-timeline";

export interface KeyboardShortcutsHandlerOptions {
  isPointerInsideWidget: () => boolean;
  getVideo: () => HTMLVideoElement | null;
  isKeyboardAcquired: () => boolean;
  getVideoFps: () => number;
  getTimeline: () => VideoTimelineHandle | null;
  getCutTrack: () => CutSegmentsTrackHandle | null;
  getAudioClipsTrack: () => AudioClipsTrackHandle | null;
  getKeyboardShortcutsControl: () => KeyboardShortcutsControlHandle | null;
  changeDoc: (fn: (d: StfuState) => void) => void;
  /** called after a new cut segment is created via the `i`/`o` in/out shortcuts —
   *  refresh the cut track + push an undo-history entry. */
  onCutSegmentCreated: () => void;
  undo: () => void;
  redo: () => void;
}

export interface KeyboardShortcutsHandlerHandle {
  handleKeyDown(e: KeyboardEvent): void;
  /** in-point set by `i`, consumed by `o` to create a cut segment — also
   *  read by index.ts's video "timeupdate" handler to draw the pending
   *  segment preview as it grows. */
  getPendingInTime(): number | null;
}

export function createKeyboardShortcutsHandler(options: KeyboardShortcutsHandlerOptions): KeyboardShortcutsHandlerHandle {
  const {
    isPointerInsideWidget,
    getVideo,
    isKeyboardAcquired,
    getVideoFps,
    getTimeline,
    getCutTrack,
    getAudioClipsTrack,
    getKeyboardShortcutsControl,
    changeDoc,
    onCutSegmentCreated,
    undo,
    redo,
  } = options;

  /** in-point set by `i`, consumed by `o` to create a cut segment — mirrors
   *  editor.js's own in/out marking convention. cleared once consumed, or
   *  whenever a new `i` overwrites it. */
  let pendingInTime: number | null = null;

  function frameDuration(): number {
    const fps = getVideoFps();
    return fps > 0 ? 1 / fps : 1 / 30;
  }

  /** creates a new cut-list segment spanning [start, end] (order-
   *  independent) — shared by the `o` shortcut and (eventually) any other
   *  in/out-marking gesture. too-short spans are silently dropped, same
   *  threshold `cut-segments-track.ts`'s own create-drag gesture uses. */
  function createCutSegment(start: number, end: number): void {
    const s = Math.min(start, end);
    const eTime = Math.max(start, end);
    if (eTime - s < 0.05) return;
    changeDoc((d) => {
      d.editableSegments.push([s, eTime] as EditableSegment);
    });
    onCutSegmentCreated();
  }

  function handleKeyDown(e: KeyboardEvent): void {
    const video = getVideo();
    if (!isPointerInsideWidget() || !video) return;
    // some other widget's text-input overlay (label/notepad/markdown) may
    // currently hold the keyboard driver — don't steal its keystrokes just
    // because the mouse happens to be hovering this widget.
    if (isKeyboardAcquired()) return;

    const timeline = getTimeline();
    const cutTrack = getCutTrack();
    const audioClipsTrack = getAudioClipsTrack();
    const keyboardShortcutsControl = getKeyboardShortcutsControl();

    const seekAmount = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case " ":
        if (video.paused) void video.play();
        else video.pause();
        break;
      case "ArrowLeft":
        video.currentTime = Math.max(0, video.currentTime - seekAmount);
        break;
      case "ArrowRight":
        video.currentTime = Math.min(video.duration || video.currentTime, video.currentTime + seekAmount);
        break;
      case "+":
      case "=":
        timeline?.zoomIn();
        break;
      case "-":
      case "_":
        timeline?.zoomOut();
        break;
      case "0":
        timeline?.zoomFit();
        break;
      case "i":
      case "I":
        pendingInTime = video.currentTime;
        cutTrack?.setPendingSegment([pendingInTime, pendingInTime]);
        break;
      case "o":
      case "O":
        if (pendingInTime !== null) {
          createCutSegment(pendingInTime, video.currentTime);
          pendingInTime = null;
          cutTrack?.setPendingSegment(null);
        }
        break;
      case "Delete":
      case "Backspace":
        // only one of the two tracks ever has an active selection at a
        // time (see the cross-track `clearSelection()` wiring in
        // index.ts), so calling both is safe — whichever has nothing
        // selected is a no-op.
        cutTrack?.deleteSelected();
        audioClipsTrack?.deleteSelected();
        break;
      case ",":
        video.currentTime = Math.max(0, video.currentTime - frameDuration());
        break;
      case ".":
        video.currentTime = Math.min(video.duration || video.currentTime, video.currentTime + frameDuration());
        break;
      case "[":
        cutTrack?.trimSelectedStartTo(video.currentTime);
        break;
      case "]":
        cutTrack?.trimSelectedEndTo(video.currentTime);
        break;
      case "s":
      case "S":
        timeline?.toggleSnap();
        break;
      case "/":
      case "?":
        keyboardShortcutsControl?.toggle();
        break;
      case "z":
      case "Z":
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.shiftKey) redo();
        else undo();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return {
    handleKeyDown,
    getPendingInTime: () => pendingInTime,
  };
}
