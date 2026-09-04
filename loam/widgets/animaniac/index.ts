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
import { log } from "@freqhole/reliquary/utils";
import type { FederatedPointerEvent, FederatedWheelEvent } from "pixi.js";
import type { PeersMap } from "../../src/file-utils/file-shared";
import type {
  CompactInfo,
  HeaderAction,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../../src/widgets/widget-types";
import type { WidgetRegistry } from "../../src/widgets/widget-registry";
import { createTimelineCamera, type TimelineCamera } from "../../src/widgets/timeline/timeline-camera";
import type { Span } from "../../src/widgets/timeline/track-item-interaction";
import { createTimelineRowStack, type TimelineRowStackHandle } from "../../src/widgets/timeline/timeline-rows";
import {
  createTimelineToolbar,
  makeTextButton,
  TOOLBAR_GROUP_GAP,
  TOOLBAR_HEIGHT,
  type TimelineToolbarHandle,
} from "../../src/widgets/timeline/timeline-chrome";
import { createTimelineRuler, type TimelineRulerHandle } from "../../src/widgets/timeline/timeline-ruler";
import { createTimelineScrollbar, type TimelineScrollbarHandle } from "../../src/widgets/timeline/timeline-scrollbar";
import { createTimelinePlayhead, type TimelinePlayheadHandle } from "../../src/widgets/timeline/timeline-playhead";
import { createCompositor, type CompositorHandle } from "./compositor";
import { createPreviewTransformEditor, type PreviewTransformEditorHandle, type TransformPatch } from "./preview-transform-editor";
import { createAudioPlayback, type AudioPlaybackHandle } from "./audio-playback";
import { createPlaybackClock, type PlaybackClock } from "./playback-clock";
import { createHistoryController, type HistoryControllerHandle } from "./history";
import { loadLocalAnimaniacPrefs, saveLocalAnimaniacPrefs } from "./local-prefs";
import { createAnimaniacDropController } from "./drop-controller";
import { createSnatchController, isAnimaniacNewBlobMessage, clipBlobInfo } from "./snatch-controller";
import { clipEnd, computeDisplayDurationSec, nextTrackOrder, removeTrack as removeTrackFromArrays, sortedTracks } from "./track-model";
import { createAudioTrack, AUDIO_TRACK_ROW_HEIGHT, type AudioTrackHandle } from "./tracks/audio-track";
import { createVisualTrack, VISUAL_TRACK_ROW_HEIGHT, type VisualTrackHandle } from "./tracks/visual-track";
import { createShadowClips, type ShadowClipSpan, type ShadowClipsHandle } from "./tracks/shadow-clips";
import { renderAudioMixdown } from "./export/audio-mixdown";
import { animaniacSchema, VISUAL_CLIP_KINDS, type AnimaniacState, type Clip, type Track } from "./types";

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
// 1x is "the full (padded) duration exactly fills the view" (zoomFit's own
// target level, see timeline-camera.ts) — the two levels below it are
// EXTRA zoom-out headroom (more empty timeline space past the last clip,
// for shuffling long clips around), not part of stfu's own default set.
const ZOOM_LEVELS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];

type TrackHandle = AudioTrackHandle | VisualTrackHandle;

const TRACK_ADD_BUTTON_WIDTH = 34;
const TRACK_ADD_BUTTON_HEIGHT = 20;

/** small speaker glyph (audio) or camera glyph (video), drawn from plain
 *  Graphics primitives — no icon font/asset needed for two simple shapes. */
function drawTrackAddIcon(g: Graphics, kind: "audio" | "video", cx: number, cy: number, color: number): void {
  if (kind === "audio") {
    g.rect(cx - 5, cy - 3, 3, 6).fill({ color });
    g.poly([cx - 2, cy - 3, cx + 4, cy - 6, cx + 4, cy + 6, cx - 2, cy + 3]).fill({ color });
    return;
  }
  g.roundRect(cx - 6, cy - 4, 12, 8, 1.5).fill({ color });
  g.roundRect(cx - 2, cy - 6, 4, 2.5, 0.5).fill({ color });
  g.circle(cx, cy, 2.2).fill({ color: 0x1a1a2e });
}

/** "+" plus a small speaker/camera glyph — replaces the old "+audio"/
 *  "+video" text buttons, which don't fit the label column's own narrow
 *  reserved width (see their mount site's own comment). */
