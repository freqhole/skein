/**
 * share dialog for the skein canvas app.
 *
 * uses @pixi/ui Dialog for the modal (backdrop, centering, button layout)
 * and a DOM <input readonly> overlay for the share URL field so the user
 * gets native text selection and clipboard support.
 *
 * everything else (labels, copy buttons, panel background) is pure pixi.
 */

import { ButtonContainer, Dialog, FancyButton } from "@pixi/ui";
import { Container, Graphics, Text, type Application } from "pixi.js";
import type { CanvasRole, InvitableRole } from "./canvas-doc";
import type { SkeinTheme } from "../theme/skein-theme";
import { log } from "@freqhole/reliquary/utils";
import { renderAvatar } from "../../widgets/narthex/social/avatar-renderer";
import { truncate } from "../../widgets/narthex/social/helpers";

const TAG = "canvas.share";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface FriendInfo {
  friendId: string;
  username: string;
  nodeId: string;
  avatarDataUrl?: string;
  isOnline: boolean;
  /** truncated and shown under the username, when there's room on the row. */
  bio?: string;
  /** true if this friend is a known reliquary hub (see docs/hub-and-profile-plan.md). */
  isHub?: boolean;
  /** true if this is still an in-progress friend request (inbound or
   *  outbound), not yet a confirmed friend — see
   *  docs/hub-and-profile-plan.md section 10.1. shown with a "(pending)"
   *  marker so the invite is honest about the relationship's state, but
   *  still invitable (the invite-write path tolerates unconfirmed
   *  friendship gracefully). */
  isPending?: boolean;
}

export interface ShareDialogOptions {
  app: Application;
  theme: SkeinTheme;
  shareUrl: string;
  /** list of peer node IDs this canvas is shared with (from canvas doc) */
  peers?: Array<{
    nodeId: string;
    joinedAt: string;
    role?: CanvasRole;
    avatarDataUrl?: string;
    isOnline?: boolean;
    /** truncated and shown under the peer's name, when known — same
     *  treatment as FriendInfo.bio. */
    bio?: string;
  }>;
  /** called when user clicks "remove" on a peer */
  onRemovePeer?: (nodeId: string) => void;
  /** called when user clicks "add friend" on a peer — sends a friend request */
  onAddFriend?: (nodeId: string) => void | Promise<void>;
  /**
   * node ids the local peer already considers a friend (any accepted
   * entry from the social doc's `friends` list, across all of a friend's
   * `nodeIds`) — used to suppress the "friend" button for a peer row that's
   * already a friend. without this, the button rendered unconditionally
   * for every peer whenever `onAddFriend` was provided, even ones already
   * friended (a real reported bug). omit/leave empty if unknown — the
   * button then falls back to its old always-shown-when-provided behavior
   * for that row.
   */
  knownFriendNodeIds?: string[] | Set<string>;
  /** called when the user changes an already-invited peer's role via the role toggle */
  onChangeRole?: (nodeId: string, role: InvitableRole) => void;
  /** list of friends who haven't been invited to this canvas yet */
  friends?: FriendInfo[];
  /** called when user clicks "invite" on a friend row — sends canvas-invite with the chosen role */
  onInviteFriend?: (friend: FriendInfo, role: InvitableRole) => void | Promise<void>;
  onClose?: () => void;
  /** optional map of nodeId -> display name for resolving peer names from friends list */
  peerDisplayNames?: Map<string, string>;
  /** pending invites on this canvas (from canvas doc pendingInvites) */
  pendingInvites?: Array<{
    targetNodeId: string;
    invite: {
      invitedBy: string;
      invitedByUsername: string;
      role: string;
      invitedAt: string;
      /** true once the owner received an accept message — target hasn't
       *  necessarily connected yet, see PendingCanvasInvite in canvas-doc.ts */
      accepted?: boolean;
      acceptedAt?: string;
    };
  }>;
  /** callback when user cancels a pending invite */
  onCancelInvite?: (targetNodeId: string) => void;
  /** declined invites (from messagez outbox shares where declined === true) */
  declinedInvites?: Array<{
    toNodeId: string;
    toUsername: string;
    canvasTitle: string;
    sentAt: string;
  }>;
  /**
   * non-admin (member/viewer) mode: hides the "invite friends"/"hub
   * nodes" sections and the "declined" section entirely — only the share
   * URL, "shared with", and "pending invites" remain, and without any of
   * the mutating action callbacks (the caller should also omit
   * onRemovePeer/onChangeRole/onAddFriend/onInviteFriend/onCancelInvite in
   * this mode; this flag only controls which *sections* render). the
   * share URL row itself is always shown, admin or not — anyone shared
   * with a canvas may reasonably want to re-share/copy the link.
   * defaults to false (the full admin dialog).
   */
  readOnly?: boolean;
  /**
   * node ids of hubs this canvas has been explicitly shared with (from
   * canvas doc's `hubNodeIds`) — when non-empty, a small toggle row is
   * shown letting the sharer opt out of including them in the link.
   * omit/leave empty to hide the toggle entirely (no hubs to offer).
   */
  hubNodeIds?: string[];
  /**
   * whether `hubNodeIds` are currently included in `shareUrl` — reflects
   * the toggle's on/off state. only meaningful (and only rendered) when
   * `hubNodeIds` is non-empty. defaults to true (include by default) when
   * omitted.
   */
  includeHubsInLink?: boolean;
  /**
   * called when the user flips the "include hub(s) in link" toggle — the
   * caller is expected to recompute `shareUrl` accordingly and rebuild the
   * dialog with the new options.
   */
  onToggleIncludeHubs?: (include: boolean) => void;
}

export interface ShareDialogHandle {
  remove(): void;
  /**
   * dev/test-only: the rendered display-name text for a friend-invite row
   * (regular or hub section), by node id, or null if that friend isn't
   * currently rendered. proves the actual rendered row content reflects
   * the right peer, not just that the right `FriendInfo` was passed in —
   * see docs/hub-and-profile-plan.md section 10.3.
   */
  getFriendRowText(nodeId: string): string | null;
}

/**
 * split a friend-invite list into the regular "invite friends" group and the
 * "hub nodes" group, per `FriendInfo.isHub` — mirrors the grouping rule
 * `friends-tab.ts`'s `HUB_GROUP_KEY` section uses (see
 * docs/hub-and-profile-plan.md section 4), just without the collapse/
 * reserved-key machinery since this list is never dragged into. exported so
 * tests can verify the grouping directly against real friend data, without
 * needing to inspect rendered pixi rows.
 */
