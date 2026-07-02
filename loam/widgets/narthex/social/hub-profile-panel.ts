// ---------------------------------------------------------------------------
// hub profile panel — standalone remote hub administration UI.
//
// docs/hub-and-profile-plan.md section 5: an admin friend of a hub can
// remotely view/allow/remove the hub's friendz list and view (read-only)
// its pending knocks, over the production `hub-admin-client.ts` client.
//
// deliberately standalone — does not import from or modify
// `friends-tab.ts`. wiring `mountHubProfilePanel()` into the friend-detail
// view is a small, separate follow-up step (see the plan doc's phased
// order), not done here.
//
// matches the visual conventions already established by the other narthex
// social tabs (`friends-tab.ts`, `requests-tab.ts`, `settings-tab.ts`):
// same fonts/colors/row heights from `./constants.ts`, same row/button
// building style.
// ---------------------------------------------------------------------------

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { log } from "../../../src/utils/log";
import {
  type HubAdminClient,
  type HubAdminFriendSummary,
  type HubAdminPendingKnockSummary,
} from "../../../src/p2p/hub-admin-client";
import { createSkeinInput, type SkeinInputHandle } from "../../../src/widgets/skein-input";
import { isValidNodeId, truncate } from "./helpers";
import {
  ACCENT,
  BG,
  BORDER,
  BUTTON_RADIUS,
  FIELD_HEIGHT,
  FONT,
  LABEL_COLOR,
  LABEL_SIZE,
  MUTED_TEXT,
  ONLINE_COLOR,
  PADDING_X,
  REJECT_COLOR,
  RESOLUTION,
  ROW_ALT_BG,
  ROW_PADDING_X,
  SCROLL_SPEED,
  TEXT_COLOR,
  TEXT_SIZE,
} from "./constants";

const TAG = "social.hub-profile-panel";

// ---------------------------------------------------------------------------
// local layout constants
// ---------------------------------------------------------------------------

const FRIEND_ROW_HEIGHT = 40;
const KNOCK_ROW_HEIGHT = 68;
const SECTION_GAP = 18;
const REMOVE_BTN_W = 60;
const REMOVE_BTN_H = 22;
const ALLOW_BTN_W = 70;

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface HubProfilePanelOptions {
  /** the hub's iroh node id this panel administers. */
  hubNodeId: string;
  /**
   * bound hub-admin-client — e.g.
   * `createHubAdminClient(hubAdminTransportFromAdapter(adapter))`. this
   * panel never constructs its own transport/client, so callers (and
   * tests) can inject any client implementation.
   */
  client: HubAdminClient;
  /** the canvas DOM element — needed by the "allow" field's DOM input overlay. */
  canvasElement: HTMLCanvasElement;
}

/**
 * plain-data snapshot of the panel's current render state — useful for
 * tests/introspection without reaching into pixi internals.
 */
export type HubProfilePanelState =
  | { status: "loading" }
  | { status: "notAdmin" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      friends: HubAdminFriendSummary[];
      pendingKnocks: HubAdminPendingKnockSummary[];
    };

