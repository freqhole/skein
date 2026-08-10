/**
 * "load reference data..." (diarization/transcript json) and "download cut
 * manifest..." widget actions, plus the small transient-message controller
 * used to surface load feedback in the widget's header. pulled out of
 * index.ts to keep that file from growing further.
 */

import { pickJsonFiles, pickReferenceDirectory, readPickedFileText, uploadFile } from "../../src/file-utils/upload";
import type { PickedFile } from "../../src/file-utils/file-shared";
import {
  mergeCombinedData,
  mergeDiarizeData,
  mergeSpeakerSamples,
  mergeTranscribeData,
  parseReferenceDataJson,
  parseSpeakerSampleFilename,
} from "./reference-data";
import type { SpeakerSample, StfuState } from "./types";

/** drop a trailing file extension for use as a download's base filename
 *  (e.g. "caretaker.mp4" -> "caretaker") — falls back to the original
 *  string unchanged if there's no extension to strip. */
export function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

export interface ReferenceDataMessageController {
  get(): string;
  /** `autoClearMs <= 0` leaves the message up until the next `set()` call. */
  set(message: string, autoClearMs?: number): void;
  destroy(): void;
}

/** transient feedback for the "load reference data..." action — shown as a
 *  non-clickable info badge in the widget frame's own header (see
 *  index.ts's `updateVideoHeaderActions()`). */
