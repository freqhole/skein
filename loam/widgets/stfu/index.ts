/**
 * stfu widget — video/audio cut-timeline editor. see
 * docs/stfu-widget-plan.md for the full design; this is the earliest slice:
 * an empty-state "click to upload video" placeholder (mirrors file.ts's
 * full-bounds-hit-area upload placeholder) that transitions to a persistent,
 * native-controls video area once a video is uploaded. the transcript,
 * cut timeline, audio-clips track, and revisions UI are later phases —
 * `stfuSchema` already reserves their fields (see types.ts) so documents
 * created now don't need reshaping later.
 */

import type { Repo } from "@automerge/automerge-repo";
import { Container, type FederatedPointerEvent, Graphics, Rectangle, Text } from "pixi.js";
import { getLocalNodeId, guessMimeFromFilename, type PeersMap, type PickedFile } from "../../src/file-utils/file-shared";
import { pickFiles, uploadFile } from "../../src/file-utils/upload";
import { getMediaPlaybackUrl } from "../../src/media";
import { ensureThumbnailPersisted } from "../../src/file-utils/thumbnail-utils";
import { isTauriMode } from "../../src/p2p/tauri-transport";
import { deleteBlob } from "../../src/storage/blob-store";
import { createMediaDomOverlay, type MediaDomOverlayHandle } from "../../src/widgets/media-dom-overlay";
import type { WidgetRegistry } from "../../src/widgets/widget-registry";
import { createAudioClipPlayback } from "./audio-clip-playback";
import { createAudioClipDragController } from "./audio-clip-drag";
import { createAudioClipsTrack, type AudioClipsTrackHandle } from "./audio-clips-track";
import {
  downloadAudioClipManifestLocal,
  downloadStfuBundle,
} from "./audio-clips-export";
import { applyCutPlaybackEffects as applyCutPlaybackEffects_, createCutOverlayElement } from "./cut-playback-effects";
import { createCutModeControl, CUT_MODE_CONTROL_RESERVED_WIDTH, type CutModeControlHandle } from "./cut-mode-control";
import { createCutSegmentsTrack, type CutSegmentsTrackHandle, type EditableSegment } from "./cut-segments-track";
import { createHistoryController } from "./history-controller";
import { createKeyboardShortcutsControl, type KeyboardShortcutsControlHandle } from "./keyboard-shortcuts-control";
import { createKeyboardShortcutsHandler } from "./keyboard-shortcuts-handler";
import {
  clampSegmentsPanelHeight,
  loadLocalCutPrefs,
  loadSegmentsPanelHeight,
  saveLocalCutPrefs,
  saveSegmentsPanelHeight,
  SEGMENTS_PANEL_MIN_HEIGHT,
  type LocalCutPrefs,
} from "./local-prefs";
import { createReferenceTrack, type ReferenceTrackHandle } from "./reference-track";
import { createReferenceDialog, type ReferenceDialogHandle } from "./reference-dialog";
import {
  createReferenceDataMessageController,
  downloadCutManifest as downloadCutManifest_,
  handleLoadReferenceData as handleLoadReferenceData_,
  stripExtension,
} from "./reference-data-actions";
import { createSegmentsPanel, SEGMENTS_PANEL_HEIGHT, type SegmentsPanelHandle } from "./segments-panel";
import { createSnatchController } from "./snatch-controller";
import { createVideoTimeline, computeTimelineShellHeight, type VideoTimelineHandle } from "./video-timeline";
import { createVoicePickerDialog, type VoicePickerDialogHandle } from "./voice-picker-dialog";
import type {
  BinPreviewContext,
  BinPreviewHandle,
  CompactInfo,
  HeaderAction,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../../src/widgets/widget-types";
import { stfuSchema, type StfuState } from "./types";

const PADDING = 8;
const TIMELINE_INSET = 6;
const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";

// a fresh upload lock claim older than this is presumed abandoned (crashed
// uploader) and no longer blocks a new upload attempt — mirrors file.ts's
// UPLOAD_LOCK_STALE_MS.
const UPLOAD_LOCK_STALE_MS = 30_000;

type LoadState = "empty" | "loading" | "ready";

export const stfuWidget: WidgetFactory<typeof stfuSchema> = {
  type: "stfu",
  metadata: {
    name: "stfu",
    description: "video/audio cut-timeline editor",
    version: "0.1.0",
    category: "media",
    defaultWidth: 640,
    defaultHeight: 480,
  },
  schema: stfuSchema,

  getCompactInfo: (state: StfuState): CompactInfo => ({
    label: state.videoFilename || "stfu",
    domain: "video",
    blobId: state.videoBlobId || undefined,
    mime: state.videoMime || undefined,
    filename: state.videoFilename || undefined,
    blake3: state.videoBlake3 || undefined,
    size: state.videoSize || undefined,
    thumbnailUrl: state.thumbnailDataUrl || undefined,
  }),

  /**
   * bin-card preview — mirrors the widget's own full-mount playback (cut
   * skip/overlay/mute effects + audio-clip playback, see
   * `mountMediaOverlay()` below) without ever mounting the full timeline/
   * segments UI. built lazily on first tap; state is a one-time snapshot
   * (no live-doc-update subscription — acceptable since bin previews don't
   * need to reflect concurrent edits while playing).
   */
  getBinPreview: (state: StfuState, previewCtx: BinPreviewContext): BinPreviewHandle | null => {
    if (!state.videoBlobId) return null;

    const localPrefs = loadLocalCutPrefs(previewCtx.widgetId);
    let overlay: MediaDomOverlayHandle | null = null;
    let cutOverlayEl: HTMLDivElement | null = null;
    let audioClipPlayback: ReturnType<typeof createAudioClipPlayback> | null = null;
    let onTimeUpdate: (() => void) | null = null;
    let onPause: (() => void) | null = null;

    async function ensureMounted(): Promise<MediaDomOverlayHandle | null> {
      if (overlay) return overlay;

      const src = await getMediaPlaybackUrl(state.videoBlobId, {
        category: "video",
        peers: previewCtx.getPeers(),
        mime: state.videoMime || undefined,
      });
      if (!src || overlay) return overlay;

      overlay = createMediaDomOverlay({
        src,
        mime: state.videoMime || undefined,
        container: previewCtx.container,
        canvasElement: previewCtx.canvasElement,
        getSize: previewCtx.getSize,
        muted: false,
        loop: false,
        controls: false,
        objectFit: "contain",
      });

      cutOverlayEl = createCutOverlayElement();
      overlay.wrapper.appendChild(cutOverlayEl);

      audioClipPlayback = createAudioClipPlayback({
        getVideo: () => overlay?.video ?? null,
        getAudioClips: () => state.audioClips,
        getPeers: () => previewCtx.getPeers(),
        isDestroyed: () => overlay === null,
      });

      onTimeUpdate = () => {
        if (!overlay) return;
        applyCutPlaybackEffects_({
          video: overlay.video,
          overlayEl: cutOverlayEl,
          editableSegments: state.editableSegments,
          cutSkipEnabled: state.cutSkipEnabled,
          cutMuteEnabled: state.cutMuteEnabled,
          overlayEnabled: localPrefs.overlayEnabled,
          muteEarlyMs: localPrefs.muteEarlyMs,
        });
        audioClipPlayback?.apply();
      };
      overlay.video.addEventListener("timeupdate", onTimeUpdate);

      onPause = () => audioClipPlayback?.stop();
      overlay.video.addEventListener("pause", onPause);

      return overlay;
    }

    function teardown(): void {
      if (overlay) {
        if (onTimeUpdate) overlay.video.removeEventListener("timeupdate", onTimeUpdate);
        if (onPause) overlay.video.removeEventListener("pause", onPause);
        overlay.close();
      }
      audioClipPlayback?.stop();
      audioClipPlayback = null;
      overlay = null;
      cutOverlayEl = null;
      onTimeUpdate = null;
      onPause = null;
    }

    return {
      isPlaying: () => Boolean(overlay && !overlay.video.paused),
      onTap: async () => {
        const ov = await ensureMounted();
        if (!ov) return;
        if (ov.video.paused) {
          try {
            await ov.video.play();
          } catch {
            /* ignore playback errors (e.g. autoplay restrictions) */
          }
        } else {
          ov.video.pause();
        }
      },
      onDoubleTap: () => {
        if (!overlay) return;
        try {
          if (overlay.video.requestFullscreen) {
            overlay.video.requestFullscreen().catch(() => {});
          } else if ((overlay.video as any).webkitRequestFullscreen) {
            (overlay.video as any).webkitRequestFullscreen();
          }
        } catch {
          /* ignore fullscreen errors */
        }
      },
      onStop: () => teardown(),
      destroy: () => teardown(),
    };
  },

  create(ctx: WidgetMountContext<typeof stfuSchema>): WidgetController {
    const container = new Container();
    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let destroyed = false;

    // only the peer who created this widget can use the initial "click to
    // upload" step — mirrors file.ts's iAmCreator gate, avoiding two peers
    // racing to upload into the same empty stfu widget.
    const iAmCreator = !ctx.canvasStore || ctx.canvasStore.isLocalWidgetCreator(ctx.widgetId);

    // -- cross-widget "drop an audio-recording/tts widget onto the audio
    // clips track" support (see docs/stfu-widget-plan.md's cross-widget
    // drag-and-drop section) — same store/repo/registry plumbing bin/index.ts
    // uses for its own dropTarget implementation.
    const store = ctx.canvasStore ?? null;
    const repo: Repo | null = store?.repo ?? null;
    const registry: WidgetRegistry | null = _stfuWidgetRegistry;

    let loadState: LoadState = ctx.doc.current.videoBlobId ? "ready" : "empty";

    let uploadAbort: AbortController | null = null;
    let uploadCancelled = false;
    let statusMessage = "";
    let progressText = "";
    let loadedVideoKey = "";
    let mediaOverlay: MediaDomOverlayHandle | null = null;
    let timeline: VideoTimelineHandle | null = null;
    let cutTrack: CutSegmentsTrackHandle | null = null;
    let audioClipsTrack: AudioClipsTrackHandle | null = null;
    let cutModeControl: CutModeControlHandle | null = null;
    // one `reference-track.ts` row per `ReferenceTrack` in the doc (see
    // reference-dialog.ts's speaker grouping), keyed by track id — kept in
    // sync with `ctx.doc.current.referenceTracks` by `syncReferenceTracks()`.
    let referenceTracks = new Map<string, ReferenceTrackHandle>();
    let referenceTrackOrder: string[] = [];
    let referenceDialog: ReferenceDialogHandle | null = null;
    let segmentsPanel: SegmentsPanelHandle | null = null;
    let keyboardShortcutsControl: KeyboardShortcutsControlHandle | null = null;
    let voicePickerDialog: VoicePickerDialogHandle | null = null;
    let cutOverlayEl: HTMLDivElement | null = null;
    let timeUpdateHandler: (() => void) | null = null;
    let pauseHandler: (() => void) | null = null;
    // the video/timeline splitter handle — created once alongside the
    // timeline itself (see `ensureTimeline()`), null until a video is loaded.
    let videoResizeHandle: Container | null = null;

    // transient feedback for the "load reference data..." action — shown
    // appended to the header line (statusMessage above is only ever shown
    // in the pre-upload "empty" placeholder state, not once a video is
    // loaded, so reference-data feedback needed its own surface).
    const referenceDataMessages = createReferenceDataMessageController(() => updateVideoHeaderActions());

    // -- mic input device selection (property tray "mic input device" select)
    // for segments-panel.ts's audio-clip record button — mirrors
    // audio-recording.ts's own device-select plumbing exactly.
    const MIC_DEVICE_DEFAULT = "System default";
    let cachedMicDevices: MediaDeviceInfo[] = [];
    const enumerateMicDevices = async (): Promise<void> => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        cachedMicDevices = all.filter((d) => d.kind === "audioinput");
      } catch {
        // enumerateDevices may be unavailable without a secure context
      }
    };
    void enumerateMicDevices();
    // called fresh each time the property tray opens the dropdown.
    const micDeviceOptions = (): string[] => [
      MIC_DEVICE_DEFAULT,
      ...cachedMicDevices.map((d) => d.label || `Microphone (${d.deviceId.slice(0, 8)}\u2026)`),
    ];

    // audio-clips playback while the video plays (tts speech synth / real
    // generated or recorded audio file) — see audio-clip-playback.ts.
    const audioClipPlayback = createAudioClipPlayback({
      getVideo: () => mediaOverlay?.video ?? null,
      getAudioClips: () => ctx.doc.current.audioClips,
      getPeers: () => ctx.canvasStore?.peers() as PeersMap | undefined,
      isDestroyed: () => destroyed,
    });

    // -- "snatch" support for peers that don't have the video blob (and/or
    // any generated/recorded audio-clip blobs) locally yet — see
    // snatch-controller.ts for the batch-snatch + background auto-snatch
    // logic (see docs/stfu-widget-plan.md).
    const snatchController = createSnatchController({
      widgetId: ctx.widgetId,
      getDocState: () => ctx.doc.current,
      getPeers: () => ctx.canvasStore?.peers() as PeersMap | undefined,
      isPeerOnline: ctx.canvasStore ? (nodeId: string) => ctx.canvasStore!.isPeerOnline(nodeId) : undefined,
      isDestroyed: () => destroyed,
      onStateChange: () => updateVideoHeaderActions(),
      onVideoSnatched: () => {
        // the blob is now locally available but nothing else changed
        // (blobId/blake3 are unchanged, so mountMediaOverlay()'s own
        // dedup guard wouldn't otherwise retry) — force a fresh attempt so
        // the video renders right away instead of only after the widget is
        // unmounted/remounted (e.g. by leaving and returning to the canvas).
        loadedVideoKey = "";
        void mountMediaOverlay();
      },
    });

    function updateVideoHeaderActions(): void {
      if (!ctx.setHeaderActions) return;
      const actions: HeaderAction[] = [];
      const videoActionState = snatchController.getVideoActionState();
      if (videoActionState === "remote") {
        actions.push({
          id: "snatch-video",
          label: "snatch all",
          onClick: () => void snatchController.handleSnatchAll(),
        });
      } else if (videoActionState === "snatching") {
        const progressText = snatchController.getProgressText();
        actions.push({
          id: "snatch-video",
          label: progressText ? `${progressText} (cancel)` : "snatching… (cancel)",
          onClick: () => snatchController.cancelSnatch(),
        });
      }
      // transient feedback for the "load reference data..." action — shown
      // as a non-clickable info badge in the widget frame's own header
      // (there's no in-canvas header row anymore, and this area sits above
      // the DOM video overlay's z-index instead of underneath it).
      const referenceDataMessage = referenceDataMessages.get();
      if (referenceDataMessage) {
        actions.push({ id: "reference-data-status", label: referenceDataMessage, isInfo: true });
      }
      ctx.setHeaderActions(actions);
    }

    // -- background ------------------------------------------------------------

    const bg = new Graphics();
    container.addChild(bg);

    const drawBg = (w: number, h: number) => {
      bg.clear();
      bg.roundRect(0, 0, w, h, 4);
      bg.fill({ color: 0x1a1a2e });
      bg.stroke({ color: 0x2a2a3e, width: 1 });
    };
    drawBg(currentWidth, currentHeight);

    // whole-widget hover tracking (used to scope global keyboard shortcuts
    // below to "pointer is over this stfu instance" — there's no existing
    // canvas-level "focused widget" concept a widget factory can query, so
    // hover is the simplest reliable signal for which instance the shortcuts
    // apply to when several stfu widgets are on the same canvas).
    let pointerInsideWidget = false;
    container.eventMode = "static";
    container.hitArea = new Rectangle(0, 0, currentWidth, currentHeight);
    container.on("pointerover", () => {
      pointerInsideWidget = true;
    });
    container.on("pointerout", () => {
      pointerInsideWidget = false;
    });

    // -- video area ---------------------------------------------------------------
    // no dedicated header row — the video area starts at y=0 so the player
    // gets the widget's full height. the "load reference data..." action's
    // transient feedback now surfaces via `updateVideoHeaderActions()`'s
    // info badge instead (see above).

    // dedicated child container whose local (0,0) is the video area's own
    // top-left (there's no header row above it anymore) — createMediaDomOverlay
    // tracks *this* container's bounds, so the DOM video element is positioned
    // correctly without needing a CSS margin hack on the video itself.
    const videoArea = new Container();
    videoArea.y = 0;
    container.addChild(videoArea);

    // -- placeholder (empty/loading state) --------------------------------------

    const placeholderBorder = new Graphics();
    const drawPlaceholderBorder = (w: number, h: number) => {
      const inset = 6;
      placeholderBorder.clear();
      placeholderBorder.rect(inset, inset, w - inset * 2, h - inset * 2);
      placeholderBorder.stroke({ color: 0x444460, width: 1 });
      // full-bounds hit area (not just the drawn border line) so a tap
      // anywhere in the widget triggers upload — see file.ts's placeholder
      // for the same fix and why it's needed.
      placeholderBorder.hitArea = new Rectangle(0, 0, w, h);
    };
    drawPlaceholderBorder(currentWidth, currentHeight);
    placeholderBorder.eventMode = "static";
    placeholderBorder.cursor = iAmCreator ? "pointer" : "default";
    container.addChild(placeholderBorder);

    const placeholderText = new Text({
      text: iAmCreator ? "click to upload video" : "waiting for video",
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 18,
        fill: 0x9090b0,
      },
      resolution: typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2,
    });
    placeholderText.anchor.set(0.5);
    placeholderText.x = currentWidth / 2;
    placeholderText.y = currentHeight / 2;
    placeholderText.eventMode = "static";
    placeholderText.cursor = iAmCreator ? "pointer" : "default";
    container.addChild(placeholderText);

    // secondary entry point, right there in the empty state, so a first-time
    // user doesn't have to go hunting through the widget actions menu for
    // "load project folder..." — accepts a whole trek-minus-paris project
    // directory (video + diarize/transcribe json + speaker samples) in one pick.
    const FOLDER_LINK_FILL = 0x8a8aae;
    const FOLDER_LINK_HOVER_FILL = 0xff33c9; // matches trek-minus-paris's --color-magenta-hover
    const placeholderFolderLink = new Text({
      text: "or load a project folder...",
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 14,
        fill: FOLDER_LINK_FILL,
      },
      resolution: typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2,
    });
    placeholderFolderLink.anchor.set(0.5);
    placeholderFolderLink.x = currentWidth / 2;
    placeholderFolderLink.y = currentHeight / 2 + 22;
    placeholderFolderLink.eventMode = "static";
    placeholderFolderLink.cursor = iAmCreator ? "pointer" : "default";
    container.addChild(placeholderFolderLink);

    // -- cut-playback local-only prefs (overlay display + mute latency-comp ms) --
    // never part of the automerge doc — see local-prefs.ts.
    let localPrefs: LocalCutPrefs = loadLocalCutPrefs(ctx.widgetId);
    function saveLocalPrefs(): void {
      saveLocalCutPrefs(ctx.widgetId, localPrefs);
    }

    // -- vertical resize handles (video area / timeline / segments panel) -------
    // the timeline shell itself is a fixed height; only the video area and
    // the segments panel below it are user-resizable, via a drag handle
    // above and below the timeline respectively. dragging either one only
    // redistributes space between the video area and segments panel — the
    // widget's own height never changes (purely local UI state, not synced
    // via the doc) — see docs/stfu-widget-plan.md.
    const HANDLE_GAP = 10;
    const VIDEO_AREA_MIN_HEIGHT = 100;

    let segmentsPanelHeight = loadSegmentsPanelHeight(ctx.widgetId, SEGMENTS_PANEL_HEIGHT);

    // -- undo/redo (local session only — does not undo peers' concurrent edits;
    // same accepted tradeoff as doodle.ts's own local-only undo stack) ----------
    // see history-controller.ts for the snapshot/undo/redo mechanics.
    const historyController = createHistoryController({
      getDocState: () => ctx.doc.current,
      changeDoc: (fn) => ctx.doc.change(fn),
      onApplied: () => {
        cutTrack?.refresh();
        audioClipsTrack?.refresh();
        segmentsPanel?.refresh();
      },
      onHistoryChanged: () => timeline?.refreshUndoRedo(),
    });

    /** call once, right after `ctx.doc.current.editableSegments`/`audioClips`
     *  are known to reflect the real starting state (inside `ensureTimeline()`). */
    function initHistory(): void {
      historyController.init();
    }

    /** record the current doc state as a new undoable entry — call after
     *  any local edit to `editableSegments`/`audioClips` completes. never
     *  call this from the doc's own "change" subscription (`applyDocState`),
     *  which also fires for remote peers' edits — that would let a peer's
     *  edit sneak into this session's own undo stack. */
    function pushHistory(): void {
      historyController.push();
    }

    function undo(): void {
      historyController.undo();
    }

    function redo(): void {
      historyController.redo();
    }

    // -- cut-playback effects (skip / overlay / mute + the "cut" overlay
    // DOM element) — see cut-playback-effects.ts. -------------------------

    function applyCutPlaybackEffects(): void {
      if (!mediaOverlay) return;
      const state = ctx.doc.current;
      applyCutPlaybackEffects_(
        {
          video: mediaOverlay.video,
          overlayEl: cutOverlayEl,
          editableSegments: state.editableSegments,
          cutSkipEnabled: state.cutSkipEnabled,
          cutMuteEnabled: state.cutMuteEnabled,
          overlayEnabled: localPrefs.overlayEnabled,
          muteEarlyMs: localPrefs.muteEarlyMs,
        }
      );
    }

    // -- audio-clip playback (tts speech synth / generated audio file /
    // recording) — see audio-clip-playback.ts. ----------------------------

    function stopClipAudio(): void {
      audioClipPlayback.stop();
    }

    function applyAudioClipPlayback(): void {
      audioClipPlayback.apply();
    }

    function handleToggleSkip(): void {
      const next = !ctx.doc.current.cutSkipEnabled;
      ctx.doc.change((d) => {
        d.cutSkipEnabled = next;
        if (next) d.cutMuteEnabled = false;
      });
      if (next && localPrefs.overlayEnabled) {
        localPrefs = { ...localPrefs, overlayEnabled: false };
        saveLocalPrefs();
      }
      cutModeControl?.refresh();
      applyCutPlaybackEffects();
    }

    function handleToggleOverlay(): void {
      const nextOverlay = !localPrefs.overlayEnabled;
      localPrefs = { ...localPrefs, overlayEnabled: nextOverlay };
      saveLocalPrefs();
      if (nextOverlay && ctx.doc.current.cutSkipEnabled) {
        ctx.doc.change((d) => {
          d.cutSkipEnabled = false;
        });
      }
      cutModeControl?.refresh();
      applyCutPlaybackEffects();
    }

    function handleToggleMute(): void {
      const next = !ctx.doc.current.cutMuteEnabled;
      ctx.doc.change((d) => {
        d.cutMuteEnabled = next;
        if (next) d.cutSkipEnabled = false;
      });
      cutModeControl?.refresh();
      applyCutPlaybackEffects();
    }

    function handleMuteEarlyMsChange(ms: number): void {
      localPrefs = { ...localPrefs, muteEarlyMs: ms };
      saveLocalPrefs();
      cutModeControl?.refresh();
    }

    // -- reference data (diarization/transcript) load — see reference-data-actions.ts --

    async function handleLoadReferenceData(): Promise<void> {
      await handleLoadReferenceData_({
        isViewerOnly: Boolean(ctx.canvasStore?.isLocalViewer()),
        isDestroyed: () => destroyed,
        changeDoc: (fn) => ctx.doc.change(fn),
        onMerged: () => {
          syncReferenceTracks();
          for (const h of referenceTracks.values()) h.refresh();
          referenceDialog?.refresh();
        },
        setMessage: (message, autoClearMs) => referenceDataMessages.set(message, autoClearMs),
      });
    }

    async function handleLoadReferenceDataFolder(): Promise<void> {
      await handleLoadReferenceData_({
        isViewerOnly: Boolean(ctx.canvasStore?.isLocalViewer()),
        isDestroyed: () => destroyed,
        changeDoc: (fn) => ctx.doc.change(fn),
        onMerged: () => {
          syncReferenceTracks();
          for (const h of referenceTracks.values()) h.refresh();
          referenceDialog?.refresh();
        },
        setMessage: (message, autoClearMs) => referenceDataMessages.set(message, autoClearMs),
        fromDirectory: true,
        // auto-init the widget's video when the picked folder has one
        // alongside the diarize/transcribe json, instead of leaving the
        // widget waiting for a separate manual upload afterward.
        hasVideo: () => Boolean(ctx.doc.current.videoBlobId),
        onVideoFound: (file) => performVideoUpload(file),
      });
    }

    function downloadCutManifest(): void {
      downloadCutManifest_(ctx.doc.current);
    }

    // -- audio-clips export (phase 6, see audio-clips-export.ts's module doc) --

    async function downloadAudioClips(): Promise<void> {
      if (isTauriMode()) {
        await downloadAudioClipManifestLocal(ctx.doc.current);
      } else {
        await downloadStfuBundle(ctx.doc.current);
      }
    }

    // -- helpers -----------------------------------------------------------------

    function syncVisibility(): void {
      const showPlaceholder = loadState !== "ready";
      placeholderBorder.visible = showPlaceholder;
      placeholderText.visible = showPlaceholder;
      // only makes sense to offer alongside the initial "click to upload"
      // prompt — hidden once an upload is actually in progress.
      placeholderFolderLink.visible = showPlaceholder && iAmCreator && loadState === "empty";
    }

    function refresh(): void {
      syncVisibility();
      if (loadState === "loading") {
        placeholderText.text = progressText || "uploading…";
      } else if (loadState === "empty") {
        placeholderText.text = statusMessage || (iAmCreator ? "click to upload video" : "waiting for video");
      }
    }

    function teardownMediaOverlay(): void {
      stopClipAudio();
      if (mediaOverlay && timeUpdateHandler) {
        mediaOverlay.video.removeEventListener("timeupdate", timeUpdateHandler);
      }
      if (mediaOverlay && pauseHandler) {
        mediaOverlay.video.removeEventListener("pause", pauseHandler);
      }
      timeUpdateHandler = null;
      pauseHandler = null;
      mediaOverlay?.close();
      mediaOverlay = null;
      cutOverlayEl = null;
      loadedVideoKey = "";
    }

    // the DOM `<video>` overlay (media-dom-overlay.ts) sits above all pixi
    // content — a real element at `z-index: 15000`, positioned in a
    // different stacking context entirely — so a widget-wide dialog (drawn
    // in pixi, underneath) would otherwise render invisibly behind it.
    // paused + hidden for as long as at least one such dialog is open;
    // a signed counter (not a boolean) so two dialogs opening/closing out of
    // order can't prematurely reveal the video while another is still up.
    let openFullWidgetDialogCount = 0;
    function handleFullWidgetDialogOpenChange(open: boolean): void {
      openFullWidgetDialogCount = Math.max(0, openFullWidgetDialogCount + (open ? 1 : -1));
      if (!mediaOverlay) return;
      if (openFullWidgetDialogCount > 0) {
        mediaOverlay.video.pause();
        stopClipAudio();
      }
      mediaOverlay.wrapper.style.visibility = openFullWidgetDialogCount > 0 ? "hidden" : "visible";
    }

    function teardownTimeline(): void {
      videoResizeHandle?.destroy({ children: true });
      videoResizeHandle = null;
      cutModeControl?.destroy();
      cutModeControl = null;
      keyboardShortcutsControl?.destroy();
      keyboardShortcutsControl = null;
      voicePickerDialog?.destroy();
      voicePickerDialog = null;
      referenceDialog?.destroy();
      referenceDialog = null;
      cutTrack?.destroy();
      cutTrack = null;
      audioClipsTrack?.destroy();
      audioClipsTrack = null;
      destroyReferenceTracks();
      segmentsPanel?.destroy();
      segmentsPanel = null;
      timeline?.destroy();
      timeline = null;
    }

    // vertical space the timeline shell reserves above the bottom edge, now
    // that the segments panel also lives down there (below the timeline,
    // per the plan doc's "below/beside-timeline list of rows" wording).
    // `HANDLE_GAP` above and below the timeline leaves room for the two
    // drag handles without them overlapping the timeline shell itself.
    function segmentsPanelY(h: number): number {
      return h - segmentsPanelHeight - PADDING;
    }
    function timelineY(h: number): number {
      return segmentsPanelY(h) - computeTimelineShellHeight(ctx.doc.current.referenceTracks.length) - HANDLE_GAP;
    }
    // pixel height available to the video area — it starts at y=0 (no header
    // row), so this is also its own bottom edge / total height.
    function videoAreaHeight(h: number): number {
      return timelineY(h) - HANDLE_GAP;
    }

    // shared layout pass — repositions/resizes every widget-owned piece for
    // a given (width, height). used both by the controller's own `resize()`
    // (driven by the widget frame / other peers' synced doc changes) and,
    // during a local drag of one of the two splitter handles below, to
    // apply a new `segmentsPanelHeight` at the *same* (w, h) — dragging a
    // splitter never changes the widget's own width/height, only the split.
    function applyLayout(w: number, h: number): void {
      currentWidth = w;
      currentHeight = h;
      drawBg(w, h);
      container.hitArea = new Rectangle(0, 0, w, h);
      drawPlaceholderBorder(w, h);
      placeholderText.x = w / 2;
      placeholderText.y = h / 2;
      placeholderFolderLink.x = w / 2;
      placeholderFolderLink.y = h / 2 + 22;
      if (timeline) {
        timeline.container.y = timelineY(h);
        timeline.resize(Math.max(0, w - TIMELINE_INSET * 2));
        cutModeControl?.resize(Math.max(0, w - TIMELINE_INSET * 2));
        for (const h of referenceTracks.values()) h.resize(Math.max(0, w - TIMELINE_INSET * 2));
      }
      keyboardShortcutsControl?.resize(w, h);
      if (segmentsPanel) {
        segmentsPanel.container.y = segmentsPanelY(h);
        segmentsPanel.resize(Math.max(0, w - TIMELINE_INSET * 2), segmentsPanelHeight);
      }
      voicePickerDialog?.resize(w, h);
      referenceDialog?.resize(w, h);
      if (videoResizeHandle) {
        videoResizeHandle.x = TIMELINE_INSET;
        videoResizeHandle.y = videoAreaHeight(h);
        drawSplitterHandle(videoResizeHandle, Math.max(0, w - TIMELINE_INSET * 2));
      }
    }

    // draws (or redraws, on width change) a thin horizontal grip bar — a
    // dim centered dash, matching the visual weight of the property-tray's
    // own resize handles rather than a full-width divider line.
    function drawSplitterHandle(handle: Container, width: number): void {
      const gfx = handle.getChildAt(0) as Graphics;
      gfx.clear();
      gfx.rect(0, 0, width, HANDLE_GAP).fill({ color: 0x000000, alpha: 0.001 });
      const dashWidth = Math.min(32, Math.max(0, width - 8));
      gfx
        .roundRect((width - dashWidth) / 2, HANDLE_GAP / 2 - 1.5, dashWidth, 3, 1.5)
        .fill({ color: 0x555566 });
      handle.hitArea = new Rectangle(0, 0, width, HANDLE_GAP);
    }

    function destroyReferenceTracks(): void {
      for (const handle of referenceTracks.values()) handle.destroy();
      referenceTracks = new Map();
      referenceTrackOrder = [];
    }

    // mounts/unmounts one `reference-track.ts` row per `ReferenceTrack` in
    // the doc (see reference-dialog.ts's speaker grouping) — called on
    // every doc change (`refreshTimelineFromDoc()`) so adding/removing/
    // reordering a track there immediately grows/shrinks the stacked
    // timeline rows. cheap to call even when nothing changed: bails out
    // early on an identical (same ids, same order) track list.
    function syncReferenceTracks(): void {
      if (!timeline) return;
      const tracks = ctx.doc.current.referenceTracks;
      const ids = tracks.map((t) => t.id);
      const unchanged =
        ids.length === referenceTrackOrder.length && ids.every((id, i) => id === referenceTrackOrder[i]);
      if (unchanged) return;

      destroyReferenceTracks();
      timeline.setReferenceRowCount(tracks.length);
      tracks.forEach((track, i) => {
        const trackId = track.id;
        const handle = createReferenceTrack({
          timeline: timeline!,
          trackId,
          row: timeline!.getReferenceRow(i),
          // a lone default track keeps the original "REFERENCE" label; once
          // there's more than one, fall back to a positional "track N" name
          // for any track the user hasn't renamed yet.
          getTrackLabel: () => {
            const current = ctx.doc.current.referenceTracks;
            if (current.length <= 1) return "REFERENCE";
            const idx = current.findIndex((t) => t.id === trackId);
            const t = idx === -1 ? undefined : current[idx];
            return t?.label || `track ${idx + 1}`;
          },
          canvasElement: ctx.canvasElement,
          getReferenceSpeakers: () => ctx.doc.current.referenceSpeakers,
          getReferenceTracks: () => ctx.doc.current.referenceTracks,
          getTranscriptSegments: () => ctx.doc.current.transcriptSegments,
          isSpeakerVisible: (label) => referenceDialog?.isSpeakerVisible(label) ?? true,
          onOpenDialog: () => referenceDialog?.toggle(),
          // drag a reference/diarization segment down into the cut list to
          // create a new editable segment snapped exactly to its start/end
          // (it can then be resized like any other cut-list segment).
          onCreateCutSegment: (start, end) => {
            ctx.doc.change((d) => {
              d.editableSegments.push([start, end]);
            });
            // unlike remote peers' edits (handled by the doc-change
            // subscription below), our own local edit needs an immediate
            // refresh here too, matching every other local mutation handler
            // in this file (`handleToggleSkip` etc) — otherwise the new
            // segment doesn't visually appear until some unrelated redraw.
            cutTrack?.refresh();
            pushHistory();
          },
          // same drag gesture, but dropped onto the audio-clips row instead —
          // snap a new clip to the same [start, end].
          onCreateAudioClip: (start, end) => {
            ctx.doc.change((d) => {
              d.audioClips.push({
                id: crypto.randomUUID(),
                trackId: "default",
                start,
                durationSec: Math.max(0.05, end - start),
                label: "",
              });
            });
            audioClipsTrack?.refresh();
            pushHistory();
          },
          // matches editor.js's own reference-track click behavior — a plain
          // click (no drag) on a segment seeks the video to its start.
          onSeek: (t) => {
            if (mediaOverlay) mediaOverlay.video.currentTime = t;
          },
          // clicking the row's label column (anywhere but the caret button)
          // toggles the segments panel's "reference" source, mirroring the
          // CUT LIST/AUDIO CLIPS labels in `video-timeline.ts`.
          onToggleVisible: () => segmentsPanel?.toggleViewMode("reference"),
          isReferenceActive: () => segmentsPanel?.isViewModeActive("reference") ?? false,
        });
        handle.resize(Math.max(0, currentWidth - TIMELINE_INSET * 2));
        referenceTracks.set(trackId, handle);
      });
      referenceTrackOrder = ids;
      applyLayout(currentWidth, currentHeight);
    }

    function ensureTimeline(): VideoTimelineHandle {
      if (timeline) return timeline;
      timeline = createVideoTimeline(
        Math.max(0, currentWidth - TIMELINE_INSET * 2),
        ctx.canvasElement,
        (t) => {
          if (mediaOverlay) mediaOverlay.video.currentTime = t;
        },
        {
          onToggleCutListVisible: () => segmentsPanel?.toggleViewMode("cutlist"),
          onToggleAudioClipsVisible: () => segmentsPanel?.toggleViewMode("audioclips"),
          isCutListVisible: () => segmentsPanel?.isViewModeActive("cutlist") ?? false,
          isAudioClipsVisible: () => segmentsPanel?.isViewModeActive("audioclips") ?? false,
          onUndo: undo,
          onRedo: redo,
          canUndo: () => historyController.canUndo(),
          canRedo: () => historyController.canRedo(),
        }
      );
      timeline.container.x = TIMELINE_INSET;
      timeline.container.y = timelineY(currentHeight);
      timeline.setDuration(ctx.doc.current.videoDurationSec);
      container.addChild(timeline.container);
      cutTrack = createCutSegmentsTrack({
        timeline,
        getSegments: () => ctx.doc.current.editableSegments,
        onChange: (next: EditableSegment[]) => {
          ctx.doc.change((d) => {
            d.editableSegments = next;
          });
          pushHistory();
        },
        getDuration: () => ctx.doc.current.videoDurationSec,
        // snap to the reference/diarization track's own segment edges and
        // the current playhead too, not just other cut-list segments —
        // matches editor.js's `maybeSnap()`.
        getSnapTimes: () => [
          ...ctx.doc.current.transcriptSegments.flatMap((s) => [s.start, s.end]),
          timeline ? timeline.getCurrentTime() : 0,
        ],
        // selecting a segment (so keyboard shortcuts have a clear target)
        // also scrolls its matching row in the segments panel into view and
        // highlights it there, mirroring the prototype's own selection UX.
        // only one timeline segment (cut-list or audio-clip) is ever
        // selected at once, so selecting a cut segment clears any selected
        // audio clip.
        onSelectionChange: (seg) => {
          segmentsPanel?.setSelectedSegment(seg);
          if (seg) audioClipsTrack?.clearSelection();
        },
      });
      audioClipsTrack = createAudioClipsTrack({
        timeline,
        getClips: () => ctx.doc.current.audioClips,
        onChange: (next) => {
          ctx.doc.change((d) => {
            d.audioClips = next;
          });
          pushHistory();
        },
        getDuration: () => ctx.doc.current.videoDurationSec,
        // snap clip placement to the cut list's own edges, the reference
        // track's edges, and the current playhead too, not just other
        // audio clips.
        getSnapTimes: () => [
          ...ctx.doc.current.editableSegments.flat(),
          ...ctx.doc.current.transcriptSegments.flatMap((s) => [s.start, s.end]),
          timeline ? timeline.getCurrentTime() : 0,
        ],
        getWorldContainer: () => findWorldContainer(),
        onDragOut: (clip, worldX, worldY) => void handleAudioClipDragOut(clip, worldX, worldY),
        // tapping a clip just selects + scrolls its row in the segments
        // panel into view — authoring its tts text happens inline there,
        // not in a popup (see segments-panel.ts's inline audio-clip rows).
        onClipTap: (clip) => {
          segmentsPanel?.setSelectedClip(clip.id);
        },
        // only one timeline segment (cut-list or audio-clip) is ever
        // selected at once, so selecting an audio clip clears any selected
        // cut-list segment.
        onSelectionChange: (clip) => {
          if (clip) cutTrack?.clearSelection();
        },
        // purge a genuinely-deleted clip's real audio blob (tts-generated
        // or recorded) so it doesn't linger forever \u2014 never fires for a
        // drag-out (that's a move to a standalone widget reusing the same
        // blob, not a delete; see `onDragOut` above). browser-only for now:
        // there's no tauri blob-delete primitive anywhere in the codebase
        // yet (only ref-count-decrement dispatches), so in tauri mode the
        // bytes just linger \u2014 not lost, just not actively reclaimed.
        onClipDelete: (clip) => {
          if (!clip.audioBlobId || isTauriMode()) return;
          void deleteBlob(clip.audioBlobId).catch((err) => {
            console.error(`stfu widget: failed to purge blob for deleted clip ${clip.id}:`, err);
          });
        },
        getPeers: () => ctx.canvasStore?.peers() as PeersMap | undefined,
      });
      timeline.reserveToolbarStart(CUT_MODE_CONTROL_RESERVED_WIDTH);
      cutModeControl = createCutModeControl({
        toolbar: timeline.toolbarRow,
        overlayParent: timeline.container,
        getSkipEnabled: () => ctx.doc.current.cutSkipEnabled,
        getOverlayEnabled: () => localPrefs.overlayEnabled,
        getMuteEnabled: () => ctx.doc.current.cutMuteEnabled,
        getMuteEarlyMs: () => localPrefs.muteEarlyMs,
        onToggleSkip: handleToggleSkip,
        onToggleOverlay: handleToggleOverlay,
        onToggleMute: handleToggleMute,
        onMuteEarlyMsChange: handleMuteEarlyMsChange,
      });
      cutModeControl.resize(Math.max(0, currentWidth - TIMELINE_INSET * 2));
      syncReferenceTracks();
      segmentsPanel = createSegmentsPanel({
        canvasElement: ctx.canvasElement,
        getEditableSegments: () => ctx.doc.current.editableSegments,
        getTranscriptSegments: () => ctx.doc.current.transcriptSegments,
        getReferenceSpeakers: () => ctx.doc.current.referenceSpeakers,
        getAudioClips: () => ctx.doc.current.audioClips,
        onSeek: (t: number) => {
          if (mediaOverlay) mediaOverlay.video.currentTime = t;
        },
        getPeers: () => ctx.canvasStore?.peers() as PeersMap | undefined,
        getMicDeviceLabel: () => {
          const label = ctx.doc.current.micDeviceLabel;
          return label === MIC_DEVICE_DEFAULT ? "" : label;
        },
        // a row click in the panel seeks (above) and should also select
        // the matching segment/clip up in the timeline tracks — "reference"
        // rows have no timeline selection concept, so only cutlist/audio
        // clip rows do anything here.
        onRowSelect: (seg) => {
          if (seg.source === "cut list") {
            cutTrack?.selectSegment([seg.start, seg.end]);
            audioClipsTrack?.clearSelection();
          } else if (seg.source === "audio clip" && seg.clip) {
            audioClipsTrack?.selectClip(seg.clip.id);
            cutTrack?.clearSelection();
          }
        },
        onClipTextCommit: (clip, text) => {
          ctx.doc.change((d) => {
            const idx = d.audioClips.findIndex((c) => c.id === clip.id);
            if (idx === -1) return;
            const target = d.audioClips[idx];
            if (target.kind === "recording") {
              // a recording clip's text input is just a caption/label (what
              // the audio says), not tts source text — the recorded bytes
              // already exist and don't get re-measured/regenerated from it.
              target.label = text;
              return;
            }
            target.ttsText = text;
            // the clip's displayed length no longer reflects this new text
            // until it's re-measured (a fresh preview) or re-generated —
            // reset back to the nominal placeholder width in the meantime.
            // real generated/recorded audio (an `audioBlobId` already set)
            // keeps its own real file duration instead.
            if (!target.audioBlobId) target.durationSec = 0;
          });
          audioClipsTrack?.refresh();
        },
        onPreviewDurationMeasured: (clip, seconds) => {
          ctx.doc.change((d) => {
            const idx = d.audioClips.findIndex((c) => c.id === clip.id);
            if (idx === -1) return;
            const target = d.audioClips[idx];
            if (target.audioBlobId) return; // a real generated/recorded file already owns the duration
            target.durationSec = seconds;
          });
          audioClipsTrack?.refresh();
        },
        onClipGenerate: (clip, text, result, voiceName, voiceLang, rate) => {
          ctx.doc.change((d) => {
            const idx = d.audioClips.findIndex((c) => c.id === clip.id);
            if (idx === -1) return;
            const target = d.audioClips[idx];
            target.kind = "tts";
            target.audioBlobId = result.blobId;
            target.audioBlake3 = result.blake3;
            target.audioMime = result.mime;
            target.audioFilename = result.filename;
            target.audioSize = result.size;
            target.durationSec = result.duration;
            target.ttsText = text;
            target.ttsVoiceName = voiceName;
            target.ttsVoiceLang = voiceLang;
            target.ttsRate = rate;
            if (!target.label) target.label = text.slice(0, 40);
          });
          audioClipsTrack?.refresh();
          segmentsPanel?.refresh();
        },
        // starting a recording always commits the clip to `kind: "recording"`
        // and clears any tts fields (mutually exclusive — see types.ts's doc
        // comment) the instant the mic actually starts, so the segments-panel
        // row immediately hides its tts controls.
        onClipRecordStart: (clip) => {
          ctx.doc.change((d) => {
            const idx = d.audioClips.findIndex((c) => c.id === clip.id);
            if (idx === -1) return;
            const target = d.audioClips[idx];
            target.kind = "recording";
            target.ttsText = undefined;
            target.ttsVoiceName = undefined;
            target.ttsVoiceLang = undefined;
            target.ttsRate = undefined;
          });
          audioClipsTrack?.refresh();
          segmentsPanel?.refresh();
        },
        // live-growing box while recording — deliberately NOT written to the
        // doc on every sample (would spam history/sync); only the timeline
        // track's own drawn box grows, via `setRecordingPreview()`.
        onClipRecordSample: (clip, _amplitude, elapsedSec) => {
          audioClipsTrack?.setRecordingPreview(clip.id, elapsedSec);
        },
        onClipRecordFinish: (clip, result) => {
          audioClipsTrack?.setRecordingPreview(null);
          ctx.doc.change((d) => {
            const idx = d.audioClips.findIndex((c) => c.id === clip.id);
            if (idx === -1) return;
            const target = d.audioClips[idx];
            target.audioBlobId = result.blobId;
            target.audioBlake3 = result.blake3;
            target.audioMime = result.mime;
            target.audioFilename = result.filename;
            target.audioSize = result.size;
            target.durationSec = result.duration;
            if (!target.label) target.label = "recording";
          });
          audioClipsTrack?.refresh();
          segmentsPanel?.refresh();
        },
        onClipRecordError: (clip, err) => {
          audioClipsTrack?.setRecordingPreview(null);
          console.error(`stfu widget: recording failed for clip ${clip.id}:`, err);
        },
        onOpenVoicePicker: (opts) => voicePickerDialog?.open(opts),
        storageKey: `skein.stfu.${ctx.widgetId}.segmentsPanel`,
        getAutoScrollEnabled: () => (timeline ? timeline.isAutoScrollEnabled() : false),
        initialHeight: segmentsPanelHeight,
      });
      segmentsPanel.container.x = TIMELINE_INSET;
      segmentsPanel.container.y = segmentsPanelY(currentHeight);
      container.addChild(segmentsPanel.container);
      segmentsPanel.resize(Math.max(0, currentWidth - TIMELINE_INSET * 2), segmentsPanelHeight);
      // re-add `timeline.container` so it renders ABOVE `segmentsPanel.container`
      // (siblings render in addChild order) — the reference speaker popover
      // (mounted inside `timeline.container`) is deliberately allowed to
      // extend down over the segments panel while open (see its
      // `overlayMaxHeight`), which only actually shows on top if the timeline
      // itself is the later sibling.
      container.addChild(timeline.container);
      // vertical splitter handle above the timeline — adjusts how the fixed
      // vertical space between the video area and the segments panel is
      // divided, via the single stored `segmentsPanelHeight` (video area
      // height stays fully derived, see `videoAreaHeight()`): dragging down
      // grows the video area and shrinks the segments panel by the same
      // amount; dragging up does the opposite. the widget's own
      // height/footprint never changes from this drag (no doc write at
      // all — purely local UI state, like the autoscroll/snap prefs above).
      videoResizeHandle = new Container();
      videoResizeHandle.addChild(new Graphics());
      videoResizeHandle.eventMode = "static";
      videoResizeHandle.cursor = "ns-resize";
      container.addChild(videoResizeHandle);

      let splitterDrag: { startGlobalY: number; startSegmentsPanelHeight: number } | null = null;
      videoResizeHandle.on("pointerdown", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        splitterDrag = { startGlobalY: e.global.y, startSegmentsPanelHeight: segmentsPanelHeight };
      });
      videoResizeHandle.on("globalpointermove", (e: FederatedPointerEvent) => {
        if (!splitterDrag) return;
        const zoom = findWorldContainer().scale.x || 1;
        const dy = (e.global.y - splitterDrag.startGlobalY) / zoom;
        // moving the handle down (positive dy) shrinks the segments panel
        // and grows the video area by the same amount (total height fixed).
        const maxForVideoMin =
          currentHeight -
          computeTimelineShellHeight(ctx.doc.current.referenceTracks.length) -
          HANDLE_GAP * 2 -
          PADDING -
          VIDEO_AREA_MIN_HEIGHT;
        const proposed = clampSegmentsPanelHeight(splitterDrag.startSegmentsPanelHeight - dy);
        segmentsPanelHeight = Math.max(SEGMENTS_PANEL_MIN_HEIGHT, Math.min(maxForVideoMin, proposed));
        applyLayout(currentWidth, currentHeight);
      });
      const finishSplitterDrag = () => {
        if (!splitterDrag) return;
        splitterDrag = null;
        saveSegmentsPanelHeight(ctx.widgetId, segmentsPanelHeight);
      };
      videoResizeHandle.on("pointerup", finishSplitterDrag);
      videoResizeHandle.on("pointerupoutside", finishSplitterDrag);
      // created last (after every reorder above) so their backdrop+panel —
      // added straight to the widget-root `container` — land as the LAST,
      // hence topmost, siblings; created any earlier and the final
      // `timeline.container` re-add above would render on top of them instead.
      keyboardShortcutsControl = createKeyboardShortcutsControl({
        toolbar: timeline.toolbarTrailingSlot,
        overlayParent: container,
        onOpenChange: handleFullWidgetDialogOpenChange,
      });
      keyboardShortcutsControl.resize(currentWidth, currentHeight);
      voicePickerDialog ??= createVoicePickerDialog({
        // mounted at the widget root (not `timeline.container`) — the
        // segments panel alone is only ~150px tall, nowhere near enough
        // room for a scrollable voice list, so this dialog covers the
        // *whole* widget instead, sized in `resize()` below.
        overlayParent: container,
        canvasElement: ctx.canvasElement,
        onOpenChange: handleFullWidgetDialogOpenChange,
      });
      voicePickerDialog.resize(currentWidth, currentHeight);
      referenceDialog ??= createReferenceDialog({
        // same reasoning as `voicePickerDialog` above — the reference row
        // alone has nowhere near enough room for a scrollable, multi-track
        // speaker list, so this also covers the *whole* widget.
        overlayParent: container,
        canvasElement: ctx.canvasElement,
        getReferenceSpeakers: () => ctx.doc.current.referenceSpeakers,
        getReferenceTracks: () => ctx.doc.current.referenceTracks,
        getTranscriptSegments: () => ctx.doc.current.transcriptSegments,
        getVideoDurationSec: () => ctx.doc.current.videoDurationSec,
        changeDoc: (fn) => ctx.doc.change(fn),
        getPeers: () => ctx.canvasStore?.peers() as PeersMap | undefined,
        onOpenChange: handleFullWidgetDialogOpenChange,
      });
      referenceDialog.resize(currentWidth, currentHeight);
      // draws/positions the splitter handle for the first time (its
      // Graphics start out empty with no hitArea until `applyLayout()` runs
      // at least once) and re-confirms every other piece's layout too.
      applyLayout(currentWidth, currentHeight);
      // seed the undo/redo baseline once, now that `ctx.doc.current`'s
      // `editableSegments`/`audioClips` reflect the real starting state.
      initHistory();
      return timeline;
    }

    async function mountMediaOverlay(): Promise<void> {
      const state = ctx.doc.current;
      if (!state.videoBlobId) return;

      const key = `${state.videoBlobId}:${state.videoBlake3}`;
      if (key === loadedVideoKey) return;
      teardownMediaOverlay();
      loadedVideoKey = key;

      const peers = ctx.canvasStore?.peers() as PeersMap | undefined;
      const src = await getMediaPlaybackUrl(state.videoBlobId, {
        category: "video",
        mime: state.videoMime,
        blake3: state.videoBlake3 || undefined,
        peers,
      });

      if (destroyed || loadedVideoKey !== key) return;
      if (!src) {
        // don't keep `loadedVideoKey` claimed on failure — otherwise a later
        // retry for this exact blob (e.g. right after a successful snatch
        // makes it locally available) silently no-ops at the guard above,
        // and the video only ever mounts after a full widget remount (the
        // "had to leave the canvas and come back" bug).
        loadedVideoKey = "";
        statusMessage = "could not load video";
        refresh();
        return;
      }

      mediaOverlay = createMediaDomOverlay({
        src,
        mime: state.videoMime || undefined,
        container: videoArea,
        canvasElement: ctx.canvasElement,
        getSize: () => ({
          width: currentWidth,
          height: Math.max(
            0,
            videoAreaHeight(currentHeight)
          ),
        }),
        muted: false,
        loop: false,
        controls: true,
        objectFit: "contain",
      });
      // stays hidden if a full-widget dialog was already open at mount time
      // (e.g. re-mounting after a blob re-fetch while the panel is up).
      if (openFullWidgetDialogCount > 0) mediaOverlay.wrapper.style.visibility = "hidden";

      cutOverlayEl = createCutOverlayElement();
      mediaOverlay.wrapper.appendChild(cutOverlayEl);

      const tl = ensureTimeline();

      // best-effort duration — populated from the browser's own metadata
      // probe rather than a backend probe pipeline (not built yet).
      mediaOverlay.video.addEventListener(
        "loadedmetadata",
        () => {
          if (destroyed) return;
          const dur = mediaOverlay?.video.duration;
          if (dur && Number.isFinite(dur)) {
            tl.setDuration(dur);
            if (Math.abs(dur - ctx.doc.current.videoDurationSec) > 0.5) {
              ctx.doc.change((d) => {
                d.videoDurationSec = dur;
              });
            }
          }
        },
        { once: true }
      );

      timeUpdateHandler = () => {
        if (mediaOverlay) tl.setCurrentTime(mediaOverlay.video.currentTime);
        applyCutPlaybackEffects();
        applyAudioClipPlayback();
        if (mediaOverlay) segmentsPanel?.onTimeUpdate(mediaOverlay.video.currentTime);
        const pendingInTime = keyboardHandler.getPendingInTime();
        if (mediaOverlay && pendingInTime !== null) {
          cutTrack?.setPendingSegment([pendingInTime, mediaOverlay.video.currentTime]);
        }
      };
      mediaOverlay.video.addEventListener("timeupdate", timeUpdateHandler);
      // "timeupdate" stops firing once paused, so a clip mid-playback needs
      // its own explicit stop trigger here rather than relying on the next
      // (nonexistent) timeupdate tick.
      pauseHandler = () => stopClipAudio();
      mediaOverlay.video.addEventListener("pause", pauseHandler);
    }

    function applyDocState(): void {
      const state = ctx.doc.current;
      const nextLoadState: LoadState = state.videoBlobId ? "ready" : loadState === "loading" ? "loading" : "empty";
      loadState = nextLoadState;

      if (loadState === "ready") {
        void mountMediaOverlay();
        void snatchController.checkVideoLocality();
        refreshTimelineFromDoc();
        snatchController.maybeAutoSnatchNew();
        void snatchController.refreshLocalityCounts();
      } else {
        teardownMediaOverlay();
        teardownTimeline();
      }
      refresh();
    }

    function refreshTimelineFromDoc(): void {
      timeline?.setDuration(ctx.doc.current.videoDurationSec);
      cutTrack?.refresh();
      audioClipsTrack?.refresh();
      cutModeControl?.refresh();
      syncReferenceTracks();
      for (const h of referenceTracks.values()) h.refresh();
      referenceDialog?.refresh();
      segmentsPanel?.refresh();
    }

    applyDocState();

    const unsubscribe = ctx.doc.on("change", () => {
      applyDocState();
    });

    // -- upload flow ---------------------------------------------------------------

    /**
     * upload `file` as this widget's video and write the resulting blob
     * fields to the doc. shared by `handleUpload()` (manual "click to
     * upload video" pick) and `handleLoadReferenceDataFolder()`'s
     * auto-detected video (see reference-data-actions.ts's `onVideoFound`).
     * returns whether the upload succeeded.
     */
    async function performVideoUpload(file: PickedFile): Promise<boolean> {
      if (destroyed) return false;
      if (loadState !== "empty") return false;
      if (ctx.canvasStore?.isLocalViewer()) return false;
      if (!iAmCreator) return false;

      const localNodeId = await getLocalNodeId();
      const cur = ctx.doc.current;
      if (
        cur.uploadingBy &&
        cur.uploadingBy !== localNodeId &&
        Date.now() - cur.uploadingAt < UPLOAD_LOCK_STALE_MS
      ) {
        return false;
      }

      loadState = "loading";
      uploadCancelled = false;
      uploadAbort = new AbortController();
      statusMessage = "";
      progressText = "";
      refresh();

      if (localNodeId) {
        ctx.doc.change((d) => {
          d.uploadingBy = localNodeId;
          d.uploadingAt = Date.now();
        });
      }

      try {
        const result = await uploadFile(file, {
          waitForCompletion: true,
          signal: uploadAbort.signal,
          onProgress: (fraction) => {
            if (loadState !== "loading" || uploadCancelled) return;
            progressText = `uploading… ${Math.round(fraction * 100)}%`;
            refresh();
          },
        });

        if (destroyed) return false;

        ctx.doc.change((d) => {
          d.videoBlobId = result.blobId;
          d.videoFilename = file.filename;
          d.videoMime = result.mime;
          d.videoSize = result.size;
          d.videoBlake3 = result.blake3 || "";
          d.uploadingBy = "";
          d.uploadingAt = 0;
        });
        // name the widget after the video so it's identifiable in the layer
        // flyout/property tray instead of showing generically as "stfu".
        ctx.canvasStore?.setWidgetTitle(ctx.widgetId, stripExtension(file.filename));
        void snatchController.checkVideoLocality();
        // best-effort poster/thumbnail — used for the compact bin card and
        // as the bin preview's poster before first play.
        void ensureThumbnailPersisted(
          { current: () => ctx.doc.current, change: (fn) => ctx.doc.change(fn) },
          result.blobId,
          { size: 200 }
        );
        return true;
      } catch (err) {
        if (destroyed) return false;
        console.error("stfu widget: video upload failed:", err);
        statusMessage = "upload failed";
        loadState = "empty";
        if (localNodeId) {
          ctx.doc.change((d) => {
            d.uploadingBy = "";
            d.uploadingAt = 0;
          });
        }
        refresh();
        return false;
      } finally {
        uploadAbort = null;
      }
    }

    const handleUpload = async () => {
      if (destroyed) return;
      if (loadState !== "empty") return;
      if (ctx.canvasStore?.isLocalViewer()) return;
      if (!iAmCreator) return;

      const picked = await pickFiles();
      if (!picked || picked.length === 0) return;
      const file = picked[0];

      const mime = file.file?.type || guessMimeFromFilename(file.filename);
      if (!mime.startsWith("video/")) {
        statusMessage = "please pick a video file";
        refresh();
        return;
      }

      await performVideoUpload(file);
    };

    placeholderText.on("pointertap", () => void handleUpload());
    placeholderBorder.on("pointertap", () => void handleUpload());
    placeholderFolderLink.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      void handleLoadReferenceDataFolder();
    });
    placeholderFolderLink.on("pointerover", () => {
      placeholderFolderLink.style.fill = FOLDER_LINK_HOVER_FILL;
    });
    placeholderFolderLink.on("pointerout", () => {
      placeholderFolderLink.style.fill = FOLDER_LINK_FILL;
    });

    // -- keyboard shortcuts — see keyboard-shortcuts-handler.ts. --------------
    //
    // matches keyboard-shortcuts-control.ts's SHORTCUTS_LIST — keep the two
    // in sync by hand whenever a shortcut is added/changed/removed.
    const keyboardHandler = createKeyboardShortcutsHandler({
      isPointerInsideWidget: () => pointerInsideWidget,
      getVideo: () => mediaOverlay?.video ?? null,
      isKeyboardAcquired: () => ctx.keyboard.isAcquired,
      getVideoFps: () => ctx.doc.current.videoFps,
      getTimeline: () => timeline,
      getCutTrack: () => cutTrack,
      getAudioClipsTrack: () => audioClipsTrack,
      getKeyboardShortcutsControl: () => keyboardShortcutsControl,
      changeDoc: (fn) => ctx.doc.change(fn),
      onCutSegmentCreated: () => {
        cutTrack?.refresh();
        pushHistory();
      },
      undo,
      redo,
    });
    document.addEventListener("keydown", keyboardHandler.handleKeyDown);

    // -- "widget → track" drag (drop an audio-recording/tts widget onto the
    // audio clips track) + its inverse ("track → widget" drag) — see
    // audio-clip-drag.ts. -----------------------------------------------------
    /** walk up from this widget's own root container to the shared pan/zoom
     *  "world" container — same 3-levels-up hierarchy every widget's own
     *  container sits inside (contentContainer → frame.root → world), per
     *  bin-drag.ts's own `getWorld()` helper. shared by the splitter drag's
     *  zoom lookup below too, not just the audio-clip drag controller. */
    function findWorldContainer(): Container {
      let current: Container = container;
      for (let i = 0; i < 3 && current.parent; i++) {
        current = current.parent;
      }
      return current;
    }

    const audioClipDrag = createAudioClipDragController({
      store,
      repo,
      registry,
      findWorldContainer,
      getTimeline: () => timeline,
      getCurrentWidth: () => currentWidth,
      timelineInset: TIMELINE_INSET,
      changeDoc: (fn) => ctx.doc.change(fn),
      onClipAdded: () => {
        // matches every other local mutation handler in this file — the
        // doc-change subscription alone doesn't reliably redraw our own
        // local edit in the same tick.
        audioClipsTrack?.refresh();
        pushHistory();
      },
    });
    const handleAudioClipDragOut = audioClipDrag.handleAudioClipDragOut;

    return {
      container,

      editableProps: [
        {
          key: "micDeviceLabel",
          label: "mic input device",
          type: "select" as const,
          options: micDeviceOptions,
          default: MIC_DEVICE_DEFAULT,
        },
      ],

      widgetActions: [
        { id: "load-reference-data", label: "load reference data...", onClick: handleLoadReferenceData },
        { id: "load-reference-data-folder", label: "load project folder...", onClick: handleLoadReferenceDataFolder },
        { id: "download-cut-manifest", label: "download cut manifest...", onClick: downloadCutManifest },
        {
          id: "download-audio-clips",
          label: isTauriMode() ? "download audio clips" : "download bundle",
          onClick: downloadAudioClips,
        },
        {
          id: "snatch-all-blobs",
          label: "snatch all",
          onClick: () => void snatchController.handleSnatchAll(),
        },
      ],

      widgetInfoRows: () => {
        const { known, local } = snatchController.getLocalityCounts();
        if (known === 0) return [];
        return [{ label: "blobs", value: `${local}/${known} local` }];
      },

      dropTarget: audioClipDrag.dropTarget,

      resize(w: number, h: number) {
        applyLayout(w, h);
      },

      destroy() {
        destroyed = true;
        uploadCancelled = true;
        uploadAbort?.abort();
        snatchController.destroy();
        referenceDataMessages.destroy();
        document.removeEventListener("keydown", keyboardHandler.handleKeyDown);
        audioClipDrag.destroy();
        unsubscribe();
        audioClipPlayback.stop();
        teardownMediaOverlay();
        teardownTimeline();
      },
    };
  },
};

// -----------------------------------------------------------------------
// registry bootstrapping
// -----------------------------------------------------------------------

// module-level reference set by registerStfuWidget() so the widget's own
// create() can look up other widget types' factories/schemas at runtime
// (needed by the "widget → track" dropTarget above to read a dragged
// audio-recording/tts widget's doc) — mirrors bin/index.ts's identical
// _binWidgetRegistry pattern.
let _stfuWidgetRegistry: WidgetRegistry | null = null;

/**
 * register the stfu widget and stash the registry reference so the widget
 * can look up other widget factories at runtime (for its dropTarget).
 */
export function registerStfuWidget(registry: WidgetRegistry): void {
  _stfuWidgetRegistry = registry;
  registry.register(stfuWidget);
}