export interface HubProfilePanelHandle {
  /** the pixi container this panel's content was mounted into (same as the `container` argument). */
  container: Container;
  /** re-layout within the given content bounds (width x height). */
  layout(width: number, height: number): void;
  /** re-fetch friendz + pending knocks from the hub. called automatically on mount. */
  refresh(): Promise<void>;
  /** current render state — see `HubProfilePanelState`. */
  getState(): HubProfilePanelState;
  /** tear down all resources (event listeners, DOM overlays, textures). */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

export function mountHubProfilePanel(
  container: Container,
  opts: HubProfilePanelOptions
): HubProfilePanelHandle {
  const { hubNodeId, client, canvasElement } = opts;

  let state: HubProfilePanelState = { status: "loading" };
  let destroyed = false;
  let currentWidth = 0;
  let scrollY = 0;
  let totalHeight = 0;
  let areaHeight = 0;

  let allowInputHandle: SkeinInputHandle | null = null;
  let allowFeedback = "";
  let allowInFlight = false;
  const removeInFlight = new Set<string>();

  // -- scaffolding: scrollable, masked content area --------------------------

  const root = new Container();
  root.eventMode = "static";
  container.addChild(root);

  const inner = new Container();
  inner.eventMode = "static";
  root.addChild(inner);

  const mask = new Graphics();
  root.addChild(mask);
  root.mask = mask;

  root.on("wheel", (e: WheelEvent) => {
    const canScroll = totalHeight > areaHeight;
    if (!canScroll) return;
    e.stopPropagation();
    if ((e as any).nativeEvent) (e as any).nativeEvent._skeinWidgetScroll = true;
    scrollY += e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED;
    clampScroll();
    inner.y = -scrollY;
  });

  function clampScroll(): void {
    const max = Math.max(0, totalHeight - areaHeight);
    scrollY = Math.max(0, Math.min(scrollY, max));
  }

  // -- data fetch --------------------------------------------------------

  async function refresh(): Promise<void> {
    state = { status: "loading" };
    rebuild();

    let listResponse;
    let knocksResponse;
    try {
      [listResponse, knocksResponse] = await Promise.all([
        client.hubAdminList(hubNodeId),
        client.hubAdminListPendingKnocks(hubNodeId),
      ]);
    } catch (err) {
      log.warn(TAG, "hub admin request failed:", err);
      if (destroyed) return;
      state = { status: "error", message: (err as Error)?.message ?? String(err) };
      rebuild();
      return;
    }
    if (destroyed) return;

    // the hub-admin protocol rejects a non-admin caller with NotAdmin on
    // every request kind (see hub_admin.rs's handle_request — the adminz
    // check runs before dispatching to any variant), so either response
    // being notAdmin means the local peer just isn't a recognized admin of
    // this hub — show a simple "not an admin" state rather than rendering
    // partial/empty lists or a raw protocol error.
    if (listResponse.kind === "notAdmin" || knocksResponse.kind === "notAdmin") {
      state = { status: "notAdmin" };
      rebuild();
      return;
    }
    if (listResponse.kind === "error") {
      state = { status: "error", message: listResponse.message };
      rebuild();
      return;
    }
    if (knocksResponse.kind === "error") {
      state = { status: "error", message: knocksResponse.message };
      rebuild();
      return;
    }
    if (listResponse.kind !== "list" || knocksResponse.kind !== "pendingKnocks") {
      state = {
        status: "error",
        message: `unexpected response shape (list: ${listResponse.kind}, knocks: ${knocksResponse.kind})`,
      };
      rebuild();
      return;
    }

    state = {
      status: "ready",
      friends: listResponse.friends,
      pendingKnocks: knocksResponse.knocks,
    };
    rebuild();
  }

  // -- actions -------------------------------------------------------------

  async function handleAllow(nodeId: string): Promise<void> {
    if (allowInFlight) return;
    if (!isValidNodeId(nodeId)) {
      allowFeedback = "not a valid node id";
      rebuild();
      return;
    }
    allowInFlight = true;
    allowFeedback = "";
    rebuild();
    try {
      const response = await client.hubAdminAllow(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        allowFeedback = response.message;
        return;
      }
      if (allowInputHandle) allowInputHandle.value = "";
      allowFeedback = "";
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminAllow failed:", err);
      if (!destroyed) allowFeedback = (err as Error)?.message ?? String(err);
    } finally {
      allowInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  async function handleRemove(nodeId: string): Promise<void> {
    if (removeInFlight.has(nodeId)) return;
    removeInFlight.add(nodeId);
    rebuild();
    try {
      const response = await client.hubAdminRemove(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminRemove failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminRemove failed:", err);
    } finally {
      removeInFlight.delete(nodeId);
      if (!destroyed) rebuild();
    }
  }

  // -- small button builder --------------------------------------------------

  function buildOutlinedButton(opts2: {
    label: string;
    width: number;
    height: number;
    color: number;
    disabled?: boolean;
    onTap: () => void;
  }): Container {
    const btn = new Container();
    btn.eventMode = opts2.disabled ? "none" : "static";
    btn.cursor = opts2.disabled ? "default" : "pointer";
    btn.hitArea = new Rectangle(0, 0, opts2.width, opts2.height);

    const bg = new Graphics();
    bg.eventMode = "none";
    bg.roundRect(0, 0, opts2.width, opts2.height, BUTTON_RADIUS);
    bg.fill({ color: 0x111118 });
    bg.stroke({ color: opts2.color, width: 1.5, alpha: opts2.disabled ? 0.4 : 1 });
    btn.addChild(bg);

    const label = new Text({
      text: opts2.label,
      style: { fontFamily: FONT, fontSize: 10, fill: opts2.color },
      resolution: RESOLUTION,
    });
    label.alpha = opts2.disabled ? 0.5 : 1;
    label.eventMode = "none";
    label.anchor.set(0.5);
    label.x = opts2.width / 2;
    label.y = opts2.height / 2;
    btn.addChild(label);

    if (!opts2.disabled) {
      btn.on("pointertap", (e) => {
        e.stopPropagation();
        opts2.onTap();
      });
    }

    return btn;
  }

  // -- rebuild ---------------------------------------------------------------

  function rebuild(): void {
    if (destroyed) return;

    if (allowInputHandle) {
      allowInputHandle.destroy();
      allowInputHandle = null;
    }
    while (inner.children.length > 0) {
      inner.removeChildAt(0).destroy({ children: true });
    }

    let dy = 0;

    // header
    const title = new Text({
      text: "hub friendz",
      style: { fontFamily: FONT, fontSize: 14, fontWeight: "bold", fill: TEXT_COLOR },
      resolution: RESOLUTION,
    });
    title.eventMode = "none";
    title.x = PADDING_X;
    title.y = dy;
    inner.addChild(title);
    dy += title.height + 2;

    const subtitle = new Text({
      text: truncate(hubNodeId, 40),
      style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    subtitle.eventMode = "none";
    subtitle.x = PADDING_X;
    subtitle.y = dy;
    inner.addChild(subtitle);
    dy += subtitle.height + SECTION_GAP;

    if (state.status === "loading") {
      const loadingText = new Text({
        text: "loading\u2026",
        style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      loadingText.eventMode = "none";
      loadingText.x = PADDING_X;
      loadingText.y = dy;
      inner.addChild(loadingText);
      dy += loadingText.height + SECTION_GAP;
      finishLayout(dy);
      return;
    }

    if (state.status === "notAdmin") {
      const notAdminText = new Text({
        text: "you're not an admin of this hub",
        style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      notAdminText.eventMode = "none";
      notAdminText.x = PADDING_X;
      notAdminText.y = dy;
      inner.addChild(notAdminText);
      dy += notAdminText.height + SECTION_GAP;
      finishLayout(dy);
      return;
    }

    if (state.status === "error") {
      const errorText = new Text({
        text: `couldn't reach the hub: ${state.message}`,
        style: {
          fontFamily: FONT,
          fontSize: TEXT_SIZE,
          fill: REJECT_COLOR,
          wordWrap: true,
          wordWrapWidth: Math.max(80, currentWidth - PADDING_X * 2),
        },
        resolution: RESOLUTION,
      });
      errorText.eventMode = "none";
      errorText.x = PADDING_X;
      errorText.y = dy;
      inner.addChild(errorText);
      dy += errorText.height + 10;

      const retryBtn = buildOutlinedButton({
        label: "retry",
        width: 60,
        height: 24,
        color: ACCENT,
        onTap: () => {
          refresh().catch(() => {});
        },
      });
      retryBtn.x = PADDING_X;
      retryBtn.y = dy;
      inner.addChild(retryBtn);
      dy += 24 + SECTION_GAP;
      finishLayout(dy);
      return;
    }

    // status === "ready" ------------------------------------------------

    const contentW = Math.max(0, currentWidth);

    // -- allow section --

    const allowLabel = new Text({
      text: "allow a peer",
      style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
      resolution: RESOLUTION,
    });
    allowLabel.eventMode = "none";
    allowLabel.x = PADDING_X;
    allowLabel.y = dy;
    inner.addChild(allowLabel);
    dy += LABEL_SIZE + 6;

    const allowRow = new Container();
    allowRow.x = PADDING_X;
    allowRow.y = dy;
    inner.addChild(allowRow);

    const inputW = Math.max(60, contentW - PADDING_X * 2 - ALLOW_BTN_W - 8);
    allowInputHandle = createSkeinInput({
      canvasElement,
      width: inputW,
      height: FIELD_HEIGHT,
      placeholder: "node id to allow",
      onEnter: (value) => {
        handleAllow(value.trim()).catch(() => {});
      },
    });
    allowRow.addChild(allowInputHandle.input);

    const allowBtn = buildOutlinedButton({
      label: allowInFlight ? "\u2026" : "allow",
      width: ALLOW_BTN_W,
      height: FIELD_HEIGHT,
      color: ACCENT,
      disabled: allowInFlight,
      onTap: () => {
        handleAllow(allowInputHandle?.value.trim() ?? "").catch(() => {});
      },
    });
    allowBtn.x = inputW + 8;
    allowRow.addChild(allowBtn);
    dy += FIELD_HEIGHT + 4;

    if (allowFeedback) {
      const feedbackText = new Text({
        text: allowFeedback,
        style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: REJECT_COLOR },
        resolution: RESOLUTION,
      });
      feedbackText.eventMode = "none";
      feedbackText.x = PADDING_X;
      feedbackText.y = dy;
      inner.addChild(feedbackText);
      dy += feedbackText.height + 6;
    }

    dy += SECTION_GAP - 4;

    // -- friendz list section --

    const friendsLabel = new Text({
      text: `friendz (${state.friends.length})`,
      style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
      resolution: RESOLUTION,
    });
    friendsLabel.eventMode = "none";
    friendsLabel.x = PADDING_X;
    friendsLabel.y = dy;
    inner.addChild(friendsLabel);
    dy += LABEL_SIZE + 8;

    if (state.friends.length === 0) {
      const emptyText = new Text({
        text: "no friendz yet",
        style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      emptyText.eventMode = "none";
      emptyText.x = PADDING_X;
      emptyText.y = dy;
      inner.addChild(emptyText);
      dy += emptyText.height + SECTION_GAP;
    } else {
      for (let i = 0; i < state.friends.length; i++) {
        const friend = state.friends[i];
        const rowY = dy;

        const row = new Container();
        row.eventMode = "static";
        row.y = rowY;
        inner.addChild(row);

        if (i % 2 === 1) {
          const rowBg = new Graphics();
          rowBg.eventMode = "none";
          rowBg.rect(0, 0, contentW, FRIEND_ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
          row.addChild(rowBg);
        }

        const isAccepted = friend.status === "accepted";
        const dot = new Graphics();
        dot.eventMode = "none";
        dot.circle(0, 0, 4);
        dot.fill({ color: isAccepted ? ONLINE_COLOR : MUTED_TEXT });
        dot.x = ROW_PADDING_X + 4;
        dot.y = FRIEND_ROW_HEIGHT / 2;
        row.addChild(dot);

        const textX = ROW_PADDING_X + 16;
        const nodeIdText = new Text({
          text: truncate(friend.nodeId, 20),
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: TEXT_COLOR },
          resolution: RESOLUTION,
        });
        nodeIdText.eventMode = "none";
        nodeIdText.x = textX;
        nodeIdText.y = 6;
        row.addChild(nodeIdText);

        const statusText = new Text({
          text: friend.status,
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        statusText.eventMode = "none";
        statusText.x = textX;
        statusText.y = 22;
        row.addChild(statusText);

        const removing = removeInFlight.has(friend.nodeId);
        const removeBtn = buildOutlinedButton({
          label: removing ? "\u2026" : "remove",
          width: REMOVE_BTN_W,
          height: REMOVE_BTN_H,
          color: REJECT_COLOR,
          disabled: removing,
          onTap: () => {
            handleRemove(friend.nodeId).catch(() => {});
          },
        });
        removeBtn.x = contentW - REMOVE_BTN_W - ROW_PADDING_X;
        removeBtn.y = (FRIEND_ROW_HEIGHT - REMOVE_BTN_H) / 2;
        row.addChild(removeBtn);

        dy += FRIEND_ROW_HEIGHT;
      }
      dy += SECTION_GAP - 8;
    }

    // -- pending knocks section (read-only) --

    const sep = new Graphics();
    sep.moveTo(PADDING_X, dy);
    sep.lineTo(contentW - PADDING_X, dy);
    sep.stroke({ color: BORDER, width: 1, alpha: 0.5 });
    inner.addChild(sep);
    dy += 12;

    const knocksLabel = new Text({
      text: `pending knocks (${state.pendingKnocks.length})`,
      style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
      resolution: RESOLUTION,
    });
    knocksLabel.eventMode = "none";
    knocksLabel.x = PADDING_X;
    knocksLabel.y = dy;
    inner.addChild(knocksLabel);
    dy += LABEL_SIZE + 4;

    const knocksHint = new Text({
      text: "read-only \u2014 approve/decline from the requester's canvas instead",
      style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    knocksHint.eventMode = "none";
    knocksHint.x = PADDING_X;
    knocksHint.y = dy;
    inner.addChild(knocksHint);
    dy += knocksHint.height + 8;

    if (state.pendingKnocks.length === 0) {
      const emptyKnocksText = new Text({
        text: "no pending knocks",
        style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      emptyKnocksText.eventMode = "none";
      emptyKnocksText.x = PADDING_X;
      emptyKnocksText.y = dy;
      inner.addChild(emptyKnocksText);
      dy += emptyKnocksText.height + SECTION_GAP;
    } else {
      for (let i = 0; i < state.pendingKnocks.length; i++) {
        const knock = state.pendingKnocks[i];
        const row = new Container();
        row.eventMode = "none";
        row.y = dy;
        inner.addChild(row);

        if (i % 2 === 1) {
          const rowBg = new Graphics();
          rowBg.eventMode = "none";
          rowBg.rect(0, 0, contentW, KNOCK_ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
          row.addChild(rowBg);
        }

        const usernameText = new Text({
          text: knock.requesterUsername || truncate(knock.requesterNodeId, 20),
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fontWeight: "bold", fill: TEXT_COLOR },
          resolution: RESOLUTION,
        });
        usernameText.eventMode = "none";
        usernameText.x = ROW_PADDING_X;
        usernameText.y = 4;
        row.addChild(usernameText);

        const canvasText = new Text({
          text: `canvas: ${truncate(knock.canvasDocId, 24)}`,
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        canvasText.eventMode = "none";
        canvasText.x = ROW_PADDING_X;
        canvasText.y = 20;
        row.addChild(canvasText);

        const messageText = new Text({
          text: truncate(knock.message, 60),
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        messageText.eventMode = "none";
        messageText.x = ROW_PADDING_X;
        messageText.y = 34;
        row.addChild(messageText);

        const knockedAtText = new Text({
          text: new Date(knock.knockedAt * 1000).toLocaleString(),
          style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        knockedAtText.eventMode = "none";
        knockedAtText.x = ROW_PADDING_X;
        knockedAtText.y = 50;
        row.addChild(knockedAtText);

        dy += KNOCK_ROW_HEIGHT;
      }
    }

    finishLayout(dy);
  }

  function finishLayout(contentHeight: number): void {
    totalHeight = contentHeight;
    clampScroll();
    inner.y = -scrollY;
  }

  // -- public interface -----------------------------------------------------

  function layout(width: number, height: number): void {
    currentWidth = width;
    areaHeight = height;

    mask.clear();
    mask.rect(0, 0, width, height);
    mask.fill({ color: BG, alpha: 0.001 });

    rebuild();
  }

  function getState(): HubProfilePanelState {
    return state;
  }

  function destroy(): void {
    destroyed = true;
    if (allowInputHandle) {
      allowInputHandle.destroy();
      allowInputHandle = null;
    }
    root.destroy({ children: true });
  }

  refresh().catch((err) => {
    log.warn(TAG, "initial refresh failed:", err);
  });

  return { container, layout, refresh, getState, destroy };
}
