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
 * this dropped onto" wiring to `drop-controller.ts`/`tracks/track.ts`.
 * splitting it this way means the "which widget type maps to which clip
 * kind" logic (the part most likely to need adjusting as new widget types
 * appear) is testable without any pixi/drag-gesture scaffolding at all.
 *
 * reads the source widget generically via the registry's own schema (the
 * same `factory.schema.parse(rawDoc)` pattern `audio-clip-drag.ts` already
 * uses), NOT by importing each widget's schema module directly — keeps
 * animaniac decoupled from every other widget's internal shape except the
 * two genuinely shared helpers below (doodle's snapshot renderer, the
 * image-blob-ref promotion helper).
 */

import { renderDoodleSnapshot, type DoodleStroke } from "../doodle";
import { saveImageDataUrlAsBlobRef, resolveImagePropUrl } from "../../src/file-utils/image-prop-blob";
import { getMediaPlaybackUrl } from "../../src/media";
import { probeMediaDuration } from "../../src/file-utils/media-duration";
import type { Clip, Keyframe } from "./types";

/** clip length (seconds) used when a source's duration is unknown AND an
 *  on-drop probe (see `resolveClipDuration()`) also fails — the clip still
 *  lands on the track instead of the drop being silently refused, and the
 *  user can drag its resize handle to the real length by hand afterward. */
const FALLBACK_CLIP_DURATION_SEC = 5;

/** doodle captures render much bigger than the doodle widget's own
 *  128px bin-card thumbnail default, since animaniac's preview (and its
 *  resize-handle scaling) can stretch a doodle-frame clip well past its
 *  source widget's on-canvas size. */
const DOODLE_CAPTURE_SIZE = 512;

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