export function splitFriendsForInvite(friends: FriendInfo[]): {
  regular: FriendInfo[];
  hub: FriendInfo[];
} {
  return {
    regular: friends.filter((f) => !f.isHub),
    hub: friends.filter((f) => f.isHub),
  };
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const DIALOG_WIDTH = 480;
const DIALOG_PADDING = 20;
const SECTION_GAP = 16;
const LABEL_GAP = 6;
const INPUT_HEIGHT = 28;
const BUTTON_PAD_H = 14;
const BUTTON_PAD_V = 6;
const COPY_FEEDBACK_MS = 1500;
const DIALOG_Z = 10002;
const DOM_Z = "10003";
// extra row height given to a friend-invite row when it also shows a
// truncated bio line underneath the name (see buildFriendInviteRow).
const FRIEND_ROW_BIO_EXTRA = 14;
// action buttons/toggles in a row (buildPeerRow, buildFriendInviteRow) are
// laid out right-to-left with a single running cursor, starting this many
// px in from the row's right edge, with exactly ROW_GAP between every
// adjacent pair — using each element's *actual* measured width (rather
// than a flat per-slot increment) is what keeps the gaps uniform no
// matter which combination of buttons/labels a given row shows.
const ROW_RIGHT_MARGIN = 8;
const ROW_GAP = 10;

// ---------------------------------------------------------------------------
// helpers — pixi
// ---------------------------------------------------------------------------

function makeLabel(text: string, theme: SkeinTheme): Text {
  const t = new Text({
    text,
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: theme.frameHeaderText,
    },
    resolution: theme.textResolution,
  });
  t.eventMode = "none";
  return t;
}

/** measure how wide a one-off Text with the row's small font would render,
 *  without adding it to the display list — used to size the "remove" and
 *  "invite" buttons (in buildPeerRow / buildFriendInviteRow respectively)
 *  to the same fixed width, so they line up across sections instead of
 *  each hugging its own (slightly different) label width. */
function measureTextWidth(text: string, theme: SkeinTheme): number {
  const probe = new Text({
    text,
    style: { fontFamily: theme.fontFamily, fontSize: theme.fontSizeSmall },
    resolution: theme.textResolution,
  });
  const width = probe.width;
  probe.destroy();
  return width;
}

function makeCopyButton(theme: SkeinTheme): {
  btn: ButtonContainer;
  bg: Graphics;
  text: Text;
  width: number;
  height: number;
} {
  const text = new Text({
    text: "copy",
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: 0xffffff,
    },
    resolution: theme.textResolution,
  });
  text.eventMode = "none";

  const bg = new Graphics();
  const width = text.width + BUTTON_PAD_H * 2;
  const height = text.height + BUTTON_PAD_V * 2;
  bg.roundRect(0, 0, width, height, 4);
  bg.fill({ color: theme.accent });

  const view = new Container();
  view.addChild(bg);
  text.x = BUTTON_PAD_H;
  text.y = BUTTON_PAD_V;
  view.addChild(text);

  const btn = new ButtonContainer(view);
  btn.cursor = "pointer";

  return { btn, bg, text, width, height };
}

/** redraw a copy button background (used after text change) */
function redrawCopyBg(bg: Graphics, text: Text, height: number, color: number): void {
  const w = text.width + BUTTON_PAD_H * 2;
  bg.clear();
  bg.roundRect(0, 0, w, height, 4);
  bg.fill({ color });
}

/** wire a copy button to clipboard + "copied!" feedback */
function wireCopy(
  btn: ButtonContainer,
  bg: Graphics,
  text: Text,
  btnHeight: number,
  value: string,
  theme: SkeinTheme,
  isRemoved: () => boolean
): void {
  btn.onPress.connect(() => {
    navigator.clipboard.writeText(value).then(
      () => {
        text.text = "copied!";
        redrawCopyBg(bg, text, btnHeight, theme.accent);
        setTimeout(() => {
          if (isRemoved()) return;
          text.text = "copy";
          redrawCopyBg(bg, text, btnHeight, theme.accent);
        }, COPY_FEEDBACK_MS);
      },
      () => {
        log.debug(TAG, "copy failed:", value.slice(0, 32) + "...");
      }
    );
  });
}

// ---------------------------------------------------------------------------
// helpers — role toggle
// ---------------------------------------------------------------------------

/** small pill button showing the current role — click cycles member <-> viewer. */
function buildRoleToggle(
  theme: SkeinTheme,
  initialRole: InvitableRole,
  onChange: (role: InvitableRole) => void
): { container: Container; width: number; height: number; setRole: (role: InvitableRole) => void } {
  let currentRole = initialRole;

  const text = new Text({
    text: currentRole,
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: 0xcbd5e1,
    },
    resolution: theme.textResolution,
  });
  text.eventMode = "none";

  const bg = new Graphics();

  const draw = () => {
    const w = Math.max(text.width, 44) + BUTTON_PAD_H * 2;
    const h = text.height + BUTTON_PAD_V * 2;
    bg.clear();
    bg.roundRect(0, 0, w, h, 4);
    bg.fill({ color: 0x27272a });
    bg.stroke({ color: 0x3f3f46, width: 1 });
    text.x = (w - text.width) / 2;
    text.y = BUTTON_PAD_V;
    return { w, h };
  };

  const view = new Container();
  view.addChild(bg);
  view.addChild(text);

  const btn = new ButtonContainer(view);
  btn.cursor = "pointer";

  const { w: width, h: height } = draw();

  const setRole = (role: InvitableRole) => {
    currentRole = role;
    text.text = currentRole;
    draw();
  };

  btn.onPress.connect(() => {
    setRole(currentRole === "member" ? "viewer" : "member");
    onChange(currentRole);
  });

  return { container: btn, width, height, setRole };
}

// ---------------------------------------------------------------------------
// helpers — peer row
// ---------------------------------------------------------------------------

