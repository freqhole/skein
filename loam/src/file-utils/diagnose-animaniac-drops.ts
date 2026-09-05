/**
 * one-shot console diagnostic for "why can't I drop this widget onto
 * animaniac" — meant to be run ad hoc from browser devtools against the
 * currently open canvas: `window.__skeinDiagnoseAnimaniacDrops()` (wired
 * in `standalone/boot.ts` right next to `window.__skeinBackfillFileDurations`).
 *
 * for every widget on the canvas that animaniac's drop-controller would
 * even consider (`isCapturableWidgetType()`), reports:
 *  - whether its own per-widget doc could be reached at all (the bug
 *    fixed in `drop-controller.ts`'s `readDroppedStateAsync()` — a widget
 *    whose doc was never opened locally this session, e.g. sitting
 *    untouched inside a bin, used to silently reject the whole drop
 *    instead of just waiting for it)
 *  - whether animaniac would actually capture it as a clip right now, and
 *    if not, why (mirrors `frame-capture.ts`'s `resolveCapturedClip()`'s
 *    own per-type gating conditions, kept in sync with it by hand — see
 *    `wouldCaptureAsClip()`'s own doc comment)
 * plus, for every animaniac widget itself, its track count (a drop needs
 * at least one non-hidden track to land on at all).
 *
 * deliberately does NOT call the real `resolveCapturedClip()` — its
 * "doodle" branch has a real side effect (renders + promotes a snapshot
 * blob), which a read-only diagnostic must never trigger just by being
 * run.
 */

import type { DocumentId } from "@automerge/automerge-repo";
import type { CanvasStore } from "../canvas/canvas-store";
import type { WidgetRegistry } from "../widgets/widget-registry";
import { resolveDocReadyCached } from "../p2p/doc-ready";
import { isCapturableWidgetType } from "../../widgets/animaniac/frame-capture";
import { animaniacSchema } from "../../widgets/animaniac/types";

export interface AnimaniacDropDiagnosisEntry {
  widgetId: string;
  type: string;
  docId: string | null;
  capturable: boolean;
  /** null when a doc read was never attempted (not capturable, or no
   *  docId yet — e.g. never mounted this session). */
  docReachable: boolean | null;
  /** the clip kind animaniac would create right now, or null if it
   *  wouldn't capture this widget at all — see `reason`. */
  wouldCaptureAs: string | null;
  reason: string;
}

export interface AnimaniacTrackSummary {
  widgetId: string;
  trackCount: number;
  nonHiddenTrackCount: number;
}

