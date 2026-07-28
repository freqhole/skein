import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { GifSource, GifSprite } from "pixi.js/gif";
import { z } from "zod";
import { isGifDataUrl, pickImageOrGifAsDataUrl } from "../src/widgets/gif-utils";
import { createMediaOverlay, type MediaOverlayHandle } from "../src/widgets/media-overlay";
import type {
  CompactInfo,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../src/widgets/widget-types";

export const imageSchema = z.object({
  url: z.string().default(""),
  fit: z.string().default("contain"),
  bgColor: z.number().default(-1),
  borderColor: z.number().default(-1),
  borderRadius: z.number().default(4),
});

export type ImageState = z.infer<typeof imageSchema>;

type LoadState = "empty" | "loading" | "loaded" | "error";

export const imageWidget: WidgetFactory<typeof imageSchema> = {
  type: "image",
  metadata: {
    name: "image",
    description: "displays an image from a URL with contain/cover fitting",
    version: "0.1.0",
    category: "basics",
  },
  schema: imageSchema,
  editableProps: [
    {
      key: "url",
      label: "image",
      type: "image" as const,
      default: "",
      imageMaxWidth: 800,
      imageMaxHeight: 800,
    },
    {
      key: "fit",
      label: "fit mode",
      type: "select" as const,
      options: ["contain", "cover"],
      default: "contain",
    },
    { key: "bgColor", label: "background", type: "color" as const, default: -1 },
    { key: "borderColor", label: "border", type: "color" as const, default: -1 },
  ],

  getCompactInfo: (state: ImageState): CompactInfo => ({
    label: state.url ? "image" : "empty image",
    thumbnailUrl: state.url || undefined,
    domain: state.url ? "photo" : undefined,
  }),

  create(ctx: WidgetMountContext<typeof imageSchema>): WidgetController {
    const container = new Container();
    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let loadState: LoadState = "empty";
    let currentTexture: Texture | null = null;
    let sprite: Sprite | null = null;
    let loadingAbort: AbortController | null = null;
    // track the URL we last started loading so we can skip stale completions
    let lastRequestedUrl = "";
    let loadedAssetKey = "";
    let gifSource: GifSource | null = null;
    let activeOverlay: MediaOverlayHandle | null = null;

    // only the peer who created this widget can use the initial "click to
    // add image" step — widgets with no recorded creator (pre-existing
    // widgets from before this field existed) are unrestricted.
    const iAmCreator = !ctx.canvasStore || ctx.canvasStore.isLocalWidgetCreator(ctx.widgetId);

    // background graphics
    const bg = new Graphics();
    container.addChild(bg);

    const drawBg = (w: number, h: number) => {
      const state = ctx.doc.current;
      bg.clear();
      bg.roundRect(0, 0, w, h, state.borderRadius);
      bg.fill(state.bgColor === -1 ? { color: 0, alpha: 0 } : { color: state.bgColor });
      bg.stroke(
        state.borderColor === -1
          ? { color: 0, alpha: 0, width: 1 }
          : { color: state.borderColor, width: 1 }
      );
    };
    drawBg(currentWidth, currentHeight);

    // placeholder text — shown when no URL is set
    const placeholderText = new Text({
      text: iAmCreator ? "click to add image" : "waiting for image",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        fill: 0x666680,
        align: "center",
      },
      resolution: 2,
    });
    placeholderText.anchor.set(0.5);
    placeholderText.x = currentWidth / 2;
    placeholderText.y = currentHeight / 2;
    placeholderText.eventMode = "static";
    placeholderText.cursor = iAmCreator ? "pointer" : "default";
    container.addChild(placeholderText);

    // placeholder dashed border overlay
    const placeholderBorder = new Graphics();
    const drawPlaceholderBorder = (w: number, h: number) => {
      const inset = 12;
      placeholderBorder.clear();
      placeholderBorder.rect(inset, inset, w - inset * 2, h - inset * 2);
      placeholderBorder.stroke({ color: 0x444460, width: 1 });
    };
    drawPlaceholderBorder(currentWidth, currentHeight);
    placeholderBorder.eventMode = "static";
    placeholderBorder.cursor = iAmCreator ? "pointer" : "default";
    container.addChild(placeholderBorder);

    // click placeholder to upload an image. gifs are read as raw bytes (see
    // pickImageOrGifAsDataUrl) instead of being resized through a canvas, so
    // their animation survives.
    const handlePlaceholderClick = async () => {
      if (loadState !== "empty") return;
      if (ctx.canvasStore?.isLocalViewer()) return;
      if (!iAmCreator) return;
      const dataUrl = await pickImageOrGifAsDataUrl({
        maxWidth: 800,
        maxHeight: 800,
      });
      if (dataUrl) {
        ctx.doc.change((draft) => {
          draft.url = dataUrl;
        });
      }
    };

    // click a loaded image to view it full-screen — reuses the same overlay
    // the file widget uses for its lightbox, so a gif keeps animating there.
    const handleOpenLightbox = () => {
      if (loadState !== "loaded" || !loadedAssetKey) return;
      if (activeOverlay) return;
      activeOverlay = createMediaOverlay({
        type: "photo",
        src: loadedAssetKey,
        onClose: () => {
          activeOverlay = null;
        },
      });
    };

    // hover a gif to animate it — GifSprite renders every frame natively, we
    // just start it paused (see loadImage) and play/stop it on hover so it's
    // static at rest, matching the file widget's hover-to-animate behavior.
    const handleGifHoverEnter = () => {
      if (loadState !== "loaded") return;
      if (sprite instanceof GifSprite) sprite.play();
    };
    const handleGifHoverLeave = () => {
      if (sprite instanceof GifSprite) {
        sprite.stop();
        sprite.currentFrame = 0;
      }
    };

    const handleBgClick = () => {
      if (loadState === "empty") {
        void handlePlaceholderClick();
      } else if (loadState === "loaded") {
        handleOpenLightbox();
      }
    };

    // click anywhere in the widget (not just the placeholder text/border) to
    // upload an image — the bg fill already spans the full content area. once
    // loaded, the same click opens the full-screen lightbox instead.
    bg.eventMode = "static";
    bg.on("pointertap", handleBgClick);
    bg.on("pointerenter", handleGifHoverEnter);
    bg.on("pointerleave", handleGifHoverLeave);
    placeholderText.on("pointertap", handlePlaceholderClick);
    placeholderBorder.on("pointertap", handlePlaceholderClick);

    // loading text
    const loadingText = new Text({
      text: "loading...",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        fill: 0x888899,
        align: "center",
      },
      resolution: 2,
    });
    loadingText.anchor.set(0.5);
    loadingText.x = currentWidth / 2;
    loadingText.y = currentHeight / 2;
    loadingText.visible = false;
    container.addChild(loadingText);

    // error text
    const errorText = new Text({
      text: "failed to load",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        fill: 0xdd4444,
        align: "center",
      },
      resolution: 2,
    });
    errorText.anchor.set(0.5);
    errorText.x = currentWidth / 2;
    errorText.y = currentHeight / 2;
    errorText.visible = false;
    container.addChild(errorText);

    // update visibility of overlays based on current load state
    const syncOverlayVisibility = () => {
      placeholderText.visible = loadState === "empty";
      placeholderBorder.visible = loadState === "empty";
      loadingText.visible = loadState === "loading";
      errorText.visible = loadState === "error";
      if (sprite) {
        sprite.visible = loadState === "loaded";
      }
      // pointer cursor while empty (upload) is restricted to the widget's
      // creator; once loaded, anyone can click to view full-screen.
      bg.cursor =
        (loadState === "empty" && iAmCreator) || loadState === "loaded" ? "pointer" : "default";
    };

    // fit the sprite within the widget bounds according to the current fit mode
    const fitSprite = (w: number, h: number) => {
      if (!sprite || !currentTexture) return;

      const imageWidth = currentTexture.width;
      const imageHeight = currentTexture.height;
      if (imageWidth === 0 || imageHeight === 0) return;

      const state = ctx.doc.current;
      const scaleX = w / imageWidth;
      const scaleY = h / imageHeight;
      const scale = state.fit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

      sprite.width = imageWidth * scale;
      sprite.height = imageHeight * scale;
      sprite.x = (w - sprite.width) / 2;
      sprite.y = (h - sprite.height) / 2;
    };

    // clean up the current sprite and texture
    const destroySprite = () => {
      handleGifHoverLeave();
      if (sprite) {
        container.removeChild(sprite);
        sprite.destroy();
        sprite = null;
      }
      // NOTE: do NOT unload a data: URL's texture — it can be shared with
      // other live consumers of the same texture (a canvas-card thumbnail,
      // the canvas-wizard's preview, a file widget's thumbnail, etc).
      // unloading it out from under them crashes the renderer mid-frame
      // ("alphaMode" null error in StencilMaskPipe) — same root cause
      // already fixed the same way in file.ts/property-tray.ts/
      // canvas-wizard.ts/canvas-card.ts/canvas-info.ts. blob: URLs are
      // never shared this way (each is unique per load), so those are
      // still safe to unload/revoke.
      if (loadedAssetKey) {
        if (loadedAssetKey.startsWith("blob:")) {
          Assets.unload(loadedAssetKey);
          URL.revokeObjectURL(loadedAssetKey);
        }
        loadedAssetKey = "";
      }
      currentTexture = null;
      if (gifSource) {
        gifSource.destroy();
        gifSource = null;
      }
    };

    // load an image from a URL, creating a texture and sprite
    const loadImage = async (url: string) => {
      // abort any in-flight request
      if (loadingAbort) {
        loadingAbort.abort();
        loadingAbort = null;
      }

      // handle empty URL
      if (!url) {
        destroySprite();
        loadState = "empty";
        syncOverlayVisibility();
        return;
      }

      lastRequestedUrl = url;
      loadState = "loading";
      syncOverlayVisibility();

      const abort = new AbortController();
      loadingAbort = abort;

      try {
        let texture: Texture;
        let assetKey: string;
        let newGifSource: GifSource | null = null;
        let newSprite: Sprite;

        // pixi's core Assets loader has no gif support at all (not even for a
        // static first frame) — it throws for any image/gif source. gifs are
        // built from raw bytes via the built-in GifSource/GifSprite instead,
        // started paused (autoPlay: false) so they're static at rest and only
        // animate on hover (see handleGifHoverEnter/Leave).
        if (url.startsWith("data:")) {
          assetKey = url;
          if (isGifDataUrl(url)) {
            const buffer = await fetch(url, { signal: abort.signal }).then((r) => r.arrayBuffer());
            newGifSource = GifSource.from(buffer);
            texture = newGifSource.textures[0];
            newSprite = new GifSprite({ source: newGifSource, autoPlay: false });
          } else {
            // data URL — use Assets.load (PixiJS v8 compatible)
            texture = await Assets.load<Texture>(url);
            newSprite = new Sprite(texture);
          }
        } else {
          // remote URL — fetch, then either build a GifSource (gif) or load
          // via Assets (everything else)
          const response = await fetch(url, { signal: abort.signal });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const blob = await response.blob();
          if (blob.type === "image/gif") {
            const buffer = await blob.arrayBuffer();
            newGifSource = GifSource.from(buffer);
            texture = newGifSource.textures[0];
            newSprite = new GifSprite({ source: newGifSource, autoPlay: false });
            assetKey = url;
          } else {
            const blobUrl = URL.createObjectURL(blob);
            texture = await Assets.load<Texture>(blobUrl);
            newSprite = new Sprite(texture);
            assetKey = blobUrl;
          }
        }

        // check if this request is still current
        if (abort.signal.aborted || lastRequestedUrl !== url) {
          newGifSource?.destroy();
          newSprite.destroy();
          // same reasoning as destroySprite() above — never unload a data:
          // URL, it may be shared with other live consumers.
          if (assetKey.startsWith("blob:")) {
            Assets.unload(assetKey);
            URL.revokeObjectURL(assetKey);
          }
          return;
        }

        // tear down previous sprite/texture before creating new ones
        destroySprite();

        currentTexture = texture;
        loadedAssetKey = assetKey;
        gifSource = newGifSource;
        sprite = newSprite;
        // insert sprite above bg but below overlay texts
        container.addChildAt(sprite, 1);

        loadState = "loaded";
        syncOverlayVisibility();
        fitSprite(currentWidth, currentHeight);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (lastRequestedUrl !== url) return;

        destroySprite();
        loadState = "error";
        syncOverlayVisibility();
      } finally {
        if (loadingAbort === abort) {
          loadingAbort = null;
        }
      }
    };

    // center all overlay texts after a resize
    const repositionOverlays = (w: number, h: number) => {
      placeholderText.x = w / 2;
      placeholderText.y = h / 2;
      loadingText.x = w / 2;
      loadingText.y = h / 2;
      errorText.x = w / 2;
      errorText.y = h / 2;
    };

    // subscribe to doc changes — reload image when URL changes, re-fit on fit mode change
    let prevUrl = ctx.doc.current.url;
    const unsub = ctx.doc.on("change", (state) => {
      drawBg(currentWidth, currentHeight);

      if (state.url !== prevUrl) {
        prevUrl = state.url;
        loadImage(state.url);
      } else if (loadState === "loaded") {
        // fit mode or other style changed — re-fit the existing sprite
        fitSprite(currentWidth, currentHeight);
      }
    });

    // kick off initial load if a URL is already set
    if (ctx.doc.current.url) {
      loadImage(ctx.doc.current.url);
    }

    return {
      container,
      destroy() {
        if (loadingAbort) {
          loadingAbort.abort();
          loadingAbort = null;
        }
        unsub();
        destroySprite();
        activeOverlay?.close();
        activeOverlay = null;
        container.destroy({ children: true });
      },
      resize(width: number, height: number) {
        currentWidth = width;
        currentHeight = height;
        drawBg(width, height);
        drawPlaceholderBorder(width, height);
        repositionOverlays(width, height);
        fitSprite(width, height);
        // a stale-sized hover overlay would show the gif at the wrong rect —
        // simplest to drop it; the pointer re-entering redraws it correctly.
        handleGifHoverLeave();
      },
    };
  },
};
