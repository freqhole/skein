/**
 * "widget → track" drag (drop an audio-recording/tts widget onto the audio
 * clips track) and its inverse "track → widget" drag (lift a clip back off
 * the track as its own standalone widget). pulled out of index.ts to keep
 * that file from growing further — see docs/stfu-widget-plan.md's
 * cross-widget drag-and-drop section for the full design.
 *
 * mirrors bin/index.ts's own dropTarget exactly in mechanics (hitTest/
 * onHover/onLeave/onDrop, pointer-position-based, no HTML5 DnD), but the
 * outcome is "move" not "nest": the dragged widget is removed from the
 * canvas entirely and a new AudioClip referencing the same audioBlobId
 * (content-addressed, so no byte copy) is appended to this doc.
 */

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { Container, Graphics } from "pixi.js";
import type { CanvasStore } from "../../src/canvas/canvas-store";
import type { DropTargetHandler } from "../../src/widgets/widget-types";
import type { WidgetRegistry } from "../../src/widgets/widget-registry";
import { AUDIO_CLIP_TRACK_HEIGHT, type VideoTimelineHandle } from "./video-timeline";
import type { AudioClip, StfuState } from "./types";
import { deepUnwrapAmStrings } from "../../src/canvas/automerge-values";

const DROPPABLE_TYPES = new Set(["audio-recording", "tts", "voice-recording"]);

export interface AudioClipDragOptions {
  store: CanvasStore | null;
  repo: Repo | null;
  registry: WidgetRegistry | null;
  findWorldContainer: () => Container;
  getTimeline: () => VideoTimelineHandle | null;
  getCurrentWidth: () => number;
  timelineInset: number;
  changeDoc: (fn: (d: StfuState) => void) => void;
  /** called after a clip is created by either drag direction — refresh the
   *  track + push an undo-history entry. */
  onClipAdded: () => void;
}

export interface AudioClipDragHandle {
  dropTarget: DropTargetHandler | undefined;
  handleAudioClipDragOut(clip: AudioClip, worldX: number, worldY: number): Promise<void>;
  destroy(): void;
}

export function createAudioClipDragController(options: AudioClipDragOptions): AudioClipDragHandle {
  const { store, repo, registry, findWorldContainer, getTimeline, getCurrentWidth, timelineInset, changeDoc, onClipAdded } =
    options;

  /** convert a `dropTarget` callback's world-space point into the audio
   *  clips row's own local coordinate frame (x=0 at the row's left edge,
   *  matching `timeline.screenXToTime()`'s convention) — returns null if
   *  the timeline isn't mounted yet. */
  function toAudioClipsLocal(worldX: number, worldY: number): { x: number; y: number } | null {
    const timeline = getTimeline();
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
    const timeline = getTimeline();
    if (!timeline) return;
    if (!dropHighlight) {
      dropHighlight = new Graphics();
      dropHighlight.eventMode = "none";
      timeline.audioClipsHitArea.addChild(dropHighlight);
    }
    const rowWidth = Math.max(0, getCurrentWidth() - timelineInset * 2);
    dropHighlight
      .clear()
      .rect(0, 0, rowWidth, AUDIO_CLIP_TRACK_HEIGHT)
      .stroke({ width: 2, color: 0xe619b3 });
  }

  /** read a dropped widget's doc (audio-recording or tts shape) via the
   *  repo/registry, same pattern as bin-drag.ts's readLabel(). returns null
   *  if the doc isn't readable yet or isn't a droppable type. */
  function readDroppedAudioState(
    entryType: string,
    docId: string | null
  ): {
    blobId: string;
    blake3: string;
    mime: string;
    duration: number;
    filename?: string;
    ttsText?: string;
    ttsVoiceName?: string;
    ttsVoiceLang?: string;
    ttsRate?: number;
  } | null {
    if (!repo || !registry || !docId || !DROPPABLE_TYPES.has(entryType)) return null;
    const factory = registry.get(entryType);
    if (!factory?.schema) return null;
    try {
      const handle = repo.handles[docId as DocumentId];
      const rawDoc = handle?.doc();
      if (!rawDoc) return null;
      // a widget doc the tumulus hub has ever written into directly (e.g.
      // stamping `snatchedBy` after a p2p snatch) round-trips string
      // fields as `ImmutableString` instances, which zod's `z.string()`
      // rejects outright — see `automerge-values.ts`'s own doc comment.
      const state = factory.schema.parse(deepUnwrapAmStrings(rawDoc)) as Record<string, unknown>;
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

  const dropTarget: DropTargetHandler | undefined = store
    ? {
        hitTest(worldX: number, worldY: number): boolean {
          const timeline = getTimeline();
          if (!timeline) return false;
          const local = toAudioClipsLocal(worldX, worldY);
          if (!local) return false;
          const rowWidth = Math.max(0, getCurrentWidth() - timelineInset * 2);
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
          const timeline = getTimeline();
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

          changeDoc((d) => {
            d.audioClips.push(clip);
          });
          // matches every other local mutation handler in this file — the
          // doc-change subscription alone doesn't reliably redraw our own
          // local edit in the same tick.
          onClipAdded();

          store.removeWidget(draggedWidgetId);
          return true;
        },
      }
    : undefined;

  return {
    dropTarget,
    handleAudioClipDragOut,
    destroy() {
      dropHighlight?.destroy();
      dropHighlight = null;
    },
  };
}
