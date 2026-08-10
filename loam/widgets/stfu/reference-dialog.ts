/**
 * stfu's reference dialog — a full-widget centered modal (mirrors
 * `keyboard-shortcuts-control.ts`'s own "centered over the whole widget"
 * pattern, via the same `expanding-panel.ts` helper) for grouping diarized
 * speakers into one or more "reference tracks" (e.g. one track for a
 * single speaker being removed, another for everyone else), previewing
 * each speaker's sample clip (process.py's `{speaker}_sample_{i}{ext}` +
 * `{speaker}_sample_{i}_thumb.jpg`, see `reference-data-actions.ts`), and
 * moving speakers between tracks via a tap-to-pick flow. `reference-track.ts` only reads
 * `isSpeakerVisible()` from this module (currently always `true` — every
 * known speaker's segments always show on the timeline).
 *
 * replaces the old anchored-below-the-row speaker-visibility popover that
 * used to live inline in `reference-track.ts`.
 */

import { Assets, Container, Graphics, Rectangle, Sprite, Text, Texture, type FederatedPointerEvent } from "pixi.js";
import type { PeersMap } from "../../src/file-utils/file-shared";
import { getMediaPlaybackUrl } from "../../src/media";
import { createExpandingPanel, type ExpandingPanelHandle } from "../../src/widgets/expanding-panel";
import { createMediaDomOverlay, type MediaDomOverlayHandle } from "../../src/widgets/media-dom-overlay";
import { createScrollableContent, type ScrollableContent } from "../../src/widgets/scrollable-content";
import { createSkeinInput, FIELD_BG, type SkeinInputHandle } from "../../src/widgets/skein-input";
import { getSpeakerSamples } from "./reference-data";
import {
  DEFAULT_REFERENCE_TRACK_ID,
  resolveReferenceTrackId,
  type ReferenceSpeaker,
  type ReferenceTrack,
  type StfuState,
  type TranscriptSegment,
} from "./types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

const DIALOG_WIDTH = 560;
const DIALOG_PAD = 12;
const HEADER_BTN_HEIGHT = 24;
const TOP_ROW_Y = 8;
const LIST_Y = TOP_ROW_Y + HEADER_BTN_HEIGHT + 10;
const MAX_LIST_HEIGHT = 380;

const TRACK_HEADER_HEIGHT = 30;
const TRACK_GAP = 14;
// each speaker "row" is a vertically-stacked card: a wide/tall sample
// carousel (image, paged with prev/next arrows, tap to watch the video) on
// top of the editable name field below it.
const CAROUSEL_HEIGHT = 170;
const CAROUSEL_ARROW_SIZE = 32;
// keeps the prev/next arrows clear of the inline video overlay (a real DOM
// element that always paints over pixi-rendered content) by insetting the
// video horizontally, rather than covering the full carousel width.
const CAROUSEL_VIDEO_INSET = CAROUSEL_ARROW_SIZE + 14;
const NAME_ROW_HEIGHT = 44;
const CARD_GAP = 6; // between the carousel and the name field
const ROW_HEIGHT = CAROUSEL_HEIGHT + CARD_GAP + NAME_ROW_HEIGHT;
const ROW_GAP = 12;
const MOVE_BUTTON_SIZE = 34;
const DELETE_TRACK_BTN_WIDTH = 56;
const DELETE_TRACK_BTN_HEIGHT = 20;
const COPY_TRACK_BTN_WIDTH = 96;
const COPY_TRACK_BTN_HEIGHT = 20;
// gap kept between the track-label input and whichever header buttons
// (copy/delete) trail it, so they never visually collide.
const HEADER_ITEM_GAP = 10;
// alternating shades (slightly lighter/darker than the panel's own
// 0x222222) drawn behind each track group so the grouping reads at a
// glance, without needing yet another border.
const TRACK_GROUP_BG_EVEN = 0x272727;
const TRACK_GROUP_BG_ODD = 0x202020;

// "drop zone" bins shown in place of the row list while picking a
// destination track for a speaker — one per track OTHER than its current one.
const DROPZONE_HEIGHT = 60;
const DROPZONE_GAP = 10;
const DROPZONE_HIGHLIGHT = 0xe619b3; // matches trek-minus-paris's --color-magenta custom property

export interface ReferenceDialogOptions {
  /** widget-root container — the dialog covers the *whole* widget, not just
   *  the timeline shell, same reasoning as `voice-picker-dialog.ts`. */
  overlayParent: Container;
  canvasElement: HTMLCanvasElement;
  getReferenceSpeakers: () => Record<string, ReferenceSpeaker>;
  getReferenceTracks: () => ReferenceTrack[];
  /** diarized/transcribed segments — used to compute each speaker's total
   *  speaking time and share of the video shown in their row. */
  getTranscriptSegments: () => TranscriptSegment[];
  getVideoDurationSec: () => number;
  changeDoc: (fn: (d: StfuState) => void) => void;
  getPeers?: () => PeersMap | undefined;
  /** fires as the dialog (or its "watch sample" sub-dialog) opens/closes —
   *  the widget's DOM video overlay sits above pixi content, so the caller
   *  uses this to pause + hide it while either is open. */
  onOpenChange?: (open: boolean) => void;
}

export interface ReferenceDialogHandle {
  /** whether a speaker's segments should currently be drawn on the timeline
   *  — `reference-track.ts` reads this on every redraw. always `true` (no
   *  per-speaker visibility toggle in this dialog). */
  isSpeakerVisible(label: string): boolean;
  /** call with the full widget's current (width, height) on mount/resize. */
  resize(width: number, height: number): void;
  open(): void;
  toggle(): void;
  /** re-read speakers/tracks and redraw — call after reference data changes
   *  for any reason (loading a project folder, merging new diarization). */
  refresh(): void;
  destroy(): void;
}

