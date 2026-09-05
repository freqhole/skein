/**
 * "snatch" support for animaniac's own clips — every clip kind that
 * carries a blob reference (doodle-frame/image's `imageUrl`, voice-
 * recording/tts/audio-segment's `audioBlobId`, video-segment's
 * `videoBlobId`) is pooled into one batch-snatch, mirroring
 * stfu/snatch-controller.ts's pattern but adapted to animaniac's
 * tracks[]/clips[] doc shape instead of stfu's single video + audioClips[].
 *
 * unlike stfu (which re-scans the whole doc reactively whenever it
 * changes, to find newly-added blobs), animaniac docs churn heavily from
 * ordinary drag/transform edits — every pixel of a move/resize is its own
 * doc change, so a full clip-list rescan on each one would be wasteful.
 * instead, `drop-controller.ts` broadcasts a lightweight EPHEMERAL ping
 * (not a doc change, see canvas-store.ts's broadcastEphemeral/onEphemeral)
 * the moment it actually adds a new blob-bearing clip, and this controller
 * reacts to that directly via `onPeerAddedBlob()` — a full doc-wide scan
 * only ever happens once, at mount (`checkAllLocality()`, to catch up on
 * whatever already existed before this peer opened the canvas).
 */

import { checkBlobLocality } from "../../src/file-utils/blob-locality";
import type { PeersMap, SnatchBlobInfo } from "../../src/file-utils/file-shared";
import { snatchBlobBatch } from "../../src/file-utils/snatch";
import { log } from "@freqhole/reliquary/utils";
import { loadAutoSnatchEnabled, saveAutoSnatchEnabled } from "./local-prefs";
import type { AnimaniacState, Clip } from "./types";

export type SnatchState = "idle" | "checking" | "local" | "remote" | "snatching";

const ANIMANIAC_NEW_BLOB_MESSAGE_TYPE = "animaniac-new-blob";

/** ephemeral (non-doc, best-effort, not persisted/replayed) message a peer
 *  broadcasts the moment it adds a new blob-bearing clip to an animaniac
 *  widget — lets every OTHER peer currently on the same canvas react
 *  immediately without an expensive full-clip-list rescan on every
 *  ordinary doc change. */
export interface AnimaniacNewBlobMessage {
  type: typeof ANIMANIAC_NEW_BLOB_MESSAGE_TYPE;
  widgetId: string;
  blob: SnatchBlobInfo;
}

export function makeAnimaniacNewBlobMessage(widgetId: string, blob: SnatchBlobInfo): AnimaniacNewBlobMessage {
  return { type: ANIMANIAC_NEW_BLOB_MESSAGE_TYPE, widgetId, blob };
}

/** narrows an arbitrary decoded ephemeral payload — every widget/feature
 *  broadcasting over the same canvas-wide ephemeral channel shares this
 *  one event stream (see presence-manager.ts's own cursor/lock messages),
 *  so a type+shape check is required before trusting the payload. */
export function isAnimaniacNewBlobMessage(msg: unknown): msg is AnimaniacNewBlobMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.type === ANIMANIAC_NEW_BLOB_MESSAGE_TYPE && typeof m.widgetId === "string" && !!m.blob && typeof m.blob === "object";
}

/** every blob reference this widget's own doc currently carries — one
 *  pass over `clips[]`, covering every clip kind with a blob field, plus
 *  any applied gain rendition (see `clipGainRenditionBlobInfo()`) each
 *  audio-bearing clip may separately carry. */
export function buildSnatchAllBlobs(state: AnimaniacState): SnatchBlobInfo[] {
  const blobs: SnatchBlobInfo[] = [];
  for (const clip of state.clips) {
    const blob = clipBlobInfo(clip);
    if (blob) blobs.push(blob);
    const rendition = clipGainRenditionBlobInfo(clip);
    if (rendition) blobs.push(rendition);
  }
  return blobs;
}

/** the one blob reference a given clip carries, if any — null for clip
 *  kinds with no blob field (label) or a not-yet-populated one (e.g. a
 *  tts clip before generation, whose `audioBlobId` is still ""). */
