// bin media controller — manages audio/video/photo playback for compact cards in bins.
//
// when a file widget with domain "audio", "video", or "photo" is rendered as a
// compact card inside a bin, this controller handles:
//   - a play/pause icon overlay on the card thumbnail (audio/video)
//   - an expand/preview icon overlay on the card thumbnail (photo/image)
//   - hover behavior to show/hide the overlay
//   - tap-to-play/pause via the audioManager (audio) or DOM <video> (video)
//   - double-tap to enter fullscreen (video)
//   - tap to open fullscreen photo preview (photo/image)
//
// the controller is created per-bin and manages all media cards within that bin.

import { Container, Graphics } from "pixi.js";
import { audioManager, getMediaPlaybackUrl } from "../../src/media";
import { getFullBlobDataUrl } from "../../src/file-utils/blob-io";
import { createMediaOverlay as createFullscreenOverlay } from "../../src/widgets/media-overlay";
import { createMediaDomOverlay } from "../../src/widgets/media-dom-overlay";
import { drawSaveIcon, drawRevealIcon } from "../../src/widgets/icons";
import { isTauriMode } from "../../src/p2p/tauri-transport";
import { performSaveOrReveal } from "./bin-save-actions";
import type { BinPreviewContext, BinPreviewHandle } from "../../src/widgets/widget-types";
import { log } from "@freqhole/reliquary/utils";
import type { RenderedCard } from "./bin-types";

const TAG = "bin.media";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** check whether a CompactInfo represents a playable media type (audio/video with play/pause) */
export function isMediaDomain(domain?: string | null): boolean {
  return domain === "audio" || domain === "video";
}

/** check whether a domain is previewable (photo/image — gets an expand icon) */
export function isPhotoDomain(domain?: string | null): boolean {
  return domain === "photo";
}

/** check whether a domain is handled by the media controller (audio/video/photo) */
export function isInteractiveDomain(domain?: string | null): boolean {
  return domain === "audio" || domain === "video" || domain === "photo";
}

/**
 * height (in the overlay's local coordinate space) reserved at the bottom
 * of the overlay for the control bar (play/pause, fullscreen, save, stop).
 * a real DOM `<video>` element renders on top of the entire pixi canvas,
 * so tracked video playback must stop short of this strip (see
 * handleVideoTap/ensurePreviewHandle) or its controls become invisible.
 */
export function computeControlRowHeight(overlayW: number, overlayH: number): number {
  return Math.max(16, Math.min(26, overlayH * 0.32, overlayW * 0.32));
}

// ---------------------------------------------------------------------------
// overlay creation
// ---------------------------------------------------------------------------

/** parts of a media overlay — stored so we can toggle play/pause icon */
export interface MediaOverlayParts {
  overlay: Container;
  playIcon: Graphics;
  pauseIcon: Graphics;
}

/**
 * create a media overlay container with play and pause icons.
 * the overlay is hidden by default and has eventMode "none" so it
 * doesn't consume pointer events (the card handles those).
 */
export function createMediaOverlay(w: number, h: number, rounded = true): MediaOverlayParts {
  const overlay = new Container();
  overlay.label = "media-overlay";
  overlay.visible = false;
  overlay.eventMode = "none";
  overlay.zIndex = 10;

  // semi-transparent background
  const bg = new Graphics();
  if (rounded) {
    bg.roundRect(0, 0, w, h, 3).fill({ color: 0x000000, alpha: 0.5 });
  } else {
    bg.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.5 });
  }
  overlay.addChild(bg);

  const iconSize = Math.max(12, Math.min(w, h) * 0.35);
  const cx = w / 2;
  const cy = h / 2;

  // play icon — triangle pointing right
  const playIcon = new Graphics();
  const triH = iconSize;
  const triW = iconSize * 0.866;
  playIcon.poly([
    { x: cx - triW / 3, y: cy - triH / 2 },
    { x: cx + (triW * 2) / 3, y: cy },
    { x: cx - triW / 3, y: cy + triH / 2 },
  ]);
  playIcon.fill({ color: 0xffffff, alpha: 0.9 });
  overlay.addChild(playIcon);

  // pause icon — two vertical bars
  const pauseIcon = new Graphics();
  const barW = iconSize * 0.2;
  const barH = iconSize * 0.7;
  const gap = iconSize * 0.15;
  pauseIcon.rect(cx - gap - barW, cy - barH / 2, barW, barH);
  pauseIcon.fill({ color: 0xffffff, alpha: 0.9 });
  pauseIcon.rect(cx + gap, cy - barH / 2, barW, barH);
  pauseIcon.fill({ color: 0xffffff, alpha: 0.9 });
  pauseIcon.visible = false;
  overlay.addChild(pauseIcon);

  return { overlay, playIcon, pauseIcon };
}

/** parts of a preview overlay — just the expand icon, no play/pause */
export interface PreviewOverlayParts {
  overlay: Container;
}

/**
 * create a preview overlay with an expand/arrow icon for photo/image cards.
 * shown on hover to indicate the card is tappable for fullscreen preview.
 */