export function createReferenceDataMessageController(onChange: () => void): ReferenceDataMessageController {
  let message = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  function set(next: string, autoClearMs = 6000): void {
    message = next;
    onChange();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (next && autoClearMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        message = "";
        onChange();
      }, autoClearMs);
    }
  }

  return {
    get: () => message,
    set,
    destroy() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export interface LoadReferenceDataOptions {
  isViewerOnly: boolean;
  isDestroyed: () => boolean;
  changeDoc: (fn: (d: StfuState) => void) => void;
  onMerged: () => void;
  setMessage: (message: string, autoClearMs?: number) => void;
  /** pick a whole project folder (every `.json` file directly inside it)
   *  instead of picking file(s) by hand — used by the "load project
   *  folder..." action. */
  fromDirectory?: boolean;
  /** true if the widget already has a video loaded — used to skip
   *  `onVideoFound` so an existing video is never clobbered by a folder
   *  that happens to contain one too. only consulted when `fromDirectory`
   *  is set. */
  hasVideo?: () => boolean;
  /** called when `fromDirectory` finds a video file directly inside the
   *  picked folder and `hasVideo` reports none loaded yet — lets index.ts
   *  perform the actual upload (it owns the upload-lock/progress state
   *  `handleUpload()`'s manual pick also uses). resolves to whether the
   *  upload succeeded. */
  onVideoFound?: (file: PickedFile) => Promise<boolean>;
}

/**
 * upload a `*_speaker_samples/` directory's sample clips + thumbnails
 * (see `parseSpeakerSampleFilename`) and attach every numbered sample to
 * its speaker (not just the lowest). returns the number of distinct
 * speakers updated (0 if `sampleFiles` is empty or none of it matched the
 * naming convention).
 */
async function loadSpeakerSampleMedia(
  sampleFiles: PickedFile[],
  changeDoc: (fn: (d: StfuState) => void) => void,
  isDestroyed: () => boolean
): Promise<number> {
  if (sampleFiles.length === 0) return 0;

  // speaker -> index -> {video?, thumbnail?}
  const bySpeaker = new Map<string, Map<number, { video?: PickedFile; thumbnail?: PickedFile }>>();
  for (const file of sampleFiles) {
    const parsed = parseSpeakerSampleFilename(file.filename);
    if (!parsed) continue;
    const byIndex = bySpeaker.get(parsed.speaker) ?? new Map<number, { video?: PickedFile; thumbnail?: PickedFile }>();
    const bucket = byIndex.get(parsed.index) ?? {};
    if (parsed.kind === "video") bucket.video = file;
    else bucket.thumbnail = file;
    byIndex.set(parsed.index, bucket);
    bySpeaker.set(parsed.speaker, byIndex);
  }

  let updated = 0;
  for (const [speaker, byIndex] of bySpeaker) {
    if (isDestroyed()) return updated;
    const indices = Array.from(byIndex.keys()).sort((a, b) => a - b);
    const samples: SpeakerSample[] = [];
    try {
      for (const index of indices) {
        const { video, thumbnail } = byIndex.get(index)!;
        if (!video) continue; // a sample with no clip (thumbnail-only) isn't usable
        const [videoResult, thumbnailResult] = await Promise.all([
          uploadFile(video),
          thumbnail ? uploadFile(thumbnail) : Promise.resolve(null),
        ]);
        if (isDestroyed()) return updated;
        samples.push({
          videoBlobId: videoResult.blobId,
          videoBlake3: videoResult.blake3 || "",
          videoMime: videoResult.mime,
          videoFilename: video.filename,
          videoSize: videoResult.size,
          thumbnailBlobId: thumbnailResult?.blobId,
          thumbnailBlake3: thumbnailResult?.blake3 || undefined,
          thumbnailMime: thumbnailResult?.mime,
          thumbnailFilename: thumbnail?.filename,
          thumbnailSize: thumbnailResult?.size,
        });
      }
      if (samples.length === 0) continue;

      changeDoc((d) => {
        d.referenceSpeakers = mergeSpeakerSamples(d.referenceSpeakers, speaker, samples);
      });
      updated++;
    } catch (err) {
      console.error(`stfu widget: failed to upload sample media for speaker "${speaker}":`, err);
    }
  }
  return updated;
}

export async function handleLoadReferenceData(options: LoadReferenceDataOptions): Promise<void> {
  const { isViewerOnly, isDestroyed, changeDoc, onMerged, setMessage, fromDirectory, hasVideo, onVideoFound } =
    options;
  if (isDestroyed() || isViewerOnly) return;

  // immediate feedback before the (possibly slow, modal) file picker opens —
  // without this the widget looked "locked up" with no indication anything
  // was happening.
  setMessage(fromDirectory ? "loading project folder…" : "loading reference data…", 0);

  const { jsonFiles: picked, sampleFiles, videoFile } = fromDirectory
    ? await pickReferenceDirectory()
    : { jsonFiles: await pickJsonFiles(), sampleFiles: [], videoFile: null };
  if (isDestroyed()) return;
  if (picked.length === 0 && sampleFiles.length === 0 && !videoFile) {
    setMessage(fromDirectory ? "no reference data or video found in that folder" : "");
    return;
  }

  const summaries: string[] = [];
  let mergedCount = 0;

  // auto-init the widget's video from the folder if one was found and the
  // widget doesn't already have one loaded — otherwise the user is left
  // waiting to add a video by hand even though one was right there. runs
  // first so its own progress message (index.ts's `performVideoUpload()`
  // drives `progressText`, not this transient message) is visible while the
  // json/sample handling below proceeds.
  if (videoFile && onVideoFound) {
    if (hasVideo?.()) {
      summaries.push(`video "${videoFile.filename}" found but widget already has one — skipped`);
    } else {
      setMessage(`found video "${videoFile.filename}" — uploading…`, 0);
      let uploaded = false;
      try {
        uploaded = await onVideoFound(videoFile);
      } catch (err) {
        console.error(`stfu widget: failed to auto-load video "${videoFile.filename}":`, err);
      }
      if (isDestroyed()) return;
      summaries.push(uploaded ? `video: ${videoFile.filename}` : `video "${videoFile.filename}" — upload failed`);
      if (uploaded) mergedCount++;
    }
  }

  for (const file of picked) {
    let raw: unknown;
    try {
      const text = await readPickedFileText(file);
      raw = JSON.parse(text);
    } catch (err) {
      console.error(`stfu widget: failed to read/parse "${file.filename}":`, err);
      summaries.push(`"${file.filename}" — not valid json`);
      continue;
    }
    if (isDestroyed()) return;

    const parsed = parseReferenceDataJson(raw);
    if (!parsed) {
      summaries.push(`"${file.filename}" — unrecognized shape`);
      continue;
    }

    changeDoc((d) => {
      if (parsed.kind === "diarize") {
        const speakerCount = Object.keys(parsed.ranges).length;
        const merged = mergeDiarizeData(d.referenceSpeakers, d.transcriptSegments, parsed);
        d.referenceSpeakers = merged.referenceSpeakers;
        d.transcriptSegments = merged.transcriptSegments;
        summaries.push(`${file.filename}: ${speakerCount} speaker(s)`);
      } else if (parsed.kind === "transcribe") {
        d.transcriptSegments = mergeTranscribeData(d.transcriptSegments, parsed);
        summaries.push(`${file.filename}: ${parsed.segments.length} segment(s)`);
      } else {
        const speakerCount = Object.keys(parsed.ranges).length;
        const merged = mergeCombinedData(d.referenceSpeakers, d.transcriptSegments, parsed);
        d.referenceSpeakers = merged.referenceSpeakers;
        d.transcriptSegments = merged.transcriptSegments;
        summaries.push(`${file.filename}: ${speakerCount} speaker(s), ${parsed.segments.length} segment(s)`);
      }
    });
    mergedCount++;
  }

  const sampleCount = await loadSpeakerSampleMedia(sampleFiles, changeDoc, isDestroyed);
  if (sampleCount > 0) {
    summaries.push(`${sampleCount} speaker sample(s)`);
    mergedCount++;
  }

  if (mergedCount === 0) {
    setMessage(summaries[0] ?? "no matching reference data found");
    return;
  }

  onMerged();
  setMessage(mergedCount === 1 ? summaries[0] : `loaded ${mergedCount} file(s): ${summaries.join("; ")}`);
}


/**
 * download the cut list as a manifest json compatible with
 * trek-minus-paris's `process.py --cut-list` arg — matches the "newer"
 * object shape `editor.py`'s `load_manual_cuts_file()` already accepts
 * (`{segments, cut_skip_enabled, cut_mute_enabled}`), so no translation
 * step is needed on the python side. audio-clip data isn't included —
 * `process.py`'s separate `--dub-segments` arg uses an unrelated shape
 * (see docs/stfu-widget-plan.md's phase-6 export section).
 */
export function downloadCutManifest(state: StfuState): void {
  const manifest = {
    segments: state.editableSegments,
    cut_skip_enabled: state.cutSkipEnabled,
    cut_mute_enabled: state.cutMuteEnabled,
  };
  const json = JSON.stringify(manifest, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const baseName = stripExtension(state.videoFilename || "cut-manifest");
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName}_manual_cuts.json`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}
