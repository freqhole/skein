/**
 * animaniac's unified pixi compositor — mounts a `Sprite`/`Text` for every
 * currently-active visual clip (doodle-frame/image/label/video-segment),
 * positions/scales/rotates/fades it via `resolveTransformAt()`, and
 * z-orders to match the track list's own visual order (the track at the
 * TOP of the list is drawn on top here too — see `update()`'s own z-order
 * comment) then array position within a track.
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

import { Assets, Container, Graphics, Sprite, Text, Texture, VideoSource } from "pixi.js";
import { GifSource, GifSprite } from "pixi.js/gif";
import { log } from "@freqhole/reliquary/utils";
import type { PeersMap } from "../../src/file-utils/file-shared";
import { resolveImagePropUrl } from "../../src/file-utils/image-prop-blob";
import { getMediaPlaybackUrl } from "../../src/media";
import { isGifDataUrl } from "../../src/widgets/gif-utils";
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
  /** a clip's own natural (unscaled, scaleX=scaleY=1) on-screen size, once
   *  known (an image/video's own texture/video hasn't necessarily loaded
   *  yet when first requested) — used by `preview-transform-editor.ts` to
   *  size its selection outline/handles. null if the clip isn't currently
   *  pooled, or its size isn't known yet. */
  getNaturalSize(clipId: string): { width: number; height: number } | null;
  /** hand a clip's own pixi node to a caller for direct live manipulation
   *  during a drag (`preview-transform-editor.ts`) — `update()` skips
   *  writing this entry's x/y/scale from the doc's own transform while a
   *  live edit is in progress, so the editor has exclusive control until
   *  `endLiveEdit()`. returns null if the clip isn't currently pooled
   *  (nothing to edit — e.g. it isn't active at the current time). */
  beginLiveEdit(clipId: string): Container | null;
  endLiveEdit(clipId: string): void;
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
  /** only set for an animated-gif image/doodle-frame clip — `update()`
   *  plays/stops it each tick to mirror `video`'s play/pause handling,
   *  rather than the standalone image widget's hover-to-play behavior
   *  (there's no hover concept in a rendered timeline preview). */
  gifSprite?: GifSprite;
  /** natural (scaleX=scaleY=1) on-screen size — set once known (may lag a
   *  tick or two behind creation for async-loaded image/video content). */
  naturalSize?: { width: number; height: number };
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
  naturalSize: { width: number; height: number };
  destroy(): void;
}

