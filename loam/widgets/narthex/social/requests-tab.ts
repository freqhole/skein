// ---------------------------------------------------------------------------
// requests tab — incoming and outbound friend requests
// ---------------------------------------------------------------------------

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { log } from "@freqhole/reliquary/utils";
import {
  acceptFriendRequest,
  isOnline as bridgeIsOnline,
  isKnownHubNodeId,
  recordFriendRequestOutcome,
  rejectFriendRequest,
  requestProfile,
} from "../../../src/p2p/friendz-bridge";
import {
  ACCEPT_COLOR,
  ACTION_BTN_SIZE,
  FONT,
  LABEL_SIZE,
  MUTED_TEXT,
  REJECT_COLOR,
  REQUEST_ROW_HEIGHT,
  REQUEST_ROW_HEIGHT_BIO,
  RESOLUTION,
  ROW_ALT_BG,
  ROW_AVATAR_SIZE,
  ROW_NAME_SIZE,
  ROW_PADDING_X,
  ROW_SUB_SIZE,
  SCROLL_SPEED,
  TEXT_COLOR,
} from "./constants";
import { renderAvatar } from "./avatar-renderer";
import { truncate } from "./helpers";
import type {
  FriendEntry,
  FriendNodeId,
  OutboundFriendRequest,
  PendingFriendRequest,
} from "./schema";
import type { TabContext, TabController } from "./types";

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export function createRequestsTab(ctx: TabContext): TabController {
  const container = new Container();
  container.eventMode = "static";

  // scrollable inner layer
  const inner = new Container();
  inner.eventMode = "static";
  container.addChild(inner);

  // mask — keeps content clipped to the content area
  const mask = new Graphics();
  container.addChild(mask);
  container.mask = mask;

  // empty state text
  const emptyText = new Text({
    text: "no pending requests",
    style: { fontFamily: FONT, fontSize: 11, fill: MUTED_TEXT },
    resolution: RESOLUTION,
  });
  emptyText.eventMode = "none";
  emptyText.visible = false;
  container.addChild(emptyText);

  let contentW = 0;
  let areaHeight = 0;
  let totalHeight = 0;
  let scrollY = 0;

  // -- scroll helpers -------------------------------------------------------

  const clampScroll = () => {
    const max = Math.max(0, totalHeight - areaHeight);
    scrollY = Math.max(0, Math.min(scrollY, max));
  };

  const positionInner = () => {
    inner.y = -scrollY;
  };

  container.on("wheel", (e: WheelEvent) => {
    const canScroll = totalHeight > areaHeight;
    if (!canScroll) return; // let the event pass through to the canvas viewport

    e.stopPropagation();
    if ((e as any).nativeEvent) (e as any).nativeEvent._skeinWidgetScroll = true;
    scrollY += e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED;
    clampScroll();
    positionInner();
  });

  // -- rebuild --------------------------------------------------------------

  const rebuild = () => {
    // tear down previous rows
    while (inner.children.length > 0) {
      inner.removeChildAt(0).destroy({ children: true });
    }

    const state = ctx.doc.current;
    const pending: PendingFriendRequest[] = (state.pendingRequests ?? []).filter(
      (r: PendingFriendRequest) => r.status === "pending"
    );
    const outbound: OutboundFriendRequest[] = state.outboundRequests ?? [];
    const pendingOutbound = outbound.filter((r) => r.status === "pending");
    const nonPendingOutbound = outbound.filter((r) => r.status !== "pending");

    const hasContent =
      pending.length > 0 || pendingOutbound.length > 0 || nonPendingOutbound.length > 0;
    emptyText.visible = !hasContent;
    if (!hasContent) {
      emptyText.x = Math.max(0, (contentW - emptyText.width) / 2);
      emptyText.y = 20;
      totalHeight = 0;
      scrollY = 0;
      positionInner();
      return;
    }

    // -- incoming pending requests ------------------------------------------

    let incomingCursorY = 0;

    for (let i = 0; i < pending.length; i++) {
      const request = pending[i];
      const bio = request.fromBio;
      const effectiveRowHeight = bio ? REQUEST_ROW_HEIGHT_BIO : REQUEST_ROW_HEIGHT;
      const rowY = incomingCursorY;
      incomingCursorY += effectiveRowHeight;

      const row = new Container();
      row.eventMode = "static";
      row.y = rowY;
      inner.addChild(row);

      // alternating bg
      if (i % 2 === 1) {
        const rowBg = new Graphics();
        rowBg.eventMode = "none";
        rowBg.rect(0, 0, contentW, effectiveRowHeight);
        rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
        row.addChild(rowBg);
      }

      // avatar circle, async image overlay, and online/offline status dot
      const displayName = request.fromUsername || request.fromNodeId.slice(0, 8);
      const avatarX = ROW_PADDING_X + ROW_AVATAR_SIZE / 2;
      const avatarY = effectiveRowHeight / 2;

      renderAvatar({
        parent: row,
        cacheKey: `request-avatar-${request.fromNodeId}`,
        centerX: avatarX,
        centerY: avatarY,
        size: ROW_AVATAR_SIZE,
        displayName,
        colorSeed: i,
        avatarUrl: request.fromAvatarDataUrl,
        online: bridgeIsOnline(request.fromNodeId),
      });

      // name
      const textX = ROW_PADDING_X + ROW_AVATAR_SIZE + ROW_PADDING_X;
      const maxNameChars = Math.max(
        6,
        Math.floor((contentW - textX - ACTION_BTN_SIZE * 2 - 24) / (ROW_NAME_SIZE * 0.55))
      );
      const nameLabel = request.fromUsername
        ? truncate(request.fromUsername, maxNameChars)
        : truncate(request.fromNodeId, maxNameChars);

      const nameText = new Text({
        text: nameLabel,
        style: {
          fontFamily: FONT,
          fontSize: ROW_NAME_SIZE,
          fontWeight: "bold",
          fill: TEXT_COLOR,
        },
        resolution: RESOLUTION,
      });
      nameText.eventMode = "none";
      nameText.x = textX;
      nameText.y = 8;
      row.addChild(nameText);

      // received at
      const receivedLabel = request.receivedAt
        ? new Date(request.receivedAt).toLocaleDateString()
        : "";
      if (receivedLabel) {
        const subText = new Text({
          text: receivedLabel,
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        subText.eventMode = "none";
        subText.x = textX;
        subText.y = 28;
        row.addChild(subText);
      }

      // bio line — shown truncated when there's room (a taller row, see
      // effectiveRowHeight above)
      if (bio) {
        const maxBioChars = Math.max(
          10,
          Math.floor((contentW - textX - ROW_PADDING_X - 20) / (ROW_SUB_SIZE * 0.55))
        );
        const bioText = new Text({
          text: truncate(bio, maxBioChars),
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        bioText.eventMode = "none";
        bioText.x = textX;
        bioText.y = 44;
        row.addChild(bioText);
      }

      // accept button (outlined rounded rect with label)
      const acceptW = 52;
      const acceptH = 22;
      const acceptBtn = new Container();
      acceptBtn.eventMode = "static";
      acceptBtn.cursor = "pointer";
      acceptBtn.hitArea = new Rectangle(0, 0, acceptW, acceptH);
      acceptBtn.x = contentW - acceptW - 52 - ROW_PADDING_X - 4;
      acceptBtn.y = (effectiveRowHeight - acceptH) / 2;

      const acceptBg = new Graphics();
      acceptBg.eventMode = "none";
      acceptBg.roundRect(0, 0, acceptW, acceptH, 4);
      acceptBg.fill({ color: 0x111118 });
      acceptBg.stroke({ color: ACCEPT_COLOR, width: 1.5 });
      acceptBtn.addChild(acceptBg);

      const acceptLabel = new Text({
        text: "accept",
        style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: ACCEPT_COLOR },
        resolution: RESOLUTION,
      });
      acceptLabel.eventMode = "none";
      acceptLabel.anchor.set(0.5);
      acceptLabel.x = acceptW / 2;
      acceptLabel.y = acceptH / 2;
      acceptBtn.addChild(acceptLabel);

      acceptBtn.on("pointertap", (e) => {
        e.stopPropagation();
        acceptFriendRequest(request.fromNodeId).catch((err) => {
          log.warn("social.requests", "failed to accept friend request:", err);
        });
        // relay the outcome back to the requester in case they're offline
        // right now - see recordFriendRequestOutcome's doc comment.
        const myProfile = ctx.doc.current.profile;
        recordFriendRequestOutcome(ctx.doc, {
          fromNodeId: request.fromNodeId,
          resolverNodeId: myProfile.nodeId,
          outcome: "accepted",
          resolverUsername: myProfile.username,
          resolverBio: myProfile.bio,
          resolverAvatarDataUrl: myProfile.avatarDataUrl,
          resolverAccentColor: myProfile.accentColor,
          expiresAt: request.expiresAt,
        });
        ctx.doc.change((draft) => {
          const req = draft.pendingRequests.find(
            (r: PendingFriendRequest) =>
              r.fromNodeId === request.fromNodeId && r.status === "pending"
          );
          if (req) req.status = "accepted-pending-ack";

          // add to friends list if not already present
          const exists = draft.friends.some((f: FriendEntry) =>
            f.nodeIds.some((n: FriendNodeId) => n.nodeId === request.fromNodeId)
          );
          if (!exists) {
            draft.friends.push({
              id: crypto.randomUUID(),
              alias: "",
              username: request.fromUsername,
              group: "",
              nodeIds: [
                {
                  nodeId: request.fromNodeId,
                  addedAt: new Date().toISOString(),
                  lastSeenAt: "",
                  username: request.fromUsername,
                  bio: request.fromBio ?? "",
                  avatarDataUrl: request.fromAvatarDataUrl ?? "",
                  profileDocId: "",
                  profileUpdatedAt: "",
                },
              ],
              createdAt: new Date().toISOString(),
              // this manual "accept" click builds a FriendEntry from the
              // locally-stored pendingRequest, which has no isHub field of
              // its own (unlike the message-arrival path in
              // friendz-wiring.ts's wireFriendHandlers()) — defaults false,
              // same as every other manual-add site.
              isHub: false,
            });
          }
        });
        // immediately fetch profile from the accepted friend and announce
        // our presence so they see us online right away
        requestProfile(request.fromNodeId).catch(() => {});
      });
      row.addChild(acceptBtn);

      // reject button (outlined rounded rect with label)
      const rejectW = 52;
      const rejectH = 22;
      const rejectBtn = new Container();
      rejectBtn.eventMode = "static";
      rejectBtn.cursor = "pointer";
      rejectBtn.hitArea = new Rectangle(0, 0, rejectW, rejectH);
      rejectBtn.x = contentW - rejectW - ROW_PADDING_X;
      rejectBtn.y = (effectiveRowHeight - rejectH) / 2;

      const rejectBg = new Graphics();
      rejectBg.eventMode = "none";
      rejectBg.roundRect(0, 0, rejectW, rejectH, 4);
      rejectBg.fill({ color: 0x111118 });
      rejectBg.stroke({ color: REJECT_COLOR, width: 1.5 });
      rejectBtn.addChild(rejectBg);

      const rejectLabel = new Text({
        text: "reject",
        style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: REJECT_COLOR },
        resolution: RESOLUTION,
      });
      rejectLabel.eventMode = "none";
      rejectLabel.anchor.set(0.5);
      rejectLabel.x = rejectW / 2;
      rejectLabel.y = rejectH / 2;
      rejectBtn.addChild(rejectLabel);

      rejectBtn.on("pointertap", (e) => {
        e.stopPropagation();
        rejectFriendRequest(request.fromNodeId).catch((err) => {
          log.warn("social.requests", "failed to reject friend request:", err);
        });
        // relay the outcome back to the requester in case they're offline
        // right now - see recordFriendRequestOutcome's doc comment.
        const myProfile = ctx.doc.current.profile;
        recordFriendRequestOutcome(ctx.doc, {
          fromNodeId: request.fromNodeId,
          resolverNodeId: myProfile.nodeId,
          outcome: "rejected",
          resolverUsername: myProfile.username,
          expiresAt: request.expiresAt,
        });
        ctx.doc.change((draft) => {
          const req = draft.pendingRequests.find(
            (r: PendingFriendRequest) =>
              r.fromNodeId === request.fromNodeId && r.status === "pending"
          );
          if (req) req.status = "rejected";
        });
      });
      row.addChild(rejectBtn);
    }

    // -- outbound pending requests ------------------------------------------

    let cursorY = incomingCursorY;

    if (pendingOutbound.length > 0) {
      // "sent requests" section label
      const sentLabel = new Text({
        text: "sent requests",
        style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      sentLabel.eventMode = "none";
      sentLabel.x = ROW_PADDING_X;
      sentLabel.y = cursorY + 4;
      inner.addChild(sentLabel);

      const labelHeight = 20;

      for (let i = 0; i < pendingOutbound.length; i++) {
        const outReq = pendingOutbound[i];
        const rowY = cursorY + labelHeight + i * REQUEST_ROW_HEIGHT;

        const row = new Container();
        row.eventMode = "static";
        row.y = rowY;
        inner.addChild(row);

        // alternating bg
        if (i % 2 === 1) {
          const rowBg = new Graphics();
          rowBg.eventMode = "none";
          rowBg.rect(0, 0, contentW, REQUEST_ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
          row.addChild(rowBg);
        }

        // avatar circle, async image overlay, and online/offline status dot
        // (no bio here — outboundFriendRequestSchema doesn't carry one, only
        // a username + avatar, both filled in once known via a
        // profile-response/identity-update from the recipient)
        const displayName = outReq.toUsername || outReq.toNodeId.slice(0, 8);
        const avatarX = ROW_PADDING_X + ROW_AVATAR_SIZE / 2;
        const avatarY = REQUEST_ROW_HEIGHT / 2;

        renderAvatar({
          parent: row,
          cacheKey: `outbound-request-avatar-${outReq.toNodeId}`,
          centerX: avatarX,
          centerY: avatarY,
          size: ROW_AVATAR_SIZE,
          displayName,
          avatarUrl: outReq.toAvatarDataUrl || undefined,
          colorSeed: pending.length + i,
          online: bridgeIsOnline(outReq.toNodeId),
        });

        // name + "pending..." status
        const textX = ROW_PADDING_X + ROW_AVATAR_SIZE + ROW_PADDING_X;

        const nameText = new Text({
          text: truncate(outReq.toUsername || truncate(outReq.toNodeId, 19), 20),
          style: {
            fontFamily: FONT,
            fontSize: ROW_NAME_SIZE,
            fontWeight: "bold",
            fill: TEXT_COLOR,
          },
          resolution: RESOLUTION,
        });
        nameText.eventMode = "none";
        nameText.x = textX;
        nameText.y = 8;
        row.addChild(nameText);

        const statusText = new Text({
          // labeled "pending... · hub" instead of plain "pending..." when
          // this outbound request's target is a known share-link hub
          // (recorded via `recordKnownHubNodeIds()`, friendz-bridge.ts) —
          // mirrors friends-tab.ts's own "pending · hub" badge, so a canvas
          // share that sends requests to both the owner AND a hub shows
          // which row is which instead of looking like an unexplained
          // duplicate.
          text: isKnownHubNodeId(outReq.toNodeId) ? "pending\u2026 \u00b7 hub" : "pending\u2026",
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        statusText.eventMode = "none";
        statusText.x = textX;
        statusText.y = 28;
        row.addChild(statusText);

        // cancel button
        const cancelBtn = new Container();
        cancelBtn.eventMode = "static";
        cancelBtn.cursor = "pointer";
        cancelBtn.hitArea = new Rectangle(0, 0, ACTION_BTN_SIZE, ACTION_BTN_SIZE);
        cancelBtn.x = contentW - ACTION_BTN_SIZE - ROW_PADDING_X;
        cancelBtn.y = (REQUEST_ROW_HEIGHT - ACTION_BTN_SIZE) / 2;

        const cancelBg = new Graphics();
        cancelBg.eventMode = "none";
        cancelBg.circle(ACTION_BTN_SIZE / 2, ACTION_BTN_SIZE / 2, ACTION_BTN_SIZE / 2);
        cancelBg.fill({ color: MUTED_TEXT });
        cancelBtn.addChild(cancelBg);

        const cancelIcon = new Text({
          text: "\u00d7",
          style: { fontFamily: FONT, fontSize: 14, fontWeight: "bold", fill: 0xffffff },
          resolution: RESOLUTION,
        });
        cancelIcon.eventMode = "none";
        cancelIcon.anchor.set(0.5);
        cancelIcon.x = ACTION_BTN_SIZE / 2;
        cancelIcon.y = ACTION_BTN_SIZE / 2;
        cancelBtn.addChild(cancelIcon);

        const outReqNodeId = outReq.toNodeId;
        cancelBtn.on("pointertap", (e: any) => {
          e.stopPropagation();
          ctx.doc.change((draft: any) => {
            const idx = draft.outboundRequests.findIndex(
              (r: any) => r.toNodeId === outReqNodeId && r.status === "pending"
            );
            if (idx !== -1) {
              draft.outboundRequests.splice(idx, 1);
            }
          });
        });
        row.addChild(cancelBtn);
      }

      cursorY += labelHeight + pendingOutbound.length * REQUEST_ROW_HEIGHT;
    }

    totalHeight = cursorY;

    // -- "clear resolved" button for non-pending outbound requests ----------

    if (nonPendingOutbound.length > 0) {
      const clearBtn = new Container();
      clearBtn.eventMode = "static";
      clearBtn.cursor = "pointer";

      const clearText = new Text({
        text: "clear resolved",
        style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      clearText.eventMode = "none";
      clearBtn.addChild(clearText);
      clearBtn.hitArea = new Rectangle(0, 0, clearText.width + 8, clearText.height + 8);
      clearBtn.x = ROW_PADDING_X;
      clearBtn.y = cursorY + 4;

      clearBtn.on("pointertap", (e) => {
        e.stopPropagation();
        ctx.doc.change((draft: any) => {
          draft.outboundRequests = draft.outboundRequests.filter(
            (r: any) => r.status === "pending"
          );
        });
      });

      inner.addChild(clearBtn);
      totalHeight = cursorY + 4 + clearText.height + 12;
    }

    clampScroll();
    positionInner();
  };

  // -- doc change subscription ----------------------------------------------

  const unsub = ctx.doc.on("change", () => {
    const state = ctx.doc.current;
    const pendingCount = (state.pendingRequests ?? []).filter(
      (r: any) => r.status === "pending"
    ).length;
    const outboundCount = (state.outboundRequests ?? []).filter(
      (r: any) => r.status === "pending"
    ).length;
    log.debug(
      "social.requests",
      "doc change — pending=" + pendingCount + " outbound=" + outboundCount
    );
    rebuild();
  });

  // -- public interface -----------------------------------------------------

  const layout = (width: number, height: number) => {
    contentW = width;
    areaHeight = height;

    // update mask to match content area
    mask.clear();
    mask.rect(0, 0, width, height);
    mask.fill({ color: 0xffffff });

    rebuild();
  };

  const destroy = () => {
    unsub();
    container.destroy({ children: true });
  };

  return { container, layout, destroy };
}
