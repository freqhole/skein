/**
 * "snatch" support for the stfu widget — locality-check + batch-snatch of
 * the video blob plus every audio-clip's real audio blob, and background
 * auto-snatch of any *new* clip blob that appears after a peer has already
 * done one manual "snatch all" (see docs/stfu-widget-plan.md). pulled out
 * of index.ts to keep that file from growing further — this piece only
 * needs read access to the doc + peers plus a couple of callbacks back into
 * the widget for header-action refresh and re-mounting the video overlay
 * once a snatch succeeds.
 */

import { checkBlobLocality } from "../../src/file-utils/blob-locality";
import type { PeersMap, SnatchBlobInfo } from "../../src/file-utils/file-shared";
import { snatchBlobBatch } from "../../src/file-utils/snatch";
import { loadAutoSnatchEnabled, saveAutoSnatchEnabled } from "./local-prefs";
import type { StfuState } from "./types";

export type VideoActionState = "idle" | "checking" | "local" | "remote" | "snatching";

export interface SnatchControllerOptions {
  widgetId: string;
  getDocState: () => StfuState;
  getPeers: () => PeersMap | undefined;
  isPeerOnline?: (nodeId: string) => boolean;
  isDestroyed: () => boolean;
  /** called whenever `videoActionState`/`progressText` change — re-render header actions. */
  onStateChange: () => void;
  /** called after a successful snatch that included the video blob — force a video overlay re-mount. */
  onVideoSnatched: () => void;
}

export interface SnatchControllerHandle {
  getVideoActionState(): VideoActionState;
  getProgressText(): string;
  checkVideoLocality(): Promise<void>;
  handleSnatchAll(): Promise<void>;
  cancelSnatch(): void;
  /** best-effort, silent background snatch of whatever's newly appeared since
   *  the last pass — no-op until `handleSnatchAll()` has succeeded once. */
  maybeAutoSnatchNew(): void;
  destroy(): void;
}

