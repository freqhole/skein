// ---------------------------------------------------------------------------
// "my canvas bin" narthex widget — show/collect the LOCAL peer's own
// curated profile canvases (the ones added via "+ add current canvas" in
// profile-tab.ts), directly on the narthex, in fully editable (non-
// read-only) mode. see docs/narthex-widgets-and-file-transfer-plan.md
// section 1.
//
// unlike widgets/narthex/friend-canvas-bin.ts (a friend-PICKER widget for
// browsing one specific FRIEND's read-only bin — a real, correct, already-
// working feature for a different use case), this widget has nothing to
// pick — it's always "my own bin" — so it hands off directly to the same
// shared `createProfileCanvasBinWidget()` renderer
// (widgets/narthex/social/canvas-bin.ts) that profile-tab.ts already
// hand-mounts internally, but as a real registered `WidgetFactory`, in
// non-read-only mode (the owner can drag/organize into folders directly
// from the narthex, not just from the profile tab's underlying doc).
//
// ## resolving "my own" profile/canvas-bin docs
//
// a real `WidgetFactory` mounted through the generic widget system
// (src/canvas/widget-manager.ts) only ever receives `ctx.canvasStore` —
// `ctx.profileStore`/`ctx.narthexDocId` are wired only for the social
// overlay's hand-built context (see widget-types.ts's doc comments), not
// for ordinary palette-placed widgets. so this widget resolves the local
// peer's own profile + canvas-bin docs itself, via `ctx.canvasStore.repo`
// + the same `ensureMyProfileDoc()`/`ensureMyCanvasBinDoc()` singleton-doc
// helpers boot.ts/profile-tab.ts already use — same pattern
// friend-canvas-bin.ts already established for reaching the repo from a
// plain `WidgetFactory` context.
//
// ## singleton
//
// only one instance ever makes sense (there's only one "my own bin") — see
// `metadata.singleton`/`singletonId` below. `profile-tab.ts`'s
// `addCurrentCanvasToProfile()` auto-adds one the first time a canvas is
// ever added to the profile; removing it via the frame close button is
// purely local (doesn't un-publish anything from the profile), and the
// palette can always re-add it since it isn't `hidden`.
// ---------------------------------------------------------------------------

import { Container, Graphics, Text } from "pixi.js";
import { z } from "zod";
import type { WidgetController, WidgetFactory, WidgetMountContext } from "../../src/widgets/widget-types";
import { ensureMyCanvasBinDoc } from "../../src/canvas/canvas-bin-doc";
import { ensureMyProfileDoc } from "../../src/canvas/profile-doc";
import { createProfileCanvasBinWidget, type ProfileCanvasBinController } from "./social/canvas-bin";
import { registerWidgetBridge, unregisterWidgetBridge } from "../../src/dev/test-bridge-registry";

// ---------------------------------------------------------------------------
// schema — no per-instance config needed, it's always "my own bin".
// ---------------------------------------------------------------------------

export const ownCanvasBinSchema = z.object({});
export type OwnCanvasBinState = z.infer<typeof ownCanvasBinSchema>;

/** the widget "type" identifier — kebab-case, same convention as every
 *  other entry in widgets/narthex/index.ts's registry. */
export const OWN_CANVAS_BIN_WIDGET_TYPE = "own-canvas-bin";

/** well-known singleton widget id — mirrors `SOCIAL_WIDGET_ID`/
 *  `MESSAGEZ_WIDGET_ID` (src/standalone/narthex-seed.ts): used both as
 *  `metadata.singletonId` (so the palette hides it once already placed,
 *  see toolbar.ts's `addWidget()`) and as the widget's own `id` field
 *  whenever profile-tab.ts auto-adds it, so the per-widget automerge doc
 *  persists across close/reopen cycles. */
export const OWN_CANVAS_BIN_WIDGET_ID = "skein-own-canvas-bin";

// ---------------------------------------------------------------------------
// visual constants (matches friend-canvas-bin.ts's palette)
// ---------------------------------------------------------------------------

