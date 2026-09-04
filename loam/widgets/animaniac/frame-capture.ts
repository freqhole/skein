/**
 * "drag an existing skein widget onto an animaniac track, absorb its
 * content as a clip" — generalizes `stfu/audio-clip-drag.ts`'s dropTarget
 * pattern (which only ever handles audio-recording/tts/voice-recording)
 * over every clip kind animaniac supports. per docs/animaniac-media-
 * segments-plan.md decision C, this is drag-in ONLY (no direct upload
 * inside animaniac itself).
 *
 * this module is split into a PURE half (`resolveCapturedClip()` — given
 * an already-read, schema-parsed source widget's state, decide what clip
 * (if any) to create) and leaves the pixi/pointer "which track row was
 * this dropped onto" wiring to the track UI modules (`tracks/visual-
 * track.ts`/`tracks/audio-track.ts`), which don't exist yet — see
 * docs/animaniac-media-segments-plan.md's checklist. splitting it this way
 * means the "which widget type maps to which clip kind" logic (the part
 * most likely to need adjusting as new widget types appear) is testable
 * without any pixi/drag-gesture scaffolding at all.
 *
 * reads the source widget generically via the registry's own schema (the
 * same `factory.schema.parse(rawDoc)` pattern `audio-clip-drag.ts` already
 * uses), NOT by importing each widget's schema module directly — keeps
 * animaniac decoupled from every other widget's internal shape except the
 * two genuinely shared helpers below (doodle's snapshot renderer, the
 * image-blob-ref promotion helper).
 */

import { renderDoodleSnapshot, type DoodleStroke } from "../doodle";
import { saveImageDataUrlAsBlobRef } from "../../src/file-utils/image-prop-blob";
import type { Clip } from "./types";

/** widget types this module knows how to turn into a clip — anything else
 *  is silently not droppable (matches `audio-clip-drag.ts`'s own
 *  `DROPPABLE_TYPES` gating convention). */
export const CAPTURABLE_WIDGET_TYPES = new Set([
  "doodle",
  "image",
  "label",
  "voice-recording",
  "tts",
  "audio-recording",
  "file",
  "stfu",
]);

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}
/** validates `v` against an allowed literal set (e.g. a zod `z.enum()`
 *  field read off an untyped `Record<string, unknown>`), falling back to
 *  a default rather than blindly casting — a stale/unexpected value from
 *  a source widget should never silently become an invalid clip field. */
function enumVal<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const baseKeyframes = [{ t: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, easing: "linear" as const }];

/**
 * given a source widget's own `type` + schema-parsed doc state, decide
 * what clip (if any) to create on `trackId` at timeline position `start`.
 * returns `null` for a widget type this module doesn't know how to
 * capture, or one that has nothing capturable yet (e.g. a tts widget that
 * hasn't generated audio, an empty image widget).
 *
 * async only because a doodle capture needs to render + promote a
 * snapshot; every other branch resolves synchronously (still returned as
 * a promise for a uniform call-site).
 */
