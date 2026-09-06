/**
 * live audio playback during animaniac timeline playback — every
 * currently-active audio-bearing clip (voice-recording/tts/audio-segment)
 * gets its own lazily-created `<audio>` element, kept in sync with the
 * timeline's own play state + position. unlike `stfu`'s own `audio-clip-
 * playback.ts` (which assumes at most one clip audible at a time via a
 * single `residentClipId`), this is pool-based — animaniac allows
 * overlapping audio-bearing clips both within and across tracks (see
 * docs/animaniac-media-segments-plan.md decision D), so N elements can
 * legitimately be playing at once; the browser mixes them for free.
 *
 * mirrors `compositor.ts`'s own pool-by-clip-id pattern (create once when
 * a clip first becomes active, tear down once it stops being active).
 */

import { log } from "@freqhole/reliquary/utils";
import type { PeersMap } from "../../src/file-utils/file-shared";
import { getMediaPlaybackUrl } from "../../src/media";
import { checkBlobLocality } from "../../src/file-utils/blob-locality";
import { isTauriMode } from "../../src/p2p/tauri-transport";
import { activeClipsAt } from "./track-model";
import type { Clip } from "./types";

const TAG = "animaniac.audio-playback";

const AUDIO_KINDS = new Set(["voice-recording", "tts", "audio-segment"]);

function isAudioBearingClip(clip: Clip): boolean {
  return AUDIO_KINDS.has(clip.kind);
}

/** where in the SOURCE audio this clip's playback should start from —
 *  every audio-bearing kind now carries its own `sourceInSec` trim. */
function sourceOffsetSec(clip: Clip): number {
  return clip.kind === "audio-segment" || clip.kind === "voice-recording" || clip.kind === "tts" ? clip.sourceInSec : 0;
}

export interface AudioRef {
  blobId: string;
  mime: string;
  blake3: string;
}

/** an applied gain rendition (see voice-recording.ts's mirror of this same
 *  concept) always wins over the clip's original audio — the whole point
 *  of committing one. gain is always rendered from the WHOLE original
 *  source (never just the trimmed range), so this is safe to prefer
 *  regardless of `sourceInSec`/`sourceOutSec`. */
export function effectiveAudioRef(clip: Clip): AudioRef | null {
  if (clip.kind !== "voice-recording" && clip.kind !== "tts" && clip.kind !== "audio-segment") return null;
  if (clip.gainRenditionBlobId) {
    return { blobId: clip.gainRenditionBlobId, mime: clip.gainRenditionMime, blake3: clip.gainRenditionBlake3 };
  }
  if (!clip.audioBlobId) return null;
  return { blobId: clip.audioBlobId, mime: clip.audioMime, blake3: clip.audioBlake3 };
}

export interface AudioPlaybackOptions {
  getClips: () => Clip[];
  getPeers?: () => PeersMap | undefined;
}

export interface AudioPlaybackHandle {
  /** call on every playback tick with the current absolute timeline time
   *  and whether playback is running (a seek while paused shouldn't start
   *  any element playing). `seeked` should be true only for a discrete
   *  jump (explicit seek / a fresh resume) — see `update()`'s own comment
   *  for why this matters. */
  update(t: number, playing: boolean, seeked: boolean): void;
  destroy(): void;
}

interface PoolEntry {
  el: HTMLAudioElement | null;
  resolving: boolean;
  /** true once `el.currentTime` has been set at least once — see `update()`. */
  synced: boolean;
  /** true once `el` has fired `loadedmetadata` (or already had metadata the
   *  moment it was checked) — `update()` withholds the first seek/`.play()`
   *  until this is true, since seeking a codec whose demuxer is slower to
   *  initialize (flac, on WKWebView/AVFoundation, confirmed empirically —
   *  other formats tolerate an immediate pre-ready seek fine) before it's
   *  ready has been observed to permanently wedge the element into
   *  rejecting every subsequent `.play()` with `NotSupportedError`, rather
   *  than just queuing the seek per spec. */
  ready: boolean;
  /** the `AudioRef` this entry's `el` was resolved from — a live doc write
   *  changing which ref a clip effectively points to (e.g. a fresh gain
   *  rendition landing) is detected by comparing against this each tick,
   *  see `update()`'s own re-resolve check. `null` while still resolving. */
  resolvedKey: string | null;
}

