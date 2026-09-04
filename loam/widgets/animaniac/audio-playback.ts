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

import type { PeersMap } from "../../src/file-utils/file-shared";
import { getMediaPlaybackUrl } from "../../src/media";
import { activeClipsAt } from "./track-model";
import type { AudioSegmentClip, Clip } from "./types";

const AUDIO_KINDS = new Set(["voice-recording", "tts", "audio-segment"]);

function isAudioBearingClip(clip: Clip): boolean {
  return AUDIO_KINDS.has(clip.kind);
}

/** where in the SOURCE audio this clip's playback should start from —
 *  trimmed segments start at their own `sourceInSec`, whole-clip kinds
 *  (voice-recording/tts) always start at 0. */
function sourceOffsetSec(clip: Clip): number {
  return clip.kind === "audio-segment" ? (clip as AudioSegmentClip).sourceInSec : 0;
}

function audioBlobIdOf(clip: Clip): string {
  return clip.kind === "voice-recording" || clip.kind === "tts" || clip.kind === "audio-segment" ? clip.audioBlobId : "";
}

export interface AudioPlaybackOptions {
  getClips: () => Clip[];
  getPeers?: () => PeersMap | undefined;
}

export interface AudioPlaybackHandle {
  /** call on every playback tick with the current absolute timeline time
   *  and whether playback is running (a seek while paused shouldn't start
   *  any element playing). */
  update(t: number, playing: boolean): void;
  destroy(): void;
}

interface PoolEntry {
  el: HTMLAudioElement | null;
  resolving: boolean;
}

export function createAudioPlayback(options: AudioPlaybackOptions): AudioPlaybackHandle {
  const { getClips, getPeers } = options;
  const pool = new Map<string, PoolEntry>();

  function ensureEntry(clip: Clip): PoolEntry {
    let entry = pool.get(clip.id);
    if (entry) return entry;
    entry = { el: null, resolving: false };
    pool.set(clip.id, entry);
    const blobId = audioBlobIdOf(clip);
    if (blobId && !entry.resolving) {
      entry.resolving = true;
      const mime = clip.kind === "voice-recording" || clip.kind === "tts" || clip.kind === "audio-segment" ? clip.audioMime : "";
      const blake3 = clip.kind === "voice-recording" || clip.kind === "tts" || clip.kind === "audio-segment" ? clip.audioBlake3 : "";
      void getMediaPlaybackUrl(blobId, { category: "audio", mime: mime || undefined, blake3: blake3 || undefined, peers: getPeers?.() }).then(
        (url) => {
          if (!url) return;
          const el = document.createElement("audio");
          el.src = url;
          entry!.el = el;
        }
      );
    }
    return entry;
  }

  function update(t: number, playing: boolean): void {
    const active = activeClipsAt(getClips().filter(isAudioBearingClip), t);
    const activeIds = new Set(active.map((c) => c.id));

    for (const [id, entry] of pool) {
      if (!activeIds.has(id)) {
        entry.el?.pause();
        pool.delete(id);
      }
    }

    for (const clip of active) {
      const entry = ensureEntry(clip);
      if (!entry.el) continue; // still resolving the blob URL, or nothing to play yet (e.g. ungenerated tts)
      const localElapsed = t - clip.start;
      const target = sourceOffsetSec(clip) + localElapsed;
      // only nudge currentTime when it's drifted more than a small
      // tolerance, so a playing element isn't fighting a seek every tick.
      if (Math.abs(entry.el.currentTime - target) > 0.2) entry.el.currentTime = target;
      if (playing && entry.el.paused) void entry.el.play().catch(() => {});
      if (!playing && !entry.el.paused) entry.el.pause();
    }
  }

  return {
    update,
    destroy() {
      for (const entry of pool.values()) entry.el?.pause();
      pool.clear();
    },
  };
}