export async function resolveCapturedClip(
  sourceType: string,
  sourceState: Record<string, unknown>,
  trackId: string,
  start: number,
  newId: () => string = () => crypto.randomUUID()
): Promise<Clip | null> {
  switch (sourceType) {
    case "doodle": {
      const strokes = Array.isArray(sourceState.strokes) ? (sourceState.strokes as DoodleStroke[]) : [];
      if (strokes.length === 0) return null;
      const bgColor = num(sourceState.bgColor, -1);
      const dataUrl = await renderDoodleSnapshot(strokes, bgColor);
      if (!dataUrl) return null;
      const imageUrl = await saveImageDataUrlAsBlobRef(dataUrl);
      return {
        kind: "doodle-frame",
        id: newId(),
        trackId,
        start,
        keyframes: baseKeyframes,
        imageUrl,
        durationSec: 1,
      };
    }

    case "image": {
      const url = str(sourceState.url);
      if (!url) return null;
      return {
        kind: "image",
        id: newId(),
        trackId,
        start,
        keyframes: baseKeyframes,
        imageUrl: url,
        durationSec: 1,
      };
    }

    case "label": {
      const text = str(sourceState.text);
      if (!text) return null;
      return {
        kind: "label",
        id: newId(),
        trackId,
        start,
        keyframes: baseKeyframes,
        text,
        color: num(sourceState.textColor, 0xffffff),
        bgColor: num(sourceState.bgColor, 0x000000),
        durationSec: 1,
      };
    }

    case "voice-recording": {
      const blobId = str(sourceState.blobId);
      if (!blobId) return null;
      return {
        kind: "voice-recording",
        id: newId(),
        trackId,
        start,
        keyframes: baseKeyframes,
        audioBlobId: blobId,
        audioBlake3: str(sourceState.blake3),
        audioMime: str(sourceState.mime),
        durationSec: num(sourceState.duration),
        lipsColor: num(sourceState.lipsColor, 0xc2455a),
        lipThickness: num(sourceState.lipThickness, 5),
        mouthMood: enumVal(sourceState.mouthMood, ["frown", "neutral", "smile"] as const, "neutral"),
        teethStyle: enumVal(sourceState.teethStyle, ["straight", "curved"] as const, "straight"),
        cupidBowAmount: num(sourceState.cupidBowAmount, 4),
      };
    }

    case "tts": {
      const blobId = str(sourceState.blobId);
      if (!blobId) return null; // not generated yet — nothing to capture
      return {
        kind: "tts",
        id: newId(),
        trackId,
        start,
        keyframes: baseKeyframes,
        audioBlobId: blobId,
        audioBlake3: str(sourceState.blake3),
        audioMime: str(sourceState.mime),
        durationSec: num(sourceState.duration),
        ttsText: str(sourceState.ttsText),
        ttsVoiceName: str(sourceState.ttsVoiceName),
        ttsVoiceLang: str(sourceState.ttsVoiceLang),
        ttsRate: num(sourceState.ttsRate, 1),
      };
    }

    case "audio-recording": {
      // a plain mic-recording widget has no mouth-animation concept — it
      // becomes a trimmable audio-segment (full source range by default,
      // matching every other frame type's "capture now, refine later"
      // flow), not a voice-recording clip.
      const blobId = str(sourceState.blobId);
      const duration = num(sourceState.duration);
      if (!blobId || duration <= 0) return null;
      return {
        kind: "audio-segment",
        id: newId(),
        trackId,
        start,
        keyframes: baseKeyframes,
        audioBlobId: blobId,
        audioBlake3: str(sourceState.blake3),
        audioMime: str(sourceState.mime),
        sourceInSec: 0,
        sourceOutSec: duration,
        label: str(sourceState.filename),
      };
    }

    case "file": {
      // file.ts now probes+stores `duration` for audio/video domains right
      // after upload (see src/file-utils/media-duration.ts) — a widget
      // uploaded before that existed just has duration 0 and isn't
      // capturable yet (matches every other "nothing to capture" case
      // here, not a special gap anymore).
      const domain = str(sourceState.domain);
      const blobId = str(sourceState.blobId);
      const duration = num(sourceState.duration);
      if (!blobId || duration <= 0) return null;
      if (domain === "audio") {
        return {
          kind: "audio-segment",
          id: newId(),
          trackId,
          start,
          keyframes: baseKeyframes,
          audioBlobId: blobId,
          audioBlake3: str(sourceState.blake3),
          audioMime: str(sourceState.mime),
          sourceInSec: 0,
          sourceOutSec: duration,
          label: str(sourceState.filename),
        };
      }
      if (domain === "video") {
        return {
          kind: "video-segment",
          id: newId(),
          trackId,
          start,
          keyframes: baseKeyframes,
          videoBlobId: blobId,
          videoBlake3: str(sourceState.blake3),
          videoMime: str(sourceState.mime),
          sourceInSec: 0,
          sourceOutSec: duration,
          muted: true,
        };
      }
      return null;
    }

    case "stfu": {
      // captures the raw source video + full duration, deliberately
      // ignoring stfu's own cut list (see docs/animaniac-media-segments-
      // plan.md decision C's explicit non-goal).
      const videoBlobId = str(sourceState.videoBlobId);
      const videoDurationSec = num(sourceState.videoDurationSec);
      if (!videoBlobId || videoDurationSec <= 0) return null;
      return {
        kind: "video-segment",
        id: newId(),
        trackId,
        start,
        keyframes: baseKeyframes,
        videoBlobId,
        videoBlake3: str(sourceState.videoBlake3),
        videoMime: str(sourceState.videoMime),
        sourceInSec: 0,
        sourceOutSec: videoDurationSec,
        muted: true,
      };
    }

    default:
      return null;
  }
}

export function isCapturableWidgetType(type: string): boolean {
  return CAPTURABLE_WIDGET_TYPES.has(type);
}

/** which track kind a source widget's captured clip would land on —
 *  computed WITHOUT doing the (possibly async) capture itself, so
 *  `drop-controller.ts` can pick/fall back to an appropriate target track
 *  before calling `resolveCapturedClip()`. returns `null` for an
 *  unrecognized type, or a `file` widget whose `domain` isn't audio/video
 *  (matches `resolveCapturedClip()`'s own gating, kept in sync with it). */
export function expectedTrackKindFor(sourceType: string, sourceState: Record<string, unknown>): "visual" | "audio" | null {
  switch (sourceType) {
    case "doodle":
    case "image":
    case "label":
    case "stfu":
      return "visual";
    case "voice-recording":
    case "tts":
    case "audio-recording":
      return "audio";
    case "file": {
      const domain = str(sourceState.domain);
      if (domain === "audio") return "audio";
      if (domain === "video") return "visual";
      return null;
    }
    default:
      return null;
  }
}