export function createPreviewOverlay(w: number, h: number, rounded = true): PreviewOverlayParts {
  const overlay = new Container();
  overlay.label = "preview-overlay";
  overlay.visible = false;
  overlay.eventMode = "none";
  overlay.zIndex = 10;

  // semi-transparent background
  const bg = new Graphics();
  if (rounded) {
    bg.roundRect(0, 0, w, h, 3).fill({ color: 0x000000, alpha: 0.4 });
  } else {
    bg.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.4 });
  }
  overlay.addChild(bg);

  const iconSize = Math.max(10, Math.min(w, h) * 0.3);
  const cx = w / 2;
  const cy = h / 2;

  // expand icon — diagonal arrow pointing upper-right with a small box corner
  const icon = new Graphics();
  const half = iconSize / 2;
  const strokeW = Math.max(1.5, iconSize * 0.12);

  // arrow shaft: from lower-left to upper-right
  icon.moveTo(cx - half, cy + half);
  icon.lineTo(cx + half, cy - half);
  icon.stroke({ width: strokeW, color: 0xffffff, alpha: 0.9 });

  // arrowhead lines at upper-right
  const headLen = half * 0.5;
  icon.moveTo(cx + half - headLen, cy - half);
  icon.lineTo(cx + half, cy - half);
  icon.lineTo(cx + half, cy - half + headLen);
  icon.stroke({ width: strokeW, color: 0xffffff, alpha: 0.9 });

  // small corner bracket at lower-left to suggest "from box"
  const cornerLen = half * 0.35;
  icon.moveTo(cx - half + cornerLen, cy + half);
  icon.lineTo(cx - half, cy + half);
  icon.lineTo(cx - half, cy + half - cornerLen);
  icon.stroke({ width: strokeW, color: 0xffffff, alpha: 0.7 });

  overlay.addChild(icon);

  return { overlay };
}

/** show the play icon and hide pause */
export function showPlayIcon(parts: MediaOverlayParts): void {
  parts.playIcon.visible = true;
  parts.pauseIcon.visible = false;
}

/** show the pause icon and hide play */
export function showPauseIcon(parts: MediaOverlayParts): void {
  parts.playIcon.visible = false;
  parts.pauseIcon.visible = true;
}

// ---------------------------------------------------------------------------
// video tracker — positions a DOM <video> over a PixiJS card
// ---------------------------------------------------------------------------

interface VideoTracker {
  video: HTMLVideoElement;
  wrapper: HTMLDivElement;
  widgetId: string;
  rafId: number;
  close: () => void;
}

function createVideoTracker(
  src: string,
  mime: string | undefined,
  card: RenderedCard,
  canvasElement: HTMLCanvasElement,
  /** width/height of the thumbnail area in local coords */
  thumbW: number,
  thumbH: number
): VideoTracker {
  // delegates to the shared, generalized DOM-video-tracking helper (see
  // loam/src/widgets/media-dom-overlay.ts) — this thin wrapper just keeps
  // this file's existing external shape (VideoTracker with widgetId/rafId)
  // unchanged for its callers below.
  const overlay = createMediaDomOverlay({
    src,
    mime,
    container: card.container,
    canvasElement,
    getSize: () => ({ width: thumbW, height: thumbH }),
    muted: false,
    loop: true,
    controls: false,
    objectFit: "cover",
  });

  return { video: overlay.video, wrapper: overlay.wrapper, widgetId: card.widgetId, rafId: 0, close: overlay.close };
}

// ---------------------------------------------------------------------------
// BinMediaController
// ---------------------------------------------------------------------------

export class BinMediaController {
  private canvasElement: HTMLCanvasElement;
  private getCard: (widgetId: string) => RenderedCard | undefined;
  private getPeers: () => Record<string, { nodeId: string }> | undefined;

  /** the widget currently playing audio */
  private audioPlayingId: string | null = null;
  /** the widget currently playing video */
  private videoTracker: VideoTracker | null = null;

  /** active fullscreen photo overlay (if any) */
  private activePhotoOverlay: import("../../src/widgets/media-overlay").MediaOverlayHandle | null =
    null;

  /** set of widget IDs that have hover listeners attached */
  private attachedCards = new Set<string>();
  /** stored overlay parts per widget ID (for icon toggling) */
  private overlayParts = new Map<string, MediaOverlayParts>();

  /** cached bin-preview handles for widgets implementing getBinPreview()
   *  (see widget-types.ts) — built lazily on first tap, one per card. */
  private previewHandles = new Map<string, BinPreviewHandle>();
  /** widget IDs whose preview media is currently mounted (built, playing or
   *  paused) — used by isMediaMounted() below. */
  private previewMounted = new Set<string>();
  /** the control bar (play/pause, fullscreen, save, stop) for each
   *  audio/video card — shown whenever that card's media is mounted
   *  (playing or paused), regardless of whether it's a preview-hook card
   *  or the generic audioManager/DOM-video path. sits in a reserved strip
   *  at the bottom of the overlay so it's never covered by the DOM
   *  <video> element rendered on top of the pixi canvas. */
  private controlBars = new Map<string, Container>();
  /** the play/pause icon graphics inside each card's control bar, kept
   *  alongside overlayParts so setCardIcon() can toggle both together. */
  private controlBarIcons = new Map<string, { playIcon: Graphics; pauseIcon: Graphics }>();

  /** unsub functions for audioManager events */
  private unsubs: Array<() => void> = [];