export function createSnatchController(options: SnatchControllerOptions): SnatchControllerHandle {
  const { widgetId, getDocState, getPeers, isPeerOnline, isDestroyed, onStateChange, onVideoSnatched } = options;

  let videoActionState: VideoActionState = "idle";
  let videoSnatchAbort: AbortController | null = null;
  let videoSnatchCancelled = false;
  let videoSnatchProgressText = "";
  // guards against re-probing locality on every doc-change tick — only
  // re-check when the blob identity actually changes (new upload/snatch).
  let checkedVideoLocalityKey = "";

  let autoSnatchEnabled = loadAutoSnatchEnabled(widgetId);
  /** blobIds already known to be local (or already attempted) as of the last
   *  auto-snatch pass — only a blobId outside this set triggers a new
   *  background batch (`snatchBlobBatch` itself is cheap to re-call, since
   *  it skips anything already local, but this avoids re-probing peers on
   *  every unrelated doc change, e.g. a caption edit). */
  const knownSnatchableBlobIds = new Set<string>();
  let autoSnatchInFlight = false;
  let autoSnatchQueued = false;

  /** the video blob (if any) plus every audio clip's real audio blob — the
   *  full set of blobs "snatch all" gathers in one batch. */
  function buildSnatchAllBlobs(): SnatchBlobInfo[] {
    const state = getDocState();
    const blobs: SnatchBlobInfo[] = [];
    if (state.videoBlobId) {
      blobs.push({
        blobId: String(state.videoBlobId || ""),
        filename: String(state.videoFilename || ""),
        mime: String(state.videoMime || ""),
        size: state.videoSize || 0,
        blake3: String(state.videoBlake3 || ""),
        domain: "video",
      });
    }
    for (const clip of state.audioClips) {
      if (!clip.audioBlobId) continue;
      blobs.push({
        blobId: String(clip.audioBlobId),
        filename: String(clip.audioFilename || `${clip.id}`),
        mime: String(clip.audioMime || ""),
        size: clip.audioSize || 0,
        blake3: String(clip.audioBlake3 || ""),
        domain: "audio",
      });
    }
    return blobs;
  }

  async function runAutoSnatch(blobs: SnatchBlobInfo[]): Promise<void> {
    const allPeers = getPeers();
    if (!allPeers || Object.keys(allPeers).length === 0) return;
    autoSnatchInFlight = true;
    try {
      await snatchBlobBatch(blobs, allPeers, { isPeerOnline });
      blobs.forEach((b) => knownSnatchableBlobIds.add(b.blobId));
    } catch (err) {
      console.warn("stfu widget: background auto-snatch of new clip(s) failed (will retry):", err);
    } finally {
      autoSnatchInFlight = false;
      if (autoSnatchQueued) {
        autoSnatchQueued = false;
        maybeAutoSnatchNew();
      }
    }
  }

  function maybeAutoSnatchNew(): void {
    if (!autoSnatchEnabled || isDestroyed()) return;
    const blobs = buildSnatchAllBlobs();
    const hasNew = blobs.some((b) => !knownSnatchableBlobIds.has(b.blobId));
    if (!hasNew) return;
    if (autoSnatchInFlight) {
      autoSnatchQueued = true;
      return;
    }
    void runAutoSnatch(blobs);
  }

  async function checkVideoLocality(): Promise<void> {
    const state = getDocState();
    if (!state.videoBlobId) {
      videoActionState = "idle";
      onStateChange();
      return;
    }
    const key = `${state.videoBlobId}:${state.videoBlake3}`;
    if (key === checkedVideoLocalityKey) return;
    checkedVideoLocalityKey = key;
    videoActionState = "checking";
    onStateChange();
    try {
      const info = await checkBlobLocality(state.videoBlobId, state.videoBlake3 || undefined);
      if (isDestroyed()) return;
      videoActionState = info.locality === "local" ? "local" : "remote";
    } catch (err) {
      if (isDestroyed()) return;
      console.error("stfu widget: video locality check failed:", err);
      videoActionState = "remote";
    }
    onStateChange();
  }

  async function handleSnatchAll(): Promise<void> {
    if (videoActionState !== "remote") return;
    const allPeers = getPeers();
    if (!allPeers || Object.keys(allPeers).length === 0) {
      console.warn("stfu widget: no peers available for snatch");
      return;
    }
    const blobs = buildSnatchAllBlobs();
    if (blobs.length === 0) return;

    videoSnatchCancelled = false;
    videoSnatchAbort = new AbortController();
    videoActionState = "snatching";
    videoSnatchProgressText = blobs.length > 1 ? `probing… (0/${blobs.length})` : "probing…";
    onStateChange();

    try {
      const results = await snatchBlobBatch(blobs, allPeers, {
        onProgress: (completedCount, totalCount, blobProgress) => {
          if (videoSnatchCancelled || isDestroyed()) return;
          const pct = blobProgress >= 0 ? ` ${Math.round(blobProgress * 100)}%` : "";
          videoSnatchProgressText = totalCount > 1 ? `snatching (${completedCount}/${totalCount})${pct}` : `snatching…${pct}`;
          onStateChange();
        },
        signal: videoSnatchAbort?.signal,
        isPeerOnline,
      });

      if (videoSnatchCancelled || isDestroyed()) return;
      // the video blob (if present) is always the first entry built by
      // `buildSnatchAllBlobs()`.
      const videoWasSnatched = getDocState().videoBlobId && results[0] !== null;
      videoActionState = videoWasSnatched ? "local" : "remote";
      videoSnatchProgressText = "";
      onStateChange();
      // this peer has now done a full manual pass — opt it into background
      // auto-snatching of any new clip that shows up later.
      autoSnatchEnabled = true;
      saveAutoSnatchEnabled(widgetId);
      blobs.forEach((b) => knownSnatchableBlobIds.add(b.blobId));
      if (videoWasSnatched) onVideoSnatched();
    } catch (err) {
      if (videoSnatchCancelled || isDestroyed()) return;
      console.error("stfu widget: snatch all failed:", err);
      videoActionState = "remote";
      videoSnatchProgressText = "";
      onStateChange();
    } finally {
      videoSnatchAbort = null;
    }
  }

  function cancelSnatch(): void {
    videoSnatchCancelled = true;
    videoSnatchAbort?.abort();
  }

  return {
    getVideoActionState: () => videoActionState,
    getProgressText: () => videoSnatchProgressText,
    checkVideoLocality,
    handleSnatchAll,
    cancelSnatch,
    maybeAutoSnatchNew,
    destroy() {
      videoSnatchCancelled = true;
      videoSnatchAbort?.abort();
    },
  };
}
