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

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { checkBlobLocality } from "../../src/file-utils/blob-locality";
import { getLocalNodeId, guessMimeFromFilename, type PeersMap } from "../../src/file-utils/file-shared";
import { snatchBlob } from "../../src/file-utils/snatch";
import { pickFiles, pickJsonFile, readPickedFileText, uploadFile } from "../../src/file-utils/upload";
import { getMediaPlaybackUrl } from "../../src/media";
import { createMediaDomOverlay, type MediaDomOverlayHandle } from "../../src/widgets/media-dom-overlay";
import type { WidgetRegistry } from "../../src/widgets/widget-registry";
import { createAudioClipsTrack, type AudioClipsTrackHandle } from "./audio-clips-track";
import { createCutModeControl, CUT_MODE_CONTROL_RESERVED_WIDTH, type CutModeControlHandle } from "./cut-mode-control";
import { createCutSegmentsTrack, type CutSegmentsTrackHandle, type EditableSegment } from "./cut-segments-track";
import { createKeyboardShortcutsControl, type KeyboardShortcutsControlHandle } from "./keyboard-shortcuts-control";
import { mergeCombinedData, mergeDiarizeData, mergeTranscribeData, parseReferenceDataJson } from "./reference-data";
import { createReferenceTrack, type ReferenceTrackHandle } from "./reference-track";
import { createSegmentsPanel, SEGMENTS_PANEL_HEIGHT, type SegmentsPanelHandle } from "./segments-panel";
import { cancelPreview, speakPreview } from "../tts/voices";
import { AUDIO_CLIP_TRACK_HEIGHT, createVideoTimeline, TIMELINE_SHELL_HEIGHT, type VideoTimelineHandle } from "./video-timeline";
import { createVoicePickerDialog, type VoicePickerDialogHandle } from "./voice-picker-dialog";
import type {
  CompactInfo,
  HeaderAction,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../../src/widgets/widget-types";
import { stfuSchema, type AudioClip, type StfuState } from "./types";

const PADDING = 8;
const HEADER_HEIGHT = 20;
const TIMELINE_INSET = 6;
const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";

/** drop a trailing file extension for use as the widget's display title
 *  (e.g. "caretaker.mp4" -> "caretaker") — falls back to the original
 *  string unchanged if there's no extension to strip. */
function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

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
    let audioClipsTrack: AudioClipsTrackHandle | null = null;
    let cutModeControl: CutModeControlHandle | null = null;
    let referenceTrack: ReferenceTrackHandle | null = null;
    let segmentsPanel: SegmentsPanelHandle | null = null;
    let keyboardShortcutsControl: KeyboardShortcutsControlHandle | null = null;
    let voicePickerDialog: VoicePickerDialogHandle | null = null;
    let cutOverlayEl: HTMLDivElement | null = null;
    let timeUpdateHandler: (() => void) | null = null;
    let pauseHandler: (() => void) | null = null;
    // audio-clips playback while the video plays — either the clip's own
    // generated/recorded audio file (`clipAudioEl`, lazily created) or, for
    // a clip that hasn't been generated yet, a live speechSynthesis reading
    // of its `ttsText` (see applyAudioClipPlayback() below).
    let clipAudioEl: HTMLAudioElement | null = null;
    let activeAudioClipId: string | null = null;

    // -- "snatch" header action for peers that don't have the video blob
    // locally yet (see docs/stfu-widget-plan.md) — mirrors peedeeeff/index.ts's
    // simpler-than-file.ts single-blob locality-check + snatch flow (stfu
    // only ever has one video blob to worry about, unlike file.ts's paused/
    // friend-request states built for arbitrary large downloads).
    type VideoActionState = "idle" | "checking" | "local" | "remote" | "snatching";
    let videoActionState: VideoActionState = "idle";
    let videoSnatchAbort: AbortController | null = null;
    let videoSnatchCancelled = false;
    let videoSnatchProgressText = "";
    // guards against re-probing locality on every doc-change tick — only
    // re-check when the blob identity actually changes (new upload/snatch).
    let checkedVideoLocalityKey = "";

    function updateVideoHeaderActions(): void {
      if (!ctx.setHeaderActions) return;
      const actions: HeaderAction[] = [];
      if (videoActionState === "remote") {
        actions.push({
          id: "snatch-video",
          label: "snatch video",
          onClick: () => void handleSnatchVideo(),
        });
      } else if (videoActionState === "snatching") {
        actions.push({
          id: "snatch-video",
          label: videoSnatchProgressText || "snatching…",
          disabled: true,
        });
      }
      ctx.setHeaderActions(actions);
    }

    async function checkVideoLocality(): Promise<void> {
      const state = ctx.doc.current;
      if (!state.videoBlobId) {
        videoActionState = "idle";
        updateVideoHeaderActions();
        return;
      }
      const key = `${state.videoBlobId}:${state.videoBlake3}`;
      if (key === checkedVideoLocalityKey) return;
      checkedVideoLocalityKey = key;
      videoActionState = "checking";
      updateVideoHeaderActions();
      try {
        const info = await checkBlobLocality(state.videoBlobId, state.videoBlake3 || undefined);
        if (destroyed) return;
        videoActionState = info.locality === "local" ? "local" : "remote";
      } catch (err) {
        if (destroyed) return;
        console.error("stfu widget: video locality check failed:", err);
        videoActionState = "remote";
      }
      updateVideoHeaderActions();
    }

    async function handleSnatchVideo(): Promise<void> {
      if (videoActionState !== "remote") return;
      const state = ctx.doc.current;
      const allPeers = ctx.canvasStore?.peers();
      if (!allPeers || Object.keys(allPeers).length === 0) {
        console.warn("stfu widget: no peers available for snatch");
        return;
      }

      videoSnatchCancelled = false;
      videoSnatchAbort = new AbortController();
      videoActionState = "snatching";
      videoSnatchProgressText = "probing…";
      updateVideoHeaderActions();

      try {
        await snatchBlob(
          {
            blobId: String(state.videoBlobId || ""),
            filename: String(state.videoFilename || ""),
            mime: String(state.videoMime || ""),
            size: state.videoSize || 0,
            blake3: String(state.videoBlake3 || ""),
            domain: "video",
          },
          allPeers as PeersMap,
          {
            onProgress: (fraction) => {
              if (videoSnatchCancelled || destroyed) return;
              videoSnatchProgressText = fraction >= 0 ? `${Math.round(fraction * 100)}%` : "snatching…";
              updateVideoHeaderActions();
            },
            signal: videoSnatchAbort?.signal,
            isPeerOnline: ctx.canvasStore ? (nodeId: string) => ctx.canvasStore!.isPeerOnline(nodeId) : undefined,
          }
        );

        if (videoSnatchCancelled || destroyed) return;
        videoActionState = "local";
        videoSnatchProgressText = "";
        updateVideoHeaderActions();
        // the blob is now locally available but nothing else changed
        // (blobId/blake3 are unchanged, so mountMediaOverlay()'s own
        // dedup guard wouldn't otherwise retry) — force a fresh attempt so
        // the video renders right away instead of only after the widget is
        // unmounted/remounted (e.g. by leaving and returning to the canvas).
        loadedVideoKey = "";
        void mountMediaOverlay();
      } catch (err) {
        if (videoSnatchCancelled || destroyed) return;
        console.error("stfu widget: video snatch failed:", err);
        videoActionState = "remote";
        videoSnatchProgressText = "";
        updateVideoHeaderActions();
      } finally {
        videoSnatchAbort = null;
      }
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

    // -- audio-clip playback (tts speech synth / generated audio file / recording) --

    // a not-yet-generated clip has no real `durationSec` yet — estimate a
    // rough speaking length from its text just to gate *when* playback
    // should start; the actual stop is driven by speechSynthesis's own
    // "end" event, not this estimate.
    function estimatedClipDuration(clip: AudioClip): number {
      if (clip.durationSec > 0) return clip.durationSec;
      const chars = (clip.ttsText || "").length;
      const rate = clip.ttsRate || 1;
      return Math.max(1, chars / (12 * rate));
    }

    function stopClipAudio(): void {
      if (!activeAudioClipId) return;
      cancelPreview();
      clipAudioEl?.pause();
      activeAudioClipId = null;
    }

    async function playClipAudioFile(clip: AudioClip, offset: number): Promise<void> {
      if (!clip.audioBlobId) return;
      const peers = ctx.canvasStore?.peers() as PeersMap | undefined;
      const url = await getMediaPlaybackUrl(clip.audioBlobId, {
        category: "audio",
        mime: clip.audioMime,
        blake3: clip.audioBlake3 || undefined,
        peers,
      });
      if (destroyed || activeAudioClipId !== clip.id || !url) return;
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

    function applyAudioClipPlayback(): void {
      if (!mediaOverlay) return;
      const video = mediaOverlay.video;
      if (video.paused) {
        stopClipAudio();
        return;
      }
      const t = video.currentTime;
      if (activeAudioClipId) {
        const activeClip = ctx.doc.current.audioClips.find((c) => c.id === activeAudioClipId);
        // grace window past the estimate — the real stop is the clip's own
        // "ended"/speechSynthesis callback, not this check; only force-stop
        // once the playhead has clearly moved away from the clip entirely
        // (e.g. the user scrubbed elsewhere mid-clip).
        if (activeClip && t >= activeClip.start - 0.25 && t <= activeClip.start + estimatedClipDuration(activeClip) + 1) {
          return;
        }
        stopClipAudio();
      }
      const clip = ctx.doc.current.audioClips.find(
        (c) => (c.audioBlobId || c.ttsText) && t >= c.start && t < c.start + estimatedClipDuration(c)
      );
      if (clip) startClipAudio(clip, Math.max(0, t - clip.start));
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

    /**
     * download the cut list as a manifest json compatible with
     * trek-minus-paris's `process.py --cut-list` arg — matches the "newer"
     * object shape `editor.py`'s `load_manual_cuts_file()` already accepts
     * (`{segments, cut_skip_enabled, cut_mute_enabled}`), so no translation
     * step is needed on the python side. audio-clip data isn't included —
     * `process.py`'s separate `--dub-segments` arg uses an unrelated shape
     * (see docs/stfu-widget-plan.md's phase-6 export section).
     */
    function downloadCutManifest(): void {
      const state = ctx.doc.current;
      const manifest = {
        segments: state.editableSegments,
        cut_skip_enabled: state.cutSkipEnabled,
        cut_mute_enabled: state.cutMuteEnabled,
      };
      const json = JSON.stringify(manifest, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const baseName = stripExtension(state.videoFilename || "cut-manifest");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}_manual_cuts.json`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1000);
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
      cutModeControl?.destroy();
      cutModeControl = null;
      keyboardShortcutsControl?.destroy();
      keyboardShortcutsControl = null;
      voicePickerDialog?.destroy();
      voicePickerDialog = null;
      cutTrack?.destroy();
      cutTrack = null;
      audioClipsTrack?.destroy();
      audioClipsTrack = null;
      referenceTrack?.destroy();
      referenceTrack = null;
      segmentsPanel?.destroy();
      segmentsPanel = null;
      timeline?.destroy();
      timeline = null;
    }

    // vertical space the timeline shell reserves above the bottom edge, now
    // that the segments panel also lives down there (below the timeline,
    // per the plan doc's "below/beside-timeline list of rows" wording).
    function timelineY(h: number): number {
      return h - SEGMENTS_PANEL_HEIGHT - PADDING - TIMELINE_SHELL_HEIGHT - PADDING;
    }
    function segmentsPanelY(h: number): number {
      return h - SEGMENTS_PANEL_HEIGHT - PADDING;
    }

    function ensureTimeline(): VideoTimelineHandle {
      if (timeline) return timeline;
      timeline = createVideoTimeline(Math.max(0, currentWidth - TIMELINE_INSET * 2), ctx.canvasElement, (t) => {
        if (mediaOverlay) mediaOverlay.video.currentTime = t;
      });
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
        onSelectionChange: (seg) => segmentsPanel?.setSelectedSegment(seg),
      });
      audioClipsTrack = createAudioClipsTrack({
        timeline,
        getClips: () => ctx.doc.current.audioClips,
        onChange: (next) => {
          ctx.doc.change((d) => {
            d.audioClips = next;
          });
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
        canvasElement: ctx.canvasElement,
        getReferenceSpeakers: () => ctx.doc.current.referenceSpeakers,
        getTranscriptSegments: () => ctx.doc.current.transcriptSegments,
        storageKey: `skein.stfu.${ctx.widgetId}.visibleSpeakers`,
        // the speaker popover is allowed to cover the rest of the timeline
        // shell + the segments panel below it while open (it's modal-ish),
        // but must still fit inside the widget's own clipped bounds.
        overlayMaxHeight: TIMELINE_SHELL_HEIGHT + PADDING + SEGMENTS_PANEL_HEIGHT + PADDING,
        // drag a reference/diarization segment down into the cut list to
        // create a new editable segment snapped exactly to its start/end
        // (it can then be resized like any other cut-list segment).
        onCreateCutSegment: (start, end) => {
          ctx.doc.change((d) => {
            d.editableSegments = [...d.editableSegments, [start, end]];
          });
          // unlike remote peers' edits (handled by the doc-change
          // subscription below), our own local edit needs an immediate
          // refresh here too, matching every other local mutation handler
          // in this file (`handleToggleSkip` etc) — otherwise the new
          // segment doesn't visually appear until some unrelated redraw.
          cutTrack?.refresh();
        },
      });
      referenceTrack.resize(Math.max(0, currentWidth - TIMELINE_INSET * 2));
      segmentsPanel = createSegmentsPanel({
        canvasElement: ctx.canvasElement,
        getEditableSegments: () => ctx.doc.current.editableSegments,
        getTranscriptSegments: () => ctx.doc.current.transcriptSegments,
        getReferenceSpeakers: () => ctx.doc.current.referenceSpeakers,
        getAudioClips: () => ctx.doc.current.audioClips,
        onSeek: (t: number) => {
          if (mediaOverlay) mediaOverlay.video.currentTime = t;
        },
        onClipTextCommit: (clip, text) => {
          ctx.doc.change((d) => {
            const idx = d.audioClips.findIndex((c) => c.id === clip.id);
            if (idx === -1) return;
            d.audioClips[idx].ttsText = text;
          });
        },
        onClipGenerate: (clip, text, result, voiceName, voiceLang, rate) => {
          ctx.doc.change((d) => {
            const idx = d.audioClips.findIndex((c) => c.id === clip.id);
            if (idx === -1) return;
            const target = d.audioClips[idx];
            target.audioBlobId = result.blobId;
            target.audioBlake3 = result.blake3;
            target.audioMime = result.mime;
            target.durationSec = result.duration;
            target.ttsText = text;
            target.ttsVoiceName = voiceName;
            target.ttsVoiceLang = voiceLang;
            target.ttsRate = rate;
            if (!target.label) target.label = text.slice(0, 40);
          });
        },
        onOpenVoicePicker: (opts) => voicePickerDialog?.open(opts),
        storageKey: `skein.stfu.${ctx.widgetId}.segmentsPanel`,
      });
      segmentsPanel.container.x = TIMELINE_INSET;
      segmentsPanel.container.y = segmentsPanelY(currentHeight);
      container.addChild(segmentsPanel.container);
      segmentsPanel.resize(Math.max(0, currentWidth - TIMELINE_INSET * 2));
      // re-add `timeline.container` so it renders ABOVE `segmentsPanel.container`
      // (siblings render in addChild order) — the reference speaker popover
      // (mounted inside `timeline.container`) is deliberately allowed to
      // extend down over the segments panel while open (see its
      // `overlayMaxHeight`), which only actually shows on top if the timeline
      // itself is the later sibling.
      container.addChild(timeline.container);
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
            currentHeight - HEADER_HEIGHT - SEGMENTS_PANEL_HEIGHT - PADDING - TIMELINE_SHELL_HEIGHT - PADDING
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
        applyAudioClipPlayback();
        if (mediaOverlay) segmentsPanel?.onTimeUpdate(mediaOverlay.video.currentTime);
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
        void checkVideoLocality();
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
      audioClipsTrack?.refresh();
      cutModeControl?.refresh();
      referenceTrack?.refresh();
      segmentsPanel?.refresh();
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
        // name the widget after the video so it's identifiable in the layer
        // flyout/property tray instead of showing generically as "stfu".
        ctx.canvasStore?.setWidgetTitle(ctx.widgetId, stripExtension(file.filename));
        void checkVideoLocality();
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

    // -- keyboard shortcuts --------------------------------------------------
    //
    // matches keyboard-shortcuts-control.ts's SHORTCUTS_LIST — keep the two
    // in sync by hand whenever a shortcut is added/changed/removed.

    /** in-point set by `i`, consumed by `o` to create a cut segment — mirrors
     *  editor.js's own in/out marking convention. cleared once consumed, or
     *  whenever a new `i` overwrites it. */
    let pendingInTime: number | null = null;

    function frameDuration(): number {
      const fps = ctx.doc.current.videoFps;
      return fps > 0 ? 1 / fps : 1 / 30;
    }

    /** creates a new cut-list segment spanning [start, end] (order-
     *  independent) — shared by the `o` shortcut and (eventually) any other
     *  in/out-marking gesture. too-short spans are silently dropped, same
     *  threshold `cut-segments-track.ts`'s own create-drag gesture uses. */
    function createCutSegment(start: number, end: number): void {
      const s = Math.min(start, end);
      const eTime = Math.max(start, end);
      if (eTime - s < 0.05) return;
      ctx.doc.change((d) => {
        d.editableSegments = [...d.editableSegments, [s, eTime]];
      });
      cutTrack?.refresh();
    }

    function handleKeyDown(e: KeyboardEvent): void {
      if (!pointerInsideWidget || !mediaOverlay) return;
      // some other widget's text-input overlay (label/notepad/markdown) may
      // currently hold the keyboard driver — don't steal its keystrokes just
      // because the mouse happens to be hovering this widget.
      if (ctx.keyboard.isAcquired) return;

      const video = mediaOverlay.video;
      const seekAmount = e.shiftKey ? 10 : 1;
      switch (e.key) {
        case " ":
          if (video.paused) void video.play();
          else video.pause();
          break;
        case "ArrowLeft":
          video.currentTime = Math.max(0, video.currentTime - seekAmount);
          break;
        case "ArrowRight":
          video.currentTime = Math.min(video.duration || video.currentTime, video.currentTime + seekAmount);
          break;
        case "+":
        case "=":
          timeline?.zoomIn();
          break;
        case "-":
        case "_":
          timeline?.zoomOut();
          break;
        case "0":
          timeline?.zoomFit();
          break;
        case "i":
        case "I":
          pendingInTime = video.currentTime;
          break;
        case "o":
        case "O":
          if (pendingInTime !== null) {
            createCutSegment(pendingInTime, video.currentTime);
            pendingInTime = null;
          }
          break;
        case "Delete":
        case "Backspace":
          cutTrack?.deleteSelected();
          break;
        case ",":
          video.currentTime = Math.max(0, video.currentTime - frameDuration());
          break;
        case ".":
          video.currentTime = Math.min(video.duration || video.currentTime, video.currentTime + frameDuration());
          break;
        case "[":
          cutTrack?.trimSelectedStartTo(video.currentTime);
          break;
        case "]":
          cutTrack?.trimSelectedEndTo(video.currentTime);
          break;
        case "s":
        case "S":
          timeline?.toggleSnap();
          break;
        case "/":
        case "?":
          keyboardShortcutsControl?.toggle();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", handleKeyDown);

    // -- "widget → track" drag: drop an audio-recording/tts widget onto the
    // audio clips track -----------------------------------------------------
    //
    // mirrors bin/index.ts's own dropTarget exactly in mechanics (hitTest/
    // onHover/onLeave/onDrop, pointer-position-based, no HTML5 DnD), but the
    // outcome is "move" not "nest": the dragged widget is removed from the
    // canvas entirely and a new AudioClip referencing the same audioBlobId
    // (content-addressed, so no byte copy) is appended to this doc — see
    // docs/stfu-widget-plan.md's cross-widget drag-and-drop section.
    const DROPPABLE_TYPES = new Set(["audio-recording", "tts", "voice-recording"]);

    /** walk up from this widget's own root container to the shared pan/zoom
     *  "world" container — same 3-levels-up hierarchy every widget's own
     *  container sits inside (contentContainer → frame.root → world), per
     *  bin-drag.ts's own `getWorld()` helper. */
    function findWorldContainer(): Container {
      let current: Container = container;
      for (let i = 0; i < 3 && current.parent; i++) {
        current = current.parent;
      }
      return current;
    }

    /** convert a `dropTarget` callback's world-space point into the audio
     *  clips row's own local coordinate frame (x=0 at the row's left edge,
     *  matching `timeline.screenXToTime()`'s convention) — returns null if
     *  the timeline isn't mounted yet. */
    function toAudioClipsLocal(worldX: number, worldY: number): { x: number; y: number } | null {
      if (!timeline) return null;
      const world = findWorldContainer();
      return timeline.audioClipsHitArea.toLocal({ x: worldX, y: worldY }, world);
    }

    let dropHighlight: Graphics | null = null;
    function setAudioClipsDropHighlight(active: boolean): void {
      if (!active) {
        dropHighlight?.destroy();
        dropHighlight = null;
        return;
      }
      if (!timeline) return;
      if (!dropHighlight) {
        dropHighlight = new Graphics();
        dropHighlight.eventMode = "none";
        timeline.audioClipsHitArea.addChild(dropHighlight);
      }
      const rowWidth = Math.max(0, currentWidth - TIMELINE_INSET * 2);
      dropHighlight
        .clear()
        .rect(0, 0, rowWidth, AUDIO_CLIP_TRACK_HEIGHT)
        .stroke({ width: 2, color: 0xe619b3 });
    }

    /** read a dropped widget's doc (audio-recording or tts shape) via the
     *  repo/registry, same pattern as bin-drag.ts's readLabel(). returns
     *  null if the doc isn't readable yet or isn't a droppable type. */
    function readDroppedAudioState(
      entryType: string,
      docId: string | null,
    ): { blobId: string; blake3: string; mime: string; duration: number; filename?: string; ttsText?: string; ttsVoiceName?: string; ttsVoiceLang?: string; ttsRate?: number } | null {
      if (!repo || !registry || !docId || !DROPPABLE_TYPES.has(entryType)) return null;
      const factory = registry.get(entryType);
      if (!factory?.schema) return null;
      try {
        const handle = repo.handles[docId as DocumentId];
        const rawDoc = handle?.doc();
        if (!rawDoc) return null;
        const state = factory.schema.parse(rawDoc) as Record<string, unknown>;
        if (!state.blobId) return null; // nothing generated/recorded yet — no audio to place
        return {
          blobId: String(state.blobId),
          blake3: typeof state.blake3 === "string" ? state.blake3 : "",
          mime: typeof state.mime === "string" ? state.mime : "",
          duration: typeof state.duration === "number" ? state.duration : 0,
          filename: typeof state.filename === "string" ? state.filename : undefined,
          ttsText: typeof state.ttsText === "string" ? state.ttsText : undefined,
          ttsVoiceName: typeof state.ttsVoiceName === "string" ? state.ttsVoiceName : undefined,
          ttsVoiceLang: typeof state.ttsVoiceLang === "string" ? state.ttsVoiceLang : undefined,
          ttsRate: typeof state.ttsRate === "number" ? state.ttsRate : undefined,
        };
      } catch {
        return null;
      }
    }

    // -- "track → widget" drag (inverse): lift a clip off the audio-clips
    // track back onto the open canvas as its own standalone widget --------
    //
    // mirrors createFileWidgetFromBlob's own repo.create()+store.addWidget()
    // pattern exactly. a clip with `ttsText` becomes a `tts` widget (so it
    // stays editable/regeneratable); anything else becomes a plain
    // `audio-recording` widget — same content-addressed `blobId`, no byte
    // copy, matching the "move not copy" semantics of the "widget → track"
    // direction above.
    async function handleAudioClipDragOut(clip: AudioClip, worldX: number, worldY: number): Promise<void> {
      if (!store || !repo || !registry || !clip.audioBlobId) return;
      const type = clip.ttsText ? "tts" : "audio-recording";
      const factory = registry.get(type);
      if (!factory?.schema) return;

      const width = factory.metadata.defaultWidth ?? 320;
      const height = factory.metadata.defaultHeight ?? (type === "tts" ? 220 : 160);

      const widgetDoc = factory.schema.parse({
        blobId: clip.audioBlobId,
        blake3: clip.audioBlake3 ?? "",
        mime: clip.audioMime ?? "",
        duration: clip.durationSec,
        filename: clip.label || "",
        ...(type === "tts"
          ? {
              ttsText: clip.ttsText ?? "",
              ttsVoiceName: clip.ttsVoiceName ?? "",
              ttsVoiceLang: clip.ttsVoiceLang ?? "",
              ttsRate: clip.ttsRate ?? 1,
            }
          : {}),
      });

      const handle = repo.create(widgetDoc);
      const zIndex = 1 + Math.max(0, ...store.allWidgets().map((w) => w.zIndex || 0));

      store.addWidget({
        id: crypto.randomUUID(),
        type,
        x: worldX - width / 2,
        y: worldY - height / 2,
        width,
        height,
        zIndex,
        props: {},
        collapsed: false,
        docId: handle.documentId,
        parentId: null,
      });
    }

    return {
      container,

      widgetActions: [
        { id: "load-reference-data", label: "load reference data...", onClick: handleLoadReferenceData },
        { id: "download-cut-manifest", label: "download cut manifest...", onClick: downloadCutManifest },
      ],

      dropTarget: store
        ? {
            hitTest(worldX: number, worldY: number): boolean {
              if (!timeline) return false;
              const local = toAudioClipsLocal(worldX, worldY);
              if (!local) return false;
              const rowWidth = Math.max(0, currentWidth - TIMELINE_INSET * 2);
              return local.x >= 0 && local.x <= rowWidth && local.y >= 0 && local.y <= AUDIO_CLIP_TRACK_HEIGHT;
            },

            onHover(_worldX: number, _worldY: number, draggedWidgetId: string): void {
              const entry = store.getWidget(draggedWidgetId);
              setAudioClipsDropHighlight(!!entry && DROPPABLE_TYPES.has(entry.type));
            },

            onLeave(): void {
              setAudioClipsDropHighlight(false);
            },

            onDrop(draggedWidgetId: string, worldX: number, worldY: number): boolean {
              setAudioClipsDropHighlight(false);
              if (!timeline) return false;

              const entry = store.getWidget(draggedWidgetId);
              if (!entry) return false;
              const dropped = readDroppedAudioState(entry.type, entry.docId);
              if (!dropped) return false;

              const local = toAudioClipsLocal(worldX, worldY);
              const start = Math.max(0, timeline.screenXToTime(local?.x ?? 0));

              const clip: AudioClip = {
                id: crypto.randomUUID(),
                trackId: "default",
                start,
                durationSec: dropped.duration,
                label: entry.type === "tts" ? (dropped.ttsText ?? "").slice(0, 40) : (dropped.filename ?? ""),
                audioBlobId: dropped.blobId,
                audioBlake3: dropped.blake3 || undefined,
                audioMime: dropped.mime || undefined,
                ttsText: dropped.ttsText || undefined,
                ttsVoiceName: dropped.ttsVoiceName || undefined,
                ttsVoiceLang: dropped.ttsVoiceLang || undefined,
                ttsRate: dropped.ttsRate,
              };

              ctx.doc.change((d) => {
                d.audioClips.push(clip);
              });

              store.removeWidget(draggedWidgetId);
              return true;
            },
          }
        : undefined,

      resize(w: number, h: number) {
        currentWidth = w;
        currentHeight = h;
        drawBg(w, h);
        container.hitArea = new Rectangle(0, 0, w, h);
        drawPlaceholderBorder(w, h);
        placeholderText.x = w / 2;
        placeholderText.y = h / 2;
        if (timeline) {
          timeline.container.y = timelineY(h);
          timeline.resize(Math.max(0, w - TIMELINE_INSET * 2));
          cutModeControl?.resize(Math.max(0, w - TIMELINE_INSET * 2));
          referenceTrack?.resize(Math.max(0, w - TIMELINE_INSET * 2));
        }
        keyboardShortcutsControl?.resize(w, h);
        if (segmentsPanel) {
          segmentsPanel.container.y = segmentsPanelY(h);
          segmentsPanel.resize(Math.max(0, w - TIMELINE_INSET * 2));
        }
        voicePickerDialog?.resize(w, h);
      },

      destroy() {
        destroyed = true;
        uploadCancelled = true;
        uploadAbort?.abort();
        videoSnatchCancelled = true;
        videoSnatchAbort?.abort();
        if (referenceDataMessageTimer !== null) clearTimeout(referenceDataMessageTimer);
        document.removeEventListener("keydown", handleKeyDown);
        dropHighlight?.destroy();
        dropHighlight = null;
        unsubscribe();
        stopClipAudio();
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