  /** double-tap detection */
  private lastTapTime = 0;
  private lastTapWidgetId = "";
  private readonly DOUBLE_TAP_MS = 400;

  private destroyed = false;

  constructor(opts: {
    canvasElement: HTMLCanvasElement;
    getCard: (widgetId: string) => RenderedCard | undefined;
    getPeers: () => Record<string, { nodeId: string }> | undefined;
  }) {
    this.canvasElement = opts.canvasElement;
    this.getCard = opts.getCard;
    this.getPeers = opts.getPeers;

    // subscribe to audioManager events
    this.unsubs.push(
      audioManager.on("ended", () => this.onAudioEnded()),
      audioManager.on("stop", () => this.onAudioStopped()),
      audioManager.on("play", () => this.onAudioPlay()),
      audioManager.on("pause", () => this.onAudioPause()),
      audioManager.on("loading", (data) => this.onAudioLoading(data.blobId)),
      audioManager.on("error", (data) => {
        log.warn("bin-media", `audio playback failed: code=${data.code} message=${data.message}`);
      })
    );
  }

  // -----------------------------------------------------------------------
  // public API — called by the bin renderer/index
  // -----------------------------------------------------------------------

  /**
   * attach media overlay + hover behavior to a card.
   * called after a card is built or rebuilt.
   * safe to call for non-media and non-photo cards (returns immediately).
   */
  attachToCard(card: RenderedCard): void {
    if (this.destroyed) return;

    const domain = card.mediaDomain;
    const isAudioVideo = isMediaDomain(domain);
    const isPhoto = isPhotoDomain(domain);

    if (!isAudioVideo && !isPhoto) return;

    // remove any previous attachment for this widget
    this.detachFromCard(card.widgetId);

    const overlay = card.mediaOverlay;
    if (!overlay) return;

    if (isAudioVideo) {
      // audio/video: find play/pause icon parts for state toggling
      const parts = this.findOverlayParts(overlay);
      if (!parts) return;

      this.overlayParts.set(card.widgetId, parts);

      // set initial icon state — if this card's audio is currently playing,
      // show the pause icon and keep the overlay visible
      const isPlayingAudio =
        card.mediaDomain === "audio" &&
        this.audioPlayingId === card.widgetId &&
        audioManager.isPlaying;

      const isPlayingVideo =
        card.mediaDomain === "video" && this.videoTracker?.widgetId === card.widgetId;

      const playing = isPlayingAudio || isPlayingVideo;
      overlay.visible = playing;

      const controlBar = this.buildControlBar(overlay, card);
      if (controlBar) {
        this.controlBars.set(card.widgetId, controlBar);
        controlBar.visible = this.isMediaMounted(card.widgetId, card);
      }
      this.setCardIcon(card.widgetId, playing ? "pause" : "play");
    } else {
      // photo: overlay is just the expand icon, no play/pause state
      overlay.visible = false;
    }

    // hover handlers — show overlay on enter, hide on leave
    const onEnter = (): void => {
      if (card.container.destroyed) return;
      overlay.visible = true;
      // the card-builder's own pointerenter (attached before this one, when
      // the card was built) unconditionally reveals the hover "save" action
      // button — override that back off if this card's media is mounted,
      // since the control bar already occupies that same bottom strip.
      if (isAudioVideo && card.actionButtons && this.isMediaMounted(card.widgetId, card)) {
        card.actionButtons.visible = false;
      }
    };

    const onLeave = (): void => {
      if (card.container.destroyed) return;
      if (isPhoto) {
        // photo overlays always hide on leave (no "playing" state)
        overlay.visible = false;
        return;
      }
      // audio/video: keep visible if currently playing
      const playing =
        (card.mediaDomain === "audio" &&
          this.audioPlayingId === card.widgetId &&
          audioManager.isPlaying) ||
        (card.mediaDomain === "video" && this.videoTracker?.widgetId === card.widgetId);
      if (!playing) {
        overlay.visible = false;
      }
    };

    card.container.on("pointerenter", onEnter);
    card.container.on("pointerleave", onLeave);

    this.attachedCards.add(card.widgetId);
  }

  /**
   * clean up media state for a removed card.
   * stops playback if this card was playing.
   */
  detachFromCard(widgetId: string): void {
    this.overlayParts.delete(widgetId);
    this.attachedCards.delete(widgetId);

    const controlBar = this.controlBars.get(widgetId);
    if (controlBar) {
      controlBar.destroy();
      this.controlBars.delete(widgetId);
    }
    this.controlBarIcons.delete(widgetId);
    const previewHandle = this.previewHandles.get(widgetId);
    if (previewHandle) {
      previewHandle.destroy();
      this.previewHandles.delete(widgetId);
      this.previewMounted.delete(widgetId);
    }

    // stop audio if this card was playing
    if (this.audioPlayingId === widgetId) {
      audioManager.stop();
      this.audioPlayingId = null;
    }

    // stop video if this card was playing
    if (this.videoTracker?.widgetId === widgetId) {
      this.videoTracker.close();
      this.videoTracker = null;
    }
  }

