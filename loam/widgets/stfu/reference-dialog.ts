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
import { createSkeinInput, type SkeinInputHandle } from "../../src/widgets/skein-input";
import {
  DEFAULT_REFERENCE_TRACK_ID,
  resolveReferenceTrackId,
  type ReferenceSpeaker,
  type ReferenceTrack,
  type StfuState,
} from "./types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

const DIALOG_WIDTH = 460;
const DIALOG_PAD = 12;
const HEADER_BTN_HEIGHT = 24;
const TOP_ROW_Y = 8;
const LIST_Y = TOP_ROW_Y + HEADER_BTN_HEIGHT + 10;
const MAX_LIST_HEIGHT = 380;

const TRACK_HEADER_HEIGHT = 30;
const TRACK_GAP = 14;
const ROW_HEIGHT = 44;
const ROW_GAP = 4;
const MOVE_BUTTON_SIZE = 32;
const THUMB_WIDTH = 44;
const THUMB_HEIGHT = 28;
const WATCH_BUTTON_SIZE = 22;
const DELETE_TRACK_BTN_WIDTH = 56;
const DELETE_TRACK_BTN_HEIGHT = 20;

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
    d.referenceTracks = [{ id: DEFAULT_REFERENCE_TRACK_ID, label: "" }];
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
  const { overlayParent, canvasElement, getReferenceSpeakers, getReferenceTracks, changeDoc, getPeers, onOpenChange } = options;

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
  titleText.position.set(DIALOG_PAD, 10);
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
    headerBg: Graphics;
    headerLabel: Text;
    input: SkeinInputHandle;
    removeButton: Container;
    removeLabel: Text;
    rows: SpeakerRow[];
    /** which track this pooled section currently represents — read by the
     *  input's own `onChange` closure, updated synchronously in
     *  `refreshPanel()` before any user input could fire it. */
    currentTrackId: string;
  }
  interface SpeakerRow {
    container: Container;
    moveButton: Container;
    moveBg: Graphics;
    moveLabel: Text;
    thumbSlot: Container;
    thumbBg: Graphics;
    thumbSprite: Sprite;
    /** editable display name — writes to `referenceSpeakers[speaker].name`;
     *  the original diarization label (`speaker` below) is never changed. */
    nameInput: SkeinInputHandle;
    watchButton: Container;
    watchBg: Graphics;
    watchLabel: Text;
    speaker: string;
    thumbKey: string | null;
  }

  const trackSectionPool: TrackSection[] = [];

  function makeSpeakerRow(parent: Container): SpeakerRow {
    const container = new Container();
    container.eventMode = "static";

    const moveButton = new Container();
    moveButton.eventMode = "static";
    moveButton.cursor = "pointer";
    const moveBg = new Graphics();
    const moveLabel = new Text({
      text: "\u21c4",
      style: { fontFamily: FONT_FAMILY, fontSize: 15, fill: 0xe2e2e2 },
      resolution: TEXT_RESOLUTION,
    });
    moveLabel.anchor.set(0.5);
    moveButton.addChild(moveBg, moveLabel);

    const thumbSlot = new Container();
    const thumbBg = new Graphics();
    const thumbSprite = new Sprite(Texture.EMPTY);
    thumbSprite.visible = false;
    thumbSlot.addChild(thumbBg, thumbSprite);

    const row: SpeakerRow = {
      container,
      moveButton,
      moveBg,
      moveLabel,
      thumbSlot,
      thumbBg,
      thumbSprite,
      // assigned just below — TypeScript can't see that yet, so this object
      // is built incrementally rather than in one literal (matches
      // `makeTrackSection()`'s own input-field pattern above).
      nameInput: undefined as unknown as SkeinInputHandle,
      watchButton: undefined as unknown as Container,
      watchBg: undefined as unknown as Graphics,
      watchLabel: undefined as unknown as Text,
      speaker: "",
      thumbKey: null,
    };

    const nameInput = createSkeinInput({
      canvasElement,
      width: 100,
      height: ROW_HEIGHT - 12,
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

    const watchButton = new Container();
    watchButton.eventMode = "static";
    watchButton.cursor = "pointer";
    const watchBg = new Graphics();
    const watchLabel = new Text({
      text: "\u25b6",
      style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xe2e2e2 },
      resolution: TEXT_RESOLUTION,
    });
    watchLabel.anchor.set(0.5);
    watchButton.addChild(watchBg, watchLabel);
    row.watchButton = watchButton;
    row.watchBg = watchBg;
    row.watchLabel = watchLabel;

    container.addChild(moveButton, thumbSlot, nameInput.input, watchButton);
    parent.addChild(container);

    return row;
  }

  function makeTrackSection(): TrackSection {
    const container = new Container();
    scrollable.content.addChild(container);

    const headerBg = new Graphics();
    const headerLabel = new Text({
      text: "",
      style: { fontFamily: FONT_FAMILY, fontSize: 11, fontWeight: "700", fill: 0xcccccc, letterSpacing: 0.3 },
      resolution: TEXT_RESOLUTION,
    });
    const section: TrackSection = {
      container,
      headerBg,
      headerLabel,
      // `input` is assigned just below — TypeScript can't see that yet, so
      // this object is built incrementally rather than in one literal.
      input: undefined as unknown as SkeinInputHandle,
      removeButton: undefined as unknown as Container,
      removeLabel: undefined as unknown as Text,
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

    container.addChild(headerBg, headerLabel, input.input, removeButton);

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

  function loadRowThumbnail(row: SpeakerRow, speaker: ReferenceSpeaker): void {
    const blobId = speaker.thumbnailBlobId;
    if (!blobId) {
      row.thumbKey = null;
      row.thumbSprite.visible = false;
      return;
    }
    const key = `${blobId}:${speaker.thumbnailBlake3 ?? ""}`;
    if (row.thumbKey === key) return; // already showing (or loading) this thumbnail
    row.thumbKey = key;
    row.thumbSprite.visible = false;
    void (async () => {
      const url = await getMediaPlaybackUrl(blobId, {
        category: "image",
        mime: speaker.thumbnailMime,
        blake3: speaker.thumbnailBlake3,
        peers: getPeers?.(),
      });
      if (!url || row.thumbKey !== key) return; // row got recycled to a different speaker/thumbnail meanwhile
      try {
        const texture = await loadTexture(url);
        if (row.thumbKey !== key) return;
        row.thumbSprite.texture = texture;
        fitSpriteInBox(row.thumbSprite, THUMB_WIDTH, THUMB_HEIGHT);
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

  // -- "watch sample" sub-dialog -------------------------------------------------

  const PREVIEW_WIDTH = 360;
  const PREVIEW_VIDEO_HEIGHT = 202; // 16:9 at 360 wide
  const PREVIEW_PAD = 12;

  const previewPanel = new Container();
  previewPanel.eventMode = "static";
  previewPanel.on("pointerdown", (e) => e.stopPropagation());

  const previewBg = new Graphics();
  previewPanel.addChild(previewBg);

  const previewTitle = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fontWeight: "700", fill: 0xffffff },
    resolution: TEXT_RESOLUTION,
  });
  previewTitle.position.set(PREVIEW_PAD, 10);
  previewPanel.addChild(previewTitle);

  const previewCloseButton = new Container();
  previewCloseButton.eventMode = "static";
  previewCloseButton.cursor = "pointer";
  const previewCloseLabel = new Text({
    text: "\u2715",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0x999999 },
    resolution: TEXT_RESOLUTION,
  });
  previewCloseLabel.anchor.set(0.5);
  previewCloseLabel.position.set(12, 12);
  previewCloseButton.hitArea = new Rectangle(0, 0, 24, 24);
  previewCloseButton.addChild(previewCloseLabel);
  previewPanel.addChild(previewCloseButton);
  previewCloseButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    previewExpandingPanel.close();
  });

  const videoSlot = new Container();
  videoSlot.position.set(PREVIEW_PAD, 36);
  previewPanel.addChild(videoSlot);

  const previewVideoAreaHeight = PREVIEW_VIDEO_HEIGHT;
  previewBg
    .clear()
    .roundRect(0, 0, PREVIEW_WIDTH, 36 + previewVideoAreaHeight + PREVIEW_PAD, 8)
    .fill({ color: 0x1a1a1a })
    .stroke({ width: 1, color: 0x3a3a3a });
  previewCloseButton.x = PREVIEW_WIDTH - 24;
  previewCloseButton.y = 8;

  let sampleOverlay: MediaDomOverlayHandle | null = null;

  function closeSamplePreview(): void {
    sampleOverlay?.close();
    sampleOverlay = null;
  }

  function centerPreviewPanel(): void {
    const h = 36 + previewVideoAreaHeight + PREVIEW_PAD;
    previewPanel.x = Math.max(0, (overlayWidth - PREVIEW_WIDTH) / 2);
    previewPanel.y = Math.max(0, (overlayHeight - h) / 2);
  }

  const previewExpandingPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent,
    panel: previewPanel,
    onOpenChange: (open) => {
      if (!open) closeSamplePreview();
      onOpenChange?.(open);
    },
  });

  async function openSamplePreview(speaker: ReferenceSpeaker, label: string): Promise<void> {
    if (!speaker.sampleVideoBlobId) return;
    previewTitle.text = label;
    previewExpandingPanel.resize(overlayWidth, overlayHeight);
    centerPreviewPanel();
    previewExpandingPanel.open();
    closeSamplePreview();
    const url = await getMediaPlaybackUrl(speaker.sampleVideoBlobId, {
      category: "video",
      mime: speaker.sampleVideoMime,
      blake3: speaker.sampleVideoBlake3,
      peers: getPeers?.(),
    });
    if (!url || !previewExpandingPanel.isOpen) return;
    sampleOverlay = createMediaDomOverlay({
      src: url,
      mime: speaker.sampleVideoMime,
      container: videoSlot,
      canvasElement,
      getSize: () => ({ width: PREVIEW_WIDTH - PREVIEW_PAD * 2, height: previewVideoAreaHeight }),
      muted: false,
      loop: false,
      controls: true,
      objectFit: "contain",
    });
  }

  // -- layout / refresh -----------------------------------------------------------

  function refreshPanel(): void {
    const speakers = getReferenceSpeakers();
    const tracks = getReferenceTracks();
    const labels = Object.keys(speakers).sort();

    const contentWidth = DIALOG_WIDTH - DIALOG_PAD * 2;

    // a full refresh always returns to the normal list view — an in-progress
    // "move" only stays up via `showDropZones()`'s own direct panel repaint.
    movingSpeaker = null;
    movingFromTrackId = null;
    dropZonesContainer.visible = false;
    scrollable.content.visible = true;
    titleText.text = "reference speakers";

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

        const showTrackChrome = tracks.length > 1;
        section.input.input.visible = showTrackChrome;
        section.removeButton.visible = showTrackChrome;
        section.headerLabel.visible = !showTrackChrome;

        if (showTrackChrome) {
          section.currentTrackId = track.id;
          if (!section.input.isEditing) section.input.value = track.label;
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
        } else {
          section.headerLabel.text = track.label || "reference speakers";
          section.headerLabel.position.set(0, 6);
        }

        section.headerBg
          .clear()
          .roundRect(0, 0, contentWidth, TRACK_HEADER_HEIGHT, 4)
          .fill({ color: 0x262626 });

        const members = byTrack.get(track.id) ?? [];
        members.forEach((label, rowIdx) => {
          const row = rowAt(section, rowIdx);
          const speaker = speakers[label];
          row.speaker = label;
          row.container.visible = true;
          row.container.y = TRACK_HEADER_HEIGHT + 6 + rowIdx * (ROW_HEIGHT + ROW_GAP);
          row.container.hitArea = new Rectangle(0, 0, contentWidth, ROW_HEIGHT);

          row.moveButton.visible = tracks.length > 1;
          row.moveButton.hitArea = new Rectangle(0, 0, MOVE_BUTTON_SIZE, MOVE_BUTTON_SIZE);
          row.moveButton.y = (ROW_HEIGHT - MOVE_BUTTON_SIZE) / 2;
          row.moveBg.clear().roundRect(0, 0, MOVE_BUTTON_SIZE, MOVE_BUTTON_SIZE, 4).fill({ color: 0x3a3a3a });
          row.moveLabel.position.set(MOVE_BUTTON_SIZE / 2, MOVE_BUTTON_SIZE / 2);
          row.moveButton.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
            e.stopPropagation();
            startMove(label, track.id);
          });

          const thumbX = MOVE_BUTTON_SIZE + 10;
          row.thumbSlot.x = thumbX;
          row.thumbSlot.y = (ROW_HEIGHT - THUMB_HEIGHT) / 2;
          const color = speaker?.color ?? 0x60a5fa;
          row.thumbBg.clear().roundRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT, 3).fill({ color: 0x111111 }).stroke({
            width: 1.5,
            color,
          });
          if (speaker) loadRowThumbnail(row, speaker);
          else row.thumbSprite.visible = false;

          const labelX = thumbX + THUMB_WIDTH + 10;
          const nameInputWidth = Math.max(60, contentWidth - labelX - WATCH_BUTTON_SIZE - 18);
          row.nameInput.setWidth(nameInputWidth);
          row.nameInput.setPlaceholder(label);
          if (!row.nameInput.isEditing) row.nameInput.value = speaker?.name || "";
          row.nameInput.input.position.set(labelX, (ROW_HEIGHT - (ROW_HEIGHT - 12)) / 2);

          row.watchButton.x = contentWidth - WATCH_BUTTON_SIZE;
          row.watchButton.y = (ROW_HEIGHT - WATCH_BUTTON_SIZE) / 2;
          row.watchButton.visible = !!speaker?.sampleVideoBlobId;
          row.watchBg.clear().roundRect(0, 0, WATCH_BUTTON_SIZE, WATCH_BUTTON_SIZE, 4).fill({ color: 0x3a3a3a });
          row.watchLabel.position.set(WATCH_BUTTON_SIZE / 2, WATCH_BUTTON_SIZE / 2);
          row.watchButton.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
            e.stopPropagation();
            if (speaker) void openSamplePreview(speaker, label);
          });
        });
        for (let i = members.length; i < section.rows.length; i++) section.rows[i].container.visible = false;

        const rowsHeight = members.length > 0 ? members.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP : 0;
        const sectionHeight = TRACK_HEADER_HEIGHT + 6 + rowsHeight + 6;
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
      previewExpandingPanel.resize(width, height);
      if (expandingPanel.isOpen) refreshPanel();
      if (previewExpandingPanel.isOpen) centerPreviewPanel();
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
      closeSamplePreview();
      previewExpandingPanel.destroy();
      for (const section of trackSectionPool) {
        section.input.destroy();
        for (const row of section.rows) row.nameInput.destroy();
      }
    },
  };
}
