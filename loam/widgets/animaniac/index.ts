/**
 * animaniac — multi-track timeline widget sequencing doodle/image/label/
 * voice-recording/tts/audio-segment/video-segment clips, dragged in from
 * other skein widgets already on the canvas (see `frame-capture.ts`/
 * `drop-controller.ts`). see docs/animaniac-plan.md +
 * docs/animaniac-media-segments-plan.md for the full design.
 *
 * this is a FIRST CUT, not a polished widget — it aggressively delegates
 * to the shared `timeline/` kit and animaniac's own already-built pure
 * modules (types/track-model/transform/clip-track-adapter/playback-clock/
 * compositor/frame-capture/drop-controller/history/tracks/*) specifically
 * so this file itself never grows anywhere near stfu's own 1591-line
 * `index.ts`. known v1 limitations, tracked in docs/animaniac-media-
 * segments-plan.md's checklist, not silently swept under the rug: no UI to
 * add/remove tracks yet (schema defaults to one visual + one audio track),
 * no live mouth-animation rendering yet (mouth-sync.ts's pure logic exists
 * and is tested, not yet hooked into the compositor), track rows don't
 * scroll if they overflow the widget's own height, and there's no
 * keyboard-shortcut layer yet.
 */

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { FederatedPointerEvent, FederatedWheelEvent } from "pixi.js";
import type { PeersMap } from "../../src/file-utils/file-shared";
import type {
  CompactInfo,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../../src/widgets/widget-types";
import type { WidgetRegistry } from "../../src/widgets/widget-registry";
import { createTimelineCamera, type TimelineCamera } from "../../src/widgets/timeline/timeline-camera";
import { createTimelineRowStack, type TimelineRowStackHandle } from "../../src/widgets/timeline/timeline-rows";
import { createTimelineToolbar, TOOLBAR_HEIGHT, type TimelineToolbarHandle } from "../../src/widgets/timeline/timeline-chrome";
import { createTimelineRuler, type TimelineRulerHandle } from "../../src/widgets/timeline/timeline-ruler";
import { createTimelineScrollbar, type TimelineScrollbarHandle } from "../../src/widgets/timeline/timeline-scrollbar";
import { createTimelinePlayhead, type TimelinePlayheadHandle } from "../../src/widgets/timeline/timeline-playhead";
import { createCompositor, type CompositorHandle } from "./compositor";
import { createAudioPlayback, type AudioPlaybackHandle } from "./audio-playback";
import { createPlaybackClock, type PlaybackClock } from "./playback-clock";
import { createHistoryController, type HistoryControllerHandle } from "./history";
import { loadLocalAnimaniacPrefs, saveLocalAnimaniacPrefs } from "./local-prefs";
import { createAnimaniacDropController } from "./drop-controller";
import { computeDisplayDurationSec, sortedTracks } from "./track-model";
import { createAudioTrack, AUDIO_TRACK_ROW_HEIGHT, type AudioTrackHandle } from "./tracks/audio-track";
import { createVisualTrack, VISUAL_TRACK_ROW_HEIGHT, type VisualTrackHandle } from "./tracks/visual-track";
import { renderAudioMixdown } from "./export/audio-mixdown";
import { animaniacSchema, type AnimaniacState, type Clip, type Track } from "./types";

export { animaniacSchema };
export type { AnimaniacState };

const TRACK_LABEL_COLUMN_WIDTH = 92;
const ROW_GAP = 3;
const RULER_HEIGHT = 14;
const SCROLLBAR_GAP = 4;
const SCROLLBAR_HEIGHT = 8;
// gap between the preview area and the timeline shell below it — also the
// height of the drag-to-resize splitter handle that lives in that gap
// (mirrors stfu's own `HANDLE_GAP`).
const PREVIEW_GAP = 10;
const PREVIEW_MIN_HEIGHT = 80;
// floor for the timeline shell's own height (toolbar + at least one row +
// ruler + scrollbar) — the preview area can't be dragged so tall that the
// timeline shrinks past this.
const TIMELINE_MIN_HEIGHT = 140;

type TrackHandle = AudioTrackHandle | VisualTrackHandle;

export const animaniacWidget: WidgetFactory<typeof animaniacSchema> = {
  type: "animaniac",
  metadata: {
    name: "animaniac",
    description: "sequence doodles, voice recordings, tts, images, labels, and video/audio segments into a timeline animation",
    version: "0.1.0",
    category: "media",
    defaultWidth: 640,
    defaultHeight: 480,
  },
  schema: animaniacSchema,

  getCompactInfo(state: AnimaniacState): CompactInfo {
    return {
      label: `animaniac (${state.tracks.length} tracks, ${state.clips.length} clips)`,
    };
  },

  create(ctx: WidgetMountContext<typeof animaniacSchema>): WidgetController {
    const store = ctx.canvasStore ?? null;
    const repo = store?.repo ?? null;
    const registry: WidgetRegistry | null = _animaniacWidgetRegistry;
    const getPeers = () => ctx.canvasStore?.peers() as PeersMap | undefined;

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let destroyed = false;

    const prefs = loadLocalAnimaniacPrefs(ctx.widgetId);

    /** clamp a candidate preview-area height to leave the timeline shell at
     *  least `TIMELINE_MIN_HEIGHT` and the preview itself at least
     *  `PREVIEW_MIN_HEIGHT` — reads `currentHeight`, so only call this
     *  after it's been assigned (always true by call time, never at
     *  module/closure-construction time). */
    function clampPreviewHeight(h: number): number {
      const maxH = Math.max(PREVIEW_MIN_HEIGHT, currentHeight - TIMELINE_MIN_HEIGHT - PREVIEW_GAP);
      return Math.max(PREVIEW_MIN_HEIGHT, Math.min(maxH, h));
    }

    let currentPreviewHeight = clampPreviewHeight(prefs.previewHeightPx);

    const container = new Container();

    // -- preview area (compositor mounts clip sprites here) -----------------
    const previewContainer = new Container();
    const previewBg = new Graphics();
    previewContainer.addChild(previewBg);
    const previewHint = new Text({
      text: "drag a doodle / voice recording / tts / image / label widget's HEADER onto a track below",
      style: { fontSize: 12, fill: 0x555566, wordWrap: true, wordWrapWidth: Math.max(100, currentWidth - 40), align: "center" },
    });
    previewHint.anchor.set(0.5);
    previewContainer.addChild(previewHint);
    const previewContent = new Container();
    previewContainer.addChild(previewContent);
    container.addChild(previewContainer);

    const compositor: CompositorHandle = createCompositor({
      container: previewContent,
      getPreviewSize: () => ({ width: currentWidth, height: currentPreviewHeight }),
      getTracks: () => ctx.doc.current.tracks,
      getClips: () => ctx.doc.current.clips,
      getPeers,
    });

    const audioPlayback: AudioPlaybackHandle = createAudioPlayback({
      getClips: () => ctx.doc.current.clips,
      getPeers,
    });

    // -- timeline shell (toolbar + N track rows + ruler + scrollbar + playhead) --
    const timelineContainer = new Container();
    container.addChild(timelineContainer);

    // declared before `toolbar` below: `createTimelineToolbar()`'s undo/redo
    // buttons call `isDisabled()` (-> `canUndo()`/`canRedo()`) synchronously
    // during their own construction (an initial `draw()`), so `history` must
    // already exist by then or this throws a TDZ ReferenceError at runtime
    // (not caught by tsc) — the same bug class already worked around for
    // `camera.setDuration()` below, just a second instance.
    const history: HistoryControllerHandle = createHistoryController({
      getDocState: () => ctx.doc.current,
      changeDoc: (fn) => ctx.doc.change(fn),
      onApplied: () => {
        syncTracks();
        for (const inst of trackInstances.values()) inst.refresh();
        camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
        compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
      },
      onHistoryChanged: () => toolbar.refreshUndoRedo(),
    });

    const camera: TimelineCamera = createTimelineCamera({
      rowWidth: Math.max(0, currentWidth - TRACK_LABEL_COLUMN_WIDTH),
      onViewChange: () => redrawChrome(),
    });
    // NOTE: this must not mutate `camera` (which synchronously fires
    // onViewChange -> redrawChrome(), reading `toolbar`/`rowStack`/etc.)
    // until every one of those chrome pieces below is actually
    // constructed — see the `camera.setDuration()` call near the bottom
    // of this function, not here.

    const toolbarContainer = new Container();
    timelineContainer.addChild(toolbarContainer);
    const toolbar: TimelineToolbarHandle = createTimelineToolbar({
      container: toolbarContainer,
      zoomIn: () => camera.zoomIn(),
      zoomOut: () => camera.zoomOut(),
      zoomFit: () => camera.zoomFit(),
      onUndo: () => history.undo(),
      onRedo: () => history.redo(),
      canUndo: () => history.canUndo(),
      canRedo: () => history.canRedo(),
      isSnapEnabled: () => prefs.snapEnabled,
      toggleSnap: () => {
        prefs.snapEnabled = !prefs.snapEnabled;
        saveLocalAnimaniacPrefs(ctx.widgetId, prefs);
      },
      isAutoScrollEnabled: () => prefs.autoScrollEnabled,
      toggleAutoScroll: () => {
        prefs.autoScrollEnabled = !prefs.autoScrollEnabled;
        saveLocalAnimaniacPrefs(ctx.widgetId, prefs);
      },
    });

    function onWheelPan(e: FederatedWheelEvent): void {
      const deltaX = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (deltaX === 0) return;
      // NOT e.preventDefault() — pixi's EventSystem always attaches its
      // native "wheel" listener with { passive: true } (confirmed in
      // node_modules/pixi.js/lib/events/EventSystem.js), so calling it here
      // is always a no-op that only produces a console warning.
      const view = camera.getView();
      const deltaTime = view.pxPerSecond > 0 ? deltaX / view.pxPerSecond : 0;
      camera.panTo(view.viewStartTime + deltaTime);
    }

    const rowStack: TimelineRowStackHandle = createTimelineRowStack({
      parent: timelineContainer,
      labelColumnWidth: TRACK_LABEL_COLUMN_WIDTH,
      rowGap: ROW_GAP,
      onWheel: onWheelPan,
    });

    const rulerContainer = new Container();
    rulerContainer.eventMode = "static";
    timelineContainer.addChild(rulerContainer);
    // click-and-drag to scrub: seeking starts immediately on pointerdown (so
    // a plain click still works) and continues tracking the pointer while
    // held, so the user can "dial in" the right time by dragging rather
    // than being stuck with wherever they first clicked.
    let scrubbing = false;
    function seekToLocalX(e: FederatedPointerEvent): void {
      const local = e.getLocalPosition(rulerContainer);
      playbackClock.seek(camera.screenXToTime(local.x));
    }
    rulerContainer.on("pointerdown", (e: FederatedPointerEvent) => {
      scrubbing = true;
      seekToLocalX(e);
    });
    rulerContainer.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (scrubbing) seekToLocalX(e);
    });
    const stopScrubbing = (): void => {
      scrubbing = false;
    };
    rulerContainer.on("pointerup", stopScrubbing);
    rulerContainer.on("pointerupoutside", stopScrubbing);
    const ruler: TimelineRulerHandle = createTimelineRuler({ container: rulerContainer });

    const scrollbarContainer = new Container();
    timelineContainer.addChild(scrollbarContainer);
    const scrollbar: TimelineScrollbarHandle = createTimelineScrollbar({
      container: scrollbarContainer,
      camera,
      height: SCROLLBAR_HEIGHT,
    });

    const playhead: TimelinePlayheadHandle = createTimelinePlayhead(timelineContainer);

    // -- per-track row instances (rebuilt whenever ctx.doc.current.tracks changes) --
    const trackInstances = new Map<string, TrackHandle>();

    function onClipsChange(nextClips: Clip[]): void {
      ctx.doc.change((d) => {
        d.clips.splice(0, d.clips.length, ...nextClips.map((c) => ({ ...c })));
      });
      history.push();
      camera.setDuration(computeDisplayDurationSec(nextClips));
      compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
      updatePreviewHintVisibility();
    }

    function syncTracks(): void {
      const tracks = sortedTracks(ctx.doc.current.tracks);
      rowStack.setRows(tracks.map((t) => ({ id: t.id, height: t.kind === "visual" ? VISUAL_TRACK_ROW_HEIGHT : AUDIO_TRACK_ROW_HEIGHT })));

      const liveIds = new Set(tracks.map((t) => t.id));
      for (const [id, inst] of trackInstances) {
        if (!liveIds.has(id)) {
          inst.destroy();
          trackInstances.delete(id);
        }
      }
      for (const track of tracks) {
        if (trackInstances.has(track.id)) continue;
        trackInstances.set(track.id, mountTrack(track));
      }
      layoutTimeline();
    }

    function mountTrack(track: Track): TrackHandle {
      const row = rowStack.getRow(track.id);
      const rowLabel = new Text({
        text: (track.label || track.kind).toUpperCase(),
        style: { fontSize: 9, fill: 0x888888, letterSpacing: 0.3 },
      });
      rowLabel.anchor.set(0, 0.5);
      rowLabel.x = 8;
      rowLabel.y = row.height / 2;
      row.labelLayer.addChild(rowLabel);
      const common = {
        trackId: track.id,
        row,
        camera,
        getDuration: () => camera.getView().duration,
        isSnapEnabled: () => prefs.snapEnabled,
        // clips always snap to the very start of the timeline (besides
        // other clips' own edges, already handled by the interaction
        // engine) — makes it easy to drag a clip flush against t=0.
        getSnapTimes: () => [0],
        getClips: () => ctx.doc.current.clips,
        onClipsChange,
      };
      return track.kind === "visual" ? createVisualTrack(common) : createAudioTrack(common);
    }

    function redrawChrome(): void {
      const view = camera.getView();
      const rowWidth = Math.max(0, currentWidth - TRACK_LABEL_COLUMN_WIDTH);
      const zoomLevels = [1, 2, 4, 8, 16, 32, 64, 128, 256];
      toolbar.setZoomLevelLabel(`${zoomLevels[Math.min(view.zoomIndex, zoomLevels.length - 1)]}x`);
      ruler.redraw(view, rowWidth, camera.timeToScreenX);
      scrollbar.redraw(rowWidth);
      updatePlayhead();
    }

    function updatePlayhead(): void {
      const view = camera.getView();
      const rowWidth = Math.max(0, currentWidth - TRACK_LABEL_COLUMN_WIDTH);
      const x = camera.timeToScreenX(view.currentTime);
      const visible = view.currentTime >= view.viewStartTime && view.currentTime <= view.viewStartTime + view.viewDuration;
      const top = TOOLBAR_HEIGHT + ROW_GAP;
      const height = rowStack.getStackHeight() + ROW_GAP + RULER_HEIGHT;
      playhead.update(TRACK_LABEL_COLUMN_WIDTH + Math.max(0, Math.min(rowWidth, x)), top, height, visible);
    }

    function layoutTimeline(): void {
      const rowWidth = Math.max(0, currentWidth - TRACK_LABEL_COLUMN_WIDTH);
      camera.setRowWidth(rowWidth);
      toolbar.layout(currentWidth);
      const rowsStartY = TOOLBAR_HEIGHT + ROW_GAP;
      rowStack.layout(rowsStartY, rowWidth);
      const rulerY = rowsStartY + rowStack.getStackHeight() + ROW_GAP;
      rulerContainer.x = TRACK_LABEL_COLUMN_WIDTH;
      rulerContainer.y = rulerY;
      // an explicit hitArea is required for a reliable click-to-seek: with
      // eventMode="static" alone, pixi falls back to hit-testing against
      // the ruler's OWN DRAWN CONTENT (thin tick strokes + pooled text
      // labels), so most of the empty space between ticks/labels never
      // registered a click at all.
      rulerContainer.hitArea = new Rectangle(0, 0, rowWidth, RULER_HEIGHT);
      const scrollbarY = rulerY + RULER_HEIGHT + SCROLLBAR_GAP;
      scrollbarContainer.x = TRACK_LABEL_COLUMN_WIDTH;
      scrollbarContainer.y = scrollbarY;
      redrawChrome();
      // track rows are created lazily (see timeline-rows.ts's makeRow(),
      // called from setRows() above via rowStack.layout()'s own callers) and
      // are added as LATER siblings than the playhead (constructed once,
      // earlier) — re-raise it every layout pass so it always renders on top
      // of every row/clip-item Graphics, not just the ones that existed at
      // construction time.
      playhead.bringToFront();
    }

    function layoutPreview(): void {
      currentPreviewHeight = clampPreviewHeight(currentPreviewHeight);
      previewBg.clear().rect(0, 0, currentWidth, currentPreviewHeight).fill({ color: 0x0c0c14 });
      previewHint.style.wordWrapWidth = Math.max(100, currentWidth - 40);
      previewHint.x = currentWidth / 2;
      previewHint.y = currentPreviewHeight / 2;
      updatePreviewHintVisibility();
      previewResizeHandle.x = 0;
      previewResizeHandle.y = currentPreviewHeight;
      drawPreviewResizeHandle(currentWidth);
      timelineContainer.y = currentPreviewHeight + PREVIEW_GAP;
    }

    function updatePreviewHintVisibility(): void {
      previewHint.visible = ctx.doc.current.clips.length === 0;
    }

    // -- preview/timeline splitter (drag to resize the compositor preview
    // area, like stfu's own video-area/segments-panel splitter) — purely
    // local UI state (persisted via local-prefs.ts, not the doc). --------
    const previewResizeHandle = new Container();
    const previewResizeHandleGfx = new Graphics();
    previewResizeHandle.addChild(previewResizeHandleGfx);
    previewResizeHandle.eventMode = "static";
    previewResizeHandle.cursor = "ns-resize";
    container.addChild(previewResizeHandle);

    function drawPreviewResizeHandle(width: number): void {
      const gfx = previewResizeHandleGfx;
      gfx.clear();
      gfx.rect(0, 0, width, PREVIEW_GAP).fill({ color: 0x000000, alpha: 0.001 });
      const dashWidth = Math.min(32, Math.max(0, width - 8));
      gfx.roundRect((width - dashWidth) / 2, PREVIEW_GAP / 2 - 1.5, dashWidth, 3, 1.5).fill({ color: 0x555566 });
      previewResizeHandle.hitArea = new Rectangle(0, 0, width, PREVIEW_GAP);
    }

    let previewSplitterDrag: { startGlobalY: number; startPreviewHeight: number } | null = null;
    previewResizeHandle.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      previewSplitterDrag = { startGlobalY: e.global.y, startPreviewHeight: currentPreviewHeight };
    });
    previewResizeHandle.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (!previewSplitterDrag) return;
      const zoom = findWorldContainer().scale.x || 1;
      const dy = (e.global.y - previewSplitterDrag.startGlobalY) / zoom;
      currentPreviewHeight = clampPreviewHeight(previewSplitterDrag.startPreviewHeight + dy);
      layoutPreview();
      layoutTimeline();
    });
    function finishPreviewSplitterDrag(): void {
      if (!previewSplitterDrag) return;
      previewSplitterDrag = null;
      prefs.previewHeightPx = currentPreviewHeight;
      saveLocalAnimaniacPrefs(ctx.widgetId, prefs);
    }
    previewResizeHandle.on("pointerup", finishPreviewSplitterDrag);
    previewResizeHandle.on("pointerupoutside", finishPreviewSplitterDrag);

    // -- playback clock: drives the compositor + mouth-sync + playhead ------
    const playbackClock: PlaybackClock = createPlaybackClock({
      getDurationSec: () => camera.getView().duration,
      onTick: (t, seeked) => {
        camera.setCurrentTime(t);
        if (prefs.autoScrollEnabled) camera.scrollTimeIntoView(t);
        compositor.update(t, playbackClock.isPlaying(), seeked);
        audioPlayback.update(t, playbackClock.isPlaying(), seeked);
        updatePlayhead();
      },
    });

    function updateHeaderActions(): void {
      ctx.setHeaderActions?.([
        {
          id: "play",
          label: playbackClock.isPlaying() ? "pause" : "play",
          onClick: () => {
            playbackClock.togglePlay();
            updateHeaderActions();
          },
        },
      ]);
    }

    // -- cross-widget drag-in (drop a doodle/voice-recording/etc. onto a track) --
    function findWorldContainer(): Container {
      let current: Container = container;
      for (let i = 0; i < 3 && current.parent; i++) current = current.parent;
      return current;
    }
    const dropController = createAnimaniacDropController({
      store,
      repo,
      registry,
      container,
      findWorldContainer,
      getSize: () => ({ width: currentWidth, height: currentHeight }),
      getTracks: () => ctx.doc.current.tracks,
      getClips: () => ctx.doc.current.clips,
      getTrackRow: (trackId) => {
        try {
          return rowStack.getRow(trackId);
        } catch {
          return null;
        }
      },
      camera,
      changeDoc: (fn) => ctx.doc.change(fn),
      onClipAdded: () => {
        history.push();
        for (const inst of trackInstances.values()) inst.refresh();
        camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
        compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
        updatePreviewHintVisibility();
      },
    });

    // -- export: audio mixdown -----------------------------------------------
    async function handleExportAudioMixdown(): Promise<void> {
      const { tracks, clips } = ctx.doc.current;
      const result = await renderAudioMixdown({ tracks, clips, getPeers });
      if (destroyed) return;
      const blob = new Blob([result.bytes.buffer as ArrayBuffer], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "animaniac-mixdown.wav";
      a.click();
      URL.revokeObjectURL(url);
    }

    // -- doc-change subscription (remote peer edits) -------------------------
    const offDocChange = ctx.doc.on("change", () => {
      syncTracks();
      camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
      compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
      updatePreviewHintVisibility();
    });

    history.init();
    camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
    syncTracks();
    layoutPreview();
    updateHeaderActions();

    return {
      container,
      dropTarget: dropController.dropTarget,
      widgetActions: [{ id: "export-audio-mixdown", label: "export audio mixdown...", onClick: () => void handleExportAudioMixdown() }],

      resize(width: number, height: number) {
        // v1 doesn't yet scroll/clip overflowing track rows to fit a
        // shrunk height — only width-driven layout (camera row width,
        // toolbar/ruler/scrollbar positions) is re-run here; `currentHeight`
        // is tracked only for the whole-widget drop-zone hover border.
        currentWidth = width;
        currentHeight = height;
        layoutPreview();
        layoutTimeline();
      },

      destroy() {
        destroyed = true;
        offDocChange();
        playbackClock.destroy();
        audioPlayback.destroy();
        compositor.destroy();
        for (const inst of trackInstances.values()) inst.destroy();
        trackInstances.clear();
        rowStack.destroy();
        toolbar.destroy();
        ruler.destroy();
        scrollbar.destroy();
        playhead.destroy();
        dropController.destroy();
        container.destroy({ children: true });
      },
    };
  },
};

// -----------------------------------------------------------------------
// registry bootstrapping (mirrors stfu/index.ts's _stfuWidgetRegistry
// pattern exactly — needed so frame-capture.ts's drop handling can read
// other widgets' schemas at runtime).
// -----------------------------------------------------------------------

let _animaniacWidgetRegistry: WidgetRegistry | null = null;

export function registerAnimaniacWidget(registry: WidgetRegistry): void {
  _animaniacWidgetRegistry = registry;
  registry.register(animaniacWidget);
}