  /**
   * handle a tap on a card.
   * returns true if this was a media card and the tap was handled.
   */
  handleTap(widgetId: string): boolean {
    const card = this.getCard(widgetId);
    if (!card || !card.mediaDomain || !isInteractiveDomain(card.mediaDomain)) {
      return false;
    }

    // double-tap detection
    const now = Date.now();
    const isDoubleTap =
      this.lastTapWidgetId === widgetId && now - this.lastTapTime < this.DOUBLE_TAP_MS;
    this.lastTapTime = now;
    this.lastTapWidgetId = widgetId;

    if (card.mediaDomain === "photo") {
      this.handlePhotoTap(card);
      return true;
    }

    if (isDoubleTap) {
      this.handleFullscreenTap(widgetId);
      return true;
    }

    this.handlePlayPauseTap(widgetId);

    return true;
  }

  // -----------------------------------------------------------------------
  // photo handling
  // -----------------------------------------------------------------------

  /**
   * open a fullscreen photo preview for a compact card.
   * resolves the blob to a data URL (file widget) or uses the thumbnailUrl
   * directly (image widget) and opens the DOM media overlay.
   */
  private async handlePhotoTap(card: RenderedCard): Promise<void> {
    const blobId = card.mediaBlobId;

    let src: string | null = null;

    if (blobId) {
      // file widget with a blob — resolve via getFullBlobDataUrl
      try {
        const peers = this.getPeers();
        src = await getFullBlobDataUrl(blobId, peers as any);
      } catch (err) {
        log.warn(TAG, "failed to resolve photo blob:", err);
      }

      if (!src) {
        // fallback: try getMediaPlaybackUrl which handles tauri asset:// etc.
        src = await getMediaPlaybackUrl(blobId, {
          category: "video", // use video slot to avoid revoking any playing audio
          peers: this.getPeers(),
          mime: card.mediaMime ?? undefined,
        });
      }
    }

    if (!src && card.thumbnailUrl) {
      // image widget (or file widget with embedded thumbnail) — use the
      // thumbnail URL directly as the preview source
      src = card.thumbnailUrl;
    }

    if (!src) {
      log.warn(TAG, "could not resolve photo for preview");
      return;
    }

    // close any existing photo overlay before opening a new one
    if (this.activePhotoOverlay && !this.activePhotoOverlay.closed) {
      this.activePhotoOverlay.close();
    }

    this.activePhotoOverlay = createFullscreenOverlay({
      type: "photo",
      src,
      filename: card.mediaLabel ?? undefined,
      mime: card.mediaMime ?? undefined,
      onClose: () => {
        this.activePhotoOverlay = null;
      },
    });
  }

  /** tear down everything */
  destroy(): void {
    this.destroyed = true;

    // unsub from audioManager events
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs.length = 0;

    // stop any active playback
    if (this.audioPlayingId) {
      // only stop if we own the current playback
      if (audioManager.isCurrentBlob(this.audioPlayingId)) {
        audioManager.stop();
      }
      this.audioPlayingId = null;
    }

    if (this.videoTracker) {
      this.videoTracker.close();
      this.videoTracker = null;
    }

    if (this.activePhotoOverlay && !this.activePhotoOverlay.closed) {
      this.activePhotoOverlay.close();
    }
    this.activePhotoOverlay = null;

    for (const handle of this.previewHandles.values()) {
      handle.destroy();
    }
    this.previewHandles.clear();
    this.previewMounted.clear();
    for (const bar of this.controlBars.values()) {
      bar.destroy();
    }
    this.controlBars.clear();
    this.controlBarIcons.clear();

    this.overlayParts.clear();
    this.attachedCards.clear();
  }

  // -----------------------------------------------------------------------
  // audio handling
  // -----------------------------------------------------------------------

  private async handleAudioTap(widgetId: string, card: RenderedCard): Promise<void> {
    const blobId = card.mediaBlobId;
    if (!blobId) return;

    // if this card is already playing, toggle pause
    if (this.audioPlayingId === widgetId && audioManager.isCurrentBlob(blobId)) {
      await audioManager.togglePlayPause();
      return;
    }

    // stop any preview-hook cards that might be playing
    this.stopAllPreviewPlayback();

    // stop any video that might be playing
    if (this.videoTracker) {
      const prevVideoId = this.videoTracker.widgetId;
      this.videoTracker.close();
      this.videoTracker = null;
      this.setCardIcon(prevVideoId, "play");
      this.setOverlayVisible(prevVideoId, false);
      this.setControlBarVisible(prevVideoId, false);
    }

    // stop any existing audio first — this ensures the global audioManager
    // emits a clean stop event so other BinMediaControllers can clear their
    // state before we start our new track
    if (audioManager.isPlaying || audioManager.currentBlob) {
      audioManager.stop();
    }

    // clear previous audio card's icon
    const prevId = this.audioPlayingId;
    this.audioPlayingId = widgetId;

    if (prevId && prevId !== widgetId) {
      this.setCardIcon(prevId, "play");
      this.setOverlayVisible(prevId, false);
      this.setControlBarVisible(prevId, false);
    }

    // show loading state (pause icon = "active")
    this.setCardIcon(widgetId, "pause");
    this.setOverlayVisible(widgetId, true);
    this.setControlBarVisible(widgetId, true);

    const peers = this.getPeers();
    const ok = await audioManager.playBlob(blobId, {
      category: "audio",
      peers,
      mime: card.mediaMime ?? undefined,
    });

    if (!ok) {
      log.warn(TAG, "failed to play audio for card:", widgetId);
      this.audioPlayingId = null;
      this.setCardIcon(widgetId, "play");
      this.setControlBarVisible(widgetId, false);
    }
  }