const BG = 0x1a1a24;
const BORDER = 0x2a2a3e;
const TEXT_COLOR = 0xf0f0ff;
const MUTED_TEXT = 0x666678;
const CARD_RADIUS = 6;
const PADDING = 10;
const HEADER_SIZE = 12;
const FONT = "system-ui, sans-serif";
const RESOLUTION = 3;

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export const ownCanvasBinWidget: WidgetFactory<typeof ownCanvasBinSchema> = {
  type: OWN_CANVAS_BIN_WIDGET_TYPE,
  metadata: {
    name: "my canvas bin",
    description: "your own curated canvases, shown to peers on your profile",
    version: "0.1.0",
    category: "narthex",
    // hidden from the "+" add-widget palette — this widget is only ever
    // auto-added by profile-tab.ts's addCurrentCanvasToProfile() (first
    // canvas ever added to the profile) or already present from a prior
    // session, never manually placed. same precedent as canvas-info.ts
    // (a real on-canvas singleton widget, auto-seeded, also hidden) and
    // messagez/social (auto-managed, hidden). `hidden` only affects the
    // palette — the generic WidgetFrame close (x) button still works
    // regardless (see widget-manager.ts's onClose/closeWidget, which has
    // no singleton/hidden check at all), so removal stays fully available.
    hidden: true,
    singleton: true,
    singletonId: OWN_CANVAS_BIN_WIDGET_ID,
    defaultWidth: 280,
    defaultHeight: 320,
  },
  schema: ownCanvasBinSchema,
  editableProps: [],

  create(ctx: WidgetMountContext<typeof ownCanvasBinSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let status: "resolving" | "unavailable" | "ready" = "resolving";
    let binController: ProfileCanvasBinController | null = null;
    // bumped on destroy — guards the async doc resolution against mounting
    // a bin controller onto a container this widget has already torn down.
    let generation = 0;

    const cardBg = new Graphics();
    container.addChild(cardBg);

    const headerText = new Text({
      text: "my canvas bin",
      style: { fontFamily: FONT, fontSize: HEADER_SIZE, fontWeight: "bold", fill: TEXT_COLOR },
      resolution: RESOLUTION,
    });
    headerText.eventMode = "none";
    container.addChild(headerText);

    const statusText = new Text({
      text: "loading...",
      style: { fontFamily: FONT, fontSize: 11, fill: MUTED_TEXT, wordWrap: true },
      resolution: RESOLUTION,
    });
    statusText.eventMode = "none";
    container.addChild(statusText);

    const binHost = new Container();
    container.addChild(binHost);

    function destroyBinController(): void {
      if (binController) {
        binController.destroy();
        binController = null;
      }
    }

    const layout = (w: number, h: number) => {
      currentWidth = w;
      currentHeight = h;

      cardBg.clear();
      cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
      cardBg.fill({ color: BG });
      cardBg.stroke({ color: BORDER, width: 1 });

      headerText.x = PADDING;
      headerText.y = PADDING;

      const contentY = PADDING + HEADER_SIZE + 8;

      if (status !== "ready") {
        binHost.visible = false;
        statusText.visible = true;
        statusText.text = status === "unavailable" ? "couldn't load your canvas bin" : "loading...";
        statusText.x = PADDING;
        statusText.y = contentY;
        return;
      }

      statusText.visible = false;
      binHost.visible = true;
      binHost.x = 0;
      binHost.y = contentY;
      binController?.layout(w, Math.max(120, h - contentY - PADDING));
    };

    function resolveOwnBin(): void {
      const myGeneration = generation;
      const repo = ctx.canvasStore?.repo;
      if (!repo) {
        status = "unavailable";
        layout(currentWidth, currentHeight);
        return;
      }
      Promise.all([ensureMyProfileDoc(repo), ensureMyCanvasBinDoc(repo)])
        .then(([profileStore, canvasBinStore]) => {
          if (myGeneration !== generation) return;
          status = "ready";
          binController = createProfileCanvasBinWidget({
            canvasBinStore,
            profileStore,
            width: currentWidth,
            height: Math.max(120, currentHeight - HEADER_SIZE - PADDING * 2),
            registerTestHooks: (hooks) => {
              registerWidgetBridge(ctx.widgetId, hooks);
            },
          });
          binHost.addChild(binController.container);
          layout(currentWidth, currentHeight);
        })
        .catch(() => {
          if (myGeneration !== generation) return;
          status = "unavailable";
          layout(currentWidth, currentHeight);
        });
    }

    layout(currentWidth, currentHeight);
    resolveOwnBin();

    return {
      container,
      resize(width: number, height: number) {
        layout(width, height);
      },
      destroy() {
        generation++;
        unregisterWidgetBridge(ctx.widgetId);
        destroyBinController();
        container.destroy({ children: true });
      },
    };
  },
};
