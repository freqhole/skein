/**
 * "drag an animaniac track clip back out onto the bare canvas, restore it
 * as a standalone widget" — the reverse of `frame-capture.ts`'s
 * `resolveCapturedClip()`. pure (no pixi/canvas-store dependency) so the
 * "which clip kind restores to which widget type/props" mapping is
 * testable on its own, matching `frame-capture.ts`'s own split.
 *
 * a clip only ever stores what it captured at drag-IN time (see
 * `types.ts`), never the source widget's full original state, so this is
 * necessarily best-effort:
 *  - doodle-frame clips carry their full source stroke/drawing state
 *    (`sourceDoodle`, see `frame-capture.ts`/`types.ts`) alongside the
 *    flattened snapshot image the compositor actually renders — restored
 *    as a real, re-editable `doodle` widget when present. a clip captured
 *    before that field existed (or whose source doodle was empty at
 *    capture time) falls back to a plain `image` widget showing the
 *    snapshot instead.
 *  - audio-segment/video-segment clips (captured from audio-recording/
 *    tts/file/stfu widgets, several possible origins for one clip kind)
 *    restore to the generic `file` widget, the one widget type that just
 *    plays back an arbitrary blob — not back to whichever specific
 *    widget type originally produced them.
 * every other clip kind (image/label/voice-recording/tts) restores to
 * its own exact matching widget type with its fields carried over 1:1.
 */

import type { Clip } from "./types";

export interface RestoredWidget {
  type: string;
  props: Record<string, unknown>;
  /** overrides the restored widget type's own factory default size — only
   *  set for a doodle-frame restore with `sourceDoodle` present, so the
   *  widget is recreated at the exact size its strokes were drawn in
   *  (stroke points are in the source widget's own local coordinates). */
  width?: number;
  height?: number;
}

/** given a clip, decide what standalone widget (type + initial props) to
 *  recreate it as. props are handed to `CanvasStore.addWidget()`'s own
 *  `props` field (seeds the new widget's per-widget doc on first mount,
 *  merged over that widget type's own schema defaults) — never a full
 *  schema-shaped object, only the fields this module actually knows. */
export function restoreWidgetFromClip(clip: Clip): RestoredWidget {
  switch (clip.kind) {
    case "doodle-frame":
      if (clip.sourceDoodle) {
        const { width, height, ...props } = clip.sourceDoodle;
        return {
          type: "doodle",
          props: {
            ...props,
            // the carried-over penColor/borderColor must survive mount —
            // doodle.ts re-randomizes both on first mount unless this is
            // already true (see its own "seed random colors once" comment).
            colorsSeeded: true,
          },
          width,
          height,
        };
      }
      // no source state survived (a clip captured before this field
      // existed, or one whose source doodle was empty at capture time) —
      // fall back to the flattened snapshot as a plain image, same as
      // before.
      return { type: "image", props: { url: clip.imageUrl } };

    case "image":
      return { type: "image", props: { url: clip.imageUrl } };

    case "label":
      return {
        type: "label",
        props: { text: clip.text, textColor: clip.color, bgColor: clip.bgColor },
      };

    case "voice-recording":
      return {
        type: "voice-recording",
        props: {
          blobId: clip.audioBlobId,
          blake3: clip.audioBlake3,
          mime: clip.audioMime,
          duration: clip.durationSec,
          lipsColor: clip.lipsColor,
          lipThickness: clip.lipThickness,
          mouthMood: clip.mouthMood,
          teethStyle: clip.teethStyle,
          cupidBowAmount: clip.cupidBowAmount,
          snatchedBy: clip.snatchedBy,
        },
      };

    case "tts":
      return {
        type: "tts",
        props: {
          blobId: clip.audioBlobId,
          blake3: clip.audioBlake3,
          mime: clip.audioMime,
          duration: clip.durationSec,
          ttsText: clip.ttsText,
          ttsVoiceName: clip.ttsVoiceName,
          ttsVoiceLang: clip.ttsVoiceLang,
          ttsRate: clip.ttsRate,
          snatchedBy: clip.snatchedBy,
        },
      };

    case "audio-segment":
      return {
        type: "file",
        props: {
          blobId: clip.audioBlobId,
          blake3: clip.audioBlake3,
          mime: clip.audioMime,
          size: clip.audioSize,
          domain: "audio",
          filename: clip.label,
          duration: Math.max(0, clip.sourceOutSec - clip.sourceInSec),
          snatchedBy: clip.snatchedBy,
        },
      };

    case "video-segment":
      return {
        type: "file",
        props: {
          blobId: clip.videoBlobId,
          blake3: clip.videoBlake3,
          mime: clip.videoMime,
          size: clip.videoSize,
          domain: "video",
          duration: Math.max(0, clip.sourceOutSec - clip.sourceInSec),
          snatchedBy: clip.snatchedBy,
        },
      };
  }
}