// a widget's raw automerge doc may predate `referenceTracks` (added after the
// widget was first created) — `ctx.doc.current` transparently fills in the
// zod schema default on every READ, but a `changeDoc()` mutator runs against
// the raw doc directly, so any mutation touching `d.referenceTracks` must
// guard against it being missing/empty first.
function ensureReferenceTracks(d: StfuState): void {
  if (!Array.isArray(d.referenceTracks) || d.referenceTracks.length === 0) {
    d.referenceTracks = [{ id: DEFAULT_REFERENCE_TRACK_ID, label: "all speakers" }];
  }
}

function makeSecondaryButton(label: string, onClick: () => void): { container: Container; draw(width: number): void } {
  const container = new Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  const bg = new Graphics();
  const text = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xdddddd },
    resolution: TEXT_RESOLUTION,
  });
  text.anchor.set(0.5);
  container.addChild(bg, text);

  let currentWidth = 0;
  const paint = (color: number) => {
    bg.clear();
    bg.roundRect(0, 0, currentWidth, HEADER_BTN_HEIGHT, 4).fill({ color });
  };
  container.on("pointerover", () => paint(0x4a4a4a));
  container.on("pointerout", () => paint(0x3a3a3a));
  container.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onClick();
  });

  return {
    container,
    draw(width: number) {
      currentWidth = width;
      paint(0x3a3a3a);
      text.x = width / 2;
      text.y = HEADER_BTN_HEIGHT / 2;
      container.hitArea = new Rectangle(0, 0, width, HEADER_BTN_HEIGHT);
    },
  };
}

/** cheap module-level texture cache — thumbnails are small and shared
 *  across every dialog instance/refresh, no reason to reload the same
 *  blob's texture twice in one session. */
const textureCache = new Map<string, Promise<Texture>>();

function loadTexture(url: string): Promise<Texture> {
  let p = textureCache.get(url);
  if (!p) {
    p = Assets.load<Texture>(url);
    textureCache.set(url, p);
  }
  return p;
}

/** scale `sprite` to fit (not fill) within `boxW`x`boxH`, centered — avoids
 *  distorting a thumbnail whose aspect ratio doesn't match the box. */
function fitSpriteInBox(sprite: Sprite, boxW: number, boxH: number): void {
  const tw = sprite.texture.width;
  const th = sprite.texture.height;
  if (!tw || !th) {
    sprite.visible = false;
    return;
  }
  const scale = Math.min(boxW / tw, boxH / th);
  sprite.width = tw * scale;
  sprite.height = th * scale;
  sprite.x = (boxW - sprite.width) / 2;
  sprite.y = (boxH - sprite.height) / 2;
  sprite.visible = true;
}