export function clipBlobInfo(clip: Clip): SnatchBlobInfo | null {
  switch (clip.kind) {
    case "doodle-frame":
    case "image": {
      if (!clip.imageUrl.startsWith("blob:")) return null;
      // blob-store ids ARE blake3 hashes (see image-prop-blob.ts) — no
      // separate blake3 field exists on these clip kinds to carry.
      const blobId = clip.imageUrl.slice("blob:".length);
      if (!blobId) return null;
      return { blobId, filename: `${clip.id}.png`, mime: "image/png", size: 0, blake3: blobId, domain: "image" };
    }
    case "voice-recording":
    case "tts":
    case "audio-segment": {
      if (!clip.audioBlobId) return null;
      return {
        blobId: clip.audioBlobId,
        filename: clip.id,
        mime: clip.audioMime || "",
        size: 0,
        blake3: clip.audioBlake3 || "",
        domain: "audio",
      };
    }
    case "video-segment": {
      if (!clip.videoBlobId) return null;
      return {
        blobId: clip.videoBlobId,
        filename: clip.id,
        mime: clip.videoMime || "",
        size: 0,
        blake3: clip.videoBlake3 || "",
        domain: "video",
      };
    }
    default:
      return null;
  }
}

/** an applied gain rendition (see index.ts's `commitGainRender()`) is a
 *  SEPARATE blob from the clip's own `clipBlobInfo()` reference — null for
 *  every clip kind without one, or one that hasn't had gain applied. */
export function clipGainRenditionBlobInfo(clip: Clip): SnatchBlobInfo | null {
  if (clip.kind !== "voice-recording" && clip.kind !== "tts" && clip.kind !== "audio-segment") return null;
  if (!clip.gainRenditionBlobId) return null;
  return {
    blobId: clip.gainRenditionBlobId,
    filename: `${clip.id}-gain`,
    mime: clip.gainRenditionMime || "",
    size: clip.gainRenditionSize,
    blake3: clip.gainRenditionBlake3 || "",
    domain: "audio",
  };
}

export interface SnatchControllerOptions {
  widgetId: string;
  getDocState: () => AnimaniacState;
  /** persist a doc mutation \u2014 used to write this peer's own node id into
   *  the snatched clip's `snatchedBy` list (see `markClipSnatched()`), the
   *  same "record who has this blob" convention file.ts/voice-recording.ts
   *  already use, mirrored per-clip here (see tumulus/src/snatch.rs). */
  changeDoc: (fn: (d: AnimaniacState) => void) => void;
  /** this peer's own node id \u2014 empty string (a no-op guard in
   *  `markClipSnatched()`) before an identity exists yet. */
  getLocalNodeId: () => string;
  getPeers: () => PeersMap | undefined;
  isPeerOnline?: (nodeId: string) => boolean;
  isDestroyed: () => boolean;
  /** called whenever `getState()`/`getProgressText()`/`getRemoteCount()`
   *  change — re-render the header action. */
  onStateChange: () => void;
}

export interface SnatchControllerHandle {
  getState(): SnatchState;
  getProgressText(): string;
  /** how many of this widget's own blobs are known-remote (not local yet)
   *  — drives the header action's visibility/label (the "small visual UI
   *  cue" that there's something to snatch). */
  getRemoteCount(): number;
  /** one-time full-clip-list locality scan — call once at mount to catch
   *  up on blobs that existed before this peer opened the canvas. */
  checkAllLocality(): Promise<void>;
  /** react to an ephemeral "new blob" ping from another peer (see
   *  `AnimaniacNewBlobMessage`) — cheap, targeted, no full-doc rescan; also
   *  best-effort auto-fetches it right away rather than waiting for a
   *  manual "snatch all" click. */
  onPeerAddedBlob(blob: SnatchBlobInfo): void;
  /** whether this specific blobId is currently known-remote (not local) —
   *  drives a per-clip "backing media not local yet" UI cue (a dashed
   *  border, see track-item-render.ts's own `remote` option). false for
   *  any blobId this controller hasn't seen/checked at all yet. */
  isBlobRemote(blobId: string): boolean;
  /** 0..1 live download progress for this blobId, or 0 if it isn't
   *  currently being fetched — drives the "fills up as it downloads"
   *  progress cue layered on top of a remote clip's dashed border. */
  getBlobProgress(blobId: string): number;
  handleSnatchAll(): Promise<void>;
  cancelSnatch(): void;
  destroy(): void;
}

/** how often to retry snatching whatever's still remote, once auto-snatch
 *  is enabled for this widget — covers a peer that was offline/unreachable
 *  on the first attempt (or the ephemeral ping simply never arrived)
 *  without needing another manual click. */
