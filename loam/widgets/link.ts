import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { z } from "zod";
import { isTauriMode } from "../src/p2p/tauri-transport";
import { fetchUnfurl } from "../src/widgets/link-unfurl";
import { createSkeinInput, type SkeinInputHandle } from "../src/widgets/skein-input";
import {
  type CompactInfo,
  type HeaderAction,
  type WidgetAction,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../src/widgets/widget-types";

export const linkSchema = z.object({
  url: z.string().default(""),
  title: z.string().default(""),
  description: z.string().default(""),
  previewUrl: z.string().default(""),
  unfurlEnabled: z.boolean().default(false),
});

export type LinkState = z.infer<typeof linkSchema>;

type FetchStatus = "idle" | "loading" | "success" | "error";

// theme
const BG_COLOR = 0x141418;
const BORDER_COLOR = 0x2a2a3e;
const BORDER_HOVER_COLOR = 0x4a4a5e;
const ICON_COLOR = 0x6366f1;
const TITLE_COLOR = 0xf0f0ff;
const URL_COLOR = 0x888898;
const DESC_COLOR = 0xaaaabc;
const HINT_COLOR = 0xf59e0b;
const MUTED_COLOR = 0x666678;
const PREVIEW_BG = 0x1e1e28;
const FONT = "system-ui, sans-serif";

// layout
const CARD_RADIUS = 8;
const PADDING_X = 14;
const PADDING_Y = 12;
const ICON_SIZE = 18;
const HEADER_HEIGHT = 26;
const DESC_FONT_SIZE = 11;
const URL_FONT_SIZE = 12;
const HINT_FONT_SIZE = 10;
const PREVIEW_RATIO = 0.42;

/** truncate a string to a rough character budget, appending an ellipsis. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "\u2026";
}

/** rough "how many characters fit in this pixel width" heuristic. */
function estimateMaxChars(width: number, fontSize: number): number {
  const avgCharWidth = fontSize * 0.55;
  return Math.max(4, Math.floor(width / avgCharWidth));
}

export const linkWidget: WidgetFactory<typeof linkSchema> = {
  type: "link",
  metadata: {
    name: "link",
    description: "a URL card with an optional title/description/preview unfurl",
    version: "0.1.0",
    category: "basics",
    defaultWidth: 280,
    defaultHeight: 210,
  },
  schema: linkSchema,
  editableProps: [
    { key: "title", label: "title", type: "string" as const, default: "" },
    { key: "description", label: "description", type: "string" as const, default: "" },
    {
      key: "previewUrl",
      label: "preview image",
      type: "image" as const,
      default: "",
      imageMaxWidth: 640,
      imageMaxHeight: 400,
    },
  ],

  getCompactInfo: (state: LinkState): CompactInfo => ({
    label: state.title || state.url || "link",
    thumbnailUrl: state.previewUrl || undefined,
  }),

  onCompactActivate: (state: LinkState): void => {
    if (state.url) {
      window.open(state.url, "_blank", "noopener,noreferrer");
    }
  },

  create(ctx: WidgetMountContext<typeof linkSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";
    container.cursor = "pointer";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let hovered = false;
    let editingUrl = false;
    let urlInputHandle: SkeinInputHandle | null = null;
    let fetchStatus: FetchStatus = "idle";
    let fetchHint = "";
    let lastUrlForFetch = "";
    let lastUnfurlEnabled = ctx.doc.current.unfurlEnabled;

    // --- graphics layers ---

    const cardBg = new Graphics();
    container.addChild(cardBg);

    const iconGfx = new Graphics();
    iconGfx.eventMode = "none";
    container.addChild(iconGfx);

    const urlText = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: URL_FONT_SIZE, fontWeight: "bold", fill: TITLE_COLOR },
      resolution: 3,
    });
    urlText.eventMode = "none";
    container.addChild(urlText);

    const subUrlText = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 10, fill: URL_COLOR },
      resolution: 3,
    });
    subUrlText.eventMode = "none";
    container.addChild(subUrlText);

    const editBtn = new Text({
      text: "\u270e", // pencil — edit the URL
      style: { fontFamily: FONT, fontSize: 13, fill: MUTED_COLOR },
      resolution: 3,
    });
    editBtn.eventMode = "static";
    editBtn.cursor = "pointer";
    container.addChild(editBtn);

    const descText = new Text({
      text: "",
      style: {
        fontFamily: FONT,
        fontSize: DESC_FONT_SIZE,
        fill: DESC_COLOR,
        wordWrap: true,
        wordWrapWidth: 200,
        lineHeight: DESC_FONT_SIZE * 1.35,
      },
      resolution: 3,
    });
    descText.eventMode = "none";
    container.addChild(descText);

    const previewBg = new Graphics();
    previewBg.eventMode = "none";
    container.addChild(previewBg);

    const previewMask = new Graphics();
    container.addChild(previewMask);

    let previewSprite: Sprite | null = null;
    let lastRequestedPreviewUrl = "";

    const loadingText = new Text({
      text: "unfurling\u2026",
      style: { fontFamily: FONT, fontSize: 11, fill: MUTED_COLOR },
      resolution: 3,
    });
    loadingText.eventMode = "none";
    loadingText.visible = false;
    container.addChild(loadingText);

    const hintText = new Text({
      text: "",
      style: {
        fontFamily: FONT,
        fontSize: HINT_FONT_SIZE,
        fill: HINT_COLOR,
        wordWrap: true,
        wordWrapWidth: 200,
      },
      resolution: 3,
    });
    hintText.eventMode = "none";
    hintText.visible = false;
    container.addChild(hintText);

    // --- preview image loading ---
    // NOTE: do NOT call Assets.unload() here — previewUrl may be a data:
    // URL shared with other live consumers of the same texture (the
    // property tray's image picker, another widget's preview, etc).
    // unloading it out from under them crashes the renderer mid-frame —
    // same root cause already worked around in canvas-card.ts/file.ts.
    const updatePreviewSprite = async (url: string, w: number, h: number) => {
      lastRequestedPreviewUrl = url;

      if (previewSprite) {
        container.removeChild(previewSprite);
        previewSprite.destroy();
        previewSprite = null;
      }

      if (!url) return;

      try {
        const texture = await Assets.load<Texture>(url);
        if (lastRequestedPreviewUrl !== url) return;

        const previewH = Math.floor(h * PREVIEW_RATIO);
        const top = h - previewH - 1;

        previewSprite = new Sprite(texture);
        previewSprite.eventMode = "none";

        const maxW = w - 2;
        const maxH = previewH;
        const scale = Math.max(maxW / texture.width, maxH / texture.height);
        previewSprite.width = texture.width * scale;
        previewSprite.height = texture.height * scale;
        previewSprite.x = 1 + (maxW - previewSprite.width) / 2;
        previewSprite.y = top + (maxH - previewSprite.height) / 2;
        previewSprite.mask = previewMask;

        container.addChildAt(previewSprite, container.getChildIndex(loadingText));
      } catch {
        // silently ignore load failures (remote og:image URLs are often
        // blocked by CORS/canvas-tainting in browser mode — same accepted
        // limitation as the HTML fetch itself).
      }
    };

    // --- layout ---

    const layout = (w: number, h: number) => {
      const state = ctx.doc.current;
      const hasPreview = !!state.previewUrl;
      const previewH = hasPreview ? Math.floor(h * PREVIEW_RATIO) : 0;
      const contentBottom = h - previewH - (hasPreview ? PADDING_Y * 0.5 : 0);

      cardBg.clear();
      cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
      cardBg.fill({ color: BG_COLOR });
      cardBg.stroke({ color: hovered ? BORDER_HOVER_COLOR : BORDER_COLOR, width: 1 });

      // icon — two overlapping rings, a simple "chain link" glyph
      const iconCx = PADDING_X + ICON_SIZE / 2;
      const iconCy = PADDING_Y + ICON_SIZE / 2;
      iconGfx.clear();
      const r = ICON_SIZE * 0.28;
      iconGfx.circle(iconCx - r * 0.55, iconCy, r);
      iconGfx.stroke({ color: ICON_COLOR, width: 2 });
      iconGfx.circle(iconCx + r * 0.55, iconCy, r);
      iconGfx.stroke({ color: ICON_COLOR, width: 2 });

      const textX = PADDING_X + ICON_SIZE + 8;
      const textMaxW = w - textX - PADDING_X - 18;

      const displayTitle = state.title || state.url;
      urlText.visible = !editingUrl;
      urlText.text = displayTitle ? truncate(displayTitle, estimateMaxChars(textMaxW, URL_FONT_SIZE)) : "no link set";
      urlText.style.fill = displayTitle ? TITLE_COLOR : MUTED_COLOR;
      urlText.x = textX;
      urlText.y = PADDING_Y;

      // second line — the raw URL, only shown when a title differs from it
      subUrlText.visible = !editingUrl && !!state.title && !!state.url;
      subUrlText.text = truncate(state.url, estimateMaxChars(textMaxW, 10));
      subUrlText.x = textX;
      subUrlText.y = PADDING_Y + URL_FONT_SIZE + 2;

      editBtn.visible = !editingUrl;
      editBtn.x = w - PADDING_X - editBtn.width;
      editBtn.y = PADDING_Y - 1;

      const descY = PADDING_Y + HEADER_HEIGHT + (state.title && state.url ? 10 : 0);
      descText.text = state.description;
      descText.style.wordWrapWidth = w - PADDING_X * 2;
      descText.x = PADDING_X;
      descText.y = descY;
      descText.visible = !!state.description;

      // preview area
      previewBg.clear();
      if (hasPreview) {
        const top = h - previewH - 1;
        previewBg.rect(1, top, w - 2, previewH);
        previewBg.fill({ color: PREVIEW_BG });
        previewMask.clear();
        previewMask.rect(1, top, w - 2, previewH);
        previewMask.fill({ color: 0xffffff });
        if (state.previewUrl !== lastRequestedPreviewUrl) {
          void updatePreviewSprite(state.previewUrl, w, h);
        }
      } else if (previewSprite || lastRequestedPreviewUrl) {
        void updatePreviewSprite("", w, h);
      }

      // loading / hint — anchored above the preview area (or bottom of card if none)
      const statusY = Math.min(contentBottom - 14, h - PADDING_Y - 14);
      loadingText.visible = fetchStatus === "loading";
      loadingText.x = PADDING_X;
      loadingText.y = statusY;

      hintText.visible = fetchStatus === "error";
      hintText.text = fetchHint;
      hintText.style.wordWrapWidth = w - PADDING_X * 2;
      hintText.x = PADDING_X;
      hintText.y = statusY;
    };

    // --- unfurl fetch ---

    const refreshHeader = () => {
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    const runUnfurl = async () => {
      if (ctx.canvasStore?.isLocalViewer()) return;
      const url = ctx.doc.current.url;
      if (!url) return;

      fetchStatus = "loading";
      fetchHint = "";
      layout(currentWidth, currentHeight);

      try {
        const result = await fetchUnfurl(url);
        fetchStatus = "success";
        fetchHint = "";
        ctx.doc.change((draft) => {
          if (result.title) draft.title = result.title;
          if (result.description) draft.description = result.description;
          if (result.imageUrl) draft.previewUrl = result.imageUrl;
        });
      } catch {
        fetchStatus = "error";
        fetchHint = isTauriMode()
          ? "unfurl failed — check the URL and try again"
          : "unfurl needs the desktop app (or the site to allow it)";
      }
      layout(currentWidth, currentHeight);
    };

    const maybeRunUnfurl = () => {
      const state = ctx.doc.current;
      if (!state.unfurlEnabled) return;
      if (ctx.canvasStore?.isLocalViewer()) return;
      if (lastUnfurlEnabled && state.url === lastUrlForFetch) return;
      lastUrlForFetch = state.url;
      void runUnfurl();
    };

    // --- URL editing (skein-input, created on demand) ---

    const startEditingUrl = () => {
      if (ctx.canvasStore?.isLocalViewer()) return;
      if (editingUrl) return;
      editingUrl = true;

      const textX = PADDING_X + ICON_SIZE + 8;
      urlInputHandle = createSkeinInput({
        canvasElement: ctx.canvasElement,
        width: currentWidth - textX - PADDING_X,
        height: 24,
        placeholder: "paste a URL...",
        value: ctx.doc.current.url,
        onEnter: (value: string) => {
          const trimmed = value.trim();
          if (trimmed !== ctx.doc.current.url) {
            ctx.doc.change((draft) => {
              draft.url = trimmed;
            });
          }
          finishEditingUrl();
        },
      });
      urlInputHandle.input.x = textX;
      urlInputHandle.input.y = PADDING_Y - 2;
      container.addChild(urlInputHandle.input);
      urlInputHandle.focus();
      layout(currentWidth, currentHeight);
    };

    const finishEditingUrl = () => {
      editingUrl = false;
      if (urlInputHandle) {
        urlInputHandle.destroy();
        urlInputHandle = null;
      }
      layout(currentWidth, currentHeight);
    };

    // --- interactions ---

    editBtn.on("pointertap", (e) => {
      e.stopPropagation();
      startEditingUrl();
    });

    container.on("pointertap", () => {
      if (editingUrl) return;
      const state = ctx.doc.current;
      if (!state.url) {
        startEditingUrl();
      } else {
        window.open(state.url, "_blank", "noopener,noreferrer");
      }
    });

    container.on("pointerover", () => {
      hovered = true;
      layout(currentWidth, currentHeight);
    });
    container.on("pointerout", () => {
      hovered = false;
      layout(currentWidth, currentHeight);
    });

    // --- unfurl toggle (header + property tray, both flip the same field) ---

    const toggleUnfurl = () => {
      if (ctx.canvasStore?.isLocalViewer()) return;
      ctx.doc.change((draft) => {
        draft.unfurlEnabled = !draft.unfurlEnabled;
      });
    };

    const makeHeaderActions = (): HeaderAction[] => [
      {
        id: "toggle-unfurl",
        label: ctx.doc.current.unfurlEnabled ? "unfurl: on" : "unfurl: off",
        shortLabel: "\u21f2",
        active: ctx.doc.current.unfurlEnabled,
        onClick: () => {
          toggleUnfurl();
          refreshHeader();
        },
      },
    ];

    const widgetActions: WidgetAction[] = [
      {
        id: "toggle-unfurl-tray",
        label: "toggle unfurl",
        onClick: toggleUnfurl,
      },
    ];

    // --- doc subscription ---

    const unsub = ctx.doc.on("change", () => {
      const state = ctx.doc.current;
      maybeRunUnfurl();
      lastUnfurlEnabled = state.unfurlEnabled;
      layout(currentWidth, currentHeight);
      refreshHeader();
    });

    // initial draw + kick off unfurl if already enabled on mount
    layout(currentWidth, currentHeight);
    maybeRunUnfurl();

    return {
      container,
      headerActions: makeHeaderActions(),
      widgetActions,

      destroy() {
        unsub();
        if (urlInputHandle) {
          urlInputHandle.destroy();
          urlInputHandle = null;
        }
        if (previewSprite) {
          previewSprite.destroy();
          previewSprite = null;
        }
        container.destroy({ children: true });
      },

      resize(width: number, height: number) {
        currentWidth = width;
        currentHeight = height;
        if (urlInputHandle) {
          urlInputHandle.setWidth(width - (PADDING_X + ICON_SIZE + 8) - PADDING_X);
        }
        layout(width, height);
      },
    };
  },
};