export interface AnimaniacDropDiagnosisReport {
  /** connected p2p peer count — 0 here means every "doc unreachable"
   *  result below is almost certainly a connectivity issue, not a bug in
   *  animaniac's own drop handling. */
  peerCount: number;
  animaniacWidgets: AnimaniacTrackSummary[];
  widgets: AnimaniacDropDiagnosisEntry[];
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

/** read-only mirror of `frame-capture.ts`'s `resolveCapturedClip()` own
 *  per-type gating conditions — decides WHETHER a clip would be created
 *  and why, without doing any of the real (possibly side-effecting, e.g.
 *  doodle's snapshot-blob promotion) capture work itself. keep in sync
 *  with that module by hand if its gating conditions ever change. */
function wouldCaptureAsClip(sourceType: string, s: Record<string, unknown>): { kind: string | null; reason: string } {
  switch (sourceType) {
    case "doodle":
      return Array.isArray(s.strokes) && s.strokes.length > 0
        ? { kind: "doodle-frame", reason: "has strokes" }
        : { kind: null, reason: "no strokes drawn yet" };
    case "image":
      return str(s.url) ? { kind: "image", reason: "has an image url" } : { kind: null, reason: "no image url set" };
    case "label":
      return str(s.text) ? { kind: "label", reason: "has text" } : { kind: null, reason: "no text set" };
    case "voice-recording":
      return str(s.blobId) ? { kind: "voice-recording", reason: "has a recorded blob" } : { kind: null, reason: "nothing recorded yet" };
    case "tts":
      return str(s.blobId) ? { kind: "tts", reason: "has generated audio" } : { kind: null, reason: "not generated yet" };
    case "audio-recording":
      if (!str(s.blobId)) return { kind: null, reason: "nothing recorded yet" };
      if (num(s.duration) <= 0) return { kind: null, reason: "duration is 0 (probe never completed)" };
      return { kind: "audio-segment", reason: "has a recorded blob with a known duration" };
    case "file": {
      const domain = str(s.domain);
      if (domain !== "audio" && domain !== "video") return { kind: null, reason: `domain "${domain || "(none)"}" is not audio/video` };
      if (!str(s.blobId)) return { kind: null, reason: "no blobId set" };
      if (num(s.duration) <= 0) return { kind: null, reason: "duration is 0 — try window.__skeinBackfillFileDurations() for this canvas" };
      return { kind: domain === "audio" ? "audio-segment" : "video-segment", reason: "has a blob with a known duration" };
    }
    case "stfu":
      if (!str(s.videoBlobId)) return { kind: null, reason: "no source video set" };
      if (num(s.videoDurationSec) <= 0) return { kind: null, reason: "video duration is 0" };
      return { kind: "video-segment", reason: "has a source video with a known duration" };
    default:
      return { kind: null, reason: "widget type is not one animaniac knows how to capture" };
  }
}

export async function diagnoseAnimaniacDrops(store: CanvasStore, registry: WidgetRegistry): Promise<AnimaniacDropDiagnosisReport> {
  const allWidgets = store.allWidgets();
  const peerCount = Object.keys(store.peers() ?? {}).length;

  const animaniacWidgets: AnimaniacTrackSummary[] = [];
  for (const entry of allWidgets.filter((w) => w.type === "animaniac")) {
    if (!entry.docId) {
      animaniacWidgets.push({ widgetId: entry.id, trackCount: 0, nonHiddenTrackCount: 0 });
      continue;
    }
    const handle = await resolveDocReadyCached(store.repo, entry.docId as DocumentId, { context: "diagnose-animaniac-drops" });
    const parsed = handle ? animaniacSchema.safeParse(handle.doc()) : null;
    const tracks = parsed?.success ? parsed.data.tracks : [];
    animaniacWidgets.push({
      widgetId: entry.id,
      trackCount: tracks.length,
      nonHiddenTrackCount: tracks.filter((t) => !t.hidden).length,
    });
  }

  const widgets = await Promise.all(
    allWidgets
      .filter((entry) => entry.type !== "animaniac")
      .map(async (entry): Promise<AnimaniacDropDiagnosisEntry> => {
        const capturable = isCapturableWidgetType(entry.type);
        if (!capturable) {
          return { widgetId: entry.id, type: entry.type, docId: entry.docId, capturable, docReachable: null, wouldCaptureAs: null, reason: "not a widget type animaniac can capture" };
        }
        if (!entry.docId) {
          return { widgetId: entry.id, type: entry.type, docId: null, capturable, docReachable: null, wouldCaptureAs: null, reason: "no docId yet (widget never mounted this session?)" };
        }
        const factory = registry.get(entry.type);
        if (!factory?.schema) {
          return { widgetId: entry.id, type: entry.type, docId: entry.docId, capturable, docReachable: null, wouldCaptureAs: null, reason: "no registered factory/schema for this widget type" };
        }
        const handle = await resolveDocReadyCached(store.repo, entry.docId as DocumentId, { context: "diagnose-animaniac-drops" });
        if (!handle) {
          return { widgetId: entry.id, type: entry.type, docId: entry.docId, capturable, docReachable: false, wouldCaptureAs: null, reason: "doc did not become reachable (see repo memory: cooldown-cached, may report unreachable instantly on a rerun within ~2min)" };
        }
        const rawDoc = handle.doc();
        if (!rawDoc) {
          return { widgetId: entry.id, type: entry.type, docId: entry.docId, capturable, docReachable: false, wouldCaptureAs: null, reason: "doc handle resolved but has no content" };
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = factory.schema.parse(rawDoc) as Record<string, unknown>;
        } catch (err) {
          return { widgetId: entry.id, type: entry.type, docId: entry.docId, capturable, docReachable: true, wouldCaptureAs: null, reason: `schema.parse threw: ${err instanceof Error ? err.message : String(err)}` };
        }
        const { kind, reason } = wouldCaptureAsClip(entry.type, parsed);
        return { widgetId: entry.id, type: entry.type, docId: entry.docId, capturable, docReachable: true, wouldCaptureAs: kind, reason };
      })
  );

  return { peerCount, animaniacWidgets, widgets };
}