  private onAudioPlay(): void {
    if (!this.audioPlayingId) return;

    // check if another controller started playback for a different blob —
    // audioManager is global, so the play event may not be for our blob
    const card = this.getCard(this.audioPlayingId);
    const ourBlobId = card?.mediaBlobId;
    if (ourBlobId && !audioManager.isCurrentBlob(ourBlobId)) {
      // another controller (or external caller) took over — clear our state
      this.setCardIcon(this.audioPlayingId, "play");
      this.setOverlayVisible(this.audioPlayingId, false);
      this.setControlBarVisible(this.audioPlayingId, false);
      this.audioPlayingId = null;
      return;
    }

    this.setCardIcon(this.audioPlayingId, "pause");
    this.setOverlayVisible(this.audioPlayingId, true);
    this.setControlBarVisible(this.audioPlayingId, true);
  }

  private onAudioPause(): void {
    if (!this.audioPlayingId) return;

    // if the pause is for a different blob, another controller has taken over
    const card = this.getCard(this.audioPlayingId);
    const ourBlobId = card?.mediaBlobId;
    if (ourBlobId && !audioManager.isCurrentBlob(ourBlobId)) {
      this.setCardIcon(this.audioPlayingId, "play");
      this.setOverlayVisible(this.audioPlayingId, false);
      this.setControlBarVisible(this.audioPlayingId, false);
      this.audioPlayingId = null;
      return;
    }

    this.setCardIcon(this.audioPlayingId, "play");
    // keep overlay visible so the user can tap to resume
    this.setOverlayVisible(this.audioPlayingId, true);
  }

  private onAudioEnded(): void {
    if (this.audioPlayingId) {
      this.setCardIcon(this.audioPlayingId, "play");
      this.setOverlayVisible(this.audioPlayingId, false);
      this.setControlBarVisible(this.audioPlayingId, false);
      this.audioPlayingId = null;
    }
  }

  private onAudioStopped(): void {
    if (this.audioPlayingId) {
      this.setCardIcon(this.audioPlayingId, "play");
      this.setOverlayVisible(this.audioPlayingId, false);
      this.setControlBarVisible(this.audioPlayingId, false);
      this.audioPlayingId = null;
    }
  }

  /**
   * called when the audioManager starts loading a new blob.
   * if the blobId doesn't match any card we're tracking, another controller
   * (or external caller) has taken over playback — clear our state.
   */
  private onAudioLoading(blobId: string): void {
    if (!this.audioPlayingId) return;

    const card = this.getCard(this.audioPlayingId);
    const ourBlobId = card?.mediaBlobId;

    // if the loading blob is not ours, another controller took over
    if (ourBlobId && blobId !== ourBlobId) {
      this.setCardIcon(this.audioPlayingId, "play");
      this.setOverlayVisible(this.audioPlayingId, false);
      this.setControlBarVisible(this.audioPlayingId, false);
      this.audioPlayingId = null;
    }
  }

  // -----------------------------------------------------------------------
  // video handling
  // -----------------------------------------------------------------------

  private async handleVideoTap(widgetId: string, card: RenderedCard): Promise<void> {
    const blobId = card.mediaBlobId;
    if (!blobId) return;

    // if this card is already playing video, toggle pause
    if (this.videoTracker?.widgetId === widgetId) {
      const video = this.videoTracker.video;
      if (video.paused) {
        try {
          await video.play();
        } catch {
          /* ignore */
        }
        this.setCardIcon(widgetId, "pause");
      } else {
        video.pause();
        this.setCardIcon(widgetId, "play");
        this.setOverlayVisible(widgetId, true);
      }
      return;
    }

    // stop any previous video
    if (this.videoTracker) {
      const prevId = this.videoTracker.widgetId;
      this.videoTracker.close();
      this.videoTracker = null;
      this.setCardIcon(prevId, "play");
      this.setOverlayVisible(prevId, false);
      this.setControlBarVisible(prevId, false);
    }

    // stop any preview-hook cards that might be playing
    this.stopAllPreviewPlayback();

    // stop any audio
    if (this.audioPlayingId) {
      const prevId = this.audioPlayingId;
      audioManager.stop();
      this.audioPlayingId = null;
      this.setCardIcon(prevId, "play");
      this.setOverlayVisible(prevId, false);
      this.setControlBarVisible(prevId, false);
    }

    // resolve the media URL
    const peers = this.getPeers();
    const src = await getMediaPlaybackUrl(blobId, {
      category: "video",
      peers,
      mime: card.mediaMime ?? undefined,
    });

    if (!src) {
      log.warn(TAG, "failed to resolve video URL for card:", widgetId);
      return;
    }

    // determine thumbnail area dimensions based on the card's media overlay size
    // the overlay covers the thumbnail area, so use its dimensions — minus
    // the reserved control-bar strip, so the DOM <video> doesn't cover it
    const overlayBounds = card.mediaOverlay;
    const thumbW = overlayBounds ? overlayBounds.width : 100;
    const thumbH = overlayBounds ? overlayBounds.height : 100;
    const controlRowH = computeControlRowHeight(thumbW, thumbH);

    this.videoTracker = createVideoTracker(
      src,
      card.mediaMime ?? undefined,
      card,
      this.canvasElement,
      thumbW,
      thumbH - controlRowH
    );

    // start playback
    try {
      await this.videoTracker.video.play();
      this.setCardIcon(widgetId, "pause");
      // hide the pixi overlay while video is playing — the DOM video covers it
      this.setOverlayVisible(widgetId, false);
      this.setControlBarVisible(widgetId, true);
    } catch (err) {
      log.warn(TAG, "video play failed:", err);
      this.videoTracker.close();
      this.videoTracker = null;
      this.setCardIcon(widgetId, "play");
      this.setControlBarVisible(widgetId, false);
    }
  }

