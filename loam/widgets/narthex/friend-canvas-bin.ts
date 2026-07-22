// ---------------------------------------------------------------------------
// "friend canvas bin" narthex widget — pin a SPECIFIC friend's profile
// canvas bin onto your own narthex as a live, read-only widget (see
// docs/hub-and-profile-plan.md section 10.2's follow-on: friend-detail
// viewing + a real placeable widget type).
//
// unlike widgets/narthex/social/canvas-bin.ts's `createProfileCanvasBinWidget()`
// (the owner's own bin, hand-mounted by profile-tab.ts with a bespoke
// context), this IS a real, registered `WidgetFactory<S>` — placeable via
// the narthex's "add widget" palette (widgets/narthex/index.ts's
// `createNarthexRegistry()`), one instance per pinned friend, with its own
// small zod schema tracking which friend it points at. it renders the exact
// same shared `createProfileCanvasBinWidget()` in read-only mode — no
// duplicated rendering/pagination logic.
//
// ## friend selection
//
// a real `WidgetFactory` mounted through the generic widget system
// (src/canvas/widget-manager.ts) has no access to the social doc / friend
// list at all — only `ctx.canvasStore` (and this widget's own `ctx.doc`).
// `src/canvas/friend-directory.ts` re-derives a best-effort friend list
// directly off the (browser-mode) social doc via `ctx.canvasStore.repo`, so
// this widget can offer a simple tap-to-pick list when first placed
// (a "needs setup" initial state, same spirit as join-canvas.ts's own
// unconfigured-until-filled-in flow — simpler than that widget's dedicated
// wizard step since there's only one field group to fill in). once a friend
// is picked, `nodeId`/`profileDocId`/`displayName` are cached directly on
// this widget's own doc — no further need for the friend list at all, so
// the tauri-mode limitation (friend-directory.ts only supports browser mode)
// only affects *picking a new* friend, never an already-configured widget.
// ---------------------------------------------------------------------------

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { z } from "zod";
import type { DocumentId } from "@automerge/automerge-repo";
import type { WidgetController, WidgetFactory, WidgetMountContext } from "../../src/widgets/widget-types";
import { CanvasBinStore } from "../../src/canvas/canvas-bin-doc";
import { ProfileStore } from "../../src/canvas/profile-doc";
import { getFriendsForPicker, type FriendPickerCandidate } from "../../src/canvas/friend-directory";
import {
  createProfileCanvasBinWidget,
  type ProfileCanvasBinController,
} from "./social/canvas-bin";
import type { ProfileCanvasBinTestHooks } from "../../src/dev/test-bridge";
import { registerWidgetBridge, unregisterWidgetBridge } from "../../src/dev/test-bridge-registry";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export const friendCanvasBinSchema = z.object({
  nodeId: z.string().default(""),
  profileDocId: z.string().default(""),
  displayName: z.string().default(""),
});

export type FriendCanvasBinState = z.infer<typeof friendCanvasBinSchema>;

/** status exposed on the test bridge — see FriendCanvasBinTestHooks. */
export type FriendCanvasBinStatus = "unconfigured" | "resolving" | "no-canvas-bin" | "ready";

/** test hooks for one instance of this widget — registered per widget id
 *  (more than one instance can exist at once, unlike the social overlay's
 *  singleton tabs) via `registerWidgetBridge(widgetId, hooks)`. */
export interface FriendCanvasBinTestHooks {
  getSelection(): { nodeId: string; profileDocId: string; displayName: string } | null;
  selectFriend(nodeId: string, profileDocId: string, displayName: string): void;
  clearSelection(): void;
  getPickerCandidates(): FriendPickerCandidate[];
  getStatus(): FriendCanvasBinStatus;
  getBinHooks(): ProfileCanvasBinTestHooks | null;
}

// ---------------------------------------------------------------------------
// visual constants (matches join-canvas.ts / canvas-bin.ts's palette)
// ---------------------------------------------------------------------------

const BG = 0x1a1a24;
const BORDER = 0x2a2a3e;
const FIELD_BG = 0x12121a;
const FIELD_BORDER = 0x333348;
const TEXT_COLOR = 0xf0f0ff;
const MUTED_TEXT = 0x666678;
const ACCENT = 0x6366f1;

