/**
 * audio-clip playback while the video plays — either a clip's own
 * generated/recorded audio file (lazily created `<audio>` element) or, for
 * a clip that hasn't been generated yet, a live speechSynthesis reading of
 * its `ttsText`. pulled out of index.ts to keep that file from growing
 * further — driven entirely by the video's own `timeupdate`/`pause` events
 * (see index.ts's `mountMediaOverlay()`).
 */

import type { PeersMap } from "../../src/file-utils/file-shared";
import { getMediaPlaybackUrl } from "../../src/media";
import { cancelPreview, speakPreview } from "../tts/voices";
import type { AudioClip } from "./types";

export interface AudioClipPlaybackOptions {
  /** the currently-mounted video element, or null if none is mounted. */
  getVideo: () => HTMLVideoElement | null;
  getAudioClips: () => AudioClip[];
  getPeers: () => PeersMap | undefined;
  isDestroyed: () => boolean;
}

export interface AudioClipPlaybackHandle {
  /** call on every video "timeupdate" (and once more on "pause") — starts/
   *  stops clip audio as the playhead enters/leaves a clip's window. */
  apply(): void;
  /** stop any in-flight clip audio immediately (e.g. video paused/seeking). */
  stop(): void;
}

// a not-yet-generated clip has no real `durationSec` yet — estimate a
// rough speaking length from its text just to gate *when* playback should
// start; the actual stop is driven by speechSynthesis's own "end" event,
// not this estimate.
function estimatedClipDuration(clip: AudioClip): number {
  if (clip.durationSec > 0) return clip.durationSec;
  const chars = (clip.ttsText || "").length;
  const rate = clip.ttsRate || 1;
  return Math.max(1, chars / (12 * rate));
}

export function createAudioClipPlayback(options: AudioClipPlaybackOptions): AudioClipPlaybackHandle {
  const { getVideo, getAudioClips, getPeers, isDestroyed } = options;

  let clipAudioEl: HTMLAudioElement | null = null;
  let activeAudioClipId: string | null = null;
  // the clip currently "occupying" the playhead's position — set once when
  // first triggered for this residency and NOT cleared just because
  // playback finishes naturally (that would let the playhead's own
  // still-being-within-the-clip's-window re-trigger it on the very next
  // timeupdate tick, looping it for the rest of the clip's estimated
  // length). only cleared once the playhead genuinely leaves every clip's
  // window, or the video pauses.
  let residentClipId: string | null = null;

  function stop(): void {
    if (activeAudioClipId) {
      cancelPreview();
      clipAudioEl?.pause();
      activeAudioClipId = null;
    }
    residentClipId = null;
  }

  async function playClipAudioFile(clip: AudioClip, offset: number): Promise<void> {
    if (!clip.audioBlobId) return;
    const peers = getPeers();
    const url = await getMediaPlaybackUrl(clip.audioBlobId, {
      category: "audio",
      mime: clip.audioMime,
      blake3: clip.audioBlake3 || undefined,
      peers,
    });
    if (isDestroyed() || activeAudioClipId !== clip.id || !url) return;
    if (!clipAudioEl) {
      clipAudioEl = document.createElement("audio");
      clipAudioEl.addEventListener("ended", () => {
        activeAudioClipId = null;
      });
    }
    if (clipAudioEl.src !== url) clipAudioEl.src = url;
    clipAudioEl.currentTime = offset;
    try {
      await clipAudioEl.play();
    } catch {
      if (activeAudioClipId === clip.id) activeAudioClipId = null;
    }
  }

  function startClipAudio(clip: AudioClip, offset: number): void {
    activeAudioClipId = clip.id;
    if (clip.audioBlobId) {
      void playClipAudioFile(clip, offset);
      return;
    }
    if (clip.ttsText) {
      speakPreview(clip.ttsText, clip.ttsVoiceName || "", clip.ttsRate || 1, () => {
        if (activeAudioClipId === clip.id) activeAudioClipId = null;
      });
      return;
    }
    activeAudioClipId = null;
  }

  function apply(): void {
    const video = getVideo();
    if (!video) return;
    if (video.paused) {
      stop();
      return;
    }
    const t = video.currentTime;
    const clip = getAudioClips().find(
      (c) => (c.audioBlobId || c.ttsText) && t >= c.start && t < c.start + estimatedClipDuration(c)
    );
    if (!clip) {
      // playhead isn't within any clip's window anymore — clear residency
      // so a later re-entry into this (or another) clip's window can
      // trigger playback again.
      residentClipId = null;
      return;
    }
    if (clip.id === residentClipId) return; // already triggered once for this residency — play exactly once, don't loop
    stop();
    residentClipId = clip.id;
    startClipAudio(clip, Math.max(0, t - clip.start));
  }

  return { apply, stop };
}
