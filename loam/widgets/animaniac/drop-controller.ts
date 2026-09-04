/**
 * "drag an existing skein widget onto animaniac" cross-widget drop
 * handling — mirrors `stfu/audio-clip-drag.ts`'s dropTarget mechanics
 * (pointer-position-based, no HTML5 DnD), generalized over every clip kind
 * via `frame-capture.ts`'s `resolveCapturedClip()` instead of one
 * hardcoded audio-only capture.
 *
 * the WHOLE widget is the drop zone (not just its track rows) — dropping
 * anywhere inside animaniac's own bounds highlights it with a magenta
 * border. tracks are unified (any clip kind can live on any track), so a
 * drop always lands wherever the pointer hit-tested a track row; otherwise
 * (dropped on the toolbar/ruler/preview area) it falls back to the first
 * non-hidden track, placed at the current end of the timeline.
 *
 * `onDrop()`'s capture step is async (a doodle-frame capture needs to
 * `await` a snapshot render + blob promotion) but `DropTargetHandler.
 * onDrop()` itself must return a plain `boolean` synchronously — this
 * returns `true` as soon as a valid type+target is confirmed (claiming the
 * drop) and does the actual clip-push + source-widget removal once the
 * async capture resolves in the background. if capture resolves to `null`
 * (nothing capturable, e.g. an empty doodle), the source widget is simply
 * left where it was dropped rather than silently vanishing.
 */

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { Container, Graphics } from "pixi.js";
import { log } from "@freqhole/reliquary/utils";
import type { CanvasStore } from "../../src/canvas/canvas-store";
import type { DropTargetHandler } from "../../src/widgets/widget-types";
import type { WidgetRegistry } from "../../src/widgets/widget-registry";
import type { TrackCameraView, TrackRowContainers } from "../../src/widgets/timeline/timeline-types";
import { expectedTrackKindFor, isCapturableWidgetType, resolveCapturedClip } from "./frame-capture";
import { clipBlobInfo, makeAnimaniacNewBlobMessage } from "./snatch-controller";
import { computeTimelineDuration, clipDurationSec, clipEnd, clipsForTrack } from "./track-model";
import { type AnimaniacState, type Clip, type Track } from "./types";

export interface AnimaniacDropControllerOptions {
  store: CanvasStore | null;
  repo: Repo | null;
  registry: WidgetRegistry | null;
  /** this animaniac widget's own id — tags the ephemeral "new blob" ping
   *  broadcast after a capture so every peer's own animaniac instance can
   *  tell whether the ping is about ITS doc (several animaniac widgets can
   *  be on the same canvas at once). */
  widgetId: string;
  /** animaniac's own root container — the drop zone + hover-border host. */
  container: Container;
  findWorldContainer: () => Container;
  getSize: () => { width: number; height: number };
  /** the composition/preview area's own size (narrower than `getSize()`'s
   *  whole-widget size, which also includes the toolbar/timeline rows) —
   *  a freshly-captured clip's initial scale is contain-fit to this so it
   *  doesn't render far larger than the composition it's dropped into. */
  getPreviewSize: () => { width: number; height: number };
  getTracks: () => Track[];
  getClips: () => Clip[];
  /** the track's own row containers, once mounted — null if that track's
   *  row isn't currently laid out (e.g. hidden). */
  getTrackRow: (trackId: string) => (TrackRowContainers & { height: number }) | null;
  camera: Pick<TrackCameraView, "screenXToTime" | "timeToScreenX">;
  changeDoc: (fn: (d: AnimaniacState) => void) => void;
  /** called after a clip is actually added — refresh the relevant track +
   *  push an undo-history entry. */
  onClipAdded: () => void;
}

export interface AnimaniacDropControllerHandle {
  dropTarget: DropTargetHandler | undefined;
  destroy(): void;
}