function buildPeerRow(
  nodeId: string,
  _joinedAt: string,
  theme: SkeinTheme,
  scrollBoxWidth: number,
  copyBtnH: number,
  rowHeight: number,
  actionBtnWidth: number,
  isRemoved: () => boolean,
  onRemovePeer?: (nodeId: string) => void,
  onAddFriend?: (nodeId: string) => void | Promise<void>,
  displayName?: string,
  role?: CanvasRole,
  onChangeRole?: (nodeId: string, role: InvitableRole) => void,
  isAlreadyFriend?: boolean,
  avatarDataUrl?: string,
  isOnline?: boolean,
  bio?: string
): Container {
  const row = new Container();

  // defensive: coerce nodeId to string (automerge may return non-string from Rust peer writes)
  const safeNodeId = typeof nodeId === "string" ? nodeId : String((nodeId as unknown) ?? "unknown");
  if (safeNodeId !== nodeId) {
    log.warn(TAG, "buildPeerRow: coerced non-string nodeId:", typeof nodeId, nodeId);
  }

  // avatar circle with initial-letter fallback, async image overlay, and
  // an online/offline status dot — see avatar-renderer.ts.
  const avatarSize = Math.min(20, copyBtnH);
  const truncated = safeNodeId.slice(0, 8) + "..." + safeNodeId.slice(-8);
  renderAvatar({
    parent: row,
    cacheKey: `share-peer-avatar-${safeNodeId}`,
    centerX: avatarSize / 2,
    centerY: rowHeight / 2,
    size: avatarSize,
    displayName: displayName || truncated,
    colorSeed: 0,
    avatarUrl: avatarDataUrl,
    online: isOnline,
  });

  // peer display: show name if known, otherwise fall back to a truncated
  // node ID (only when nothing else identifies this peer) — node ids are
  // otherwise not shown at all here anymore (still copyable via the copy
  // button below).
  const label = displayName ? displayName : truncated;
  const idText = new Text({
    text: label,
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: theme.frameHeaderText,
      fontWeight: displayName ? "bold" : "normal",
    },
    resolution: theme.textResolution,
  });
  idText.eventMode = "none";
  idText.x = avatarSize + 8;
  idText.y = bio ? avatarSize / 2 - idText.height - 1 : (rowHeight - idText.height) / 2;
  row.addChild(idText);

  // bio, truncated — shown under the name when there's room (the row
  // grows a little taller for this, see the caller's per-row height calc),
  // same treatment as buildFriendInviteRow's bio line.
  if (bio) {
    const bioText = new Text({
      text: truncate(bio, 40),
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall - 1,
        fill: 0x6b7280,
      },
      resolution: theme.textResolution,
    });
    bioText.eventMode = "none";
    bioText.x = idText.x;
    bioText.y = idText.y + idText.height + 2;
    row.addChild(bioText);
  }

  // action buttons/toggle are laid out right-to-left with a single running
  // cursor and a uniform ROW_GAP between every adjacent pair, using each
  // element's *actual* measured width — order (right to left): remove ->
  // friend -> role toggle/admin label -> copy. the "friend" button only
  // applies when the peer genuinely isn't already a friend (see
  // isAlreadyFriend param / knownFriendNodeIds).
  const showFriendBtn = !!onAddFriend && !isAlreadyFriend;
  const showRoleToggle = !!onChangeRole && role !== "admin";
  const showAdminLabel = !showRoleToggle && role === "admin";

  let cursor = scrollBoxWidth - ROW_RIGHT_MARGIN;

  // remove button (if handler provided) — flush right
  if (onRemovePeer) {
    const removeBtnText = new Text({
      text: "remove",
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall,
        fill: 0xef4444,
      },
      resolution: theme.textResolution,
    });
    removeBtnText.eventMode = "none";

    const removeBtnBg = new Graphics();
    // fixed width (matches buildFriendInviteRow's "invite" button) so
    // remove/invite buttons line up across the dialog's sections instead
    // of each hugging its own label's width.
    const removeW = actionBtnWidth;
    const removeH = removeBtnText.height + 6 * 2;
    removeBtnBg.roundRect(0, 0, removeW, removeH, 4);
    removeBtnBg.fill({ color: 0x7f1d1d });

    const removeView = new Container();
    removeView.addChild(removeBtnBg);
    removeBtnText.x = 14;
    removeBtnText.y = 6;
    removeView.addChild(removeBtnText);

    const removeBtn = new ButtonContainer(removeView);
    removeBtn.cursor = "pointer";
    removeBtn.x = cursor - removeW;
    removeBtn.y = (rowHeight - removeH) / 2;
    row.addChild(removeBtn);
    cursor -= removeW + ROW_GAP;

    removeBtn.onPress.connect(() => {
      onRemovePeer(safeNodeId);
    });
  }

  // add friend button (if handler provided and not already a friend)
  if (showFriendBtn) {
    const friendBtnText = new Text({
      text: "friend",
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall,
        fill: 0xa78bfa,
      },
      resolution: theme.textResolution,
    });
    friendBtnText.eventMode = "none";

    const friendBtnBg = new Graphics();
    const friendW = friendBtnText.width + 14 * 2;
    const friendH = friendBtnText.height + 6 * 2;
    friendBtnBg.roundRect(0, 0, friendW, friendH, 4);
    friendBtnBg.fill({ color: 0x2e1065 });

    const friendView = new Container();
    friendView.addChild(friendBtnBg);
    friendBtnText.x = 14;
    friendBtnText.y = 6;
    friendView.addChild(friendBtnText);

    const friendBtn = new ButtonContainer(friendView);
    friendBtn.cursor = "pointer";

    friendBtn.x = cursor - friendW;
    friendBtn.y = (rowHeight - friendH) / 2;
    row.addChild(friendBtn);
    cursor -= friendW + ROW_GAP;

    friendBtn.onPress.connect(async () => {
      // show immediate feedback
      friendBtnText.text = "sending...";
      friendBtnBg.clear();
      const sendingW = friendBtnText.width + 14 * 2;
      friendBtnBg.roundRect(0, 0, sendingW, friendH, 4);
      friendBtnBg.fill({ color: 0x1e1b4b });

      try {
        await onAddFriend(safeNodeId);
        if (isRemoved()) return;
        friendBtnText.text = "sent!";
      } catch {
        if (isRemoved()) return;
        friendBtnText.text = "failed";
      }

      friendBtnBg.clear();
      const feedbackW = friendBtnText.width + 14 * 2;
      friendBtnBg.roundRect(0, 0, feedbackW, friendH, 4);
      friendBtnBg.fill({ color: 0x1e1b4b });

      setTimeout(() => {
        if (isRemoved()) return;
        friendBtnText.text = "friend";
        friendBtnBg.clear();
        friendBtnBg.roundRect(0, 0, friendW, friendH, 4);
        friendBtnBg.fill({ color: 0x2e1065 });
      }, 1500);
    });
  }

  // role toggle — shown for non-admin peers when a change handler is
  // provided, otherwise an "admin" label for admins. sits between the
  // friend/remove buttons and the copy button.
  if (showRoleToggle) {
    const toggle = buildRoleToggle(theme, role === "viewer" ? "viewer" : "member", (newRole) => {
      onChangeRole!(safeNodeId, newRole);
    });
    toggle.container.x = cursor - toggle.width;
    toggle.container.y = (rowHeight - toggle.height) / 2;
    row.addChild(toggle.container);
    cursor -= toggle.width + ROW_GAP;
  } else if (showAdminLabel) {
    const adminText = new Text({
      text: "admin",
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall,
        fill: 0x6b7280,
      },
      resolution: theme.textResolution,
    });
    adminText.eventMode = "none";
    adminText.x = cursor - adminText.width;
    adminText.y = (rowHeight - adminText.height) / 2;
    row.addChild(adminText);
    cursor -= adminText.width + ROW_GAP;
  }

  // copy button — copies full node ID; always the leftmost action element
  const copyBtn = makeCopyButton(theme);
  copyBtn.btn.x = cursor - copyBtn.width;
  copyBtn.btn.y = (rowHeight - copyBtn.height) / 2;
  row.addChild(copyBtn.btn);
  wireCopy(copyBtn.btn, copyBtn.bg, copyBtn.text, copyBtnH, safeNodeId, theme, isRemoved);

  return row;
}