  private handleVideoFullscreen(): void {
    if (!this.videoTracker) return;
    const video = this.videoTracker.video;
    try {
      if (video.requestFullscreen) {
        video.requestFullscreen().catch(() => {});
      } else if ((video as any).webkitRequestFullscreen) {
        (video as any).webkitRequestFullscreen();
      }
    } catch {
      /* ignore fullscreen errors */
    }
  }

  // -----------------------------------------------------------------------
  // preview-hook handling (widgets implementing getBinPreview(), e.g. stfu)
  // -----------------------------------------------------------------------

  /** build (once) or return the cached BinPreviewHandle for a card. */
  private ensurePreviewHandle(card: RenderedCard): BinPreviewHandle | null {
    if (!card.createBinPreview) return null;
    const existing = this.previewHandles.get(card.widgetId);
    if (existing) return existing;

    const overlay = card.mediaOverlay;
    const thumbW = overlay ? overlay.width : 100;
    const thumbH = overlay ? overlay.height : 100;
    // reserve the control-bar strip so the widget's own DOM video overlay
    // (see stfu's getBinPreview()) doesn't render on top of it
    const controlRowH = computeControlRowHeight(thumbW, thumbH);
    const previewCtx: BinPreviewContext = {
      widgetId: card.widgetId,
      container: card.container,
      canvasElement: this.canvasElement,
      getSize: () => ({ width: thumbW, height: thumbH - controlRowH }),
      getPeers: () => this.getPeers(),
    };

    const handle = card.createBinPreview(previewCtx);
    if (!handle) return null;
    this.previewHandles.set(card.widgetId, handle);
    return handle;
  }

  private async handlePreviewTap(widgetId: string, card: RenderedCard): Promise<void> {
    const handle = this.ensurePreviewHandle(card);
    if (!handle) return;

    // stop any generic audio/video playback and any *other* preview-hook
    // card's playback first — only one media element plays at a time.
    if (this.videoTracker) {
      const prevId = this.videoTracker.widgetId;
      this.videoTracker.close();
      this.videoTracker = null;
      this.setCardIcon(prevId, "play");
      this.setOverlayVisible(prevId, false);
      this.setControlBarVisible(prevId, false);
    }
    if (this.audioPlayingId) {
      const prevId = this.audioPlayingId;
      audioManager.stop();
      this.audioPlayingId = null;
      this.setCardIcon(prevId, "play");
      this.setOverlayVisible(prevId, false);
      this.setControlBarVisible(prevId, false);
    }
    this.stopAllPreviewPlayback(widgetId);

    await handle.onTap();
    const playing = handle.isPlaying();
    if (playing) {
      this.previewMounted.add(widgetId);
    }
    this.setCardIcon(widgetId, playing ? "pause" : "play");
    // hide the pixi overlay while playing — the DOM video covers it, same
    // as the generic video-tracker path
    this.setOverlayVisible(widgetId, !playing);
    this.setControlBarVisible(widgetId, this.previewMounted.has(widgetId));
  }

  private handlePreviewDoubleTap(widgetId: string): void {
    this.previewHandles.get(widgetId)?.onDoubleTap();
  }

  private handlePreviewStop(widgetId: string): void {
    const handle = this.previewHandles.get(widgetId);
    if (!handle) return;
    handle.onStop();
    this.previewMounted.delete(widgetId);
    this.setCardIcon(widgetId, "play");
    this.setOverlayVisible(widgetId, false);
    this.setControlBarVisible(widgetId, false);
  }

  /** stop every mounted preview-hook card's playback, optionally excluding one. */
  private stopAllPreviewPlayback(exceptWidgetId?: string): void {
    for (const [id, handle] of this.previewHandles) {
      if (id === exceptWidgetId) continue;
      if (!this.previewMounted.has(id)) continue;
      handle.onStop();
      this.previewMounted.delete(id);
      this.setCardIcon(id, "play");
      this.setOverlayVisible(id, false);
      this.setControlBarVisible(id, false);
    }
  }

  /** true if a card's media (generic audio/video, or a preview-hook's own
   *  media) is currently mounted — playing or paused-but-loaded. drives
   *  the "stop/clear" icon's visibility. */
  private isMediaMounted(widgetId: string, card: RenderedCard): boolean {
    if (card.createBinPreview) return this.previewMounted.has(widgetId);
    if (card.mediaDomain === "video") return this.videoTracker?.widgetId === widgetId;
    if (card.mediaDomain === "audio") return this.audioPlayingId === widgetId;
    return false;
  }

