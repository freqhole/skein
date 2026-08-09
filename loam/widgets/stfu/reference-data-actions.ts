/**
 * "load reference data..." (diarization/transcript json) and "download cut
 * manifest..." widget actions, plus the small transient-message controller
 * used to surface load feedback in the widget's header. pulled out of
 * index.ts to keep that file from growing further.
 */

import { pickJsonDirectory, pickJsonFiles, readPickedFileText } from "../../src/file-utils/upload";
import { mergeCombinedData, mergeDiarizeData, mergeTranscribeData, parseReferenceDataJson } from "./reference-data";
import type { StfuState } from "./types";

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
}

export async function handleLoadReferenceData(options: LoadReferenceDataOptions): Promise<void> {
  const { isViewerOnly, isDestroyed, changeDoc, onMerged, setMessage, fromDirectory } = options;
  if (isDestroyed() || isViewerOnly) return;

  // immediate feedback before the (possibly slow, modal) file picker opens —
  // without this the widget looked "locked up" with no indication anything
  // was happening.
  setMessage(fromDirectory ? "loading project folder…" : "loading reference data…", 0);

  const picked = await (fromDirectory ? pickJsonDirectory() : pickJsonFiles());
  if (isDestroyed()) return;
  if (picked.length === 0) {
    setMessage("");
    return;
  }

  const summaries: string[] = [];
  let mergedCount = 0;
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