export function createAudioPlayback(options: AudioPlaybackOptions): AudioPlaybackHandle {
  const { getClips, getPeers } = options;
  const pool = new Map<string, PoolEntry>();

  function refKey(ref: AudioRef): string {
    return `${ref.blobId}|${ref.blake3}`;
  }

  function ensureEntry(clip: Clip): PoolEntry {
    let entry = pool.get(clip.id);
    if (entry) return entry;
    entry = { el: null, resolving: false, synced: false, ready: false, resolvedKey: null };
    pool.set(clip.id, entry);
    const ref = effectiveAudioRef(clip);
    if (ref && !entry.resolving) {
      entry.resolving = true;
      const { blobId, mime, blake3 } = ref;
      entry.resolvedKey = refKey(ref);
      // in tauri mode, blob_get_path()/blob lookups prefer blake3 over
      // blobId when both are present (see media-urls.ts's own "lookupId =
      // blake3 || blobId" comment: "on skein-tauri, blob ids ARE blake3
      // hashes") — a clip whose `audioBlake3` was captured stale/empty (or
      // simply wrong, e.g. left over from before a snatch re-keyed the
      // blob locally) resolves under a DIFFERENT key than the live file
      // widget's own doc uses, even though the underlying content is the
      // same. logging both the value actually used as the lookup key AND
      // a live locality check makes a stale reference obvious at a glance.
      const tauriLookupId = blake3 || blobId;
      log.debug(TAG, "resolving playback url", {
        clipId: clip.id,
        kind: clip.kind,
        blobId,
        blake3,
        mime,
        isTauriMode: isTauriMode(),
        tauriLookupId,
      });
      checkBlobLocality(blobId, blake3 || undefined)
        .then((info) => log.debug(TAG, "blob locality (blobId+blake3 as stored on the clip)", { clipId: clip.id, ...info }))
        .catch((err) => log.debug(TAG, "checkBlobLocality threw (non-fatal)", { clipId: clip.id, err }));
      void getMediaPlaybackUrl(blobId, { category: "audio", mime: mime || undefined, blake3: blake3 || undefined, peers: getPeers?.() }).then(
        (url) => {
          if (!url) {
            log.warn(TAG, "getMediaPlaybackUrl returned null — nothing to play", { clipId: clip.id, kind: clip.kind, blobId: blobId.slice(0, 12) });
            return;
          }
          log.debug(TAG, "playback url resolved", { clipId: clip.id, kind: clip.kind, url: url.slice(0, 60) });
          const el = document.createElement("audio");
          // a detached (never-appended-to-the-document) media element has
          // been observed to fail decoding a less-common codec (flac) with
          // `NotSupportedError` on WKWebView/AVFoundation even though the
          // identical blob plays fine through file.ts's DOM-attached
          // element — hidden but attached, matching every other working
          // playback element in this codebase.
          el.style.display = "none";
          document.body.appendChild(el);
          el.addEventListener("loadedmetadata", () => {
            entry!.ready = true;
          });
          el.src = url;
          if (el.readyState >= HTMLMediaElement.HAVE_METADATA) entry!.ready = true;
          el.addEventListener("error", () => {
            log.warn(TAG, "<audio> element error event", {
              clipId: clip.id,
              kind: clip.kind,
              blobId,
              blake3,
              mime,
              // readyState/networkState/canPlayType are the browser's own
              // diagnosis of WHY it rejected this src, without needing a
              // separate debug-log-level capture; concurrentAudioElements
              // (count of other pool entries with a live <audio> right now)
              // tests whether this only fails when several clips' elements
              // are alive at once (a possible AVFoundation concurrent-
              // decoder-instance limit for a less common codec like flac).
              readyState: el.readyState,
              networkState: el.networkState,
              canPlayFlac: el.canPlayType("audio/flac"),
              isConnected: el.isConnected,
              concurrentAudioElements: [...pool.values()].filter((e) => e.el).length,
              mediaError: el.error ? { code: el.error.code, message: el.error.message } : null,
              srcPrefix: el.src.slice(0, 32),
            });
          });
          entry!.el = el;
        }
      );
    }
    return entry;
  }

  function update(t: number, playing: boolean, seeked: boolean): void {
    const active = activeClipsAt(getClips().filter(isAudioBearingClip), t);
    const activeIds = new Set(active.map((c) => c.id));

    for (const [id, entry] of pool) {
      if (!activeIds.has(id)) {
        entry.el?.pause();
        entry.el?.remove();
        pool.delete(id);
      }
    }

    // a still-active clip whose effective ref changed (a gain rendition
    // just landed, from this peer or a remote one) needs a fresh element —
    // deleting the stale entry here lets `ensureEntry()` below recreate it
    // and re-seek/resume at the correct position via its own `!synced`
    // path, same as a brand-new clip becoming active.
    for (const clip of active) {
      const entry = pool.get(clip.id);
      if (!entry || entry.resolvedKey === null) continue; // not created yet, or still resolving for the first time
      const ref = effectiveAudioRef(clip);
      const currentKey = ref ? refKey(ref) : null;
      if (currentKey !== entry.resolvedKey) {
        entry.el?.pause();
        entry.el?.remove();
        pool.delete(clip.id);
      }
    }


    for (const clip of active) {
      const entry = ensureEntry(clip);
      if (!entry.el) continue; // still resolving the blob URL, or nothing to play yet (e.g. ungenerated tts)
      if (!entry.ready) continue; // element created but not yet past HAVE_METADATA — wait rather than race a seek
      const localElapsed = t - clip.start;
      const target = sourceOffsetSec(clip) + localElapsed;
      // only force a currentTime write on a discrete jump (`seeked`, or the
      // very first sync for this element) — NOT on every regular playback
      // tick. setting .currentTime on an already-playing <audio> element
      // forces an internal reseek, which glitches audibly (worse on tauri's
      // wkwebview than chromium) if done ~60 times/sec; every other audio
      // path in this codebase (voice-recording.ts, stfu/audio-clip-
      // playback.ts, file.ts's plain player) seeks once then lets the
      // element's own native clock run untouched — this used to fight that
      // native clock every tick instead.
      if (!entry.synced || seeked) {
        entry.el.currentTime = target;
        entry.synced = true;
        log.debug(TAG, "seeked", { clipId: clip.id, kind: clip.kind, target, sourceOffsetSec: sourceOffsetSec(clip), localElapsed, audioDuration: entry.el.duration });
      }
      if (playing && entry.el.paused) {
        void entry.el.play().catch((err) => {
          log.warn(TAG, "play() rejected", { clipId: clip.id, kind: clip.kind, error: err instanceof Error ? err.message : String(err), srcPrefix: entry.el?.src.slice(0, 32) });
        });
      }
      if (!playing && !entry.el.paused) entry.el.pause();
    }
  }

  return {
    update,
    destroy() {
      for (const entry of pool.values()) {
        entry.el?.pause();
        entry.el?.remove();
      }
      pool.clear();
    },
  };
}
