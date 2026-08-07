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
import { pickFiles, uploadFile } from "../../src/file-utils/upload";
import { getMediaPlaybackUrl } from "../../src/media";
import { createMediaDomOverlay, type MediaDomOverlayHandle } from "../../src/widgets/media-dom-overlay";
import type {
  CompactInfo,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../../src/widgets/widget-types";
import { stfuSchema, type StfuState } from "./types";

const PADDING = 8;
const HEADER_HEIGHT = 20;
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
    let loadedVideoKey = "";
    let mediaOverlay: MediaDomOverlayHandle | null = null;

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
          ? [state.videoFilename, state.videoDurationSec ? `${Math.round(state.videoDurationSec)}s` : null]
              .filter(Boolean)
              .join(" · ")
          : "";
    }

    function teardownMediaOverlay(): void {
      mediaOverlay?.close();
      mediaOverlay = null;
      loadedVideoKey = "";
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
        container,
        canvasElement: ctx.canvasElement,
        getSize: () => ({
          width: currentWidth,
          height: Math.max(0, currentHeight - HEADER_HEIGHT),
        }),
        muted: false,
        loop: false,
        controls: true,
        objectFit: "contain",
      });
      mediaOverlay.video.style.marginTop = `${HEADER_HEIGHT}px`;

      // best-effort duration — populated from the browser's own metadata
      // probe rather than a backend probe pipeline (not built yet).
      mediaOverlay.video.addEventListener(
        "loadedmetadata",
        () => {
          if (destroyed) return;
          const dur = mediaOverlay?.video.duration;
          if (dur && Number.isFinite(dur) && Math.abs(dur - ctx.doc.current.videoDurationSec) > 0.5) {
            ctx.doc.change((d) => {
              d.videoDurationSec = dur;
            });
          }
        },
        { once: true }
      );
    }

    function applyDocState(): void {
      const state = ctx.doc.current;
      const nextLoadState: LoadState = state.videoBlobId ? "ready" : loadState === "loading" ? "loading" : "empty";
      loadState = nextLoadState;

      if (loadState === "ready") {
        void mountMediaOverlay();
      } else {
        teardownMediaOverlay();
      }
      refresh();
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

      resize(w: number, h: number) {
        currentWidth = w;
        currentHeight = h;
        drawBg(w, h);
        drawPlaceholderBorder(w, h);
        placeholderText.x = w / 2;
        placeholderText.y = h / 2;
      },

      destroy() {
        destroyed = true;
        uploadCancelled = true;
        uploadAbort?.abort();
        unsubscribe();
        teardownMediaOverlay();
      },
    };
  },
};