  /** handle a tap on the generic "stop/clear" icon — tears down whichever
   *  playback mechanism (preview-hook or generic audio/video) is mounted
   *  for this card, reverting it to its poster/thumbnail. */
  private handleStopTap(widgetId: string): void {
    const card = this.getCard(widgetId);
    if (!card) return;

    if (card.createBinPreview) {
      this.handlePreviewStop(widgetId);
      return;
    }

    if (card.mediaDomain === "video" && this.videoTracker?.widgetId === widgetId) {
      this.videoTracker.close();
      this.videoTracker = null;
      this.setCardIcon(widgetId, "play");
      this.setOverlayVisible(widgetId, false);
      this.setControlBarVisible(widgetId, false);
      return;
    }

    if (card.mediaDomain === "audio" && this.audioPlayingId === widgetId) {
      audioManager.stop();
      this.audioPlayingId = null;
      this.setCardIcon(widgetId, "play");
      this.setOverlayVisible(widgetId, false);
      this.setControlBarVisible(widgetId, false);
    }
  }

  private setControlBarVisible(widgetId: string, visible: boolean): void {
    const bar = this.controlBars.get(widgetId);
    if (bar) bar.visible = visible;

    // the control bar docks to the same bottom strip as the generic hover
    // "save/reveal" action button — suppress that button while the bar is
    // shown so it doesn't render underneath it (see bin-card-builders.ts).
    const card = this.getCard(widgetId);
    if (card?.actionButtons && visible) {
      card.actionButtons.visible = false;
    }
  }

  /** dispatch a tap on the control bar's play/pause button — mirrors the
   *  generic card-tap dispatch in handleTap() below. */
  private handlePlayPauseTap(widgetId: string): void {
    const card = this.getCard(widgetId);
    if (!card) return;
    if (card.createBinPreview) {
      void this.handlePreviewTap(widgetId, card);
      return;
    }
    if (card.mediaDomain === "video") {
      void this.handleVideoTap(widgetId, card);
    } else if (card.mediaDomain === "audio") {
      void this.handleAudioTap(widgetId, card);
    }
  }

  /** dispatch a tap on the control bar's fullscreen button (video only). */
  private handleFullscreenTap(widgetId: string): void {
    const card = this.getCard(widgetId);
    if (!card) return;
    if (card.createBinPreview) {
      this.handlePreviewDoubleTap(widgetId);
      return;
    }
    if (card.mediaDomain === "video" && this.videoTracker?.widgetId === widgetId) {
      this.handleVideoFullscreen();
    }
  }

  /** dispatch a tap on the control bar's save button. */
  private handleSaveTap(widgetId: string): void {
    const card = this.getCard(widgetId);
    if (!card || !card.mediaBlobId) return;
    void performSaveOrReveal(
      {
        blobId: card.mediaBlobId,
        filename: card.filename,
        mime: card.mediaMime,
        blake3: card.blake3,
        size: card.fileSize,
        domain: card.mediaDomain,
        snatchedBy: card.snatchedBy,
      },
      this.getPeers
    );
  }