const AUTO_SNATCH_RETRY_MS = 20_000;

/** a handful of delayed re-scans after the very first `checkAllLocality()`
 *  call (mount time) — the doc a widget first mounts against may still be
 *  mid-sync (a peer just joined the canvas and the full clips[] history
 *  hasn't arrived over the wire yet), so a locality scan taken at the
 *  exact instant of mount can under-count "0 remote" and then never
 *  reconsider once the rest of the doc catches up (this controller
 *  deliberately doesn't re-scan on every doc change — see the module doc
 *  comment). bounded (not indefinite) so it doesn't turn into the exact
 *  "rescan on every change" cost this design otherwise avoids. */
const CATCHUP_RESCAN_DELAYS_MS = [2_000, 6_000, 15_000];

export function createSnatchController(options: SnatchControllerOptions): SnatchControllerHandle {
  const { widgetId, getDocState, changeDoc, getLocalNodeId, getPeers, isPeerOnline, isDestroyed, onStateChange } = options;
  log.debug("animaniac.snatch", "[ANIMANIAC-DBG] createSnatchController:", widgetId, "autoSnatchEnabled=", loadAutoSnatchEnabled(widgetId));

  let state: SnatchState = "idle";
  let progressText = "";
  let abort: AbortController | null = null;
  let cancelled = false;
  let autoSnatchEnabled = loadAutoSnatchEnabled(widgetId);
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let catchupScansScheduled = false;
  const catchupTimers: ReturnType<typeof setTimeout>[] = [];

  // blobId -> known-remote (not local) — the working set "snatch all"
  // acts on. populated by checkAllLocality() (mount-time catch-up) and
  // onPeerAddedBlob() (real-time ephemeral pings); a blobId is removed
  // once confirmed local.
  const remoteBlobs = new Map<string, SnatchBlobInfo>();
  // blobId -> 0..1 live download progress, only while actively fetching
  // (see snatchOne()/handleSnatchAll()'s own onProgress wiring below).
  // monotonic (never allowed to decrease for the same blobId) — a
  // transfer that stalls/retries against a slow or flaky peer must not
  // visibly flash the progress fill backwards ("strobing").
  const blobProgress = new Map<string, number>();

  function bumpProgress(blobId: string, fraction: number): void {
    if (fraction < 0) return;
    const prev = blobProgress.get(blobId) ?? 0;
    if (fraction > prev) blobProgress.set(blobId, fraction);
  }

  /** records that this peer now has `blobId` locally by writing its own
   *  node id into the OWNING clip's `snatchedBy` list \u2014 lets any other
   *  peer (or the hub, via tumulus/src/snatch.rs's own per-clip mirror of
   *  this) discover this peer as a source without a live ephemeral ping.
   *  a no-op if no identity exists yet, or no clip currently carries this
   *  blobId (e.g. it was deleted mid-download). checks the OWNING clip's
   *  primary blob field first, then its gain rendition field — `blobId`
   *  unambiguously identifies which one, since they're always different
   *  blobs (see `clipGainRenditionBlobInfo()`). */
  function markClipSnatched(blobId: string): void {
    const localNodeId = getLocalNodeId();
    if (!localNodeId) return;
    changeDoc((d) => {
      const clip = d.clips.find((c) => clipBlobInfo(c)?.blobId === blobId);
      if (clip && "snatchedBy" in clip) {
        if (!clip.snatchedBy.includes(localNodeId)) clip.snatchedBy.push(localNodeId);
        return;
      }
      const renditionClip = d.clips.find((c) => clipGainRenditionBlobInfo(c)?.blobId === blobId);
      if (!renditionClip || !("gainRenditionSnatchedBy" in renditionClip)) return;
      if (!renditionClip.gainRenditionSnatchedBy.includes(localNodeId)) {
        renditionClip.gainRenditionSnatchedBy.push(localNodeId);
      }
    });
  }

  /** derives `state` from `remoteBlobs.size` alone — callers are
   *  responsible for calling this only once THEIR OWN "checking"/
   *  "snatching" operation has actually finished (previously this had a
   *  guard that bailed out whenever `state` was already "checking"/
   *  "snatching" — but those are EXACTLY the states checkAllLocality()/
   *  handleSnatchAll() themselves set before doing their work, so the
   *  guard saw its own caller's in-progress state and refused to ever
   *  finalize it, permanently wedging `state` and silently no-oping
   *  every future "snatch all" click). */
  function recomputeState(): void {
    state = remoteBlobs.size > 0 ? "remote" : "local";
  }

  function ensureRetryTimer(): void {
    if (retryTimer || !autoSnatchEnabled) return;
    retryTimer = setInterval(() => {
      if (isDestroyed() || remoteBlobs.size === 0) return;
      log.debug("animaniac.snatch", "[ANIMANIAC-DBG] auto-snatch retry tick:", remoteBlobs.size, "still remote");
      void handleSnatchAll();
    }, AUTO_SNATCH_RETRY_MS);
  }

  function scheduleCatchupRescans(): void {
    if (catchupScansScheduled) return;
    catchupScansScheduled = true;
    for (const delay of CATCHUP_RESCAN_DELAYS_MS) {
      catchupTimers.push(
        setTimeout(() => {
          if (isDestroyed()) return;
          log.debug("animaniac.snatch", "[ANIMANIAC-DBG] catch-up rescan (doc may have still been syncing at mount)");
          void checkAllLocality();
        }, delay)
      );
    }
  }

  async function checkAllLocality(): Promise<void> {
    if (isDestroyed()) return;
    log.debug("animaniac.snatch", "[ANIMANIAC-DBG] checkAllLocality: starting");
    state = "checking";
    onStateChange();
    try {
      const blobs = buildSnatchAllBlobs(getDocState());
      const results = await Promise.all(
        blobs.map(async (b) => ({ b, info: await checkBlobLocality(b.blobId, b.blake3 || undefined).catch(() => ({ locality: "unknown" as const })) }))
      );
      if (isDestroyed()) return;
      remoteBlobs.clear();
      for (const { b, info } of results) {
        if (info.locality !== "local") remoteBlobs.set(b.blobId, b);
      }
      log.debug(
        "animaniac.snatch",
        "[ANIMANIAC-DBG] checkAllLocality:",
        `${blobs.length} known, ${remoteBlobs.size} remote, autoSnatchEnabled=${autoSnatchEnabled}`,
        blobs.map((b) => ({ blobId: b.blobId.slice(0, 12), domain: b.domain }))
      );
    } catch (err) {
      // a single stuck/thrown locality check must not leave `state`
      // wedged at "checking" forever — that would silently no-op every
      // future "snatch all" click (its own guard bails out before
      // logging anything at all), with zero visible feedback.
      log.warn("animaniac.snatch", "[ANIMANIAC-DBG] checkAllLocality threw:", err);
    }
    recomputeState();
    onStateChange();
    // already opted in from a previous session (this peer has done a
    // manual/automatic snatch for this widget before) — don't wait for
    // another manual click, just quietly catch up right away.
    if (autoSnatchEnabled && remoteBlobs.size > 0) void handleSnatchAll();
    ensureRetryTimer();
    scheduleCatchupRescans();
  }

  async function snatchOne(blob: SnatchBlobInfo): Promise<void> {
    const allPeers = getPeers();
    const peerCount = allPeers ? Object.keys(allPeers).length : 0;
    log.debug("animaniac.snatch", "[ANIMANIAC-DBG] snatchOne:", blob.blobId.slice(0, 12), blob.domain, `${peerCount} peer(s) known`);
    if (!allPeers || peerCount === 0) return;
    try {
      const [result] = await snatchBlobBatch([blob], allPeers, {
        isPeerOnline,
        onProgress: (_completed, _total, fraction) => {
          if (isDestroyed()) return;
          bumpProgress(blob.blobId, fraction);
          onStateChange();
        },
      });
      if (isDestroyed()) return;
      log.debug("animaniac.snatch", "[ANIMANIAC-DBG] snatchOne result:", blob.blobId.slice(0, 12), result ? "ok" : "failed/not found");
      blobProgress.delete(blob.blobId);
      if (result !== null) {
        remoteBlobs.delete(blob.blobId);
        markClipSnatched(blob.blobId);
      }
      recomputeState();
      onStateChange();
    } catch (err) {
      log.warn("animaniac.snatch", "[ANIMANIAC-DBG] snatchOne threw:", blob.blobId.slice(0, 12), err);
      blobProgress.delete(blob.blobId);
      // stays in remoteBlobs — a manual "snatch all" or a later ping/retry can retry.
    }
  }

  function onPeerAddedBlob(blob: SnatchBlobInfo): void {
    if (isDestroyed() || !blob.blobId) return;
    remoteBlobs.set(blob.blobId, blob);
    recomputeState();
    onStateChange();
    // a ping is already an explicit, targeted signal (not a wide reactive
    // rescan) — cheap enough to just fetch it immediately rather than
    // waiting for a manual click.
    void snatchOne(blob);
  }

  async function handleSnatchAll(): Promise<void> {
    log.debug("animaniac.snatch", "[ANIMANIAC-DBG] handleSnatchAll: clicked, state=", state);
    if (state === "snatching" || state === "checking") {
      log.debug("animaniac.snatch", "[ANIMANIAC-DBG] handleSnatchAll: bailing early, already", state);
      return;
    }
    const allPeers = getPeers();
    const peerCount = allPeers ? Object.keys(allPeers).length : 0;
    const blobs = [...remoteBlobs.values()];
    log.debug(
      "animaniac.snatch",
      "[ANIMANIAC-DBG] handleSnatchAll:",
      blobs.length,
      "remote,",
      peerCount,
      "peer(s) known:",
      allPeers ? Object.values(allPeers).map((p) => p.nodeId.slice(0, 16)) : [],
      "blobs:",
      blobs.map((b) => ({ blobId: b.blobId.slice(0, 12), domain: b.domain }))
    );
    if (!allPeers || peerCount === 0 || blobs.length === 0) return;

    cancelled = false;
    abort = new AbortController();
    state = "snatching";
    progressText = blobs.length > 1 ? `probing… (0/${blobs.length})` : "probing…";
    onStateChange();

    try {
      const results = await snatchBlobBatch(blobs, allPeers, {
        onProgress: (completed, total, fraction, currentIndex) => {
          if (cancelled || isDestroyed()) return;
          const blobId = blobs[currentIndex]?.blobId;
          if (blobId) bumpProgress(blobId, fraction);
          const pct = fraction >= 0 ? ` ${Math.round(fraction * 100)}%` : "";
          progressText = total > 1 ? `snatching (${completed}/${total})${pct}` : `snatching…${pct}`;
          onStateChange();
        },
        onBlobComplete: (index) => {
          // clear per-blob as soon as ITS OWN transfer finishes, rather
          // than waiting for the whole batch — otherwise an already-
          // finished blob sits at 100% progress but still shows the
          // dashed "remote" border until every other blob in the batch
          // also finishes. deliberately does NOT call recomputeState()
          // here — the overall `state` must stay "snatching" until the
          // WHOLE batch finishes below, not just this one blob.
          const b = blobs[index];
          if (!b) return;
          blobProgress.delete(b.blobId);
          remoteBlobs.delete(b.blobId);
          onStateChange();
        },
        signal: abort?.signal,
        isPeerOnline,
      });
      if (cancelled || isDestroyed()) return;
      let successCount = 0;
      blobs.forEach((b, i) => {
        blobProgress.delete(b.blobId);
        if (results[i] !== null) {
          remoteBlobs.delete(b.blobId);
          markClipSnatched(b.blobId);
          successCount++;
        }
      });
      log.debug("animaniac.snatch", "[ANIMANIAC-DBG] handleSnatchAll done:", `${successCount}/${blobs.length} succeeded`);
      progressText = "";
      recomputeState();
      onStateChange();
      if (successCount > 0 && !autoSnatchEnabled) {
        autoSnatchEnabled = true;
        saveAutoSnatchEnabled(widgetId);
        ensureRetryTimer();
      }
    } catch (err) {
      if (cancelled || isDestroyed()) return;
      console.error("animaniac widget: snatch all failed:", err);
      blobs.forEach((b) => blobProgress.delete(b.blobId));
      progressText = "";
      recomputeState();
      onStateChange();
    } finally {
      abort = null;
    }
  }

  function cancelSnatch(): void {
    cancelled = true;
    abort?.abort();
  }

  return {
    getState: () => state,
    getProgressText: () => progressText,
    getRemoteCount: () => remoteBlobs.size,
    checkAllLocality,
    onPeerAddedBlob,
    isBlobRemote: (blobId) => remoteBlobs.has(blobId),
    getBlobProgress: (blobId) => blobProgress.get(blobId) ?? 0,
    handleSnatchAll,
    cancelSnatch,
    destroy() {
      cancelled = true;
      abort?.abort();
      if (retryTimer) clearInterval(retryTimer);
      for (const t of catchupTimers) clearTimeout(t);
    },
  };
}
