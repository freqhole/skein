/**
 * "download audio-clips manifest..." (tauri) / "download zip bundle..."
 * (browser) widget actions — phase 6 export, audio-clips-track half. see
 * docs/stfu-widget-plan.md's "export manifest schema stability" section and
 * phase 6 checklist for the design this follows:
 *
 * - `dubSegments` (the old trek-minus-paris `*_dub_segments.json` shape) was
 *   dropped entirely when the audio clips track landed — this is a new
 *   manifest shape mirroring `audioClips` directly, not a 1:1 port. it isn't
 *   consumed by `process.py` yet (that side needs matching new
 *   silence+fade-then-mix-in rendering logic, out of scope here) — this is
 *   only the skein-side half.
 * - the manifest carries its own `manifestVersion`, independent of
 *   `stfuSchema`'s own (version-less) doc-migration story, since this is a
 *   wire format read by a separate python codebase.
 * - tauri never duplicates files: clips are referenced by their real local
 *   blob path (`getBlobLocalPath()`), so only the small manifest json is
 *   downloaded. browser has no local filesystem to point at, so "download
 *   bundle..." zips up everything instead: the manifest, every clip's
 *   actual audio bytes, the source video, and (if any exists) the merged
 *   reference/transcript data — following playlistz's
 *   `playlistDownloadService.ts`/`zipBuilder.ts` pattern of building the
 *   archive with `fflate`.
 */

import { zipSync, type Zippable } from "fflate";
import { getBlobLocalPath } from "../../src/file-utils/blob-io";
import { getBlob } from "../../src/storage/blob-store";
import { stripExtension } from "./reference-data-actions";
import type { AudioClip, StfuState } from "./types";

/** bumped whenever this manifest's shape changes — a separate, explicit
 *  version for a wire format read by a different codebase (python), unlike
 *  `stfuSchema`'s own version-less doc-migration story (see module doc). */
export const AUDIO_CLIP_MANIFEST_VERSION = 1;

export interface AudioClipManifestEntry {
  id: string;
  trackId: string;
  start: number;
  durationSec: number;
  label: string;
  origin: "tts" | "recording";
  ttsText: string;
  /** absolute local filesystem path (tauri) or a path relative to the zip's
   *  own root (browser) — always a path a human/`process.py` can resolve
   *  the actual audio bytes from, never a bare blob id. */
  audioFilename: string;
}

export interface AudioClipManifest {
  manifestVersion: number;
  audioClips: AudioClipManifestEntry[];
}

type ReadyAudioClip = AudioClip & { audioBlobId: string };

/** clips with committed audio bytes — a brand-new placeholder clip (no
 *  `kind` decided yet) or one still mid-generation has nothing to export. */
function readyClips(clips: AudioClip[]): ReadyAudioClip[] {
  return clips.filter((c): c is ReadyAudioClip => !!c.audioBlobId);
}

/** best-effort file extension from a clip's stored mime type — falls back
 *  to wav (the common tts/mic-recording container in this widget). */
function extensionForMime(mime: string | undefined): string {
  if (mime?.includes("wav")) return "wav";
  if (mime?.includes("mp3") || mime?.includes("mpeg")) return "mp3";
  if (mime?.includes("webm")) return "webm";
  if (mime?.includes("ogg")) return "ogg";
  return "wav";
}

/** build the manifest — pure and easily unit-testable. `audioFilename` is
 *  supplied by the caller since it's the one thing that differs between the
 *  tauri (absolute local path) and browser (zip-relative name) export
 *  paths; clips the caller couldn't resolve a filename for should already
 *  be filtered out before calling this. */
export function buildAudioClipManifest(
  clips: ReadyAudioClip[],
  audioFilename: (clip: ReadyAudioClip) => string
): AudioClipManifest {
  const audioClips = clips
    .map((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      start: clip.start,
      durationSec: clip.durationSec,
      label: clip.label,
      origin: (clip.kind === "recording" ? "recording" : "tts") as "tts" | "recording",
      ttsText: clip.ttsText ?? "",
      audioFilename: audioFilename(clip),
    }))
    .sort((a, b) => a.start - b.start);
  return { manifestVersion: AUDIO_CLIP_MANIFEST_VERSION, audioClips };
}

