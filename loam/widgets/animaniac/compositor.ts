/**
 * animaniac's unified pixi compositor — mounts a `Sprite`/`Text` for every
 * currently-active visual clip (doodle-frame/image/label/video-segment),
 * positions/scales/rotates/fades it via `resolveTransformAt()`, and
 * z-orders by track (`sortedTracks()`) then array position within a track.
 *
 * video-segment clips are just another `Sprite` here too (pixi.js's
 * built-in `VideoSource`, `Texture.from(videoElement)`) — NOT a DOM
 * overlay, per docs/animaniac-media-segments-plan.md decision B — so
 * there is exactly one rendering path for every visual clip kind, no
 * separate z-order reconciliation between two systems.
 *
 * pool-based: a clip's sprite is created once when it first becomes
 * active and torn down once it stops being active (or is removed/edited
 * out from under it), rather than rebuilt every tick.
 */

import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { PeersMap } from "../../src/file-utils/file-shared";
import { resolveImagePropUrl } from "../../src/file-utils/image-prop-blob";
import { getMediaPlaybackUrl } from "../../src/media";
import { MouthRenderer, type Mood, type TeethStyle } from "../voice-recording-mouth";
import { createMouthEnvelopeCache, opennessAtElapsed, type MouthEnvelopeCache } from "./mouth-sync";
import { activeClipsAt, clipsForTrack, sortedTracks } from "./track-model";
import { resolveTransformAt } from "./transform";
import type { Clip, Track, VoiceRecordingClip } from "./types";

export interface CompositorOptions {
  /** container every clip sprite is mounted into — caller owns sizing/masking. */
  container: Container;
  /** current preview area size — a clip's keyframe x/y=0 renders at the
   *  CENTER of this area (an offset from there), not at the container's
   *  own (0,0) corner, since every sprite is anchored at its own center
   *  (a corner-anchored default would render most of it off-screen). */
  getPreviewSize: () => { width: number; height: number };
  getTracks: () => Track[];
  getClips: () => Clip[];
  getPeers?: () => PeersMap | undefined;
}

export interface CompositorHandle {
  /** call on every playback tick (from `playback-clock.ts`'s `onTick`) with
   *  the current absolute timeline time and whether playback is running
   *  (drives whether video-segment `<video>` elements are playing or
   *  paused — a seek while paused shouldn't start them). `seeked` should be
   *  true only for a discrete jump (explicit seek / a fresh resume / an
   *  edit-driven re-render outside the normal tick loop) — see
   *  `applyVideoTime()`'s own comment for why this matters. */
  update(t: number, playing: boolean, seeked: boolean): void;
  destroy(): void;
}

interface PoolEntry {
  node: Container;
  /** the clip's own local elapsed time this entry was last drawn at — only
   *  used to avoid redundant video-element seeks (see `applyVideoTime()`). */
  video?: HTMLVideoElement;
  /** true once this entry's `<video>` has had its `currentTime` set at
   *  least once — see `applyVideoTime()`. */
  videoSynced?: boolean;
  destroy(): void;
}

const VISUAL_KINDS = new Set(["doodle-frame", "image", "label", "video-segment"]);

function isVisualClip(clip: Clip): boolean {
  return VISUAL_KINDS.has(clip.kind);
}

// a voice-recording clip's animated mouth renders at this fixed box size
// (roughly `voice-recording.ts`'s own default widget aspect ratio) —
// there's no UI yet to resize/reposition it beyond its keyframes' x/y/scale.
const MOUTH_BOX_WIDTH = 160;
const MOUTH_BOX_HEIGHT = 110;

interface MouthPoolEntry {
  node: Container;
  mouth: MouthRenderer;
  envelope: Float32Array | null;
  envelopeRequested: boolean;
  destroy(): void;
}