// ---------------------------------------------------------------------------
// helpers — friend invite row
// ---------------------------------------------------------------------------

function buildFriendInviteRow(
  friend: FriendInfo,
  theme: SkeinTheme,
  scrollBoxWidth: number,
  rowHeight: number,
  actionBtnWidth: number,
  isRemoved: () => boolean,
  onInvite?: (friend: FriendInfo, role: InvitableRole) => void | Promise<void>
): { container: Container; nameText: Text } {
  const row = new Container();

  // avatar circle with initial-letter fallback, async image overlay, and
  // an online/offline status dot — see avatar-renderer.ts.
  const avatarSize = 22;
  const displayNameForAvatar = friend.username || friend.nodeId;
  renderAvatar({
    parent: row,
    cacheKey: `share-friend-avatar-${friend.nodeId}`,
    centerX: avatarSize / 2,
    centerY: rowHeight / 2,
    size: avatarSize,
    displayName: displayNameForAvatar,
    colorSeed: 0,
    avatarUrl: friend.avatarDataUrl,
    online: friend.isOnline,
  });

  // username text — a still-pending friend request gets a "(pending)"
  // suffix so the invite is honest about the relationship not being
  // confirmed yet (see docs/hub-and-profile-plan.md section 10.1), without
  // hiding the row entirely.
  const baseDisplayName = friend.username || friend.nodeId.slice(0, 12) + "...";
  const displayName = friend.isPending ? baseDisplayName + " (pending)" : baseDisplayName;
  const nameText = new Text({
    text: displayName,
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: friend.isPending ? 0x9ca3af : theme.frameHeaderText,
    },
    resolution: theme.textResolution,
  });
  nameText.eventMode = "none";
  nameText.x = avatarSize + 8;
  nameText.y = friend.bio ? avatarSize / 2 - nameText.height - 1 : (rowHeight - nameText.height) / 2;
  row.addChild(nameText);

  // bio, truncated — shown under the name when there's room (the row
  // grows a little taller for this, see the caller's per-row height calc)
  if (friend.bio) {
    const bioText = new Text({
      text: truncate(friend.bio, 40),
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall - 1,
        fill: 0x6b7280,
      },
      resolution: theme.textResolution,
    });
    bioText.eventMode = "none";
    bioText.x = avatarSize + 8;
    bioText.y = nameText.y + nameText.height + 2;
    row.addChild(bioText);
  }


  // role toggle — chooses member (default) or viewer before inviting.
  let selectedRole: InvitableRole = "member";
  const roleToggle = buildRoleToggle(theme, selectedRole, (role) => {
    selectedRole = role;
  });

  // invite button — right-aligned, role toggle sits just to its left
  const inviteBtnText = new Text({
    text: "invite",
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: 0x60a5fa,
    },
    resolution: theme.textResolution,
  });
  inviteBtnText.eventMode = "none";

  const inviteBtnBg = new Graphics();
  // fixed width (matches buildPeerRow's "remove" button) so remove/invite
  // buttons line up across the dialog's sections instead of each hugging
  // its own label's width.
  const inviteW = actionBtnWidth;
  const inviteH = inviteBtnText.height + 6 * 2;
  inviteBtnBg.roundRect(0, 0, inviteW, inviteH, 4);
  inviteBtnBg.fill({ color: 0x1e3a5f });

  const inviteView = new Container();
  inviteView.addChild(inviteBtnBg);
  inviteBtnText.x = 14;
  inviteBtnText.y = 6;
  inviteView.addChild(inviteBtnText);

  const inviteBtn = new ButtonContainer(inviteView);
  inviteBtn.cursor = "pointer";
  inviteBtn.x = scrollBoxWidth - inviteW - ROW_RIGHT_MARGIN;
  inviteBtn.y = (rowHeight - inviteH) / 2;
  row.addChild(inviteBtn);

  roleToggle.container.x = inviteBtn.x - roleToggle.width - ROW_GAP;
  roleToggle.container.y = (rowHeight - roleToggle.height) / 2;
  row.addChild(roleToggle.container);

  inviteBtn.onPress.connect(async () => {
    // show sending feedback
    inviteBtnText.text = "sending...";
    inviteBtnText.style.fill = 0x60a5fa;
    inviteBtnBg.clear();
    const sendingW = inviteBtnText.width + 14 * 2;
    inviteBtnBg.roundRect(0, 0, sendingW, inviteH, 4);
    inviteBtnBg.fill({ color: 0x1e1b4b });

    try {
      await onInvite?.(friend, selectedRole);
      if (isRemoved()) return;
      // success state
      inviteBtnText.text = "sent!";
      inviteBtnText.style.fill = 0x4ade80;
      inviteBtnBg.clear();
      const sentW = inviteBtnText.width + 14 * 2;
      inviteBtnBg.roundRect(0, 0, sentW, inviteH, 4);
      inviteBtnBg.fill({ color: 0x14532d });
    } catch {
      if (isRemoved()) return;
      // failure state
      inviteBtnText.text = "failed";
      inviteBtnText.style.fill = 0xef4444;
      inviteBtnBg.clear();
      const failW = inviteBtnText.width + 14 * 2;
      inviteBtnBg.roundRect(0, 0, failW, inviteH, 4);
      inviteBtnBg.fill({ color: 0x7f1d1d });
    }

    // revert to invite after delay
    setTimeout(() => {
      if (isRemoved()) return;
      inviteBtnText.text = "invite";
      inviteBtnText.style.fill = 0x60a5fa;
      inviteBtnBg.clear();
      inviteBtnBg.roundRect(0, 0, inviteW, inviteH, 4);
      inviteBtnBg.fill({ color: 0x1e3a5f });
    }, COPY_FEEDBACK_MS);
  });

  return { container: row, nameText };
}

// ---------------------------------------------------------------------------
// helpers — pending invite row
// ---------------------------------------------------------------------------