export function createAnimaniacDropController(options: AnimaniacDropControllerOptions): AnimaniacDropControllerHandle {
  const { store, repo, registry, widgetId, container, findWorldContainer, getSize, getPreviewSize, getTracks, getClips, getTrackRow, camera, changeDoc, onClipAdded } =
    options;

  const hoverBorder = new Graphics();
  hoverBorder.eventMode = "none";
  hoverBorder.visible = false;
  container.addChild(hoverBorder);

  function setHovering(hovering: boolean): void {
    hoverBorder.visible = hovering;
    if (!hovering) return;
    const { width, height } = getSize();
    hoverBorder
      .clear()
      .rect(1, 1, Math.max(0, width - 2), Math.max(0, height - 2))
      .stroke({ width: 3, color: 0xd946ef });
  }

  // live placeholder segment shown WHILE hovering (before the drop is
  // actually committed) — reveals which track + timeline position the
  // widget would land at, reusing the same target-resolution logic
  // `onDrop()` itself uses (so the preview never lies about where the
  // real drop will go). one shared Graphics, reparented to whichever
  // row is the current best-guess target (only one row can be targeted
  // at a time).
  const placeholderGhost = new Graphics();
  placeholderGhost.eventMode = "none";
  placeholderGhost.visible = false;

  function hidePlaceholder(): void {
    placeholderGhost.visible = false;
    placeholderGhost.parent?.removeChild(placeholderGhost);
  }

  function showPlaceholder(worldX: number, worldY: number, draggedWidgetId: string): void {
    if (!store || !isInsideWidget(worldX, worldY)) {
      hidePlaceholder();
      return;
    }
    const entry = store.getWidget(draggedWidgetId);
    if (!entry || !isCapturableWidgetType(entry.type)) {
      log.debug("animaniac.drop", "[ANIMANIAC-DBG] showPlaceholder: not capturable", entry?.type);
      hidePlaceholder();
      return;
    }
    const sourceState = readDroppedState(entry.type, entry.docId);
    if (!sourceState) {
      log.debug("animaniac.drop", "[ANIMANIAC-DBG] showPlaceholder: no sourceState", entry.type, entry.docId);
      hidePlaceholder();
      return;
    }
    const expectedKind = expectedTrackKindFor(entry.type, sourceState);
    if (!expectedKind) {
      log.debug("animaniac.drop", "[ANIMANIAC-DBG] showPlaceholder: expectedTrackKindFor returned null", entry.type, sourceState);
      hidePlaceholder();
      return;
    }
    const target = resolveDropTarget(worldX, worldY);
    const row = target ? getTrackRow(target.trackId) : null;
    if (!target || !row) {
      log.debug("animaniac.drop", "[ANIMANIAC-DBG] showPlaceholder: no target/row", "target:", target, "hasRow:", !!row);
      hidePlaceholder();
      return;
    }
    // rough duration estimate for the placeholder's own width — mirrors
    // `resolveCapturedClip()`'s own defaults without doing the real
    // (possibly async, e.g. a doodle snapshot) capture itself.
    const rawDuration = sourceState.duration ?? sourceState.videoDurationSec;
    const duration = typeof rawDuration === "number" && rawDuration > 0 ? rawDuration : 1;
    const x1 = camera.timeToScreenX(target.start);
    const x2 = camera.timeToScreenX(target.start + duration);
    row.contentLayer.addChild(placeholderGhost);
    placeholderGhost.visible = true;
    placeholderGhost
      .clear()
      .roundRect(Math.min(x1, x2), 2, Math.max(2, Math.abs(x2 - x1)), Math.max(0, row.height - 4), 3)
      .fill({ color: 0xd946ef, alpha: 0.25 })
      .stroke({ width: 1.5, color: 0xd946ef });
  }

  /** converts a world-space point into animaniac's own root container's
   *  local frame — used both for the whole-widget hitTest and to decide
   *  whether a drop landed inside the widget at all. */
  function toWidgetLocal(worldX: number, worldY: number): { x: number; y: number } {
    return container.toLocal({ x: worldX, y: worldY }, findWorldContainer());
  }

  function isInsideWidget(worldX: number, worldY: number): boolean {
    const { width, height } = getSize();
    const local = toWidgetLocal(worldX, worldY);
    return local.x >= 0 && local.x <= width && local.y >= 0 && local.y <= height;
  }

  /** finds which track row (if any) contains this world-space point, along
   *  with the point converted into that row's own local frame. */
  function hitTestTrack(worldX: number, worldY: number): { track: Track; localX: number; localY: number } | null {
    const world = findWorldContainer();
    for (const track of getTracks()) {
      if (track.hidden) continue;
      const row = getTrackRow(track.id);
      if (!row) continue;
      const local = row.hitArea.toLocal({ x: worldX, y: worldY }, world);
      const hitRect = row.hitArea.hitArea as { contains?: (x: number, y: number) => boolean } | null;
      if (hitRect?.contains?.(local.x, local.y)) return { track, localX: local.x, localY: local.y };
    }
    return null;
  }

  function readDroppedState(entryType: string, docId: string | null): Record<string, unknown> | null {
    if (!repo || !registry || !docId || !isCapturableWidgetType(entryType)) {
      log.debug("animaniac.drop", "[ANIMANIAC-DBG] readDroppedState: bailing", {
        entryType,
        docId,
        hasRepo: !!repo,
        hasRegistry: !!registry,
        isCapturable: isCapturableWidgetType(entryType),
      });
      return null;
    }
    const factory = registry.get(entryType);
    if (!factory?.schema) {
      log.debug("animaniac.drop", "[ANIMANIAC-DBG] readDroppedState: no registered factory/schema for type", entryType);
      return null;
    }
    try {
      const handle = repo.handles[docId as DocumentId];
      const rawDoc = handle?.doc();
      if (!rawDoc) {
        log.debug("animaniac.drop", "[ANIMANIAC-DBG] readDroppedState: no handle/doc yet for docId", docId, "hasHandle:", !!handle);
        return null;
      }
      const parsed = factory.schema.parse(rawDoc) as Record<string, unknown>;
      log.debug("animaniac.drop", "[ANIMANIAC-DBG] readDroppedState: parsed ok", entryType, Object.keys(parsed));
      return parsed;
    } catch (err) {
      log.debug("animaniac.drop", "[ANIMANIAC-DBG] readDroppedState: schema.parse threw", entryType, err);
      return null;
    }
  }

  /** resolves the target track + timeline position for a drop: prefer a
   *  specific row hit, else fall back to the first non-hidden track,
   *  placed at the current end of the timeline (per the user's "if it's
   *  not dropped in a specific place, just place it at the end" request).
   *  any track accepts any clip kind (tracks are unified). */
  function resolveDropTarget(worldX: number, worldY: number): { trackId: string; start: number } | null {
    const hit = hitTestTrack(worldX, worldY);
    if (hit) {
      return { trackId: hit.track.id, start: Math.max(0, camera.screenXToTime(hit.localX)) };
    }
    const fallbackTrack = getTracks().find((t) => !t.hidden);
    log.debug(
      "animaniac.drop",
      "[ANIMANIAC-DBG] resolveDropTarget: no row hit, falling back",
      "tracks:",
      getTracks().map((t) => ({ id: t.id, hidden: t.hidden })),
      "fallback:",
      fallbackTrack?.id
    );
    if (!fallbackTrack) return null;
    return { trackId: fallbackTrack.id, start: computeTimelineDuration(getClips()) };
  }

  const dropTarget: DropTargetHandler | undefined = store
    ? {
        hitTest(worldX: number, worldY: number): boolean {
          return isInsideWidget(worldX, worldY);
        },

        onHover(worldX: number, worldY: number, draggedWidgetId: string): void {
          setHovering(true);
          const entry = store.getWidget(draggedWidgetId);
          log.debug("animaniac.drop", "[ANIMANIAC-DBG] onHover:", draggedWidgetId, "entryType:", entry?.type);
          showPlaceholder(worldX, worldY, draggedWidgetId);
        },

        onLeave(): void {
          setHovering(false);
          hidePlaceholder();
        },

        onDrop(draggedWidgetId: string, worldX: number, worldY: number): boolean {
          setHovering(false);
          hidePlaceholder();
          const entry = store.getWidget(draggedWidgetId);
          if (!entry || !isCapturableWidgetType(entry.type)) {
            log.debug("animaniac.drop", "onDrop: dragged widget not capturable", { entryType: entry?.type });
            return false;
          }
          const sourceState = readDroppedState(entry.type, entry.docId);
          if (!sourceState) {
            log.debug("animaniac.drop", "onDrop: could not read dropped widget's doc state", { entryType: entry.type, docId: entry.docId });
            return false;
          }
          const expectedKind = expectedTrackKindFor(entry.type, sourceState);
          if (!expectedKind) {
            log.debug("animaniac.drop", "onDrop: could not determine target track kind", { entryType: entry.type });
            return false;
          }
          const target = resolveDropTarget(worldX, worldY);
          if (!target) {
            log.debug("animaniac.drop", "onDrop: no track exists", { expectedKind });
            return false;
          }
          const { trackId, start } = target;
          log.debug("animaniac.drop", "onDrop: hit", { entryType: entry.type, trackId, start });

          void resolveCapturedClip(entry.type, sourceState, trackId, start, undefined, getPreviewSize(), { width: entry.width, height: entry.height }).then((clip) => {
            if (!clip) {
              // resolveCapturedClip() is deliberately pure/unlogged (see its
              // own doc comment) — log the relevant sourceState fields HERE
              // instead so a "why did this return null" question is
              // answerable from this one log line without touching that
              // module (e.g. a not-yet-generated tts clip has no
              // audioBlobId yet; a fresh audio-recording may have duration
              // 0 until its own probe finishes).
              log.debug("animaniac.drop", "[ANIMANIAC-DBG] onDrop: resolveCapturedClip returned null (nothing capturable yet)", {
                entryType: entry.type,
                blobId: sourceState.blobId,
                domain: sourceState.domain,
                duration: sourceState.duration,
                videoBlobId: sourceState.videoBlobId,
                videoDurationSec: sourceState.videoDurationSec,
              });
              return;
            }
            // items on a single track must not overlap each other (see
            // track-item-interaction.ts's own preventOverlap option, used
            // by tracks/track.ts for interactive drags) — a drop lands
            // wherever the pointer was released with no collision check of
            // its own, so re-place it at the end of THIS track's own clips
            // if it would overlap one already there.
            const existingOnTrack = clipsForTrack(getClips(), trackId);
            const newEnd = clip.start + clipDurationSec(clip);
            const overlaps = existingOnTrack.some((other) => clip.start < clipEnd(other) && newEnd > other.start);
            if (overlaps) {
              const trackEnd = existingOnTrack.reduce((max, other) => Math.max(max, clipEnd(other)), 0);
              clip.start = trackEnd;
            }
            changeDoc((d) => {
              d.clips.push(clip);
            });
            onClipAdded();
            store.removeWidget(draggedWidgetId);
            log.debug("animaniac.drop", "onDrop: captured", { clipKind: clip.kind, trackId });
            // notify every OTHER peer currently on this canvas right away
            // (ephemeral, not a doc change — see snatch-controller.ts's own
            // doc comment) so their own snatch-all cue lights up without
            // waiting on a full clip-list rescan.
            const blob = clipBlobInfo(clip);
            if (blob) store.broadcastEphemeral(new TextEncoder().encode(JSON.stringify(makeAnimaniacNewBlobMessage(widgetId, blob))));
          });

          return true;
        },
      }
    : undefined;

  return {
    dropTarget,
    destroy() {
      hoverBorder.destroy();
      placeholderGhost.destroy();
    },
  };
}