  /**
   * build the control bar (play/pause, fullscreen[video], save, stop) for
   * an audio/video card, docked to the bottom strip of the overlay's
   * bounds — added as a sibling of `overlay` (not a child of it, since the
   * overlay's own `eventMode` is "none" and would swallow hit testing for
   * anything nested inside it). shown whenever the card's media is mounted
   * (see isMediaMounted()), whether that's a preview-hook card or the
   * generic audioManager/DOM-video path. the reserved strip stays clear of
   * the real DOM `<video>` element (see computeControlRowHeight()), which
   * otherwise renders on top of the entire pixi canvas and would hide it.
   */
  private buildControlBar(overlay: Container, card: RenderedCard): Container | null {
    const parent = overlay.parent;
    if (!parent) return null;

    const widgetId = card.widgetId;
    const w = overlay.width;
    const h = overlay.height;
    const rowH = computeControlRowHeight(w, h);
    const iconSize = Math.max(10, rowH * 0.6);
    const cy = rowH / 2;

    const bar = new Container();
    bar.label = "media-control-bar";
    bar.zIndex = 20;
    bar.visible = false;
    bar.x = overlay.x;
    bar.y = overlay.y + h - rowH;

    const bg = new Graphics();
    bg.rect(0, 0, w, rowH).fill({ color: 0x000000, alpha: 0.55 });
    bar.addChild(bg);

    const isVideo = card.mediaDomain === "video" || Boolean(card.createBinPreview);
    const canSave = Boolean(card.mediaBlobId);
    const buttonCount = 2 + (isVideo ? 1 : 0) + (canSave ? 1 : 0);
    const slotW = Math.min(rowH, w / buttonCount);
    let x = (w - slotW * buttonCount) / 2;

    const addHitArea = (slotX: number, onTap: () => void): void => {
      const hit = new Graphics();
      hit.rect(slotX, 0, slotW, rowH).fill({ color: 0x000000, alpha: 0.001 });
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.on("pointertap", (e: any) => {
        e.stopPropagation();
        onTap();
      });
      bar.addChild(hit);
    };

    // play/pause toggle
    const cxPlay = x + slotW / 2;
    const playIcon = new Graphics();
    const triH = iconSize * 0.85;
    const triW = triH * 0.866;
    playIcon
      .poly([
        { x: cxPlay - triW / 3, y: cy - triH / 2 },
        { x: cxPlay + (triW * 2) / 3, y: cy },
        { x: cxPlay - triW / 3, y: cy + triH / 2 },
      ])
      .fill({ color: 0xffffff, alpha: 0.95 });
    bar.addChild(playIcon);

    const pauseIcon = new Graphics();
    const pBarW = iconSize * 0.2;
    const pBarH = iconSize * 0.65;
    const pGap = iconSize * 0.14;
    pauseIcon.rect(cxPlay - pGap - pBarW, cy - pBarH / 2, pBarW, pBarH).fill({ color: 0xffffff, alpha: 0.95 });
    pauseIcon.rect(cxPlay + pGap, cy - pBarH / 2, pBarW, pBarH).fill({ color: 0xffffff, alpha: 0.95 });
    pauseIcon.visible = false;
    bar.addChild(pauseIcon);
    this.controlBarIcons.set(widgetId, { playIcon, pauseIcon });
    addHitArea(x, () => this.handlePlayPauseTap(widgetId));
    x += slotW;

    // fullscreen (video only)
    if (isVideo) {
      const cxFs = x + slotW / 2;
      const half = iconSize * 0.3;
      const cornerLen = half * 0.6;
      const strokeW = Math.max(1.2, iconSize * 0.1);
      const fsIcon = new Graphics();
      fsIcon
        .moveTo(cxFs - half, cy - half + cornerLen)
        .lineTo(cxFs - half, cy - half)
        .lineTo(cxFs - half + cornerLen, cy - half);
      fsIcon
        .moveTo(cxFs + half - cornerLen, cy - half)
        .lineTo(cxFs + half, cy - half)
        .lineTo(cxFs + half, cy - half + cornerLen);
      fsIcon
        .moveTo(cxFs + half, cy + half - cornerLen)
        .lineTo(cxFs + half, cy + half)
        .lineTo(cxFs + half - cornerLen, cy + half);
      fsIcon
        .moveTo(cxFs - half + cornerLen, cy + half)
        .lineTo(cxFs - half, cy + half)
        .lineTo(cxFs - half, cy + half - cornerLen);
      fsIcon.stroke({ width: strokeW, color: 0xffffff, alpha: 0.95, cap: "round", join: "round" });
      bar.addChild(fsIcon);
      addHitArea(x, () => this.handleFullscreenTap(widgetId));
      x += slotW;
    }

    // save / reveal
    if (canSave) {
      const cxSave = x + slotW / 2;
      const saveDraw = isTauriMode() ? drawRevealIcon : drawSaveIcon;
      const saveIcon = new Graphics();
      saveDraw(saveIcon, cxSave - iconSize / 2, cy - iconSize / 2, iconSize, 0xffffff, 0.95);
      bar.addChild(saveIcon);
      addHitArea(x, () => this.handleSaveTap(widgetId));
      x += slotW;
    }

    // stop / clear
    {
      const cxStop = x + slotW / 2;
      const r = iconSize / 2;
      const stopIcon = new Graphics();
      const armLen = r * 0.5;
      stopIcon.moveTo(cxStop - armLen, cy - armLen).lineTo(cxStop + armLen, cy + armLen);
      stopIcon.moveTo(cxStop + armLen, cy - armLen).lineTo(cxStop - armLen, cy + armLen);
      stopIcon.stroke({ width: Math.max(1.5, iconSize * 0.14), color: 0xffffff, alpha: 0.95, cap: "round" });
      bar.addChild(stopIcon);
      addHitArea(x, () => this.handleStopTap(widgetId));
    }

    parent.addChild(bar);
    return bar;
  }

  // -----------------------------------------------------------------------
  // icon management
  // -----------------------------------------------------------------------

  private setCardIcon(widgetId: string, icon: "play" | "pause"): void {
    const parts = this.overlayParts.get(widgetId);
    if (parts) {
      if (icon === "play") {
        showPlayIcon(parts);
      } else {
        showPauseIcon(parts);
      }
    }

    const barIcons = this.controlBarIcons.get(widgetId);
    if (barIcons) {
      barIcons.playIcon.visible = icon === "play";
      barIcons.pauseIcon.visible = icon === "pause";
    }
  }

  private setOverlayVisible(widgetId: string, visible: boolean): void {
    const card = this.getCard(widgetId);
    if (!card?.mediaOverlay) return;
    card.mediaOverlay.visible = visible;
  }

  /**
   * find the play/pause icon graphics inside a media overlay container.
   * the overlay is built by createMediaOverlay() which adds children in order:
   * [0] bg, [1] playIcon, [2] pauseIcon
   */
  private findOverlayParts(overlay: Container): MediaOverlayParts | null {
    if (overlay.children.length < 3) return null;
    const playIcon = overlay.children[1] as Graphics;
    const pauseIcon = overlay.children[2] as Graphics;
    return { overlay, playIcon, pauseIcon };
  }
}