function makeTrackAddButton(kind: "audio" | "video", onClick: () => void): Container {
  const c = new Container();
  const bg = new Graphics();
  const icon = new Graphics();
  const plus = new Text({ text: "+", style: { fontSize: 12, fill: 0xd8f4fb, fontWeight: "bold" } });
  const w = TRACK_ADD_BUTTON_WIDTH;
  const h = TRACK_ADD_BUTTON_HEIGHT;
  const draw = (hover: boolean) => {
    bg.clear();
    bg.roundRect(0, 0, w, h, 4).fill({ color: hover ? 0x3a3a52 : 0x2a2a3e });
  };
  draw(false);
  plus.anchor.set(0, 0.5);
  plus.x = 3;
  plus.y = h / 2;
  icon.clear();
  drawTrackAddIcon(icon, kind, w - 12, h / 2, 0xd8f4fb);
  c.addChild(bg, plus, icon);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerover", () => draw(true));
  c.on("pointerout", () => draw(false));
  c.on("pointertap", (e) => {
    e.stopPropagation();
    onClick();
  });
  return c;
}

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
    // hover tracking for the keyboard-shortcut gate below (space/delete) —
    // there's no canvas-level "focused widget" concept a widget factory
    // can query, so "is the pointer currently over this instance" is the
    // simplest reliable signal for which of possibly several animaniac
    // widgets on the same canvas a global keydown should apply to —
    // mirrors stfu/index.ts's own identical pattern.
    let pointerInsideWidget = false;
    container.eventMode = "static";
    container.hitArea = new Rectangle(0, 0, currentWidth, currentHeight);
    container.on("pointerover", () => {
      pointerInsideWidget = true;
    });
    container.on("pointerout", () => {
      pointerInsideWidget = false;
    });

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
    // clips both the compositor's own rendered sprites AND the transform
    // editor's selection outline/handles to the preview's own bounds — a
    // rotated/oversized clip or a handle dragged near the edge previously
    // rendered outside the widget entirely. mask must be a SIBLING (not a
    // descendant) of what it clips, with eventMode="none" explicitly set
    // (see repo conventions — a mask that's a descendant, or one that
    // isn't explicitly non-interactive, can silently break hit-testing on
    // the masked content underneath it).
    const previewClipLayer = new Container();
    previewContainer.addChild(previewClipLayer);
    const previewMask = new Graphics();
    previewMask.eventMode = "none";
    previewContainer.addChild(previewMask);
    previewClipLayer.mask = previewMask;
    const previewContent = new Container();
    previewClipLayer.addChild(previewContent);
    // topmost sibling of the preview area — selection outline/handles for
    // whatever's currently shown (doodle/image/label/video/mouth), see
    // preview-transform-editor.ts. added here (not deferred to later)
    // because it must render above `previewContent`'s clip sprites, which
    // are added right after it below.
    const previewOverlay = new Container();
    previewClipLayer.addChild(previewOverlay);
    container.addChild(previewContainer);

    const compositor: CompositorHandle = createCompositor({
      container: previewContent,
      getPreviewSize: () => ({ width: currentWidth, height: currentPreviewHeight }),
      getTracks: () => ctx.doc.current.tracks,
      getClips: () => ctx.doc.current.clips,
      getPeers,
    });

    // -- currently selected clip (kept in sync bidirectionally with each
    // track row's own selection, and with the preview transform editor's
    // own click-to-select — see `setSelectedClipId()`) ----------------------
    let selectedClipId: string | null = null;

    function setSelectedClipId(id: string | null): void {
      if (selectedClipId === id) return;
      selectedClipId = id;
      const clip = id ? ctx.doc.current.clips.find((c) => c.id === id) : null;
      // keep the owning track row's own selection in sync too, so a clip
      // selected via the preview editor also shows selected on the
      // timeline (and vice versa, via onSelectionChange below).
      if (clip) trackInstances.get(clip.trackId)?.selectId(id!);
      previewTransformEditor.refresh();
    }

    /** writes a finished preview-editor drag's new x/y/scaleX/scaleY into
     *  the clip's first keyframe (phase-1 clips always have exactly one —
     *  see types.ts's schema doc comment) and pushes undo history. */
    function commitClipTransform(clipId: string, patch: TransformPatch): void {
      ctx.doc.change((d) => {
        const clip = d.clips.find((c) => c.id === clipId);
        const kf = clip?.keyframes[0];
        if (!kf) return;
        if (patch.x !== undefined) kf.x = patch.x;
        if (patch.y !== undefined) kf.y = patch.y;
        if (patch.scaleX !== undefined) kf.scaleX = patch.scaleX;
        if (patch.scaleY !== undefined) kf.scaleY = patch.scaleY;
        if (patch.rotation !== undefined) kf.rotation = patch.rotation;
      });
      history.push();
      compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
      previewTransformEditor.refresh();
    }

    /** deletes a clip by id (used by both the timeline/preview-editor's
     *  "delete selected" shortcut and the visual-track shadow bar for a
     *  voice-recording's mouth timing — see tracks/shadow-clips.ts). */
    function removeClipById(id: string): void {
      ctx.doc.change((d) => {
        const idx = d.clips.findIndex((c) => c.id === id);
        if (idx >= 0) d.clips.splice(idx, 1);
      });
      if (selectedClipId === id) selectedClipId = null;
      history.push();
      refreshAllTracks();
      camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
      compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
      previewTransformEditor.refresh();
      updatePreviewHintVisibility();
    }

    /** deletes whichever clip is currently selected (via either the
     *  timeline or the preview editor — same shared `selectedClipId`) —
     *  wired to the delete/backspace keyboard shortcut below. */
    function deleteSelectedClip(): void {
      if (selectedClipId) removeClipById(selectedClipId);
    }

    /** mutes a video-segment's own embedded audio, WITHOUT removing the
     *  clip itself — wired as the audio-track shadow bar's own "delete"
     *  action (see tracks/shadow-clips.ts); the bar just disappears next
     *  refresh since it's only shown for `!muted` video-segment clips. */
    function muteVideoClip(id: string): void {
      ctx.doc.change((d) => {
        const clip = d.clips.find((c) => c.id === id);
        if (clip && clip.kind === "video-segment") clip.muted = true;
      });
      history.push();
      refreshAllTracks();
      compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
    }

    /** adds a new, empty track of the given kind, appended after every
     *  existing track of that same kind — wired to the "add visual/audio
     *  track" widgetActions below (property-tray menu items). */
    function addNewTrack(kind: "visual" | "audio"): void {
      const track: Track = { id: crypto.randomUUID(), kind, label: "", order: nextTrackOrder(ctx.doc.current.tracks, kind), muted: false, hidden: false };
      ctx.doc.change((d) => {
        d.tracks.push(track);
      });
      history.push();
      syncTracks();
    }

    /** removes a track AND every clip on it (an orphaned clip with no
     *  track would be unreachable) — wired to each row's own small "×"
     *  delete button (see `mountTrack()`). */
    function removeTrackAndClips(trackId: string): void {
      const { tracks: nextTracks, clips: nextClips } = removeTrackFromArrays(ctx.doc.current.tracks, ctx.doc.current.clips, trackId);
      ctx.doc.change((d) => {
        d.tracks.splice(0, d.tracks.length, ...nextTracks.map((t) => ({ ...t })));
        d.clips.splice(0, d.clips.length, ...nextClips.map((c) => ({ ...c })));
      });
      if (selectedClipId && !nextClips.some((c) => c.id === selectedClipId)) selectedClipId = null;
      history.push();
      syncTracks();
      camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
      compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
      previewTransformEditor.refresh();
      updatePreviewHintVisibility();
    }

    const previewTransformEditor: PreviewTransformEditorHandle = createPreviewTransformEditor({
      container: previewOverlay,
      getPreviewSize: () => ({ width: currentWidth, height: currentPreviewHeight }),
      getClips: () => ctx.doc.current.clips,
      getTracks: () => ctx.doc.current.tracks,
      getCurrentTime: () => playbackClock.getCurrentTime(),
      getNaturalSize: (clipId) => compositor.getNaturalSize(clipId),
      getSelectedClipId: () => selectedClipId,
      onSelect: setSelectedClipId,
      beginLiveEdit: (clipId) => compositor.beginLiveEdit(clipId),
      endLiveEdit: (clipId) => compositor.endLiveEdit(clipId),
      onTransformCommit: commitClipTransform,
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
        refreshAllTracks();
        camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
        compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
        previewTransformEditor.refresh();
      },
      onHistoryChanged: () => toolbar.refreshUndoRedo(),
    });

    const camera: TimelineCamera = createTimelineCamera({
      rowWidth: Math.max(0, currentWidth - TRACK_LABEL_COLUMN_WIDTH),
      zoomLevels: ZOOM_LEVELS,
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

    // "+audio"/"+video" track buttons — an animaniac-specific concept
    // stfu's own timeline doesn't share, so added directly here (not
    // inside timeline-chrome.ts). mounted in the label column's own
    // otherwise-empty space at the ruler's row (see layoutTimeline()) —
    // not the toolbar row, which is already crowded with zoom/undo/snap/
    // autoscroll/play. icon buttons (not text) — "+video"/"+audio" text
    // labels don't fit the label column's own narrow width.
    const addVideoTrackBtn = makeTrackAddButton("video", () => addNewTrack("visual"));
    const addAudioTrackBtn = makeTrackAddButton("audio", () => addNewTrack("audio"));
    timelineContainer.addChild(addVideoTrackBtn, addAudioTrackBtn);

    // play/pause + snatch-all, anchored to the left of the toolbar's own
    // autoscroll button (via `getTrailingGroupLeftX()`) — a second, more-
    // reachable entry point alongside the widget frame's own header
    // action, since that header action can silently overflow into the
    // frame's hamburger flyout on a narrower widget (see widget-frame.ts's
    // own overflow behavior) — and simply easier to notice/find than a
    // header button in practice. a single glyph (not the word "play"/
    // "pause") for play so it stays compact; snatch-all is ALWAYS visible
    // (never conditionally hidden — a no-op click when everything's
    // already local is harmless), just relabeled by updateHeaderActions().
    const toolbarPlayBtn = makeTextButton("\u25b6", () => handlePlayToggle());
    const toolbarSnatchBtn = makeTextButton("snatch all", () => void snatchController.handleSnatchAll());
    toolbarContainer.addChild(toolbarPlayBtn, toolbarSnatchBtn);

    /** positions the toolbar's own play/snatch-all buttons to the left of
     *  autoscroll — recomputed whenever either button's own width changes
     *  (a label change) or the widget resizes. */
    function layoutTrailingButtons(): void {
      const leftOfAutoscroll = toolbar.getTrailingGroupLeftX();
      toolbarPlayBtn.x = Math.max(0, leftOfAutoscroll - TOOLBAR_GROUP_GAP - toolbarPlayBtn.buttonWidth);
      toolbarSnatchBtn.x = Math.max(0, toolbarPlayBtn.x - TOOLBAR_GROUP_GAP - toolbarSnatchBtn.buttonWidth);
    }

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

    // `onWheelPan()`'s own pixi-level wheel handling above only stops the
    // event from bubbling to pixi ancestors — it does NOT stop
    // `viewport.ts`'s own, separately-registered native "wheel" listener on
    // the same <canvas> element from ALSO firing and panning/zooming the
    // whole canvas underneath the timeline (the exact "trackpad scroll
    // also scrolls the whole skein canvas" bug reported). that listener
    // opts out early when it sees `_skeinWidgetScroll === true` on the
    // native event (the same convention `stfu/video-timeline.ts` and
    // `scrollable-content.ts` already use) — claim it here, in a document-
    // capture-phase listener guaranteed to run BEFORE the canvas's own
    // bubble-phase listener, whenever the pointer is over the timeline
    // shell (toolbar/rows/ruler/scrollbar) AND the gesture is a
    // horizontal pan (the same condition `onWheelPan()` itself uses).
    function onNativeWheel(e: WheelEvent): void {
      const deltaX = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (deltaX === 0) return;
      const rect = ctx.canvasElement.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const g = timelineContainer.getGlobalPosition();
      // local widget dimensions and screen/global dimensions only match at
      // 1x canvas zoom — correct for the canvas's own zoom via the
      // container's own world transform scale, same technique
      // `stfu/video-timeline.ts`/`scrollable-content.ts` use.
      const scaleX = timelineContainer.worldTransform.a;
      const scaleY = timelineContainer.worldTransform.d;
      const shellHeight = TOOLBAR_HEIGHT + ROW_GAP + rowStack.getStackHeight() + ROW_GAP + RULER_HEIGHT + SCROLLBAR_GAP + SCROLLBAR_HEIGHT;
      const inside = px >= g.x && px <= g.x + currentWidth * scaleX && py >= g.y && py <= g.y + shellHeight * scaleY;
      if (inside) (e as WheelEvent & { _skeinWidgetScroll?: boolean })._skeinWidgetScroll = true;
    }
    document.addEventListener("wheel", onNativeWheel, { capture: true, passive: true });

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

    // -- "shadow" bars for clips whose data lives on a DIFFERENT track kind
    // (a video-segment's own embedded audio; a voice-recording's talking-
    // mouth timing) but should also be visible+deletable on this one — see
    // tracks/shadow-clips.ts's own doc comment for why this isn't built on
    // the full drag/resize interaction engine. always shown on the FIRST
    // non-hidden track of the *other* kind; rebuilt lazily (not on every
    // refresh) only when that target track actually changes.
    const AUDIO_SHADOW_COLORS = { fill: 0x2a2a4a, fillHover: 0x3a3a6a, stroke: 0xd946ef };
    const VISUAL_SHADOW_COLORS = { fill: 0x2a3a2a, fillHover: 0x3a5a3a, stroke: 0x45c9e6 };
    let audioShadowRowId: string | null = null;
    let audioShadowHandle: ShadowClipsHandle | null = null;
    let visualShadowRowId: string | null = null;
    let visualShadowHandle: ShadowClipsHandle | null = null;

    function ensureAudioShadowHandle(target: Track | undefined): void {
      if (!target) {
        audioShadowHandle?.destroy();
        audioShadowHandle = null;
        audioShadowRowId = null;
        return;
      }
      if (audioShadowHandle && audioShadowRowId === target.id) return;
      audioShadowHandle?.destroy();
      audioShadowHandle = null;
      let row;
      try {
        row = rowStack.getRow(target.id);
      } catch {
        audioShadowRowId = null; // row not laid out yet — retry next refresh
        return;
      }
      audioShadowRowId = target.id;
      audioShadowHandle = createShadowClips({
        row,
        camera,
        rowHeight: AUDIO_TRACK_ROW_HEIGHT,
        colors: AUDIO_SHADOW_COLORS,
        getSelectedId: () => selectedClipId,
        onSelect: setSelectedClipId,
        onDelete: (id) => muteVideoClip(id),
      });
    }

    function ensureVisualShadowHandle(target: Track | undefined): void {
      if (!target) {
        visualShadowHandle?.destroy();
        visualShadowHandle = null;
        visualShadowRowId = null;
        return;
      }
      if (visualShadowHandle && visualShadowRowId === target.id) return;
      visualShadowHandle?.destroy();
      visualShadowHandle = null;
      let row;
      try {
        row = rowStack.getRow(target.id);
      } catch {
        visualShadowRowId = null;
        return;
      }
      visualShadowRowId = target.id;
      visualShadowHandle = createShadowClips({
        row,
        camera,
        rowHeight: VISUAL_TRACK_ROW_HEIGHT,
        colors: VISUAL_SHADOW_COLORS,
        getSelectedId: () => selectedClipId,
        onSelect: setSelectedClipId,
        onDelete: (id) => removeClipById(id),
      });
    }

    /** whether `clip`'s own backing media blob isn't local yet — drives
     *  the dashed-border cue on both native track bars and shadow bars.
     *  false for a clip kind with no blob field (label) at all. */
    function isClipRemote(clip: Clip): boolean {
      const blob = clipBlobInfo(clip);
      return !!blob && snatchController.isBlobRemote(blob.blobId);
    }

    /** 0..1 live download progress for `clip`'s own blob, 0 if not
     *  currently being fetched (or it has no blob field at all). */
    function clipProgress(clip: Clip): number {
      const blob = clipBlobInfo(clip);
      return blob ? snatchController.getBlobProgress(blob.blobId) : 0;
    }

    function refreshShadowClips(): void {
      const tracks = ctx.doc.current.tracks;
      const clips = ctx.doc.current.clips;
      const liveTracks = sortedTracks(tracks);

      ensureAudioShadowHandle(liveTracks.find((t) => t.kind === "audio" && !t.hidden));
      if (audioShadowHandle) {
        const spans: ShadowClipSpan[] = clips
          .filter((c) => c.kind === "video-segment" && !c.muted)
          .map((c) => ({ id: c.id, start: c.start, end: clipEnd(c), label: "audio", remote: isClipRemote(c), progress: clipProgress(c) }));
        audioShadowHandle.refresh(spans);
      }

      ensureVisualShadowHandle(liveTracks.find((t) => t.kind === "visual" && !t.hidden));
      if (visualShadowHandle) {
        const spans: ShadowClipSpan[] = clips
          .filter((c) => c.kind === "voice-recording")
          .map((c) => ({ id: c.id, start: c.start, end: clipEnd(c), label: "mouth", remote: isClipRemote(c), progress: clipProgress(c) }));
        visualShadowHandle.refresh(spans);
      }
    }

    /** redraws every track row AND the cross-strip shadow bars — call
     *  whenever the clip list or camera view changes. */
    function refreshAllTracks(): void {
      for (const inst of trackInstances.values()) inst.refresh();
      refreshShadowClips();
    }

    function onClipsChange(nextClips: Clip[]): void {
      ctx.doc.change((d) => {
        d.clips.splice(0, d.clips.length, ...nextClips.map((c) => ({ ...c })));
      });
      history.push();
      camera.setDuration(computeDisplayDurationSec(nextClips));
      compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
      previewTransformEditor.refresh();
      updatePreviewHintVisibility();
      // a same-track move/resize commit already redraws its own row
      // internally (track-item-interaction.ts) — only the shadow bars on
      // the OTHER strip (e.g. a video-segment's audio-track counterpart)
      // need an explicit nudge to reflect the edit.
      refreshShadowClips();
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
      refreshShadowClips();
    }

    /** does `globalY` (a pixi FederatedPointerEvent's own `.global.y`,
     *  true stage coordinates — NOT the app's separate pan/zoom "world"
     *  units, unlike drop-controller.ts's own hit-testing) fall within
     *  this track's own row bounds? used by `onMoveOutOfRow` below to
     *  support dragging a clip vertically onto a DIFFERENT track. */
    function trackRowContainsGlobalY(trackId: string, globalY: number): boolean {
      let row;
      try {
        row = rowStack.getRow(trackId);
      } catch {
        return false;
      }
      // `x` doesn't matter for a vertical-only hit-test, and this app's
      // canvas pan/zoom is scale+translate only (never rotated), so an
      // arbitrary x doesn't skew the resulting local y.
      const local = row.hitArea.toLocal({ x: 0, y: globalY });
      return local.y >= 0 && local.y <= row.height;
    }

    /** shared by `moveClipToTrackAtGlobalY()` and the live ghost preview
     *  below — finds whichever OTHER same-kind track's row currently
     *  contains `globalY`, or undefined if the pointer isn't over a valid
     *  cross-track drop target. */
    function findCrossTrackTargetAtGlobalY(clip: Clip, globalY: number): Track | undefined {
      const wantedKind: Track["kind"] = (VISUAL_CLIP_KINDS as readonly string[]).includes(clip.kind) ? "visual" : "audio";
      return sortedTracks(ctx.doc.current.tracks).find(
        (t) => t.id !== clip.trackId && t.kind === wantedKind && !t.hidden && trackRowContainsGlobalY(t.id, globalY)
      );
    }

    /** moves a clip to whichever OTHER track (of the same visual/audio
     *  kind) the pointer ended up over at the end of a move drag — wired
     *  as `onMoveOutOfRow` for both track kinds in `mountTrack()` below.
     *  returns false (drag falls back to a normal same-track move) if the
     *  pointer didn't land on a different, kind-matching track. */
    function moveClipToTrackAtGlobalY(clip: Clip, span: Span, globalY: number): boolean {
      const target = findCrossTrackTargetAtGlobalY(clip, globalY);
      if (!target) return false;
      ctx.doc.change((d) => {
        const c = d.clips.find((x) => x.id === clip.id);
        if (!c) return;
        c.trackId = target.id;
        c.start = span.start;
      });
      history.push();
      refreshAllTracks();
      camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
      compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
      previewTransformEditor.refresh();
      return true;
    }

    // live ghost segment shown in the TARGET row while a clip is being
    // dragged across tracks (before the drop itself commits) — mirrors
    // drop-controller.ts's own drag-IN placeholder, but for an item
    // already on one of this widget's own tracks. one shared Graphics,
    // reparented to whichever row is the current best-guess target.
    const crossTrackGhost = new Graphics();
    crossTrackGhost.eventMode = "none";
    crossTrackGhost.visible = false;

    function hideCrossTrackGhost(): void {
      crossTrackGhost.visible = false;
      crossTrackGhost.parent?.removeChild(crossTrackGhost);
    }

    function showCrossTrackGhost(clip: Clip, span: Span, globalY: number): void {
      const target = findCrossTrackTargetAtGlobalY(clip, globalY);
      if (!target) {
        hideCrossTrackGhost();
        return;
      }
      let row;
      try {
        row = rowStack.getRow(target.id);
      } catch {
        hideCrossTrackGhost();
        return;
      }
      const x1 = camera.timeToScreenX(span.start);
      const x2 = camera.timeToScreenX(span.end);
      row.contentLayer.addChild(crossTrackGhost);
      crossTrackGhost.visible = true;
      crossTrackGhost
        .clear()
        .roundRect(Math.min(x1, x2), 2, Math.max(2, Math.abs(x2 - x1)), Math.max(0, row.height - 4), 3)
        .fill({ color: 0xd946ef, alpha: 0.25 })
        .stroke({ width: 1.5, color: 0xd946ef });
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
      // small per-row "remove this track (and its clips)" affordance —
      // top-right of the label column, matches the label column's own
      // reserved width (TRACK_LABEL_COLUMN_WIDTH).
      const removeBtn = new Text({ text: "×", style: { fontSize: 12, fill: 0x777788 } });
      removeBtn.anchor.set(1, 0);
      removeBtn.x = TRACK_LABEL_COLUMN_WIDTH - 6;
      removeBtn.y = 2;
      removeBtn.eventMode = "static";
      removeBtn.cursor = "pointer";
      removeBtn.on("pointerover", () => (removeBtn.style.fill = 0xff6b6b));
      removeBtn.on("pointerout", () => (removeBtn.style.fill = 0x777788));
      removeBtn.on("pointerdown", (e) => {
        e.stopPropagation();
        removeTrackAndClips(track.id);
      });
      row.labelLayer.addChild(removeBtn);
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
        // selecting a clip on the timeline also shows its handles in the
        // preview (and vice versa — see setSelectedClipId()'s own
        // reciprocal selectId() call).
        onSelectionChange: (clip: Clip | null) => setSelectedClipId(clip?.id ?? null),
        onMoveOutOfRow: (clip: Clip, span: Span, globalY: number) => moveClipToTrackAtGlobalY(clip, span, globalY),
        onDraggingMove: (clip: Clip, span: Span | null, globalY: number) => {
          if (span) showCrossTrackGhost(clip, span, globalY);
          else hideCrossTrackGhost();
        },
        isClipRemote: (clip: Clip) => isClipRemote(clip),
        getClipProgress: (clip: Clip) => clipProgress(clip),
      };
      return track.kind === "visual" ? createVisualTrack(common) : createAudioTrack(common);
    }

    function redrawChrome(): void {
      const view = camera.getView();
      const rowWidth = Math.max(0, currentWidth - TRACK_LABEL_COLUMN_WIDTH);
      toolbar.setZoomLevelLabel(`${ZOOM_LEVELS[Math.min(view.zoomIndex, ZOOM_LEVELS.length - 1)]}x`);
      ruler.redraw(view, rowWidth, camera.timeToScreenX);
      scrollbar.redraw(rowWidth);
      // track items draw their own screen position from the camera's
      // CURRENT view (via track-item-interaction.ts's own spanToScreen()) —
      // without this, panning/zooming moved the ruler ticks + scrollbar
      // thumb but left every clip frozen at its last-drawn position, since
      // nothing else calls refresh() on a plain camera pan (only on an
      // actual clips-array change).
      refreshAllTracks();
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
      layoutTrailingButtons();
      const rowsStartY = TOOLBAR_HEIGHT + ROW_GAP;
      rowStack.layout(rowsStartY, rowWidth);
      const rulerY = rowsStartY + rowStack.getStackHeight() + ROW_GAP;
      // "+video"/"+audio" live in the label column's own otherwise-empty
      // space, at the ruler's row (see their own construction comment).
      addVideoTrackBtn.x = 4;
      addVideoTrackBtn.y = rulerY;
      addAudioTrackBtn.x = addVideoTrackBtn.x + TRACK_ADD_BUTTON_WIDTH + 4;
      addAudioTrackBtn.y = rulerY;
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
      previewMask.clear().rect(0, 0, currentWidth, currentPreviewHeight).fill({ color: 0xffffff });
      previewHint.style.wordWrapWidth = Math.max(100, currentWidth - 40);
      previewHint.x = currentWidth / 2;
      previewHint.y = currentPreviewHeight / 2;
      updatePreviewHintVisibility();
      previewResizeHandle.x = 0;
      previewResizeHandle.y = currentPreviewHeight;
      drawPreviewResizeHandle(currentWidth);
      timelineContainer.y = currentPreviewHeight + PREVIEW_GAP;
      previewTransformEditor.refresh();
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
        previewTransformEditor.refresh();
        updatePlayhead();
      },
      // keeps the play/pause label in sync even when the clock stops
      // itself at the end of the timeline (not just on an explicit click —
      // see playback-clock.ts's own doc comment on why `onTick` alone
      // isn't enough for this).
      onPlayingChange: () => updateHeaderActions(),
    });

    /** plain play/pause toggle — media snatching is a SEPARATE concern
     *  (see the dedicated "snatch all" header action below), not
     *  conflated with playback: mount-time locality checks, bounded
     *  catch-up rescans, the auto-snatch-once-opted-in retry timer, and
     *  ephemeral "new blob" pings already keep media in sync without
     *  needing a play press to kick anything off. */
    function handlePlayToggle(): void {
      playbackClock.togglePlay();
    }

    function updateHeaderActions(): void {
      const actions: HeaderAction[] = [
        {
          id: "play",
          label: playbackClock.isPlaying() ? "pause" : "play",
          onClick: () => {
            handlePlayToggle();
            updateHeaderActions();
          },
        },
      ];
      // "snatch all" — the deliberate first-encounter action for a peer
      // that doesn't have this widget's media locally yet; every later
      // blob syncs on its own from then on (see snatch-controller.ts's
      // own auto-snatch-once-opted-in mechanism). ALWAYS present (never
      // conditionally hidden) so it's reliably discoverable regardless of
      // whatever the locality-detection state happens to be at the
      // moment — a no-op click when everything's already local is
      // harmless (handleSnatchAll() itself just returns immediately).
      const snatchState = snatchController.getState();
      const remoteCount = snatchController.getRemoteCount();
      const snatchLabel =
        snatchState === "snatching"
          ? `${snatchController.getProgressText() || "snatching…"} (cancel)`
          : remoteCount > 0
            ? `snatch all (${remoteCount})`
            : "snatch all";
      actions.push({
        id: "snatch-all",
        label: snatchLabel,
        onClick: () => (snatchState === "snatching" ? snatchController.cancelSnatch() : void snatchController.handleSnatchAll()),
      });
      log.debug(
        "animaniac.snatch",
        "[ANIMANIAC-DBG] updateHeaderActions:",
        `snatchState=${snatchState}`,
        `hasSetHeaderActions=${!!ctx.setHeaderActions}`,
        actions.map((a) => ({ id: a.id, label: a.label }))
      );
      ctx.setHeaderActions?.(actions);

      // mirror the same play/snatch-all state into animaniac's OWN
      // toolbar (not just the widget frame's header action) — a header
      // action can silently overflow into the frame's hamburger flyout on
      // a narrower widget (see widget-frame.ts's own overflow behavior),
      // so this is the more reliably-visible copy. always visible, same
      // reasoning as the header action above.
      toolbarPlayBtn.setLabel?.(playbackClock.isPlaying() ? "\u23f8" : "\u25b6");
      toolbarSnatchBtn.setLabel?.(snatchLabel);
      layoutTrailingButtons();
    }

    // -- "snatch" support for peers who don't yet have every clip's blob
    // locally — see snatch-controller.ts's own doc comment for why this
    // reacts to a targeted ephemeral ping (from `drop-controller.ts`) for
    // ongoing use rather than re-scanning the whole clip list on every doc
    // change (this widget's docs churn heavily from ordinary drag edits).
    const snatchController = createSnatchController({
      widgetId: ctx.widgetId,
      getDocState: () => ctx.doc.current,
      getPeers,
      isPeerOnline: ctx.canvasStore ? (nodeId: string) => ctx.canvasStore!.isPeerOnline(nodeId) : undefined,
      isDestroyed: () => destroyed,
      onStateChange: () => {
        updateHeaderActions();
        refreshShadowClips();
        for (const inst of trackInstances.values()) inst.refresh();
      },
    });
    const offSnatchEphemeral = ctx.canvasStore?.onEphemeral((_senderId, data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(new TextDecoder().decode(data));
      } catch {
        return;
      }
      if (isAnimaniacNewBlobMessage(msg) && msg.widgetId === ctx.widgetId) {
        snatchController.onPeerAddedBlob(msg.blob);
      }
    });

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
      widgetId: ctx.widgetId,
      container,
      findWorldContainer,
      getSize: () => ({ width: currentWidth, height: currentHeight }),
      getPreviewSize: () => ({ width: currentWidth, height: currentPreviewHeight }),
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
        refreshAllTracks();
        camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
        compositor.update(playbackClock.getCurrentTime(), playbackClock.isPlaying(), true);
        previewTransformEditor.refresh();
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
      previewTransformEditor.refresh();
      updatePreviewHintVisibility();
    });

    // -- keyboard shortcuts: space (play/pause), delete/backspace (delete
    // selected clip) — deliberately minimal (animaniac has none of stfu's
    // more specific in/out-marking/trim/zoom shortcut set) — gated the same
    // way stfu's own keyboard-shortcuts-handler.ts is: only acts while the
    // pointer is over THIS widget instance and no other text input has
    // claimed the keyboard. --------------------------------------------
    function handleKeyDown(e: KeyboardEvent): void {
      if (!pointerInsideWidget || ctx.keyboard.isAcquired) return;
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        handlePlayToggle();
        updateHeaderActions();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (!selectedClipId) return;
        e.preventDefault();
        deleteSelectedClip();
      }
    }
    document.addEventListener("keydown", handleKeyDown);

    history.init();
    camera.setDuration(computeDisplayDurationSec(ctx.doc.current.clips));
    // start "fit to content" (1x), not whatever zoomIndex=0 happens to mean
    // in ZOOM_LEVELS — its extra zoom-out-past-fit entries are only meant
    // to be reachable via the toolbar's own zoom-out button, not the
    // widget's default opening view.
    camera.zoomFit();
    syncTracks();
    layoutPreview();
    updateHeaderActions();
    void snatchController.checkAllLocality();

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
        container.hitArea = new Rectangle(0, 0, width, height);
        layoutPreview();
        layoutTimeline();
      },

      destroy() {
        destroyed = true;
        document.removeEventListener("keydown", handleKeyDown);
        document.removeEventListener("wheel", onNativeWheel, { capture: true });
        offDocChange();
        offSnatchEphemeral?.();
        snatchController.destroy();
        playbackClock.destroy();
        audioPlayback.destroy();
        compositor.destroy();
        previewTransformEditor.destroy();
        for (const inst of trackInstances.values()) inst.destroy();
        trackInstances.clear();
        audioShadowHandle?.destroy();
        visualShadowHandle?.destroy();
        rowStack.destroy();
        toolbar.destroy();
        ruler.destroy();
        scrollbar.destroy();
        playhead.destroy();
        dropController.destroy();
        crossTrackGhost.destroy();
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