function buildPendingInviteRow(
  targetNodeId: string,
  invite: {
    invitedBy: string;
    invitedByUsername: string;
    role: string;
    invitedAt: string;
    accepted?: boolean;
    acceptedAt?: string;
  },
  theme: SkeinTheme,
  scrollBoxWidth: number,
  rowHeight: number,
  _isRemoved: () => boolean,
  onCancelInvite?: (targetNodeId: string) => void,
  displayName?: string
): Container {
  const row = new Container();

  // name or truncated node ID
  const truncated = targetNodeId.slice(0, 8) + "..." + targetNodeId.slice(-8);
  const label = displayName || truncated;
  const nameText = new Text({
    text: label,
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: theme.frameHeaderText,
      fontWeight: displayName ? "bold" : "normal",
    },
    resolution: theme.textResolution,
  });
  nameText.eventMode = "none";
  nameText.y = (rowHeight - nameText.height) / 2;
  row.addChild(nameText);

  // status subtitle — "accepted, connecting…" once the owner has received
  // an accept message, otherwise "invited [date]". this entry is only
  // removed once the peer actually shows up in `peers` (real connection),
  // not merely on accept — see PendingCanvasInvite in canvas-doc.ts.
  const invitedDate = invite.invitedAt ? new Date(invite.invitedAt).toLocaleDateString() : "";
  const statusText = invite.accepted
    ? "accepted, connecting…"
    : invitedDate
      ? `invited ${invitedDate}`
      : "invited";
  const dateText = new Text({
    text: statusText,
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall - 1,
      fill: invite.accepted ? 0x4ade80 : 0x6b7280,
    },
    resolution: theme.textResolution,
  });
  dateText.eventMode = "none";
  dateText.x = nameText.x + nameText.width + 8;
  dateText.y = (rowHeight - dateText.height) / 2;
  row.addChild(dateText);

  // cancel button
  if (onCancelInvite) {
    const cancelBtnText = new Text({
      text: "cancel",
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall,
        fill: 0xef4444,
      },
      resolution: theme.textResolution,
    });
    cancelBtnText.eventMode = "none";

    const cancelBtnBg = new Graphics();
    const cancelW = cancelBtnText.width + 14 * 2;
    const cancelH = cancelBtnText.height + 6 * 2;
    cancelBtnBg.roundRect(0, 0, cancelW, cancelH, 4);
    cancelBtnBg.fill({ color: 0x7f1d1d });

    const cancelView = new Container();
    cancelView.addChild(cancelBtnBg);
    cancelBtnText.x = 14;
    cancelBtnText.y = 6;
    cancelView.addChild(cancelBtnText);

    const cancelBtn = new ButtonContainer(cancelView);
    cancelBtn.cursor = "pointer";
    cancelBtn.x = scrollBoxWidth - cancelW;
    cancelBtn.y = (rowHeight - cancelH) / 2;
    row.addChild(cancelBtn);

    cancelBtn.onPress.connect(() => {
      onCancelInvite(targetNodeId);

      // visual feedback
      cancelBtnText.text = "cancelled";
      cancelBtnText.style.fill = 0x6b7280;
      cancelBtnBg.clear();
      const feedbackW = cancelBtnText.width + 14 * 2;
      cancelBtnBg.roundRect(0, 0, feedbackW, cancelH, 4);
      cancelBtnBg.fill({ color: 0x1f1f1f });
    });
  }

  return row;
}

// ---------------------------------------------------------------------------
// helpers — declined invite row
// ---------------------------------------------------------------------------

function buildDeclinedRow(
  toNodeId: string,
  toUsername: string,
  theme: SkeinTheme,
  _scrollBoxWidth: number,
  rowHeight: number,
  displayName?: string
): Container {
  const row = new Container();

  // name or truncated node ID
  const truncated = toNodeId.slice(0, 8) + "..." + toNodeId.slice(-8);
  const label = displayName || toUsername || truncated;
  const nameText = new Text({
    text: label,
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: theme.frameHeaderText,
    },
    resolution: theme.textResolution,
  });
  nameText.eventMode = "none";
  nameText.y = (rowHeight - nameText.height) / 2;
  row.addChild(nameText);

  // "declined" status label
  const statusText = new Text({
    text: "declined",
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: 0x6b7280,
    },
    resolution: theme.textResolution,
  });
  statusText.eventMode = "none";
  statusText.x = nameText.x + nameText.width + 8;
  statusText.y = (rowHeight - statusText.height) / 2;
  row.addChild(statusText);

  return row;
}

// ---------------------------------------------------------------------------
// helpers — DOM input overlays
// ---------------------------------------------------------------------------

/**
 * create a read-only DOM <input> positioned over a pixi placeholder container.
 * the input floats above the canvas with position: fixed so the user can
 * select and copy text natively.
 */