const CARD_RADIUS = 6;
const PADDING = 10;
const HEADER_SIZE = 12;
const ROW_HEIGHT = 30;
const FONT = "system-ui, sans-serif";
const RESOLUTION = 3;

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export const friendCanvasBinWidget: WidgetFactory<typeof friendCanvasBinSchema> = {
  type: "friend-canvas-bin",
  metadata: {
    name: "friend's canvas bin",
    description: "pin a friend's shared canvas bin, read-only",
    version: "0.1.0",
    category: "narthex",
    defaultWidth: 260,
    defaultHeight: 280,
  },
  schema: friendCanvasBinSchema,
  editableProps: [],

  create(ctx: WidgetMountContext<typeof friendCanvasBinSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let status: FriendCanvasBinStatus = "unconfigured";
    let candidates: FriendPickerCandidate[] = [];
    let binController: ProfileCanvasBinController | null = null;
    let lastBinHooks: ProfileCanvasBinTestHooks | null = null;
    // bumped on every selection change so a stale async resolution (from a
    // friend selected before the user picked a different one, or cleared
    // the selection) can't mount over the current state.
    let generation = 0;

    const cardBg = new Graphics();
    container.addChild(cardBg);

    const headerText = new Text({
      text: "friend's canvas bin",
      style: { fontFamily: FONT, fontSize: HEADER_SIZE, fontWeight: "bold", fill: TEXT_COLOR },
      resolution: RESOLUTION,
    });
    headerText.eventMode = "none";
    container.addChild(headerText);

    const changeBtn = new Container();
    changeBtn.eventMode = "static";
    changeBtn.cursor = "pointer";
    changeBtn.visible = false;
    const changeLabel = new Text({
      text: "change",
      style: { fontFamily: FONT, fontSize: 10, fill: ACCENT },
      resolution: RESOLUTION,
    });
    changeLabel.eventMode = "none";
    changeBtn.addChild(changeLabel);
    container.addChild(changeBtn);

    const statusText = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 11, fill: MUTED_TEXT, wordWrap: true },
      resolution: RESOLUTION,
    });
    statusText.eventMode = "none";
    statusText.visible = false;
    container.addChild(statusText);

    const pickerContainer = new Container();
    pickerContainer.eventMode = "static";
    container.addChild(pickerContainer);

    const binHost = new Container();
    container.addChild(binHost);

    changeBtn.on("pointertap", (e) => {
      e.stopPropagation();
      clearSelection();
    });

    function selectFriend(nodeId: string, profileDocId: string, displayName: string): void {
      ctx.doc.change((draft) => {
        draft.nodeId = nodeId;
        draft.profileDocId = profileDocId;
        draft.displayName = displayName;
      });
      layout(currentWidth, currentHeight);
    }

    function clearSelection(): void {
      ctx.doc.change((draft) => {
        draft.nodeId = "";
        draft.profileDocId = "";
        draft.displayName = "";
      });
      layout(currentWidth, currentHeight);
    }

    function destroyBinController(): void {
      if (binController) {
        binController.destroy();
        binController = null;
      }
      lastBinHooks = null;
    }

    function renderPicker(): void {
      while (pickerContainer.children.length > 0) {
        pickerContainer.removeChildAt(0).destroy({ children: true });
      }
      if (candidates.length === 0) {
        statusText.visible = true;
        statusText.text = "no friends with a shared profile yet";
        return;
      }
      statusText.visible = false;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const row = new Container();
        row.eventMode = "static";
        row.cursor = "pointer";
        row.y = i * ROW_HEIGHT;
        row.hitArea = new Rectangle(0, 0, currentWidth - PADDING * 2, ROW_HEIGHT - 4);

        const rowBg = new Graphics();
        rowBg.roundRect(0, 0, currentWidth - PADDING * 2, ROW_HEIGHT - 4, 4);
        rowBg.fill({ color: FIELD_BG });
        rowBg.stroke({ color: FIELD_BORDER, width: 1 });
        row.addChild(rowBg);

        const rowLabel = new Text({
          text: candidate.displayName,
          style: { fontFamily: FONT, fontSize: 11, fill: TEXT_COLOR },
          resolution: RESOLUTION,
        });
        rowLabel.eventMode = "none";
        rowLabel.x = 8;
        rowLabel.y = (ROW_HEIGHT - 4 - rowLabel.height) / 2;
        row.addChild(rowLabel);

        row.on("pointertap", (e) => {
          e.stopPropagation();
          selectFriend(candidate.nodeId, candidate.profileDocId, candidate.displayName);
        });

        pickerContainer.addChild(row);
      }
    }

    function refreshCandidates(): void {
      const repo = ctx.canvasStore?.repo;
      if (!repo) return;
      getFriendsForPicker(repo)
        .then((list) => {
          candidates = list;
          if (status === "unconfigured") renderPicker();
        })
        .catch(() => {
          // best effort — leave candidates empty.
        });
    }

    function mountReadOnlyBin(canvasBinStore: CanvasBinStore, profileStore: ProfileStore): void {
      destroyBinController();
      status = "ready";
      binController = createProfileCanvasBinWidget({
        canvasBinStore,
        profileStore,
        width: currentWidth,
        height: Math.max(120, currentHeight - HEADER_SIZE - PADDING * 2),
        isReadOnly: true,
        registerTestHooks: (hooks) => {
          lastBinHooks = hooks;
        },
      });
      binHost.addChild(binController.container);
      layout(currentWidth, currentHeight);
    }

    function resolveFriendBin(profileDocId: string): void {
      const myGeneration = ++generation;
      status = "resolving";
      lastBinHooks = null;
      const repo = ctx.canvasStore?.repo;
      if (!repo) {
        status = "no-canvas-bin";
        layout(currentWidth, currentHeight);
        return;
      }
      ProfileStore.open(repo, profileDocId as DocumentId)
        .then(async (friendProfileStore) => {
          if (myGeneration !== generation) return;
          const canvasBinDocId = friendProfileStore.canvasBinDocId();
          if (!canvasBinDocId) {
            status = "no-canvas-bin";
            layout(currentWidth, currentHeight);
            return;
          }
          const friendCanvasBinStore = await CanvasBinStore.open(repo, canvasBinDocId as DocumentId);
          if (myGeneration !== generation) return;
          mountReadOnlyBin(friendCanvasBinStore, friendProfileStore);
        })
        .catch(() => {
          if (myGeneration !== generation) return;
          status = "no-canvas-bin";
          layout(currentWidth, currentHeight);
        });
    }

    const layout = (w: number, h: number) => {
      currentWidth = w;
      currentHeight = h;

      cardBg.clear();
      cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
      cardBg.fill({ color: BG });
      cardBg.stroke({ color: BORDER, width: 1 });

      const state = ctx.doc.current;
      const configured = state.profileDocId !== "";

      headerText.text = configured ? (state.displayName || "friend") + "'s canvas bin" : "pick a friend";
      headerText.x = PADDING;
      headerText.y = PADDING;

      changeBtn.visible = configured;
      changeBtn.x = w - changeLabel.width - PADDING;
      changeBtn.y = PADDING;
      changeBtn.hitArea = new Rectangle(-4, -4, changeLabel.width + 8, changeLabel.height + 8);

      const contentY = PADDING + HEADER_SIZE + 8;

      if (!configured) {
        status = "unconfigured";
        destroyBinController();
        binHost.visible = false;
        statusText.visible = false;
        pickerContainer.visible = true;
        pickerContainer.x = PADDING;
        pickerContainer.y = contentY;
        refreshCandidates();
        renderPicker();
        return;
      }

      pickerContainer.visible = false;

      if (status === "unconfigured") {
        resolveFriendBin(state.profileDocId);
      }

      if (status === "resolving") {
        binHost.visible = false;
        statusText.visible = true;
        statusText.text = `loading ${state.displayName || "friend"}'s canvas bin...`;
        statusText.x = PADDING;
        statusText.y = contentY;
        return;
      }

      if (status === "no-canvas-bin") {
        binHost.visible = false;
        statusText.visible = true;
        statusText.text = `${state.displayName || "this friend"} hasn't shared a canvas bin yet`;
        statusText.x = PADDING;
        statusText.y = contentY;
        return;
      }

      // ready
      statusText.visible = false;
      binHost.visible = true;
      binHost.x = 0;
      binHost.y = contentY;
      if (binController) {
        binController.layout(w, Math.max(120, h - contentY - PADDING));
      }
    };

    registerWidgetBridge(ctx.widgetId, {
      getSelection: () => {
        const state = ctx.doc.current;
        return state.profileDocId ? { nodeId: state.nodeId, profileDocId: state.profileDocId, displayName: state.displayName } : null;
      },
      selectFriend,
      clearSelection,
      getPickerCandidates: () => [...candidates],
      getStatus: () => status,
      getBinHooks: () => lastBinHooks,
    } satisfies FriendCanvasBinTestHooks);

    layout(currentWidth, currentHeight);

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