export function createCompositor(options: CompositorOptions): CompositorHandle {
  const { container, getPreviewSize, getTracks, getClips, getPeers } = options;

  const pool = new Map<string, PoolEntry>();
  // clip ids currently under exclusive live-drag control by
  // `preview-transform-editor.ts` — `update()` skips writing their
  // x/y/scale from the doc so the editor's own direct node manipulation
  // isn't fought/overwritten by the next tick (only actually matters while
  // playing; while paused there's no competing tick anyway).
  const liveEditIds = new Set<string>();

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
    const w = text.width + 24;
    const h = text.height + 16;
    bg.roundRect(-w / 2, -h / 2, w, h, 6).fill({ color: clip.bgColor });
    node.addChild(bg, text);
    container.addChild(node);
    return { node, naturalSize: { width: w, height: h }, destroy: () => node.destroy({ children: true }) };
  }

  /** shared by doodle-frame/image — both resolve to a plain image `Sprite`
   *  from an `imageUrl` (a `blob:<id>` ref or external URL), or (for an
   *  animated gif) a `GifSprite` — see `makeImageEntry()` below for why
   *  gif detection has to happen on the fetched `Blob`'s own `.type`
   *  rather than sniffing the resolved url string (a blob-store object
   *  URL carries no extension/mime hint at all, unlike a `data:` URL).
   *  NOTE: pixi's `Sprite.from(url)`/`Texture.from(url)` for a STRING id
   *  is a synchronous CACHE-ONLY lookup (pixi's own `textureFrom()`: `if
   *  (typeof id === "string") return Cache.Cache.get(id);`) — it never
   *  fetches/decodes anything, so a brand-new blob: URL (never previously
   *  loaded) silently resolves to an EMPTY/invisible texture with no
   *  error. `Assets.load()` alone isn't enough either though — its own
   *  extension/data-url sniffing (`loadTextures.js`'s `test()`) never
   *  matches a bare blob: URL (no recognizable extension, not a data:
   *  URL), so it silently picks the wrong parser and resolves to
   *  something with no usable `.source` — decode via `createImageBitmap()`
   *  for any blob-store URL instead, bypassing pixi's resolver entirely. */
  async function loadImageSource(imageUrl: string): Promise<{ texture: Texture } | { gifSource: GifSource } | null> {
    const resolvedUrl = await resolveImagePropUrl(imageUrl);
    if (!resolvedUrl) {
      // silent by default in resolveImagePropUrl() (image-prop-blob.ts) —
      // either the blob simply isn't present LOCALLY yet (a data-locality
      // issue, e.g. captured on a different peer/build and not yet
      // snatched/synced here — NOT necessarily a code bug) or
      // getMediaPlaybackUrl() itself failed. log here so a platform-
      // specific "works in browser, not in tauri" report has something
      // concrete to go on next time instead of a bare invisible sprite.
      log.warn("animaniac", "loadImageSource: could not resolve imageUrl to a usable url (blob missing locally?)", imageUrl.slice(0, 40));
      return null;
    }
    try {
      // a `data:image/gif` url can be detected from the string itself, but
      // any OTHER resolved url (a browser blob-store object url, a tauri
      // `asset://` url, or a genuine external http(s) url) carries no mime
      // hint in the string at all — has to be fetched and its `Blob.type`
      // checked instead (mirrors image.ts's own "remote URL" branch).
      // `Assets.load()` was tried here previously but its own extension/
      // data-url sniffing (`loadTextures.js`'s `test()`) never matches a
      // bare `blob:`/`asset://` url, silently picking the wrong parser —
      // fetch+decode bypasses pixi's resolver entirely for every case.
      if (isGifDataUrl(resolvedUrl)) {
        const buffer = await fetch(resolvedUrl).then((r) => r.arrayBuffer());
        return { gifSource: GifSource.from(buffer) };
      }
      if (resolvedUrl.startsWith("data:")) {
        const tex = await Assets.load<Texture>(resolvedUrl);
        if (!tex || !tex.source?.style) {
          log.warn("animaniac", "loadImageSource: loaded texture has no usable GPU source", imageUrl.slice(0, 32));
          return null;
        }
        return { texture: tex };
      }
      const blob = await fetch(resolvedUrl).then((r) => r.blob());
      if (blob.type === "image/gif") {
        return { gifSource: GifSource.from(await blob.arrayBuffer()) };
      }
      const tex = Texture.from(await createImageBitmap(blob));
      if (!tex.source?.style) {
        log.warn("animaniac", "loadImageSource: loaded texture has no usable GPU source", imageUrl.slice(0, 32));
        return null;
      }
      return { texture: tex };
    } catch (err) {
      log.warn("animaniac", "loadImageSource failed:", err);
      return null;
    }
  }

  function makeImageEntry(imageUrl: string): PoolEntry {
    const node = new Container();
    container.addChild(node);
    const entry: PoolEntry = {
      node,
      destroy: () => {
        entry.gifSprite?.destroy();
        node.destroy({ children: true });
      },
    };
    void loadImageSource(imageUrl).then((source) => {
      if (!source || node.destroyed) return;
      if ("gifSource" in source) {
        const sprite = new GifSprite({ source: source.gifSource, autoPlay: false });
        sprite.anchor.set(0.5);
        node.addChild(sprite);
        entry.gifSprite = sprite;
        entry.naturalSize = { width: sprite.width, height: sprite.height };
        return;
      }
      const sprite = new Sprite(source.texture);
      sprite.anchor.set(0.5);
      node.addChild(sprite);
      entry.naturalSize = { width: source.texture.width, height: source.texture.height };
    });
    return entry;
  }

  function makeVideoEntry(clip: Extract<Clip, { kind: "video-segment" }>): PoolEntry {
    const node = new Container();
    container.addChild(node);
    // placeholder size until the video's own metadata loads (see below) —
    // lets the transform editor still show a reasonably-sized box
    // immediately rather than nothing at all.
    const entry: PoolEntry = {
      node,
      naturalSize: { width: 320, height: 180 },
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
      log.debug("animaniac", "[ANIMANIAC-DBG] video-segment getMediaPlaybackUrl ->", clip.videoBlobId.slice(0, 12), url ? "got url" : "null");
      if (!url || node.destroyed) return;
      const video = document.createElement("video");
      video.src = url;
      video.muted = clip.muted;
      video.playsInline = true;
      entry.video = video;
      const mime = clip.videoMime || "";
      if (mime) {
        log.debug("animaniac", "[ANIMANIAC-DBG] video-segment mime:", clip.videoBlobId.slice(0, 12), mime, "canPlayType:", video.canPlayType(mime));
      }
      video.addEventListener("loadedmetadata", () => {
        log.debug("animaniac", "[ANIMANIAC-DBG] video-segment loadedmetadata:", clip.videoBlobId.slice(0, 12), video.videoWidth, video.videoHeight);
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          entry.naturalSize = { width: video.videoWidth, height: video.videoHeight };
        }
      });
      video.addEventListener("canplay", () => {
        log.debug("animaniac", "[ANIMANIAC-DBG] video-segment canplay:", clip.videoBlobId.slice(0, 12));
      });
      video.addEventListener("error", () => {
        const err = video.error;
        // MediaError.code: 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
        // (e.g. codec/container the platform's media engine can't decode —
        // seen for videos authored on a browser peer then snatched to a
        // native Tauri peer, where WKWebView's media stack supports a
        // narrower codec set than desktop Chrome/Firefox)
        log.warn("animaniac", "[ANIMANIAC-DBG] video-segment element failed to load:", clip.videoBlobId.slice(0, 12), "mime:", mime, "code:", err?.code, "message:", err?.message);
      });
      // `Texture.from(video)` would use VideoSource's own `autoPlay: true`
      // default, which starts playback the instant the video can play —
      // fighting `applyVideoTime()`'s own explicit play/pause control
      // (harmless in practice, since the next tick's `video.pause()` call
      // re-asserts it, but constructing the source with `autoPlay: false`
      // up front avoids the unwanted brief autoplay entirely.
      //
      // constructing the VideoSource immediately (readyState 0, no decoded
      // frame yet) let pixi's GPU texture get allocated before the video's
      // real dimensions/first frame existed — seeking or playing shortly
      // after landed a `glCopySubTextureCHROMIUM: destination level ...
      // must be defined` GL error on some backends (a partial-copy upload
      // targeting a texture level that was never given an initial full
      // `texImage2D` at real dimensions). wait for `loadeddata` (a real
      // decoded frame + known dimensions) before constructing the
      // VideoSource/Sprite at all, so pixi's first-ever upload for this
      // texture already has valid data + dimensions.
      const attachSprite = () => {
        if (node.destroyed || entry.node.children.length > 0) return;
        // "WebGL: INVALID_VALUE: Offset overflows texture dimensions" is a
        // confirmed, still-open upstream pixi.js bug for video textures
        // (https://github.com/pixijs/pixijs/issues/11001) — pixi's own
        // maintainers' only suggested mitigation is an explicit
        // `texture.source.update()` right after creation ("helps
        // sometimes but not always", per that thread) — cheap and
        // harmless, so applied here regardless.
        log.debug("animaniac", "[ANIMANIAC-DBG] video-segment attaching texture at native size:", clip.videoBlobId.slice(0, 12), video.videoWidth, video.videoHeight);
        const source = new VideoSource({ resource: video, autoPlay: false, autoLoad: true });
        const sprite = new Sprite(new Texture({ source }));
        source.update();
        sprite.anchor.set(0.5);
        node.addChild(sprite);
      };
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        attachSprite();
      } else {
        video.addEventListener("loadeddata", attachSprite, { once: true });
      }
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
    return { node, mouth, envelope: null, envelopeRequested: false, naturalSize: { width: MOUTH_BOX_WIDTH, height: MOUTH_BOX_HEIGHT }, destroy: () => node.destroy({ children: true }) };
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
    // `clip.muted` only gets applied at video-element CREATION time
    // otherwise (see `makeVideoEntry()`) — the element is pooled/reused
    // across frames, so a mute toggled after mount (the timeline's own
    // "mute"/"unmute" action) never reached the still-playing element.
    if (video.muted !== clip.muted) video.muted = clip.muted;
    if (!entry.videoSynced || seeked) {
      video.currentTime = clip.sourceInSec + localElapsed;
      entry.videoSynced = true;
    }
    if (playing && video.paused) void video.play().catch(() => {});
    if (!playing && !video.paused) video.pause();
  }

  /** an animated-gif image/doodle-frame clip's `GifSprite` — play while the
   *  timeline itself is playing, stop (freeze on current frame) otherwise,
   *  mirroring `applyVideoTime()`'s play/pause handling above. `GifSprite`
   *  has no independent seek-to-timeline-position concept (unlike video,
   *  a gif's own frame timing isn't meant to be scrubbed to an arbitrary
   *  point) — it just free-runs its own loop whenever playing. */
  function applyGifPlayback(entry: PoolEntry, playing: boolean): void {
    const gif = entry.gifSprite;
    if (!gif) return;
    if (playing && !gif.playing) gif.play();
    if (!playing && gif.playing) gif.stop();
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

    // z-order: matches the TRACK LIST's own visual order (see index.ts's
    // `syncTracks()`/`timeline-rows.ts`'s `layout()`, which lay out
    // `sortedTracks()`'s ascending-`order` result top-to-bottom) — the
    // track at the TOP of that list is drawn on TOP here too, so
    // `sortedTracks()`'s own ascending order is walked in REVERSE (the
    // bottom-of-list track's clips are pushed first / drawn first / end
    // up at the back; the top-of-list track's clips are pushed last /
    // drawn last / end up in front). array position within a track is a
    // stable tiebreak, matching track-model.ts's own `clipsForTrack()`.
    // `active` is already visual-clip-only (see above), so a track
    // holding a mix of visual/audio clips only contributes its visual
    // ones here.
    const orderedClips: Clip[] = [];
    for (const track of sortedTracks(tracks.filter((tr) => !tr.hidden)).reverse()) {
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
      if (!liveEditIds.has(clip.id)) {
        const transform = resolveTransformAt(clip.keyframes, localElapsed);
        // a keyframe's x/y=0 means "centered in the preview area" (every
        // sprite is anchor(0.5)) — not the container's own (0,0) corner.
        entry.node.x = previewWidth / 2 + transform.x;
        entry.node.y = previewHeight / 2 + transform.y;
        entry.node.scale.set(transform.scaleX, transform.scaleY);
        entry.node.rotation = transform.rotation;
        entry.node.alpha = transform.opacity;
      }

      if (clip.kind === "video-segment") applyVideoTime(entry, clip, localElapsed, playing, seeked);
      if (clip.kind === "doodle-frame" || clip.kind === "image") applyGifPlayback(entry, playing);
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
      if (!liveEditIds.has(clip.id)) {
        const transform = resolveTransformAt(clip.keyframes, localElapsed);
        entry.node.x = previewWidth / 2 + transform.x;
        entry.node.y = previewHeight / 2 + transform.y;
        entry.node.scale.set(transform.scaleX, transform.scaleY);
        entry.node.rotation = transform.rotation;
        entry.node.alpha = transform.opacity;
      }
      entry.mouth.setOpenness(entry.envelope ? opennessAtElapsed(entry.envelope, localElapsed) : 0);
    }

    // keep mouths above every doodle/image/label/video sprite regardless
    // of the visual z-order reshuffling (`setChildIndex`) above.
    container.addChild(mouthLayer);
  }

  return {
    update,
    getNaturalSize(clipId: string) {
      return pool.get(clipId)?.naturalSize ?? mouthPool.get(clipId)?.naturalSize ?? null;
    },
    beginLiveEdit(clipId: string) {
      liveEditIds.add(clipId);
      return pool.get(clipId)?.node ?? mouthPool.get(clipId)?.node ?? null;
    },
    endLiveEdit(clipId: string) {
      liveEditIds.delete(clipId);
    },
    destroy() {
      for (const entry of pool.values()) entry.destroy();
      pool.clear();
      for (const entry of mouthPool.values()) entry.destroy();
      mouthPool.clear();
      mouthEnvelopeCache.clear();
    },
  };
}