/** reconstruct `process.py`'s combined `{speakers, segments}` reference-data
 *  shape (see reference-data.ts's `parseReferenceDataJson` "combined"
 *  branch) from the doc's own already-merged `referenceSpeakers`/
 *  `transcriptSegments` \u2014 re-loadable elsewhere via "load reference
 *  data...". returns null when there's nothing to export yet. */
function buildCombinedReferenceData(
  state: StfuState
): { speakers: Record<string, [number, number][]>; segments: { start: number; end: number; text: string }[] } | null {
  if (Object.keys(state.referenceSpeakers).length === 0 && state.transcriptSegments.length === 0) {
    return null;
  }
  const speakers: Record<string, [number, number][]> = {};
  for (const label of Object.keys(state.referenceSpeakers)) speakers[label] = [];
  for (const seg of state.transcriptSegments) {
    if (!seg.speaker) continue;
    (speakers[seg.speaker] ??= []).push([seg.start, seg.end]);
  }
  const segments = state.transcriptSegments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  return { speakers, segments };
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

/**
 * tauri: every clip's audio already lives on local disk somewhere in the
 * blob store — no need to copy bytes, just point the manifest at the real
 * path directly. clips whose blob isn't available locally yet (never
 * snatched) are skipped with a warning rather than emitting a path that
 * won't resolve.
 */
export async function downloadAudioClipManifestLocal(state: StfuState): Promise<void> {
  const clips = readyClips(state.audioClips);
  const paths = new Map<string, string>();
  for (const clip of clips) {
    const path = await getBlobLocalPath(clip.audioBlobId);
    if (path) {
      paths.set(clip.id, path);
    } else {
      console.warn(`stfu widget: no local path for clip "${clip.id}"'s audio — omitting from the audio-clips manifest`);
    }
  }

  const manifest = buildAudioClipManifest(
    clips.filter((c) => paths.has(c.id)),
    (clip) => paths.get(clip.id) as string
  );
  const json = JSON.stringify(manifest, null, 2);
  const baseName = stripExtension(state.videoFilename || "audio-clips");
  triggerDownload(new Blob([json], { type: "application/json" }), `${baseName}_audio_clips.json`);
}

/**
 * browser: no local filesystem to point at, so bundle everything into one
 * zip — the audio-clips manifest, the source video, every clip's actual
 * audio bytes, and (if any exists) the merged reference/transcript data —
 * so the download is a complete, self-contained project a user can hand
 * off or feed into trek-minus-paris's process.py. anything whose bytes
 * aren't available locally yet (never downloaded/synced) is skipped with
 * a warning rather than silently producing a broken bundle.
 */
export async function downloadStfuBundle(state: StfuState): Promise<void> {
  const clips = readyClips(state.audioClips);
  const files: Zippable = {};
  const names = new Map<string, string>();

  for (const clip of clips) {
    const blob = await getBlob(clip.audioBlobId, clip.audioBlake3);
    if (!blob) {
      console.warn(`stfu widget: no local audio data for clip "${clip.id}" — omitting from the bundle`);
      continue;
    }
    const filename = `audio/${clip.id}.${extensionForMime(clip.audioMime)}`;
    files[filename] = new Uint8Array(await blob.arrayBuffer());
    names.set(clip.id, filename);
  }

  const baseName = stripExtension(state.videoFilename || "stfu");

  const manifest = buildAudioClipManifest(
    clips.filter((c) => names.has(c.id)),
    (clip) => names.get(clip.id) as string
  );
  files[`${baseName}_audio_clips.json`] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const referenceData = buildCombinedReferenceData(state);
  if (referenceData) {
    files[`${baseName}_reference.json`] = new TextEncoder().encode(JSON.stringify(referenceData, null, 2));
  }

  if (state.videoBlobId) {
    const videoBlob = await getBlob(state.videoBlobId, state.videoBlake3);
    if (videoBlob) {
      files[state.videoFilename || `${baseName}.mp4`] = new Uint8Array(await videoBlob.arrayBuffer());
    } else {
      console.warn("stfu widget: no local video data — omitting from the bundle");
    }
  }

  const zipped = zipSync(files, { level: 6 });
  triggerDownload(new Blob([zipped as BlobPart], { type: "application/zip" }), `${baseName}_bundle.zip`);
}