function createReadOnlyInput(
  placeholder: Container,
  canvasElement: HTMLCanvasElement,
  value: string,
  theme: SkeinTheme
): HTMLInputElement {
  const globalPos = placeholder.toGlobal({ x: 0, y: 0 });
  const globalEnd = placeholder.toGlobal({
    x: placeholder.width,
    y: placeholder.height,
  });
  const rect = canvasElement.getBoundingClientRect();

  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = value;
  input.autocomplete = "off";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("spellcheck", "false");

  const s = input.style;
  s.position = "fixed";
  s.left = `${rect.left + globalPos.x}px`;
  s.top = `${rect.top + globalPos.y}px`;
  s.width = `${globalEnd.x - globalPos.x}px`;
  s.height = `${globalEnd.y - globalPos.y}px`;
  s.fontFamily = theme.fontFamily;
  s.fontSize = `${theme.fontSizeSmall}px`;
  s.color = "#e0e0e0";
  s.background = "#0a0a0a";
  s.border = "1px solid #2a2a2a";
  s.borderRadius = "4px";
  s.padding = "0 8px";
  s.boxSizing = "border-box";
  s.outline = "none";
  s.zIndex = DOM_Z;

  document.body.appendChild(input);
  return input;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * show a share dialog using @pixi/ui Dialog with DOM input overlays
 * for the share string and share URL fields.
 *
 * dismisses on backdrop click, Escape, or the close button.
 */
export function showShareDialog(options: ShareDialogOptions): ShareDialogHandle {
  const { app, theme, shareUrl, onClose } = options;
  const readOnly = options.readOnly === true;
  const peerList = options.peers ?? [];

  let removed = false;
  const isRemoved = () => removed;
  const domInputs: HTMLInputElement[] = [];

  // -------------------------------------------------------------------------
  // measure a copy button so we can compute row layout
  // -------------------------------------------------------------------------

  const copyBtnProbe = makeCopyButton(theme);
  const copyBtnW = copyBtnProbe.width;
  const copyBtnH = copyBtnProbe.height;

  // shared fixed width for the "remove" (buildPeerRow) and "invite"
  // (buildFriendInviteRow) buttons — using the wider of the two labels'
  // natural widths means both buttons line up across sections instead of
  // each hugging its own (slightly different) label width.
  const actionBtnWidth =
    Math.max(measureTextWidth("remove", theme), measureTextWidth("invite", theme)) +
    BUTTON_PAD_H * 2;

  // scrollBox width = dialogWidth - 2 * padding (Dialog does this internally)
  const scrollBoxWidth = DIALOG_WIDTH - DIALOG_PADDING * 2;
  const valueWidth = scrollBoxWidth - copyBtnW - 8;

  // -------------------------------------------------------------------------
  // build content rows — each row: label + placeholder + copy button
  // -------------------------------------------------------------------------

  function buildRow(
    labelStr: string,
    value: string
  ): { container: Container; placeholder: Graphics; copyBtn: ReturnType<typeof makeCopyButton> } {
    const row = new Container();

    const label = makeLabel(labelStr, theme);
    label.x = 0;
    label.y = 0;
    row.addChild(label);

    // placeholder graphics — marks where the DOM input will float
    const placeholder = new Graphics();
    placeholder.roundRect(0, 0, valueWidth, INPUT_HEIGHT, 4);
    placeholder.fill({ color: 0x0a0a0a });
    placeholder.stroke({ color: 0x2a2a2a, width: 1 });
    placeholder.x = 0;
    placeholder.y = label.height + LABEL_GAP;
    row.addChild(placeholder);

    // copy button
    const copyBtn = makeCopyButton(theme);
    copyBtn.btn.x = valueWidth + 8;
    copyBtn.btn.y = label.height + LABEL_GAP + (INPUT_HEIGHT - copyBtnH) / 2;
    row.addChild(copyBtn.btn);

    wireCopy(copyBtn.btn, copyBtn.bg, copyBtn.text, copyBtnH, value, theme, isRemoved);

    return { container: row, placeholder, copyBtn };
  }

  // share URL row — shown to everyone (admin or not; see
  // ShareDialogOptions.readOnly), since anyone shared with a canvas may
  // reasonably want to re-share/copy the link. "share string" (the raw
  // encoded nodeId+docId, redundant with the URL and only ever useful to
  // an admin) was removed entirely per explicit ask — the URL alone is
  // what anyone actually needs to invite/join.
  const shareUrlRow = buildRow("share URL", shareUrl);

  // -------------------------------------------------------------------------
  // "include hub(s) in link" toggle — only shown when this canvas has been
  // explicitly shared with at least one hub (see canvas-doc.ts's
  // `hubNodeIds`). lets the sharer opt out of including hub node ids in the
  // link; default (when the toggle isn't touched) is to include them, so a
  // brand-new invitee can befriend a hub and receive the invite/canvas via
  // gossip even if the sharer goes offline right after sending the link —
  // see share-string.ts's top doc comment for the full rationale.
  const hubNodeIds = options.hubNodeIds ?? [];
  const includeHubsSection = new Container();
  if (hubNodeIds.length > 0) {
    const includeHubs = options.includeHubsInLink !== false;
    const hubCount = hubNodeIds.length;

    const toggleLabel = makeLabel("include hub(s) in link", theme);
    includeHubsSection.addChild(toggleLabel);

    const toggleText = new Text({
      text: includeHubs ? "on" : "off",
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall,
        fill: includeHubs ? 0x86efac : 0x9ca3af,
      },
      resolution: theme.textResolution,
    });
    toggleText.eventMode = "none";

    const toggleBg = new Graphics();
    const drawToggle = (on: boolean) => {
      const w = Math.max(toggleText.width, 32) + BUTTON_PAD_H * 2;
      const h = toggleText.height + BUTTON_PAD_V * 2;
      toggleBg.clear();
      toggleBg.roundRect(0, 0, w, h, 4);
      toggleBg.fill({ color: on ? 0x14532d : 0x27272a });
      toggleBg.stroke({ color: on ? 0x22c55e : 0x3f3f46, width: 1 });
      toggleText.x = (w - toggleText.width) / 2;
      toggleText.y = BUTTON_PAD_V;
      return { w, h };
    };
    const { w: toggleW, h: toggleH } = drawToggle(includeHubs);

    const toggleView = new Container();
    toggleView.addChild(toggleBg);
    toggleView.addChild(toggleText);

    const toggleBtn = new ButtonContainer(toggleView);
    toggleBtn.cursor = "pointer";
    toggleBtn.x = scrollBoxWidth - toggleW;
    toggleBtn.y = toggleLabel.height / 2 - toggleH / 2;
    toggleBtn.onPress.connect(() => {
      options.onToggleIncludeHubs?.(!includeHubs);
    });
    includeHubsSection.addChild(toggleBtn);

    const description = new Text({
      text:
        hubCount === 1
          ? "this canvas has been shared with a hub — including its node id lets a new invitee connect to it and receive this invite even while you're offline."
          : `this canvas has been shared with ${hubCount} hubs — including their node ids lets a new invitee connect to one and receive this invite even while you're offline.`,
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall - 1,
        fill: 0x6b7280,
        wordWrap: true,
        wordWrapWidth: scrollBoxWidth,
      },
      resolution: theme.textResolution,
    });
    // the toggle button's row (label + button, whichever is taller) needs
    // to fully clear before the description starts, not just the label's
    // own height — the button is often taller than the label text, so
    // using only toggleLabel.height here left the description crowding /
    // overlapping the button.
    description.y = Math.max(toggleLabel.height, toggleBtn.y + toggleH) + LABEL_GAP;
    includeHubsSection.addChild(description);
  }

  // -------------------------------------------------------------------------
  // peer list section
  //
  // peers whose node id is a known hub (hubNodeIds, from the canvas doc) are
  // rendered in the "hub nodes" section below instead of here — grouped
  // together with not-yet-invited hub friends rather than mixed in among
  // regular peers, per a real reported preference.
  // -------------------------------------------------------------------------

  const hubNodeIdSet = new Set(hubNodeIds);
  const hubPeers = peerList.filter((p) => hubNodeIdSet.has(p.nodeId));
  const nonHubPeers = peerList.filter((p) => !hubNodeIdSet.has(p.nodeId));
  const peerNameMap = options.peerDisplayNames;
  const knownFriends =
    options.knownFriendNodeIds instanceof Set
      ? options.knownFriendNodeIds
      : new Set(options.knownFriendNodeIds ?? []);

  const peerSection = new Container();
  const peerLabel = makeLabel("shared with", theme);
  peerSection.addChild(peerLabel);

  if (nonHubPeers.length === 0) {
    const emptyText = new Text({
      text: "no peers yet",
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall,
        fill: 0x6b7280,
      },
      resolution: theme.textResolution,
    });
    emptyText.y = peerLabel.height + LABEL_GAP;
    peerSection.addChild(emptyText);
  } else {
    let peerY = peerLabel.height + LABEL_GAP;
    for (const peer of nonHubPeers) {
      const rowHeight = peer.bio ? copyBtnH + FRIEND_ROW_BIO_EXTRA : copyBtnH;
      const peerRow = buildPeerRow(
        peer.nodeId,
        peer.joinedAt,
        theme,
        scrollBoxWidth,
        copyBtnH,
        rowHeight,
        actionBtnWidth,
        isRemoved,
        options.onRemovePeer,
        options.onAddFriend,
        peerNameMap?.get(peer.nodeId),
        peer.role,
        options.onChangeRole,
        knownFriends.has(peer.nodeId),
        peer.avatarDataUrl,
        peer.isOnline,
        peer.bio
      );
      peerRow.y = peerY;
      peerSection.addChild(peerRow);
      peerY += rowHeight + 4;
    }
  }

  // -------------------------------------------------------------------------
  // friend invite section — admin-only (see ShareDialogOptions.readOnly)
  // -------------------------------------------------------------------------

  const friendSection = new Container();
  const friendLabel = makeLabel("invite friends", theme);
  let friendList: FriendInfo[] = [];
  let hubFriendList: FriendInfo[] = [];

  // dev/test-only: rendered display-name text for each friend-invite row,
  // by node id — see ShareDialogHandle.getFriendRowText().
  const friendRowNameTexts = new Map<string, Text>();

  if (!readOnly) {
    friendSection.addChild(friendLabel);

    // hub friends get their own section below, always last — see
    // splitFriendsForInvite()'s doc comment for the grouping rule.
    const allFriends = options.friends ?? [];
    ({ regular: friendList, hub: hubFriendList } = splitFriendsForInvite(allFriends));

    if (friendList.length === 0) {
      const noFriendsText = new Text({
        text: "no friends to invite",
        style: {
          fontFamily: theme.fontFamily,
          fontSize: theme.fontSizeSmall,
          fill: 0x6b7280,
        },
        resolution: theme.textResolution,
      });
      noFriendsText.eventMode = "none";
      noFriendsText.y = friendLabel.height + LABEL_GAP;
      friendSection.addChild(noFriendsText);
    } else {
      let friendY = friendLabel.height + LABEL_GAP;
      for (const friend of friendList) {
        const rowHeight = friend.bio ? copyBtnH + FRIEND_ROW_BIO_EXTRA : copyBtnH;
        const { container: friendRow, nameText } = buildFriendInviteRow(
          friend,
          theme,
          scrollBoxWidth,
          rowHeight,
          actionBtnWidth,
          isRemoved,
          options.onInviteFriend
        );
        friendRow.y = friendY;
        friendSection.addChild(friendRow);
        friendRowNameTexts.set(friend.nodeId, nameText);
        friendY += rowHeight + 4;
      }
    }
  }

  // -------------------------------------------------------------------------
  // hub nodes section — always last. groups BOTH hub peers already shared
  // with this canvas (moved out of "shared with" above, at the top of this
  // list) and hub friends not yet invited (below them). the invite-friend
  // sub-list is admin-only (see ShareDialogOptions.readOnly), but already-
  // shared hub peers are shown to anyone (same visibility as "shared with").
  // -------------------------------------------------------------------------

  const hubFriendSection = new Container();
  const showHubSection = hubPeers.length > 0 || (!readOnly && hubFriendList.length > 0);
  if (showHubSection) {
    const hubFriendLabel = makeLabel("hub nodes", theme);
    hubFriendSection.addChild(hubFriendLabel);

    let hubFriendY = hubFriendLabel.height + LABEL_GAP;
    for (const peer of hubPeers) {
      const rowHeight = peer.bio ? copyBtnH + FRIEND_ROW_BIO_EXTRA : copyBtnH;
      const peerRow = buildPeerRow(
        peer.nodeId,
        peer.joinedAt,
        theme,
        scrollBoxWidth,
        copyBtnH,
        rowHeight,
        actionBtnWidth,
        isRemoved,
        options.onRemovePeer,
        options.onAddFriend,
        peerNameMap?.get(peer.nodeId),
        peer.role,
        options.onChangeRole,
        knownFriends.has(peer.nodeId),
        peer.avatarDataUrl,
        peer.isOnline,
        peer.bio
      );
      peerRow.y = hubFriendY;
      hubFriendSection.addChild(peerRow);
      hubFriendY += rowHeight + 4;
    }
    for (const friend of hubFriendList) {
      const rowHeight = friend.bio ? copyBtnH + FRIEND_ROW_BIO_EXTRA : copyBtnH;
      const { container: friendRow, nameText } = buildFriendInviteRow(
        friend,
        theme,
        scrollBoxWidth,
        rowHeight,
        actionBtnWidth,
        isRemoved,
        options.onInviteFriend
      );
      friendRow.y = hubFriendY;
      hubFriendSection.addChild(friendRow);
      friendRowNameTexts.set(friend.nodeId, nameText);
      hubFriendY += rowHeight + 4;
    }
  }

  // -------------------------------------------------------------------------
  // pending invites section
  // -------------------------------------------------------------------------

  const pendingSection = new Container();
  const pendingLabel = makeLabel("pending invites", theme);
  pendingSection.addChild(pendingLabel);

  const pendingList = options.pendingInvites ?? [];
  const nameMap = options.peerDisplayNames;

  if (pendingList.length === 0) {
    const noPendingText = new Text({
      text: "no pending invites",
      style: {
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSizeSmall,
        fill: 0x6b7280,
      },
      resolution: theme.textResolution,
    });
    noPendingText.eventMode = "none";
    noPendingText.y = pendingLabel.height + LABEL_GAP;
    pendingSection.addChild(noPendingText);
  } else {
    let pendingY = pendingLabel.height + LABEL_GAP;
    for (const entry of pendingList) {
      const pendingRow = buildPendingInviteRow(
        entry.targetNodeId,
        entry.invite,
        theme,
        scrollBoxWidth,
        copyBtnH,
        isRemoved,
        options.onCancelInvite,
        nameMap?.get(entry.targetNodeId)
      );
      pendingRow.y = pendingY;
      pendingSection.addChild(pendingRow);
      pendingY += copyBtnH + 4;
    }
  }

  // -------------------------------------------------------------------------
  // declined invites section — admin-only (see ShareDialogOptions.readOnly)
  // -------------------------------------------------------------------------

  const declinedSection = new Container();
  const declinedLabel = makeLabel("declined", theme);
  const declinedList = readOnly ? [] : (options.declinedInvites ?? []);

  if (!readOnly) {
    declinedSection.addChild(declinedLabel);
    if (declinedList.length === 0) {
      const noneText = new Text({
        text: "none",
        style: {
          fontFamily: theme.fontFamily,
          fontSize: theme.fontSizeSmall,
          fill: 0x6b7280,
        },
        resolution: theme.textResolution,
      });
      noneText.eventMode = "none";
      noneText.y = declinedLabel.height + LABEL_GAP;
      declinedSection.addChild(noneText);
    } else {
      let declinedY = declinedLabel.height + LABEL_GAP;
      for (const entry of declinedList) {
        const declinedRow = buildDeclinedRow(
          entry.toNodeId,
          entry.toUsername,
          theme,
          scrollBoxWidth,
          copyBtnH,
          nameMap?.get(entry.toNodeId)
        );
        declinedRow.y = declinedY;
        declinedSection.addChild(declinedRow);
        declinedY += copyBtnH + 4;
      }
    }
  }

  // -------------------------------------------------------------------------
  // close button (FancyButton — required by Dialog's button API)
  // -------------------------------------------------------------------------

  const closeBtnWidth = scrollBoxWidth;
  const closeBtnHeight = INPUT_HEIGHT;

  const closeBtnBg = new Graphics();
  closeBtnBg.roundRect(0, 0, closeBtnWidth, closeBtnHeight, 4);
  closeBtnBg.fill({ color: 0x0a0a0a });
  closeBtnBg.stroke({ color: 0x1f1f1f, width: 1 });

  const closeBtnText = new Text({
    text: "close",
    style: {
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSizeSmall,
      fill: theme.frameHeaderText,
    },
    resolution: theme.textResolution,
  });

  const closeButton = new FancyButton({
    defaultView: closeBtnBg,
    text: closeBtnText,
    padding: 0,
  });

  // -------------------------------------------------------------------------
  // title
  // -------------------------------------------------------------------------

  const titleText = new Text({
    text: "share canvas",
    style: {
      fontFamily: theme.fontFamily,
      fontSize: 16,
      fontWeight: "600",
      fill: theme.frameHeaderText,
    },
    resolution: theme.textResolution,
  });

  // -------------------------------------------------------------------------
  // compute dialog height
  //
  // the Dialog allocates scrollBox height as:
  //   dialogHeight - 2*padding - buttonContainer.height - titleText.height
  //
  // our content needs:
  //   shareUrlRow height + elementsMargin + ...
  // -------------------------------------------------------------------------

  // the actual list of top-level content sections, in render order — built
  // once and reused both for the Dialog's `content` array below and for
  // gap-count math, so the two can never silently drift apart (e.g. when
  // `readOnly` hides some of them).
  const contentSections: Container[] = [
    shareUrlRow.container,
    ...(hubNodeIds.length > 0 ? [includeHubsSection] : []),
    peerSection,
    ...(readOnly ? [] : [friendSection]),
    ...(showHubSection ? [hubFriendSection] : []),
    pendingSection,
    ...(readOnly ? [] : [declinedSection]),
  ];

  const rowHeight = titleText.height + LABEL_GAP + INPUT_HEIGHT; // approximate single row
  // sum actual per-row heights (not a flat multiply) since a row with a
  // bio grows taller than the base copyBtnH — see FRIEND_ROW_BIO_EXTRA.
  // works for both FriendInfo rows and peer rows (both have an optional
  // `bio` field).
  const friendRowsHeight = (list: Array<{ bio?: string }>) =>
    list.length === 0
      ? copyBtnH + 4
      : list.reduce((sum, f) => sum + (f.bio ? copyBtnH + FRIEND_ROW_BIO_EXTRA : copyBtnH) + 4, 0);
  const sumRowHeights = (list: Array<{ bio?: string }>) =>
    list.reduce((sum, item) => sum + (item.bio ? copyBtnH + FRIEND_ROW_BIO_EXTRA : copyBtnH) + 4, 0);
  const peerSectionHeight = peerLabel.height + LABEL_GAP + friendRowsHeight(nonHubPeers);
  const friendSectionHeight = readOnly
    ? 0
    : friendLabel.height + LABEL_GAP + friendRowsHeight(friendList);
  const hubFriendSectionHeight = showHubSection
    ? hubFriendSection.getChildAt(0).height +
      LABEL_GAP +
      sumRowHeights(hubPeers) +
      sumRowHeights(hubFriendList)
    : 0;
  // measured after the section is fully built above (label + toggle row +
  // wrapped description) — getBounds()/getLocalBounds() reflects the real
  // wrapped text height, unlike a fixed estimate.
  const includeHubsSectionHeight =
    hubNodeIds.length > 0 ? includeHubsSection.getLocalBounds().height : 0;
  const pendingSectionHeight =
    pendingLabel.height + LABEL_GAP + Math.max(1, pendingList.length) * (copyBtnH + 4);
  const declinedSectionHeight = readOnly
    ? 0
    : declinedLabel.height + LABEL_GAP + Math.max(1, declinedList.length) * (copyBtnH + 4);
  const contentNeeded =
    rowHeight +
    SECTION_GAP * Math.max(0, contentSections.length - 1) +
    includeHubsSectionHeight +
    peerSectionHeight +
    friendSectionHeight +
    hubFriendSectionHeight +
    pendingSectionHeight +
    declinedSectionHeight;
  const DIALOG_HEIGHT =
    DIALOG_PADDING * 2 + titleText.height + contentNeeded + closeBtnHeight + DIALOG_PADDING;

  // -------------------------------------------------------------------------
  // background panel
  // -------------------------------------------------------------------------

  const panelBg = new Graphics();
  panelBg.roundRect(0, 0, DIALOG_WIDTH, DIALOG_HEIGHT, 8);
  panelBg.fill({ color: 0x141414 });
  panelBg.stroke({ color: 0x2a2a2a, width: 1 });

  // -------------------------------------------------------------------------
  // create the dialog
  // -------------------------------------------------------------------------

  const dialog = new Dialog({
    background: panelBg,
    title: titleText,
    width: DIALOG_WIDTH,
    height: DIALOG_HEIGHT,
    padding: DIALOG_PADDING,
    content: contentSections,
    buttons: [closeButton],
    scrollBox: {
      background: 0x141414,
      padding: 0,
      elementsMargin: SECTION_GAP,
      radius: 0,
      type: "vertical",
    },
    closeOnBackdropClick: true,
    backdropColor: 0x000000,
    backdropAlpha: 0.6,
  });

  dialog.zIndex = DIALOG_Z;
  dialog.x = app.screen.width / 2;
  dialog.y = app.screen.height / 2;
  app.stage.addChild(dialog);
  dialog.open();

  // -------------------------------------------------------------------------
  // DOM input overlays — created after dialog is open and positioned
  // -------------------------------------------------------------------------

  // force a transform update so toGlobal() returns correct screen positions
  app.stage.updateTransform({});

  const canvasEl = app.canvas as HTMLCanvasElement;
  const shareUrlInput = createReadOnlyInput(shareUrlRow.placeholder, canvasEl, shareUrl, theme);
  domInputs.push(shareUrlInput);

  // -------------------------------------------------------------------------
  // close / teardown wiring
  // -------------------------------------------------------------------------

  function teardown(): void {
    if (removed) return;
    removed = true;

    window.removeEventListener("keydown", handleKeyDown, true);

    for (const input of domInputs) {
      input.remove();
    }

    app.stage.removeChild(dialog);
    dialog.destroy({ children: true });
    onClose?.();
  }

  // close button — Dialog emits onSelect with the button index
  dialog.onSelect.connect(() => {
    dialog.close();
  });

  // backdrop click — Dialog calls close() internally, which emits onClose
  dialog.onClose.connect(() => {
    teardown();
  });

  // Escape key
  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dialog.close();
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);

  // -------------------------------------------------------------------------
  // handle
  // -------------------------------------------------------------------------

  return {
    remove(): void {
      teardown();
    },
    getFriendRowText(nodeId: string): string | null {
      return friendRowNameTexts.get(nodeId)?.text ?? null;
    },
  };
}
