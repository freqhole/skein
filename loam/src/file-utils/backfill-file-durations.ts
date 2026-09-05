/**
 * one-shot backfill for `file` widgets created BEFORE `create-file-widget.ts`
 * started probing audio/video duration upfront (see its own doc comment) —
 * an older widget can be stuck at `duration: 0` forever, which is exactly
 * what `widgets/animaniac/frame-capture.ts`'s `resolveCapturedClip()`
 * requires to be `> 0` before it'll capture a `file` (audio/video domain)
 * drop as a clip. not a schema/shape migration — every field already
 * exists, this just re-runs the same probe for whichever widgets never got
 * a real answer the first time.
 *
 * `voice-recording` widgets do NOT need this: `resolveCapturedClip()`'s own
 * "voice-recording" case only ever requires a truthy `audioBlobId`, no
 * duration check at all — if an old voice-recording widget still can't be
 * dropped onto animaniac after the bin-drag-out fix ships, that's a
 * different bug, not a data problem this backfill would touch.
 *
 * intentionally not wired into any UI button — this is meant to be run
 * once, ad hoc, from the browser devtools console against the currently
 * open canvas: `window.__skeinBackfillFileDurations()` (wired in
 * `standalone/boot.ts` right next to `window.__skein`).
 */

import type { DocumentId } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import type { CanvasStore } from "../canvas/canvas-store";
import { fileSchema } from "../../widgets/file";
import { getMediaPlaybackUrl } from "../media/media-urls";
import { probeMediaDuration } from "./media-duration";
import { resolveDocReadyCached } from "../p2p/doc-ready";

const TAG = "file-utils.backfill-file-durations";

export interface BackfillFileDurationsResult {
  /** audio/video `file` widgets found on this canvas. */
  checked: number;
  /** how many had `duration` successfully re-probed and written. */
  fixed: number;
  /** how many were audio/video with `duration <= 0` but the re-probe also
   *  failed/returned 0 (e.g. the blob isn't locally available to probe) —
   *  left untouched, safe to re-run later once the blob is snatched. */
  failed: number;
  /** how many `file` widgets' own per-widget doc never became reachable at
   *  all (see `resolveDocReadyCached()`'s bounded ~15s wait) — these were
   *  never even checked for a stale duration, so a `checked: 0` result
   *  with `unreachable > 0` means "couldn't tell", NOT "nothing needed
   *  fixing". safe to re-run later once connectivity/peer availability
   *  improves. */
  unreachable: number;
}

/** re-probes and backfills `duration` for every `file` widget on `store`'s
 *  canvas whose domain is audio/video and whose `duration` is still `<= 0`.
 *  read-only for every other widget (skips non-file types, non-audio/video
 *  domains, and anything that already has a real duration). */
export async function backfillMissingFileDurations(store: CanvasStore): Promise<BackfillFileDurationsResult> {
  const result: BackfillFileDurationsResult = { checked: 0, fixed: 0, failed: 0, unreachable: 0 };

  for (const entry of store.allWidgets()) {
    if (entry.type !== "file" || !entry.docId) continue;

    const handle = await resolveDocReadyCached<{ duration: number }>(store.repo, entry.docId as DocumentId, { context: "backfill-file-durations" });
    if (!handle) {
      result.unreachable++;
      continue;
    }
    const rawDoc = handle.doc();
    if (!rawDoc) {
      result.unreachable++;
      continue;
    }

    const parsed = fileSchema.safeParse(rawDoc);
    if (!parsed.success) continue;
    const state = parsed.data;
    if (state.domain !== "audio" && state.domain !== "video") continue;
    if (state.duration > 0) continue;

    result.checked++;
    try {
      const url = await getMediaPlaybackUrl(state.blobId, {
        category: state.domain,
        mime: state.mime || undefined,
        blake3: state.blake3 || undefined,
      });
      const duration = url ? await probeMediaDuration(url, state.domain) : 0;
      if (duration > 0) {
        handle.change((d) => {
          d.duration = duration;
        });
        result.fixed++;
        log.debug(TAG, `backfilled duration for ${entry.docId.slice(0, 12)}... (${state.filename}): ${duration}s`);
      } else {
        result.failed++;
      }
    } catch (err) {
      result.failed++;
      log.debug(TAG, `probe failed for ${entry.docId.slice(0, 12)}... (non-fatal):`, err);
    }
  }

  return result;
}