export function createCompositor(options: CompositorOptions): CompositorHandle {
  const { container, getPreviewSize, getTracks, getClips, getPeers } = options;

  const pool = new Map<string, PoolEntry>();

  // mouths render in their own always-on-top layer (re-raised every tick,
  // see `update()`) so a voice-recording clip's talking mouth is never
  // hidden behind a doodle/image/label sprite's own z-order reshuffling.
  const mouthLayer = new Container();
  container.addChild(mouthLayer);
  const mouthPool = new Map<string, MouthPoolEntry>();
  const mouthEnvelopeCache: MouthEnvelopeCache = createMouthEnvelopeCache({ getPeers });

  function makePlaceholder(): PoolEntry {
    const node = new Container();
    container.addChild(node);
    return { node, destroy: () => node.destroy({ children: true }) };
  }

  function makeLabelEntry(clip: Extract<Clip, { kind: "label" }>): PoolEntry {
    const node = new Container();
    const bg = new Graphics();
    const text = new Text({ text: clip.text, style: { fill: clip.color, fontSize: 32 } });
    text.anchor.set(0.5);
    bg.roundRect(-text.width / 2 - 12, -text.height / 2 - 8, text.width + 24, text.height + 16, 6).fill({
      color: clip.bgColor,
    });
    node.addChild(bg, text);
    container.addChild(node);
    return { node, destroy: () => node.destroy({ children: true }) };
  }

  /** shared by doodle-frame/image — both resolve to a plain image `Sprite`
   *  from an `imageUrl` (a `blob:<id>` ref or external URL). */
  function makeImageEntry(imageUrl: string): PoolEntry {
    const node = new Container();
    container.addChild(node);
    const entry: PoolEntry = { node, destroy: () => node.destroy({ children: true }) };
    void resolveImagePropUrl(imageUrl).then((url) => {
      if (!url || node.destroyed) return;
      const sprite = Sprite.from(url);
      sprite.anchor.set(0.5);
      node.addChild(sprite);
    });
    return entry;
  }

  function makeVideoEntry(clip: Extract<Clip, { kind: "video-segment" }>): PoolEntry {
    const node = new Container();
    container.addChild(node);
    const entry: PoolEntry = {
      node,
      destroy: () => {
        entry.video?.pause();
        node.destroy({ children: true });
      },
    };
    void getMediaPlaybackUrl(clip.videoBlobId, {
      category: "video",
      mime: clip.videoMime || undefined,
      blake3: clip.videoBlake3 || undefined,
      peers: getPeers?.(),
    }).then((url) => {
      if (!url || node.destroyed) return;
      const video = document.createElement("video");
      video.src = url;
      video.muted = clip.muted;
      video.playsInline = true;
      entry.video = video;
      const sprite = new Sprite(Texture.from(video));
      sprite.anchor.set(0.5);
      node.addChild(sprite);
    });
    return entry;
  }

  function makeEntry(clip: Clip): PoolEntry {
    switch (clip.kind) {
      case "label":
        return makeLabelEntry(clip);
      case "doodle-frame":
      case "image":
        return makeImageEntry(clip.imageUrl);
      case "video-segment":
        return makeVideoEntry(clip);
      default:
        return makePlaceholder();
    }
  }

  /** `MouthRenderer` draws relative to its own (0,0)..(w,h) top-left-
   *  origin box, unlike every other clip kind here (anchor(0.5) sprites) —
   *  wrap it in an inner box offset by (-w/2,-h/2) so `entry.node.x/y`
   *  still means "this clip's own CENTER", matching every other clip kind's
   *  transform semantics. */
  function makeMouthEntry(clip: VoiceRecordingClip): MouthPoolEntry {
    const node = new Container();
    mouthLayer.addChild(node);
    const box = new Container();
    box.x = -MOUTH_BOX_WIDTH / 2;
    box.y = -MOUTH_BOX_HEIGHT / 2;
    node.addChild(box);
    const mouth = new MouthRenderer(
      box,
      MOUTH_BOX_WIDTH,
      MOUTH_BOX_HEIGHT,
      clip.lipsColor,
      clip.lipThickness,
      clip.mouthMood as Mood,
      clip.teethStyle as TeethStyle,
      clip.cupidBowAmount
    );
    return { node, mouth, envelope: null, envelopeRequested: false, destroy: () => node.destroy({ children: true }) };
  }

  /** keeps a video-segment clip's underlying `<video>` element's play state
   *  and seek position in sync with the timeline. `currentTime` is only
   *  force-written on a discrete jump (`seeked`, or the element's first
   *  sync) — NOT on every regular playback tick. writing `currentTime` on
   *  an already-playing media element forces an internal reseek, which
   *  glitches audibly (worse on tauri's wkwebview than chromium) if done
   *  ~60 times/sec; every other media path in this codebase (voice-
   *  recording.ts, stfu/audio-clip-playback.ts, file.ts's plain player)
   *  seeks once then lets the element's own native clock run untouched. */
  function applyVideoTime(entry: PoolEntry, clip: Extract<Clip, { kind: "video-segment" }>, localElapsed: number, playing: boolean, seeked: boolean): void {
    const video = entry.video;
    if (!video) return;
    if (!entry.videoSynced || seeked) {
      video.currentTime = clip.sourceInSec + localElapsed;
      entry.videoSynced = true;
    }
    if (playing && video.paused) void video.play().catch(() => {});
    if (!playing && !video.paused) video.pause();
  }

  function update(t: number, playing: boolean, seeked: boolean): void {
    const tracks = getTracks();
    const clips = getClips();
    const active = activeClipsAt(clips, t).filter(isVisualClip);
    const activeIds = new Set(active.map((c) => c.id));

    for (const [id, entry] of pool) {
      if (!activeIds.has(id)) {
        entry.destroy();
        pool.delete(id);
      }
    }

    // z-order: visual tracks in ascending `order`, then array position
    // within each track as a stable tiebreak — matches track-model.ts's
    // own `sortedTracks()`/`clipsForTrack()` helpers so there's exactly
    // one place this ordering is defined.
    const orderedClips: Clip[] = [];
    for (const track of sortedTracks(tracks.filter((tr) => tr.kind === "visual" && !tr.hidden))) {
      orderedClips.push(...clipsForTrack(active, track.id));
    }

    const { width: previewWidth, height: previewHeight } = getPreviewSize();
    orderedClips.forEach((clip, i) => {
      let entry = pool.get(clip.id);
      if (!entry) {
        entry = makeEntry(clip);
        pool.set(clip.id, entry);
      }
      container.setChildIndex(entry.node, Math.min(container.children.length - 1, i));

      const localElapsed = t - clip.start;
      const transform = resolveTransformAt(clip.keyframes, localElapsed);
      // a keyframe's x/y=0 means "centered in the preview area" (every
      // sprite is anchor(0.5)) — not the container's own (0,0) corner.
      entry.node.x = previewWidth / 2 + transform.x;
      entry.node.y = previewHeight / 2 + transform.y;
      entry.node.scale.set(transform.scale);
      entry.node.rotation = transform.rotation;
      entry.node.alpha = transform.opacity;

      if (clip.kind === "video-segment") applyVideoTime(entry, clip, localElapsed, playing, seeked);
    });

    // -- voice-recording mouths: separate pool, keyed off the AUDIO clip
    // list (not `active`/`isVisualClip`, since voice-recording clips live
    // on audio tracks) --------------------------------------------------
    const activeMouthClips = activeClipsAt(clips, t).filter((c): c is VoiceRecordingClip => c.kind === "voice-recording");
    const activeMouthIds = new Set(activeMouthClips.map((c) => c.id));

    for (const [id, entry] of mouthPool) {
      if (!activeMouthIds.has(id)) {
        entry.destroy();
        mouthPool.delete(id);
      }
    }

    for (const clip of activeMouthClips) {
      let entry = mouthPool.get(clip.id);
      if (!entry) {
        entry = makeMouthEntry(clip);
        mouthPool.set(clip.id, entry);
      }
      if (!entry.envelopeRequested) {
        entry.envelopeRequested = true;
        const clipId = clip.id;
        void mouthEnvelopeCache.getEnvelope(clip).then((env) => {
          const stillPooled = mouthPool.get(clipId);
          if (stillPooled === entry) entry.envelope = env;
        });
      }

      const localElapsed = t - clip.start;
      const transform = resolveTransformAt(clip.keyframes, localElapsed);
      entry.node.x = previewWidth / 2 + transform.x;
      entry.node.y = previewHeight / 2 + transform.y;
      entry.node.scale.set(transform.scale);
      entry.node.rotation = transform.rotation;
      entry.node.alpha = transform.opacity;
      entry.mouth.setOpenness(entry.envelope ? opennessAtElapsed(entry.envelope, localElapsed) : 0);
    }

    // keep mouths above every doodle/image/label/video sprite regardless
    // of the visual z-order reshuffling (`setChildIndex`) above.
    container.addChild(mouthLayer);
  }

  return {
    update,
    destroy() {
      for (const entry of pool.values()) entry.destroy();
      pool.clear();
      for (const entry of mouthPool.values()) entry.destroy();
      mouthPool.clear();
      mouthEnvelopeCache.clear();
    },
  };
}
