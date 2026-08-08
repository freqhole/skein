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

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { getLocalNodeId, guessMimeFromFilename, type PeersMap } from "../../src/file-utils/file-shared";
import { pickFiles, pickJsonFile, readPickedFileText, uploadFile } from "../../src/file-utils/upload";
import { getMediaPlaybackUrl } from "../../src/media";
import { createMediaDomOverlay, type MediaDomOverlayHandle } from "../../src/widgets/media-dom-overlay";
import { createCutModeControl, CUT_MODE_CONTROL_RESERVED_WIDTH, type CutModeControlHandle } from "./cut-mode-control";
import { createCutSegmentsTrack, type CutSegmentsTrackHandle, type EditableSegment } from "./cut-segments-track";
import { mergeCombinedData, mergeDiarizeData, mergeTranscribeData, parseReferenceDataJson } from "./reference-data";
import { createReferenceTrack, type ReferenceTrackHandle } from "./reference-track";
import { createVideoTimeline, TIMELINE_SHELL_HEIGHT, type VideoTimelineHandle } from "./video-timeline";
import type {
  CompactInfo,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../../src/widgets/widget-types";
import { stfuSchema, type StfuState } from "./types";

const PADDING = 8;
const HEADER_HEIGHT = 20;
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
    defaultWidth: 480,
    defaultHeight: 320,
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
  }),

  create(ctx: WidgetMountContext<typeof stfuSchema>): WidgetController {
    const container = new Container();
    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let destroyed = false;

    // only the peer who created this widget can use the initial "click to
    // upload" step — mirrors file.ts's iAmCreator gate, avoiding two peers
    // racing to upload into the same empty stfu widget.
    const iAmCreator = !ctx.canvasStore || ctx.canvasStore.isLocalWidgetCreator(ctx.widgetId);

    let loadState: LoadState = ctx.doc.current.videoBlobId ? "ready" : "empty";

    let uploadAbort: AbortController | null = null;
    let uploadCancelled = false;
    let statusMessage = "";
    let progressText = "";
    // transient feedback for the "load reference data..." action — shown
    // appended to the header line (statusMessage above is only ever shown
    // in the pre-upload "empty" placeholder state, not once a video is
    // loaded, so reference-data feedback needed its own surface).
    let referenceDataMessage = "";
    let referenceDataMessageTimer: ReturnType<typeof setTimeout> | null = null;
    let loadedVideoKey = "";
    let mediaOverlay: MediaDomOverlayHandle | null = null;
    let timeline: VideoTimelineHandle | null = null;
    let cutTrack: CutSegmentsTrackHandle | null = null;
    let cutModeControl: CutModeControlHandle | null = null;
    let referenceTrack: ReferenceTrackHandle | null = null;
    let cutOverlayEl: HTMLDivElement | null = null;
    let timeUpdateHandler: (() => void) | null = null;

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

    // -- header (filename / duration / status) ----------------------------------

    const headerText = new Text({
      text: "",
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 11,
        fill: 0x94a3b8,
      },
      resolution: typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2,
    });
    headerText.x = PADDING;
    headerText.y = PADDING;
    container.addChild(headerText);

    // dedicated child container whose local (0,0) is the video area's own
    // top-left (below the header row) — createMediaDomOverlay tracks *this*
    // container's bounds, so the DOM video element is positioned correctly
    // without needing a CSS margin hack on the video itself.
    const videoArea = new Container();
    videoArea.y = HEADER_HEIGHT;
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
        fontSize: 12,
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

    // -- cut-playback local-only prefs (overlay display + mute latency-comp ms) --
    // never part of the automerge doc — these don't affect the exported/rendered
    // output, only how this browser instance previews cuts locally (mirrors
    // trek-minus-paris's localStorage-vs-manifest split — see docs/stfu-widget-plan.md).

    interface LocalCutPrefs {
      overlayEnabled: boolean;
      muteEarlyMs: number;
    }

    const localPrefsKey = `skein.stfu.${ctx.widgetId}.cutPlaybackPrefs`;

    function loadLocalPrefs(): LocalCutPrefs {
      try {
        const raw = localStorage.getItem(localPrefsKey);
        if (!raw) return { overlayEnabled: false, muteEarlyMs: 150 };
        const parsed = JSON.parse(raw);
        return {
          overlayEnabled: Boolean(parsed.overlayEnabled),
          muteEarlyMs: typeof parsed.muteEarlyMs === "number" ? parsed.muteEarlyMs : 150,
        };
      } catch {
        return { overlayEnabled: false, muteEarlyMs: 150 };
      }
    }

    function saveLocalPrefs(): void {
      try {
        localStorage.setItem(localPrefsKey, JSON.stringify(localPrefs));
      } catch {
        // private browsing / storage disabled / quota exceeded — not fatal, prefs just don't persist
      }
    }

    let localPrefs = loadLocalPrefs();

    // -- cut-overlay DOM element (the "overlay cuts" playback effect) ------------
    // a red-tinted fade-in indicator over the video while the playhead is
    // inside a cut segment — appended into the media overlay's own wrapper
    // div (see media-dom-overlay.ts) so it's torn down automatically
    // alongside the video element. direct port of trek-minus-paris
    // editor.js's `#cut-overlay` (see editor.css), including the giant
    // red "×" mark above the "cut" label.

    function createCutOverlayEl(): HTMLDivElement {
      const el = document.createElement("div");
      const s = el.style;
      s.position = "absolute";
      s.inset = "0";
      s.display = "flex";
      s.flexDirection = "column";
      s.alignItems = "center";
      s.justifyContent = "center";
      s.gap = "0.5rem";
      s.background = "rgba(200, 0, 0, 0.18)";
      s.opacity = "0";
      s.pointerEvents = "none";
      s.transition = "opacity 0.08s ease";

      const xMark = document.createElement("div");
      xMark.textContent = "\u00d7";
      const xs = xMark.style;
      xs.fontSize = "9rem";
      xs.lineHeight = "1";
      xs.fontWeight = "700";
      xs.color = "rgba(255, 45, 45, 0.9)";
      xs.textShadow = "0 0 24px rgba(0, 0, 0, 0.7)";

      const label = document.createElement("div");
      label.textContent = "cut";
      const ls = label.style;
      ls.fontSize = "1.1rem";
      ls.fontWeight = "600";
      ls.letterSpacing = "0.25em";
      ls.textTransform = "uppercase";
      ls.color = "rgba(255, 255, 255, 0.92)";
      ls.background = "rgba(0, 0, 0, 0.55)";
      ls.padding = "0.2rem 0.9rem";
      ls.borderRadius = "4px";

      el.appendChild(xMark);
      el.appendChild(label);
      return el;
    }

    function setCutOverlayActive(active: boolean): void {
      if (cutOverlayEl) cutOverlayEl.style.opacity = active ? "1" : "0";
    }

    // -- cut-playback effects (skip / overlay / mute) -----------------------------

    function findContainingSegment(t: number): EditableSegment | null {
      for (const seg of ctx.doc.current.editableSegments) {
        if (t >= seg[0] && t < seg[1]) return seg;
      }
      return null;
    }

    function applyCutPlaybackEffects(): void {
      if (!mediaOverlay) return;
      const video = mediaOverlay.video;
      const state = ctx.doc.current;

      if (state.cutSkipEnabled) {
        setCutOverlayActive(false);
        video.muted = false;
        if (video.paused || video.seeking) return;
        let seg = findContainingSegment(video.currentTime);
        let guard = 0;
        while (seg && guard < 10) {
          video.currentTime = Math.min(video.duration || seg[1], seg[1] + 0.01);
          seg = findContainingSegment(video.currentTime);
          guard++;
        }
        return;
      }

      const seg = findContainingSegment(video.currentTime);
      setCutOverlayActive(localPrefs.overlayEnabled && Boolean(seg));
      const upcomingSeg = findContainingSegment(video.currentTime + localPrefs.muteEarlyMs / 1000);
      video.muted = state.cutMuteEnabled && Boolean(upcomingSeg);
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

    // -- reference data (diarization/transcript) load ------------------------------

    async function handleLoadReferenceData(): Promise<void> {
      if (destroyed) return;
      if (ctx.canvasStore?.isLocalViewer()) return;

      // immediate feedback before the (possibly slow, modal) file picker
      // opens — without this the widget looked "locked up" with no
      // indication anything was happening.
      setReferenceDataMessage("loading reference data…", 0);

      const picked = await pickJsonFile();
      if (destroyed) return;
      if (!picked) {
        setReferenceDataMessage("");
        return;
      }

      let raw: unknown;
      try {
        const text = await readPickedFileText(picked);
        raw = JSON.parse(text);
      } catch (err) {
        console.error("stfu widget: failed to read/parse reference data json:", err);
        setReferenceDataMessage(`could not read "${picked.filename}" — not valid json`);
        return;
      }
      if (destroyed) return;

      const parsed = parseReferenceDataJson(raw);
      if (!parsed) {
        setReferenceDataMessage(
          `"${picked.filename}" doesn't match the expected diarization or transcript json shape`
        );
        return;
      }

      let summary = "";
      ctx.doc.change((d) => {
        if (parsed.kind === "diarize") {
          const speakerCount = Object.keys(parsed.ranges).length;
          const merged = mergeDiarizeData(d.referenceSpeakers, d.transcriptSegments, parsed);
          d.referenceSpeakers = merged.referenceSpeakers;
          d.transcriptSegments = merged.transcriptSegments;
          const hasTranscriptText = merged.transcriptSegments.some((s) => s.text);
          summary =
            `loaded diarization: ${speakerCount} speaker(s)` +
            (hasTranscriptText ? "" : " — now load the matching transcript json for text");
        } else if (parsed.kind === "transcribe") {
          d.transcriptSegments = mergeTranscribeData(d.transcriptSegments, parsed);
          const hasSpeakers = Object.keys(d.referenceSpeakers).length > 0;
          summary =
            `loaded transcript: ${parsed.segments.length} segment(s)` +
            (hasSpeakers ? "" : " — now load the matching diarization json for speaker labels");
        } else {
          const speakerCount = Object.keys(parsed.ranges).length;
          const merged = mergeCombinedData(d.referenceSpeakers, d.transcriptSegments, parsed);
          d.referenceSpeakers = merged.referenceSpeakers;
          d.transcriptSegments = merged.transcriptSegments;
          summary = `loaded reference data: ${speakerCount} speaker(s), ${parsed.segments.length} segment(s)`;
        }
      });
      referenceTrack?.refresh();
      setReferenceDataMessage(summary);
    }

    // -- helpers -----------------------------------------------------------------

    function syncVisibility(): void {
      const showPlaceholder = loadState !== "ready";
      placeholderBorder.visible = showPlaceholder;
      placeholderText.visible = showPlaceholder;
    }

    function refresh(): void {
      syncVisibility();
      const state = ctx.doc.current;
      if (loadState === "loading") {
        placeholderText.text = progressText || "uploading…";
      } else if (loadState === "empty") {
        placeholderText.text = statusMessage || (iAmCreator ? "click to upload video" : "waiting for video");
      }
      headerText.text =
        loadState === "ready"
          ? [
              state.videoFilename,
              state.videoDurationSec ? `${Math.round(state.videoDurationSec)}s` : null,
              referenceDataMessage || null,
            ]
              .filter(Boolean)
              .join(" · ")
          : "";
    }

    function setReferenceDataMessage(message: string, autoClearMs = 6000): void {
      referenceDataMessage = message;
      refresh();
      if (referenceDataMessageTimer !== null) {
        clearTimeout(referenceDataMessageTimer);
        referenceDataMessageTimer = null;
      }
      if (message && autoClearMs > 0) {
        referenceDataMessageTimer = setTimeout(() => {
          referenceDataMessageTimer = null;
          referenceDataMessage = "";
          refresh();
        }, autoClearMs);
      }
    }

    function teardownMediaOverlay(): void {
      if (mediaOverlay && timeUpdateHandler) {
        mediaOverlay.video.removeEventListener("timeupdate", timeUpdateHandler);
      }
      timeUpdateHandler = null;
      mediaOverlay?.close();
      mediaOverlay = null;
      cutOverlayEl = null;
      loadedVideoKey = "";
    }

    function teardownTimeline(): void {
      cutModeControl?.destroy();
      cutModeControl = null;
      cutTrack?.destroy();
      cutTrack = null;
      referenceTrack?.destroy();
      referenceTrack = null;
      timeline?.destroy();
      timeline = null;
    }

    function ensureTimeline(): VideoTimelineHandle {
      if (timeline) return timeline;
      timeline = createVideoTimeline(Math.max(0, currentWidth - TIMELINE_INSET * 2));
      timeline.container.x = TIMELINE_INSET;
      timeline.container.y = currentHeight - TIMELINE_SHELL_HEIGHT - PADDING;
      timeline.setDuration(ctx.doc.current.videoDurationSec);
      container.addChild(timeline.container);
      cutTrack = createCutSegmentsTrack({
        timeline,
        getSegments: () => ctx.doc.current.editableSegments,
        onChange: (next: EditableSegment[]) => {
          ctx.doc.change((d) => {
            d.editableSegments = next;
          });
        },
        getDuration: () => ctx.doc.current.videoDurationSec,
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
      referenceTrack = createReferenceTrack({
        timeline,
        overlayParent: timeline.container,
        getReferenceSpeakers: () => ctx.doc.current.referenceSpeakers,
        getTranscriptSegments: () => ctx.doc.current.transcriptSegments,
        storageKey: `skein.stfu.${ctx.widgetId}.visibleSpeakers`,
      });
      referenceTrack.resize(Math.max(0, currentWidth - TIMELINE_INSET * 2));
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
          height: Math.max(0, currentHeight - HEADER_HEIGHT - TIMELINE_SHELL_HEIGHT - PADDING),
        }),
        muted: false,
        loop: false,
        controls: true,
        objectFit: "contain",
      });

      cutOverlayEl = createCutOverlayEl();
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
      };
      mediaOverlay.video.addEventListener("timeupdate", timeUpdateHandler);
    }

    function applyDocState(): void {
      const state = ctx.doc.current;
      const nextLoadState: LoadState = state.videoBlobId ? "ready" : loadState === "loading" ? "loading" : "empty";
      loadState = nextLoadState;

      if (loadState === "ready") {
        void mountMediaOverlay();
        refreshTimelineFromDoc();
      } else {
        teardownMediaOverlay();
        teardownTimeline();
      }
      refresh();
    }

    function refreshTimelineFromDoc(): void {
      timeline?.setDuration(ctx.doc.current.videoDurationSec);
      cutTrack?.refresh();
      cutModeControl?.refresh();
      referenceTrack?.refresh();
    }

    applyDocState();

    const unsubscribe = ctx.doc.on("change", () => {
      applyDocState();
    });

    // -- upload flow ---------------------------------------------------------------

    const handleUpload = async () => {
      if (destroyed) return;
      if (loadState !== "empty") return;
      if (ctx.canvasStore?.isLocalViewer()) return;
      if (!iAmCreator) return;

      const localNodeId = await getLocalNodeId();
      const cur = ctx.doc.current;
      if (
        cur.uploadingBy &&
        cur.uploadingBy !== localNodeId &&
        Date.now() - cur.uploadingAt < UPLOAD_LOCK_STALE_MS
      ) {
        return;
      }

      const picked = await pickFiles();
      if (!picked || picked.length === 0) return;
      const file = picked[0];

      const mime = file.file?.type || guessMimeFromFilename(file.filename);
      if (!mime.startsWith("video/")) {
        statusMessage = "please pick a video file";
        refresh();
        return;
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

        if (destroyed) return;

        ctx.doc.change((d) => {
          d.videoBlobId = result.blobId;
          d.videoFilename = file.filename;
          d.videoMime = result.mime;
          d.videoSize = result.size;
          d.videoBlake3 = result.blake3 || "";
          d.uploadingBy = "";
          d.uploadingAt = 0;
        });
      } catch (err) {
        if (destroyed) return;
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
      } finally {
        uploadAbort = null;
      }
    };

    placeholderText.on("pointertap", () => void handleUpload());
    placeholderBorder.on("pointertap", () => void handleUpload());

    return {
      container,

      widgetActions: [{ id: "load-reference-data", label: "load reference data...", onClick: handleLoadReferenceData }],

      resize(w: number, h: number) {
        currentWidth = w;
        currentHeight = h;
        drawBg(w, h);
        drawPlaceholderBorder(w, h);
        placeholderText.x = w / 2;
        placeholderText.y = h / 2;
        if (timeline) {
          timeline.container.y = h - TIMELINE_SHELL_HEIGHT - PADDING;
          timeline.resize(Math.max(0, w - TIMELINE_INSET * 2));
          cutModeControl?.resize(Math.max(0, w - TIMELINE_INSET * 2));
          referenceTrack?.resize(Math.max(0, w - TIMELINE_INSET * 2));
        }
      },

      destroy() {
        destroyed = true;
        uploadCancelled = true;
        uploadAbort?.abort();
        if (referenceDataMessageTimer !== null) clearTimeout(referenceDataMessageTimer);
        unsubscribe();
        teardownMediaOverlay();
        teardownTimeline();
      },
    };
  },
};