const baseKeyframes = [{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" as const }];

/** a freshly-captured clip's initial keyframe list, scaled (uniformly, so
 *  aspect ratio is preserved) to fit within the composition preview's own
 *  width/height — "contain" semantics, never upscaling a naturally-
 *  smaller source. `naturalSize`/`previewSize` missing or invalid (e.g. a
 *  probe below failed) falls back to the old always-1 behavior. */
function containKeyframes(
  naturalSize: { width: number; height: number } | null,
  previewSize: { width: number; height: number } | undefined
): Keyframe[] {
  const scale =
    naturalSize && previewSize && naturalSize.width > 0 && naturalSize.height > 0
      ? Math.min(1, previewSize.width / naturalSize.width, previewSize.height / naturalSize.height)
      : 1;
  return [{ t: 0, x: 0, y: 0, scaleX: scale, scaleY: scale, rotation: 0, opacity: 1, easing: "linear" }];
}

/** decodes an already-stored image ref (a `blob:<id>` ref or external url,
 *  same shape `imageClipSchema`/`doodleFrameClipSchema` store) just far
 *  enough to read its natural pixel dimensions — used once at capture time
 *  to compute `containKeyframes()`'s initial scale. best-effort: returns
 *  null on any failure (blob not local yet, decode error, etc.) rather
 *  than blocking the capture. */
async function probeImageNaturalSize(imageUrl: string): Promise<{ width: number; height: number } | null> {
  try {
    const resolvedUrl = await resolveImagePropUrl(imageUrl);
    if (!resolvedUrl) return null;
    const blob = await fetch(resolvedUrl).then((r) => r.blob());
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** same idea as `probeImageNaturalSize()` but for a video-segment's own
 *  blob — loads just enough of a detached `<video>` element to read its
 *  `videoWidth`/`videoHeight` from `loadedmetadata`, then lets it go. */
async function probeVideoNaturalSize(blobId: string, mime: string, blake3: string): Promise<{ width: number; height: number } | null> {
  try {
    const url = await getMediaPlaybackUrl(blobId, { category: "video", mime: mime || undefined, blake3: blake3 || undefined });
    if (!url) return null;
    return await new Promise((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.addEventListener("loadedmetadata", () => resolve({ width: video.videoWidth, height: video.videoHeight }), { once: true });
      video.addEventListener("error", () => resolve(null), { once: true });
      video.src = url;
    });
  } catch {
    return null;
  }
}

/** `sourceState.duration` if already known and positive; otherwise probes
 *  the blob directly (same technique `file-utils/backfill-file-durations.ts`
 *  uses) so a drop never has to wait for that separate one-shot tool to run
 *  first. falls back to `FALLBACK_CLIP_DURATION_SEC` if the probe also
 *  fails (blob not local yet, decode error) — never writes back to the
 *  source widget's own doc, this only affects the freshly captured clip's
 *  own length. */
async function resolveClipDuration(sourceState: Record<string, unknown>, domain: "audio" | "video", blobId: string): Promise<number> {
  const known = num(sourceState.duration);
  if (known > 0) return known;
  try {
    const url = await getMediaPlaybackUrl(blobId, { category: domain, mime: str(sourceState.mime) || undefined, blake3: str(sourceState.blake3) || undefined });
    const probed = url ? await probeMediaDuration(url, domain) : 0;
    if (probed > 0) return probed;
  } catch {
    // fall through to the default below
  }
  return FALLBACK_CLIP_DURATION_SEC;
}

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
  newId: () => string = () => crypto.randomUUID(),
  previewSize?: { width: number; height: number },
  /** the source widget's own on-canvas width/height at drag time — only
   *  used by the "doodle" branch (see `sourceDoodle`'s own doc comment in
   *  `types.ts`); every other branch ignores it. */
  sourceSize?: { width: number; height: number }
): Promise<Clip | null> {
  switch (sourceType) {
    case "doodle": {
      const strokes = Array.isArray(sourceState.strokes) ? (sourceState.strokes as DoodleStroke[]) : [];
      if (strokes.length === 0) return null;
      const bgColor = num(sourceState.bgColor, -1);
      // renderDoodleSnapshot()'s own default (128px, for a small bin-card
      // thumbnail) looks blurry once stretched up in animaniac's preview
      // (especially with the resize handles' own scaleX/scaleY) — capture
      // at a much larger fixed size here instead.
      const dataUrl = await renderDoodleSnapshot(strokes, bgColor, DOODLE_CAPTURE_SIZE);
      if (!dataUrl) return null;
      const imageUrl = await saveImageDataUrlAsBlobRef(dataUrl);
      return {
        kind: "doodle-frame",
        id: newId(),
        trackId,
        start,
        keyframes: containKeyframes({ width: DOODLE_CAPTURE_SIZE, height: DOODLE_CAPTURE_SIZE }, previewSize),
        imageUrl,
        durationSec: 1,
        snatchedBy: [],
        // full source state, purely so a later drag-out-to-canvas restore
        // (clip-restore.ts) can rebuild an actual re-editable doodle
        // widget instead of just this flattened snapshot — never read by
        // the compositor itself.
        sourceDoodle: {
          strokes,
          bgColor,
          penColor: num(sourceState.penColor, 0xd946ef),
          penWidth: num(sourceState.penWidth, 3),
          pressureScale: num(sourceState.pressureScale, 0),
          brushShape: str(sourceState.brushShape, "circle"),
          angleScale: num(sourceState.angleScale, 0),
          chiselAngle: num(sourceState.chiselAngle, -45),
          penOpacity: num(sourceState.penOpacity, 100),
          borderColor: num(sourceState.borderColor, 0xa855f7),
          borderWidth: num(sourceState.borderWidth, 1),
          width: sourceSize?.width ?? 640,
          height: sourceSize?.height ?? 340,
        },
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
        keyframes: containKeyframes(await probeImageNaturalSize(url), previewSize),
        imageUrl: url,
        durationSec: 1,
        snatchedBy: [],
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
        snatchedBy: [],
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
        snatchedBy: [],
      };
    }

    case "audio-recording": {
      // a plain mic-recording widget has no mouth-animation concept — it
      // becomes a trimmable audio-segment (full source range by default,
      // matching every other frame type's "capture now, refine later"
      // flow), not a voice-recording clip.
      const blobId = str(sourceState.blobId);
      if (!blobId) return null;
      const duration = await resolveClipDuration(sourceState, "audio", blobId);
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
        snatchedBy: [],
      };
    }

    case "file": {
      // file.ts probes+stores `duration` for audio/video domains right
      // after upload (see src/file-utils/media-duration.ts) — an older
      // widget uploaded before that existed (or one whose probe failed,
      // e.g. the blob wasn't local yet) can still be stuck at duration 0,
      // so `resolveClipDuration()` re-probes on drop and falls back to a
      // default length rather than refusing the capture outright.
      const domain = str(sourceState.domain);
      const blobId = str(sourceState.blobId);
      if (!blobId || (domain !== "audio" && domain !== "video")) return null;
      const duration = await resolveClipDuration(sourceState, domain, blobId);
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
          snatchedBy: [],
        };
      }
      if (domain === "video") {
        return {
          kind: "video-segment",
          id: newId(),
          trackId,
          start,
          keyframes: containKeyframes(await probeVideoNaturalSize(blobId, str(sourceState.mime), str(sourceState.blake3)), previewSize),
          videoBlobId: blobId,
          videoBlake3: str(sourceState.blake3),
          videoMime: str(sourceState.mime),
          sourceInSec: 0,
          sourceOutSec: duration,
          muted: false,
          snatchedBy: [],
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
        keyframes: containKeyframes(await probeVideoNaturalSize(videoBlobId, str(sourceState.videoMime), str(sourceState.videoBlake3)), previewSize),
        videoBlobId,
        videoBlake3: str(sourceState.videoBlake3),
        videoMime: str(sourceState.videoMime),
        sourceInSec: 0,
        sourceOutSec: videoDurationSec,
        muted: false,
        snatchedBy: [],
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