export function createReferenceDialog(options: ReferenceDialogOptions): ReferenceDialogHandle {
  const {
    overlayParent,
    canvasElement,
    getReferenceSpeakers,
    getReferenceTracks,
    getTranscriptSegments,
    getVideoDurationSec,
    changeDoc,
    getPeers,
    onOpenChange,
  } = options;

  let overlayWidth = 0;
  let overlayHeight = 0;

  // -- panel shell (title, add-track/close buttons) -----------------------------

  const panel = new Container();
  panel.eventMode = "static";
  panel.on("pointerdown", (e) => e.stopPropagation());

  const panelBg = new Graphics();
  panel.addChild(panelBg);

  const titleText = new Text({
    text: "reference speakers",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fontWeight: "700", fill: 0xffffff },
    resolution: TEXT_RESOLUTION,
  });
  titleText.anchor.set(0, 0.5);
  titleText.position.set(DIALOG_PAD, TOP_ROW_Y + HEADER_BTN_HEIGHT / 2);
  panel.addChild(titleText);

  const addTrackButton = makeSecondaryButton("+ add track", () => {
    changeDoc((d) => {
      ensureReferenceTracks(d);
      // unshift (not push) so the new track is visible at the top of the
      // list without scrolling — safe since `resolveTrackId` no longer
      // depends on array position for its fallback.
      d.referenceTracks.unshift({ id: crypto.randomUUID(), label: "" });
    });
    refreshPanel();
  });
  panel.addChild(addTrackButton.container);

  // shown in place of `addTrackButton` while picking a destination track for
  // a speaker (see "move speaker to another track" below).
  const cancelMoveButton = makeSecondaryButton("cancel", () => cancelMove());
  cancelMoveButton.draw(90);
  cancelMoveButton.container.x = DIALOG_WIDTH - 24 - 8 - 90;
  cancelMoveButton.container.y = TOP_ROW_Y;
  cancelMoveButton.container.visible = false;
  panel.addChild(cancelMoveButton.container);

  const closeButton = new Container();
  closeButton.eventMode = "static";
  closeButton.cursor = "pointer";
  const closeLabel = new Text({
    text: "\u2715",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0x999999 },
    resolution: TEXT_RESOLUTION,
  });
  closeLabel.anchor.set(0.5);
  closeLabel.position.set(12, 12);
  closeButton.hitArea = new Rectangle(0, 0, 24, 24);
  closeButton.addChild(closeLabel);
  panel.addChild(closeButton);
  closeButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    expandingPanel.close();
  });

  const scrollable: ScrollableContent = createScrollableContent(
    panel,
    canvasElement,
    DIALOG_PAD,
    LIST_Y,
    DIALOG_WIDTH - DIALOG_PAD * 2,
    1
  );

  const emptyText = new Text({
    text: "no diarization data found for this video",
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      fill: 0x888888,
      wordWrap: true,
      wordWrapWidth: DIALOG_WIDTH - DIALOG_PAD * 2,
    },
    resolution: TEXT_RESOLUTION,
  });
  scrollable.content.addChild(emptyText);

  // -- drag-drop "drop zones" (replace the row list while dragging) ------------

  interface DropZone {
    container: Container;
    bg: Graphics;
    label: Text;
    sub: Text;
    trackId: string;
  }
  const dropZonePool: DropZone[] = [];
  const dropZonesContainer = new Container();
  dropZonesContainer.visible = false;
  dropZonesContainer.position.set(DIALOG_PAD, LIST_Y);
  panel.addChild(dropZonesContainer);
  let dropZoneWidth = 1;

  function makeDropZone(): DropZone {
    const container = new Container();
    container.eventMode = "static";
    container.cursor = "pointer";
    const bg = new Graphics();
    const label = new Text({
      text: "",
      style: { fontFamily: FONT_FAMILY, fontSize: 13, fontWeight: "700", fill: 0xffffff },
      resolution: TEXT_RESOLUTION,
    });
    const sub = new Text({
      text: "tap to move here",
      style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0x999999 },
      resolution: TEXT_RESOLUTION,
    });
    label.position.set(14, 12);
    sub.position.set(14, 34);
    container.addChild(bg, label, sub);
    dropZonesContainer.addChild(container);
    const zone: DropZone = { container, bg, label, sub, trackId: "" };
    container.on("pointerover", () => paintDropZone(zone, true));
    container.on("pointerout", () => paintDropZone(zone, false));
    container.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      confirmMove(zone.trackId);
    });
    dropZonePool.push(zone);
    return zone;
  }

  function dropZoneAt(i: number): DropZone {
    while (dropZonePool.length <= i) makeDropZone();
    return dropZonePool[i];
  }

  function paintDropZone(zone: DropZone, hovered: boolean): void {
    zone.bg.clear();
    zone.bg
      .roundRect(0, 0, dropZoneWidth, DROPZONE_HEIGHT, 6)
      .fill({ color: hovered ? 0x3a2a38 : 0x262626 })
      .stroke({ width: hovered ? 2 : 1, color: hovered ? DROPZONE_HIGHLIGHT : 0x4a4a4a });
  }

  /** hides the normal row list and shows one tappable drop-zone bin per
   *  track other than `sourceTrackId` — called once a "move" tap starts. */
  function showDropZones(sourceTrackId: string): void {
    if (activeVideoRow) closeRowVideo(activeVideoRow); // row list is about to be hidden
    const tracks = getReferenceTracks();
    const speakers = getReferenceSpeakers();
    const targets = tracks.filter((t) => t.id !== sourceTrackId);
    dropZoneWidth = DIALOG_WIDTH - DIALOG_PAD * 2;

    targets.forEach((track, i) => {
      const zone = dropZoneAt(i);
      zone.trackId = track.id;
      zone.container.visible = true;
      zone.container.y = i * (DROPZONE_HEIGHT + DROPZONE_GAP);
      const memberCount = Object.values(speakers).filter((s) => resolveReferenceTrackId(s, tracks) === track.id).length;
      zone.label.text = track.label || `track ${tracks.indexOf(track) + 1}`;
      zone.sub.text = `${memberCount} speaker${memberCount === 1 ? "" : "s"} \u2014 tap to move here`;
      paintDropZone(zone, false);
    });
    for (let i = targets.length; i < dropZonePool.length; i++) dropZonePool[i].container.visible = false;

    titleText.text = `move "${movingSpeaker}" to:`;
    addTrackButton.container.visible = false;
    cancelMoveButton.container.visible = true;
    scrollable.content.visible = false;
    dropZonesContainer.visible = true;
    const height = targets.length * DROPZONE_HEIGHT + Math.max(0, targets.length - 1) * DROPZONE_GAP;
    paintPanelShell(LIST_Y + Math.max(1, height) + DIALOG_PAD);
  }

  function hideDropZones(): void {
    dropZonesContainer.visible = false;
    scrollable.content.visible = true;
    titleText.text = "reference speakers";
    addTrackButton.container.visible = true;
    cancelMoveButton.container.visible = false;
  }

  // -- track section pool (header + its member rows) ---------------------------

  interface TrackSection {
    container: Container;
    /** alternating-shade backdrop spanning the whole group (header + rows)
     *  so the grouping is visible at a glance. */
    groupBg: Graphics;
    headerBg: Graphics;
    headerLabel: Text;
    input: SkeinInputHandle;
    removeButton: Container;
    removeLabel: Text;
    /** copies every transcript segment belonging to this track's speakers
     *  onto the cut track's segment timeline (`d.editableSegments`). */
    copyButton: Container;
    copyLabel: Text;
    rows: SpeakerRow[];
    /** which track this pooled section currently represents — read by the
     *  input's own `onChange` closure, updated synchronously in
     *  `refreshPanel()` before any user input could fire it. */
    currentTrackId: string;
  }
  interface SpeakerRow {
    container: Container;
    /** fills the whole card the same color as the name input's own
     *  background, so the gaps around/below it don't show through as a
     *  mismatched strip. */
    cardBg: Graphics;
    /** color-coded outline around the whole card (carousel + name field). */
    rowBorder: Graphics;
    carouselSlot: Container;
    carouselBg: Graphics;
    carouselSprite: Sprite;
    /** anchor for the inline video overlay, inset from the carousel's edges
     *  so the prev/next arrows stay visible/clickable while a video plays. */
    videoSlot: Container;
    prevArrow: Container;
    nextArrow: Container;
    indexText: Text;
    /** total speaking time + share of the video, e.g. "2:34 (18%)" —
     *  derived from `transcriptSegments`, refreshed alongside the rest of
     *  the row. */
    statsText: Text;
    moveButton: Container;
    moveBg: Graphics;
    moveLabel: Text;
    /** editable display name — writes to `referenceSpeakers[speaker].name`;
     *  the original diarization label (`speaker` below) is never changed. */
    nameInput: SkeinInputHandle;
    speaker: string;
    /** which track `speaker` currently belongs to — kept in sync with
     *  `speaker` in `refreshPanel()`, read by `moveButton`'s tap handler. */
    currentTrackId: string;
    /** which slide the carousel is currently showing — each sample
     *  contributes two slides (its thumbnail, then its video; see
     *  `sampleIndexForSlide()`/`isVideoSlide()`) — reset to 0 whenever this
     *  pooled row gets recycled to a new speaker. */
    carouselSlide: number;
    thumbKey: string | null;
    /** the inline video overlay currently playing in this row's carousel
     *  (see `playRowVideo()`/`closeRowVideo()`), or null when showing the
     *  static thumbnail. */
    videoOverlay: MediaDomOverlayHandle | null;
    videoKey: string | null;
  }

  const trackSectionPool: TrackSection[] = [];

  function makeCarouselArrowButton(glyph: string): Container {
    const button = new Container();
    button.eventMode = "static";
    button.cursor = "pointer";
    button.hitArea = new Rectangle(0, 0, CAROUSEL_ARROW_SIZE, CAROUSEL_ARROW_SIZE);
    const bg = new Graphics()
      .roundRect(0, 0, CAROUSEL_ARROW_SIZE, CAROUSEL_ARROW_SIZE, 4)
      .fill({ color: 0x000000, alpha: 0.45 });
    const label = new Text({
      text: glyph,
      style: { fontFamily: FONT_FAMILY, fontSize: 18, fill: 0xf0f0f0 },
      resolution: TEXT_RESOLUTION,
    });
    label.anchor.set(0.5);
    label.position.set(CAROUSEL_ARROW_SIZE / 2, CAROUSEL_ARROW_SIZE / 2);
    button.addChild(bg, label);
    return button;
  }

  function makeSpeakerRow(parent: Container): SpeakerRow {
    const container = new Container();
    container.eventMode = "static";

    const cardBg = new Graphics();
    const rowBorder = new Graphics();

    const carouselSlot = new Container();
    carouselSlot.eventMode = "static";
    carouselSlot.cursor = "pointer";
    const carouselBg = new Graphics();
    const carouselSprite = new Sprite(Texture.EMPTY);
    carouselSprite.visible = false;
    carouselSlot.addChild(carouselBg, carouselSprite);

    const videoSlot = new Container();

    const prevArrow = makeCarouselArrowButton("\u2039");
    const nextArrow = makeCarouselArrowButton("\u203a");
    const indexText = new Text({
      text: "",
      style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xe2e2e2 },
      resolution: TEXT_RESOLUTION,
    });
    const statsText = new Text({
      text: "",
      style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xe2e2e2 },
      resolution: TEXT_RESOLUTION,
    });

    const moveButton = new Container();
    moveButton.eventMode = "static";
    moveButton.cursor = "pointer";
    const moveBg = new Graphics();
    const moveLabel = new Text({
      text: "\u21c4",
      style: { fontFamily: FONT_FAMILY, fontSize: 17, fill: 0xe2e2e2 },
      resolution: TEXT_RESOLUTION,
    });
    moveLabel.anchor.set(0.5);
    moveButton.addChild(moveBg, moveLabel);

    const row: SpeakerRow = {
      container,
      cardBg,
      rowBorder,
      carouselSlot,
      carouselBg,
      carouselSprite,
      videoSlot,
      prevArrow,
      nextArrow,
      indexText,
      statsText,
      moveButton,
      moveBg,
      moveLabel,
      // assigned just below — TypeScript can't see that yet, so this object
      // is built incrementally rather than in one literal (matches
      // `makeTrackSection()`'s own input-field pattern above).
      nameInput: undefined as unknown as SkeinInputHandle,
      speaker: "",
      currentTrackId: "",
      carouselSlide: 0,
      thumbKey: null,
      videoOverlay: null,
      videoKey: null,
    };

    // every handler below reads `row.*` at tap-time (not a per-refresh
    // closure capture) — safe because a pooled row's fields are always
    // updated in place, never replaced, so they're current by the time a
    // user can actually tap.
    carouselSlot.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (!row.speaker || row.videoOverlay) return; // no speaker, or already playing
      pageCarousel(1); // tapping the thumbnail jumps straight to that sample's video
    });
    const pageCarousel = (delta: number) => {
      const speaker = row.speaker ? getReferenceSpeakers()[row.speaker] : undefined;
      const total = slideCountFor(speaker);
      if (total === 0) return;
      row.carouselSlide = (row.carouselSlide + delta + total) % total;
      row.indexText.text = total > 1 ? `${row.carouselSlide + 1} / ${total}` : "";
      renderCarouselSlide(row, speaker);
    };
    prevArrow.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      pageCarousel(-1);
    });
    nextArrow.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      pageCarousel(1);
    });
    moveButton.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (row.speaker) startMove(row.speaker, row.currentTrackId);
    });

    const nameInput = createSkeinInput({
      canvasElement,
      width: 100,
      height: NAME_ROW_HEIGHT - 8,
      fontSize: 12,
      textColor: 0xdddddd,
      onChange: (v) => {
        if (!row.speaker) return;
        changeDoc((d) => {
          const s = d.referenceSpeakers[row.speaker];
          if (s) s.name = v;
        });
      },
    });
    row.nameInput = nameInput;

    container.addChild(
      cardBg,
      carouselSlot,
      videoSlot,
      prevArrow,
      nextArrow,
      indexText,
      statsText,
      moveButton,
      nameInput.input,
      rowBorder
    );
    parent.addChild(container);

    return row;
  }

  function makeTrackSection(): TrackSection {
    const container = new Container();
    scrollable.content.addChild(container);

    const groupBg = new Graphics();
    const headerBg = new Graphics();
    const headerLabel = new Text({
      text: "",
      style: { fontFamily: FONT_FAMILY, fontSize: 11, fontWeight: "700", fill: 0xcccccc, letterSpacing: 0.3 },
      resolution: TEXT_RESOLUTION,
    });
    const section: TrackSection = {
      container,
      groupBg,
      headerBg,
      headerLabel,
      // `input`/`copyButton` are assigned just below — TypeScript can't see
      // that yet, so this object is built incrementally rather than in one
      // literal.
      input: undefined as unknown as SkeinInputHandle,
      removeButton: undefined as unknown as Container,
      removeLabel: undefined as unknown as Text,
      copyButton: undefined as unknown as Container,
      copyLabel: undefined as unknown as Text,
      rows: [],
      currentTrackId: "",
    };
    const input = createSkeinInput({
      canvasElement,
      width: DIALOG_WIDTH - DIALOG_PAD * 2 - 100,
      height: TRACK_HEADER_HEIGHT - 6,
      placeholder: "track label...",
      fontSize: 11,
      onChange: (v) => {
        if (!section.currentTrackId) return;
        changeDoc((d) => {
          ensureReferenceTracks(d);
          const t = d.referenceTracks.find((rt) => rt.id === section.currentTrackId);
          if (t) t.label = v;
        });
      },
    });
    input.input.visible = false;
    section.input = input;

    const removeButton = new Container();
    removeButton.eventMode = "static";
    removeButton.cursor = "pointer";
    const removeBg = new Graphics();
    const paintRemoveBg = (color: number) =>
      removeBg.clear().roundRect(0, 0, DELETE_TRACK_BTN_WIDTH, DELETE_TRACK_BTN_HEIGHT, 4).fill({ color });
    paintRemoveBg(0x3a3a3a);
    const removeLabel = new Text({
      text: "delete",
      style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xdddddd },
      resolution: TEXT_RESOLUTION,
    });
    removeLabel.anchor.set(0.5);
    removeLabel.position.set(DELETE_TRACK_BTN_WIDTH / 2, DELETE_TRACK_BTN_HEIGHT / 2);
    removeButton.addChild(removeBg, removeLabel);
    removeButton.hitArea = new Rectangle(0, 0, DELETE_TRACK_BTN_WIDTH, DELETE_TRACK_BTN_HEIGHT);
    removeButton.on("pointerover", () => paintRemoveBg(0x4a4a4a));
    removeButton.on("pointerout", () => paintRemoveBg(0x3a3a3a));
    removeButton.visible = false;
    section.removeButton = removeButton;
    section.removeLabel = removeLabel;

    const copyButton = new Container();
    copyButton.eventMode = "static";
    copyButton.cursor = "pointer";
    const copyBg = new Graphics();
    const paintCopyBg = (color: number) =>
      copyBg.clear().roundRect(0, 0, COPY_TRACK_BTN_WIDTH, COPY_TRACK_BTN_HEIGHT, 4).fill({ color });
    paintCopyBg(0x4d1140);
    const copyLabel = new Text({
      text: "copy to cuts",
      style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xdddddd },
      resolution: TEXT_RESOLUTION,
    });
    copyLabel.anchor.set(0.5);
    copyLabel.position.set(COPY_TRACK_BTN_WIDTH / 2, COPY_TRACK_BTN_HEIGHT / 2);
    copyButton.addChild(copyBg, copyLabel);
    copyButton.hitArea = new Rectangle(0, 0, COPY_TRACK_BTN_WIDTH, COPY_TRACK_BTN_HEIGHT);
    copyButton.on("pointerover", () => paintCopyBg(0x671758));
    copyButton.on("pointerout", () => paintCopyBg(0x4d1140));
    copyButton.visible = false;
    section.copyButton = copyButton;
    section.copyLabel = copyLabel;

    container.addChild(groupBg, headerBg, headerLabel, input.input, removeButton, copyButton);

    return section;
  }

  function trackSectionAt(i: number): TrackSection {
    while (trackSectionPool.length <= i) trackSectionPool.push(makeTrackSection());
    return trackSectionPool[i];
  }

  function rowAt(section: TrackSection, i: number): SpeakerRow {
    while (section.rows.length <= i) section.rows.push(makeSpeakerRow(section.container));
    return section.rows[i];
  }

  // -- thumbnail loading ---------------------------------------------------------

  /** each sample contributes 2 carousel slides: its thumbnail, then its
   *  video — so browsing a speaker's samples pages through image, video,
   *  image, video, ... rather than needing a tap to reveal each video. */
  function slideCountFor(speaker: ReferenceSpeaker | undefined): number {
    return speaker ? getSpeakerSamples(speaker).length * 2 : 0;
  }
  function sampleIndexForSlide(slide: number): number {
    return Math.floor(slide / 2);
  }
  function isVideoSlide(slide: number): boolean {
    return slide % 2 === 1;
  }

  /** e.g. "2:34 (18%)" — share is omitted once no video duration is known
   *  yet, and the whole string is blank for a speaker with no segments. */
  function formatSpeakingStats(totalSec: number, videoDurationSec: number): string {
    if (totalSec <= 0) return "";
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    const time = `${m}:${String(s).padStart(2, "0")}`;
    if (videoDurationSec <= 0) return time;
    const pct = Math.round((totalSec / videoDurationSec) * 100);
    return `${time} (${pct}%)`;
  }

  /** show whichever of the row's current slide (thumbnail or video) is due
   *  — called on initial layout and every time `carouselSlide` changes. */
  function renderCarouselSlide(row: SpeakerRow, speaker: ReferenceSpeaker | undefined): void {
    if (!speaker || slideCountFor(speaker) === 0) {
      closeRowVideo(row);
      row.thumbKey = null;
      row.carouselSprite.visible = false;
      return;
    }
    const sampleIndex = sampleIndexForSlide(row.carouselSlide);
    if (isVideoSlide(row.carouselSlide)) {
      row.carouselSprite.visible = false;
      void playRowVideo(row, sampleIndex);
    } else {
      closeRowVideo(row);
      loadCarouselThumbnail(row, speaker, sampleIndex);
    }
  }

  function loadCarouselThumbnail(row: SpeakerRow, speaker: ReferenceSpeaker, sampleIndex: number): void {
    const sample = getSpeakerSamples(speaker)[sampleIndex];
    const blobId = sample?.thumbnailBlobId;
    if (!blobId) {
      row.thumbKey = null;
      row.carouselSprite.visible = false;
      return;
    }
    const key = `${sampleIndex}:${blobId}:${sample.thumbnailBlake3 ?? ""}`;
    if (row.thumbKey === key) return; // already showing (or loading) this thumbnail
    row.thumbKey = key;
    row.carouselSprite.visible = false;
    void (async () => {
      const url = await getMediaPlaybackUrl(blobId, {
        category: "image",
        mime: sample.thumbnailMime,
        blake3: sample.thumbnailBlake3,
        peers: getPeers?.(),
      });
      if (!url || row.thumbKey !== key) return; // row got recycled to a different speaker/thumbnail meanwhile
      try {
        const texture = await loadTexture(url);
        if (row.thumbKey !== key) return;
        row.carouselSprite.texture = texture;
        fitSpriteInBox(row.carouselSprite, DIALOG_WIDTH - DIALOG_PAD * 2, CAROUSEL_HEIGHT);
      } catch (err) {
        console.error(`stfu widget: failed to load thumbnail for reference dialog:`, err);
      }
    })();
  }

  // -- "move speaker to another track" tap flow ---------------------------------

  let movingSpeaker: string | null = null;
  let movingFromTrackId: string | null = null;

  function startMove(speakerLabel: string, sourceTrackId: string): void {
    if (getReferenceTracks().length <= 1) return; // nothing to move to
    movingSpeaker = speakerLabel;
    movingFromTrackId = sourceTrackId;
    showDropZones(sourceTrackId);
  }

  function confirmMove(targetTrackId: string): void {
    const speakerLabel = movingSpeaker;
    const sourceTrackId = movingFromTrackId;
    if (speakerLabel && targetTrackId !== sourceTrackId) {
      changeDoc((d) => {
        const speaker = d.referenceSpeakers[speakerLabel];
        if (speaker) speaker.trackId = targetTrackId;
      });
    }
    cancelMove();
  }

  function cancelMove(): void {
    movingSpeaker = null;
    movingFromTrackId = null;
    hideDropZones();
    refreshPanel();
  }

  // -- inline row video playback -------------------------------------------------
  // tapping a row's carousel plays that sample's video right there (a DOM
  // overlay tracking the carousel's screen rect, same mechanism the old
  // "watch sample" popup used) instead of opening a separate dialog. only
  // one row plays at a time.

  let activeVideoRow: SpeakerRow | null = null;

  function closeRowVideo(row: SpeakerRow): void {
    row.videoOverlay?.close();
    row.videoOverlay = null;
    row.videoKey = null;
    if (activeVideoRow === row) activeVideoRow = null;
  }

  async function playRowVideo(row: SpeakerRow, sampleIndex: number): Promise<void> {
    if (!row.speaker) return;
    const speaker = getReferenceSpeakers()[row.speaker];
    const samples = speaker ? getSpeakerSamples(speaker) : [];
    const sample = samples[sampleIndex];
    if (!sample) return;

    const key = `${row.speaker}:${sampleIndex}:${sample.videoBlobId}`;
    row.videoKey = key;
    if (activeVideoRow && activeVideoRow !== row) closeRowVideo(activeVideoRow);

    const url = await getMediaPlaybackUrl(sample.videoBlobId, {
      category: "video",
      mime: sample.videoMime,
      blake3: sample.videoBlake3,
      peers: getPeers?.(),
    });
    if (!url || row.videoKey !== key) return; // paged/recycled/closed meanwhile

    row.videoOverlay?.close();
    row.videoOverlay = createMediaDomOverlay({
      src: url,
      mime: sample.videoMime,
      container: row.videoSlot,
      canvasElement,
      getSize: () => ({ width: DIALOG_WIDTH - DIALOG_PAD * 2 - CAROUSEL_VIDEO_INSET * 2, height: CAROUSEL_HEIGHT }),
      muted: false,
      loop: false,
      controls: true,
      objectFit: "contain",
    });
    activeVideoRow = row;
  }

  // -- layout / refresh -----------------------------------------------------------


  function refreshPanel(): void {
    const speakers = getReferenceSpeakers();
    const tracks = getReferenceTracks();
    const labels = Object.keys(speakers).sort();
    const videoDurationSec = getVideoDurationSec();
    const speakingSeconds = new Map<string, number>();
    for (const seg of getTranscriptSegments()) {
      if (!seg.speaker) continue;
      speakingSeconds.set(seg.speaker, (speakingSeconds.get(seg.speaker) ?? 0) + Math.max(0, seg.end - seg.start));
    }

    const contentWidth = DIALOG_WIDTH - DIALOG_PAD * 2;

    // a full refresh always returns to the normal list view — an in-progress
    // "move" only stays up via `showDropZones()`'s own direct panel repaint.
    movingSpeaker = null;
    movingFromTrackId = null;
    dropZonesContainer.visible = false;
    scrollable.content.visible = true;
    titleText.text = "reference speakers";
    // pooled rows may get reassigned to a different speaker/order below —
    // stop whatever was playing rather than risk it ending up detached.
    if (activeVideoRow) closeRowVideo(activeVideoRow);

    // header buttons
    addTrackButton.container.visible = true;
    cancelMoveButton.container.visible = false;
    addTrackButton.draw(90);
    addTrackButton.container.x = DIALOG_WIDTH - 24 - 8 - 90;
    addTrackButton.container.y = TOP_ROW_Y;

    emptyText.visible = labels.length === 0;
    let finalListHeight = 1;

    if (labels.length === 0) {
      finalListHeight = Math.max(1, emptyText.height);
      scrollable.reflow(contentWidth, finalListHeight);
      scrollable.resize(contentWidth, finalListHeight);
      for (const section of trackSectionPool) section.container.visible = false;
    } else {
      // group speaker labels by resolved track id, preserving alphabetical order.
      const byTrack = new Map<string, string[]>();
      for (const track of tracks) byTrack.set(track.id, []);
      for (const label of labels) {
        const trackId = resolveReferenceTrackId(speakers[label], tracks);
        (byTrack.get(trackId) ?? byTrack.set(trackId, []).get(trackId)!).push(label);
      }

      let y = 0;
      tracks.forEach((track, sectionIdx) => {
        const section = trackSectionAt(sectionIdx);
        section.container.visible = true;
        section.container.y = y;

        const members = byTrack.get(track.id) ?? [];
        const showTrackChrome = tracks.length > 1;
        // a lone, unnamed default track would just repeat the dialog's own
        // "reference speakers" title — skip its header row entirely then.
        const showHeaderLabel = !showTrackChrome && !!track.label;
        const showHeader = showTrackChrome || showHeaderLabel;
        const showCopyButton = showHeader && members.length > 0;
        section.input.input.visible = showTrackChrome;
        section.removeButton.visible = showTrackChrome;
        section.copyButton.visible = showCopyButton;
        section.headerLabel.visible = showHeaderLabel;
        section.headerBg.visible = showHeader;

        if (showTrackChrome) {
          section.currentTrackId = track.id;
          if (!section.input.isEditing) section.input.value = track.label;
          // leaves room (plus a gap) for the copy/delete buttons trailing it.
          section.input.setWidth(
            contentWidth - DELETE_TRACK_BTN_WIDTH - HEADER_ITEM_GAP - (showCopyButton ? COPY_TRACK_BTN_WIDTH + HEADER_ITEM_GAP : 0)
          );
          section.input.input.position.set(0, 3);
          section.removeButton.x = contentWidth - DELETE_TRACK_BTN_WIDTH;
          section.removeButton.y = (TRACK_HEADER_HEIGHT - DELETE_TRACK_BTN_HEIGHT) / 2;
          section.removeButton.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
            e.stopPropagation();
            const current = getReferenceTracks();
            if (current.length <= 1) return;
            changeDoc((d) => {
              ensureReferenceTracks(d);
              const idx = d.referenceTracks.findIndex((t) => t.id === track.id);
              if (idx === -1) return;
              d.referenceTracks.splice(idx, 1);
              ensureReferenceTracks(d);
              const fallbackId =
                d.referenceTracks.find((t) => t.id === DEFAULT_REFERENCE_TRACK_ID)?.id ??
                d.referenceTracks[0]?.id ??
                DEFAULT_REFERENCE_TRACK_ID;
              for (const label of Object.keys(d.referenceSpeakers)) {
                if (d.referenceSpeakers[label].trackId === track.id) {
                  d.referenceSpeakers[label].trackId = fallbackId;
                }
              }
            });
            refreshPanel();
          });
        } else if (showHeaderLabel) {
          section.headerLabel.text = track.label;
          section.headerLabel.position.set(0, 6);
        }

        section.headerBg
          .clear()
          .roundRect(0, 0, contentWidth, TRACK_HEADER_HEIGHT, 4)
          .fill({ color: 0x262626 });

        const headerHeight = showHeader ? TRACK_HEADER_HEIGHT + 6 : 0;

        // -- "copy to cuts" button: pushes this group's transcript segments
        // onto the cut track's segment timeline (`d.editableSegments`) ------
        if (showCopyButton) {
          section.copyButton.x = contentWidth - (showTrackChrome ? DELETE_TRACK_BTN_WIDTH + HEADER_ITEM_GAP : 0) - COPY_TRACK_BTN_WIDTH;
          section.copyButton.y = (TRACK_HEADER_HEIGHT - COPY_TRACK_BTN_HEIGHT) / 2;
          section.copyButton.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
            e.stopPropagation();
            const memberSet = new Set(members);
            changeDoc((d) => {
              const existing = new Set(d.editableSegments.map(([s, en]) => `${s}:${en}`));
              for (const seg of d.transcriptSegments) {
                if (!memberSet.has(seg.speaker)) continue;
                const key = `${seg.start}:${seg.end}`;
                if (existing.has(key)) continue;
                existing.add(key);
                d.editableSegments.push([seg.start, seg.end]);
              }
            });
          });
        }

        members.forEach((label, rowIdx) => {
          const row = rowAt(section, rowIdx);
          const speaker = speakers[label];
          const totalSlides = slideCountFor(speaker);
          if (row.speaker !== label) row.carouselSlide = 0; // row recycled for a new speaker
          row.speaker = label;
          row.currentTrackId = track.id;
          row.carouselSlide = totalSlides > 0 ? Math.min(row.carouselSlide, totalSlides - 1) : 0;
          row.container.visible = true;
          row.container.y = headerHeight + rowIdx * (ROW_HEIGHT + ROW_GAP);
          row.container.hitArea = new Rectangle(0, 0, contentWidth, ROW_HEIGHT);

          const color = speaker?.color ?? 0x60a5fa;

          // -- whole-card fill (matches the name input's own bg, below) plus
          // its color-coded outline --------------------------------------
          row.cardBg.clear().roundRect(0, 0, contentWidth, ROW_HEIGHT, 8).fill({ color: FIELD_BG });
          row.rowBorder.clear().roundRect(0, 0, contentWidth, ROW_HEIGHT, 8).stroke({ width: 2, color });

          // -- carousel (sample thumbnail/video, paged with prev/next arrows) --
          row.carouselSlot.x = 0;
          row.carouselSlot.y = 0;
          row.carouselSlot.hitArea = new Rectangle(0, 0, contentWidth, CAROUSEL_HEIGHT);
          row.carouselBg.clear().roundRect(0, 0, contentWidth, CAROUSEL_HEIGHT, 6).fill({ color: 0x111111 });
          renderCarouselSlide(row, speaker);
          row.videoSlot.position.set(CAROUSEL_VIDEO_INSET, 0);

          const hasMultipleSlides = totalSlides > 1;
          row.prevArrow.visible = hasMultipleSlides;
          row.nextArrow.visible = hasMultipleSlides;
          row.prevArrow.position.set(8, (CAROUSEL_HEIGHT - CAROUSEL_ARROW_SIZE) / 2);
          row.nextArrow.position.set(contentWidth - CAROUSEL_ARROW_SIZE - 8, (CAROUSEL_HEIGHT - CAROUSEL_ARROW_SIZE) / 2);
          row.indexText.text = hasMultipleSlides ? `${row.carouselSlide + 1} / ${totalSlides}` : "";
          row.indexText.position.set(
            contentWidth - row.indexText.width - 10,
            CAROUSEL_HEIGHT - row.indexText.height - 6
          );
          row.statsText.text = formatSpeakingStats(speakingSeconds.get(label) ?? 0, videoDurationSec);
          row.statsText.position.set(10, CAROUSEL_HEIGHT - row.statsText.height - 6);

          // -- move-to-another-track button, overlaid on the carousel's top-left corner
          row.moveButton.visible = tracks.length > 1;
          row.moveButton.hitArea = new Rectangle(0, 0, MOVE_BUTTON_SIZE, MOVE_BUTTON_SIZE);
          row.moveButton.position.set(6, 6);
          row.moveBg.clear().roundRect(0, 0, MOVE_BUTTON_SIZE, MOVE_BUTTON_SIZE, 4).fill({ color: 0x000000, alpha: 0.45 });
          row.moveLabel.position.set(MOVE_BUTTON_SIZE / 2, MOVE_BUTTON_SIZE / 2);

          // -- name field, full width below the carousel — no border of its
          // own, so it blends seamlessly into the card's matching background
          row.nameInput.setWidth(contentWidth);
          row.nameInput.setBorderColor(FIELD_BG);
          row.nameInput.setPlaceholder(label);
          if (!row.nameInput.isEditing) row.nameInput.value = speaker?.name || "";
          row.nameInput.input.position.set(0, CAROUSEL_HEIGHT + CARD_GAP);
        });
        for (let i = members.length; i < section.rows.length; i++) section.rows[i].container.visible = false;

        const rowsHeight = members.length > 0 ? members.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP : 0;
        const sectionHeight = headerHeight + rowsHeight + (showHeader ? 6 : 0);
        section.groupBg
          .clear()
          .roundRect(-6, -6, contentWidth + 12, sectionHeight + 12, 8)
          .fill({ color: sectionIdx % 2 === 0 ? TRACK_GROUP_BG_EVEN : TRACK_GROUP_BG_ODD });
        y += sectionHeight + TRACK_GAP;
      });
      for (let i = tracks.length; i < trackSectionPool.length; i++) trackSectionPool[i].container.visible = false;

      const contentHeight = Math.max(1, y - TRACK_GAP);
      scrollable.reflow(contentWidth, contentHeight);
      finalListHeight = Math.min(MAX_LIST_HEIGHT, contentHeight);
      scrollable.resize(contentWidth, Math.max(1, finalListHeight));
    }

    paintPanelShell(LIST_Y + finalListHeight + DIALOG_PAD);
  }

  function paintPanelShell(panelHeight: number): void {
    panelBg.clear().roundRect(0, 0, DIALOG_WIDTH, panelHeight, 8).fill({ color: 0x222222 }).stroke({
      width: 1,
      color: 0x3a3a3a,
    });
    closeButton.x = DIALOG_WIDTH - 24;
    closeButton.y = 8;
    centerPanel(panelHeight);
  }

  function centerPanel(panelHeight: number): void {
    panel.x = Math.max(0, (overlayWidth - DIALOG_WIDTH) / 2);
    panel.y = Math.max(0, (overlayHeight - panelHeight) / 2);
  }

  const expandingPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent,
    panel,
    onOpenChange: (open) => {
      if (open) refreshPanel();
      else if (activeVideoRow) closeRowVideo(activeVideoRow);
      onOpenChange?.(open);
    },
  });

  return {
    isSpeakerVisible(): boolean {
      return true;
    },
    resize(width: number, height: number) {
      overlayWidth = width;
      overlayHeight = height;
      expandingPanel.resize(width, height);
      if (expandingPanel.isOpen) refreshPanel();
    },
    open() {
      expandingPanel.open();
    },
    toggle() {
      expandingPanel.toggle();
    },
    refresh() {
      if (expandingPanel.isOpen) refreshPanel();
    },
    destroy() {
      scrollable.destroy();
      expandingPanel.destroy();
      if (activeVideoRow) closeRowVideo(activeVideoRow);
      for (const section of trackSectionPool) {
        section.input.destroy();
        for (const row of section.rows) row.nameInput.destroy();
      }
    },
  };
}
