// ---------------------------------------------------------------------------
// shared avatar + online-status-dot rendering, used anywhere a peer identity
// is shown (friends tab, requests tab, messagez widget, share dialog, narthex
// canvas-cards). draws a colored initial-letter circle immediately, then
// swaps in the real avatar image asynchronously if one is available.
// ---------------------------------------------------------------------------

import { Assets, Container, Graphics, Sprite, Text } from "pixi.js";
import { log } from "@freqhole/reliquary/utils";
import { BG, FONT, OFFLINE_COLOR, ONLINE_COLOR, ONLINE_DOT_BORDER, ONLINE_DOT_SIZE, RESOLUTION } from "./constants";
import { colorForName } from "./helpers";

export interface RenderAvatarOptions {
  /** container the avatar (and, if requested, the status dot) are added to. */
  parent: Container;
  /** unique cache key for the async texture load (e.g. `friend-avatar-${id}`) —
   *  avoids reloading/re-decoding the same data url texture across rebuilds. */
  cacheKey: string;
  /** center of the avatar circle, in `parent`'s local coordinates. */
  centerX: number;
  centerY: number;
  /** diameter of the avatar circle. */
  size: number;
  /** used for the initial-letter fallback and its palette color. */
  displayName: string;
  /** seeds the fallback color when `displayName` doesn't hash distinctly
   *  enough on its own (mirrors the row index used elsewhere). */
  colorSeed: number;
  /** data url (or any pixi-loadable src) for the real avatar image, if known. */
  avatarUrl?: string;
  /** when provided, draws an online/offline status dot at the avatar's
   *  bottom-right corner. omit entirely to skip the dot (e.g. for a peer
   *  whose online state isn't meaningful in that context). */
  online?: boolean;
  /** color of the status dot's border ring — should match whatever
   *  background the avatar sits on. defaults to the widget's base bg. */
  dotBorderColor?: number;
}

/**
 * render an avatar circle (with initial-letter fallback, async image
 * overlay, and optional online-status dot) into `opts.parent`.
 *
 * fire-and-forget: the avatar image load happens asynchronously and checks
 * `parent.destroyed` before touching it, so it's safe to call this right
 * before a row/container may be torn down on the next rebuild.
 */
export function renderAvatar(opts: RenderAvatarOptions): void {
  const { parent, cacheKey, centerX, centerY, size, displayName, colorSeed, avatarUrl, online } =
    opts;
  const dotBorderColor = opts.dotBorderColor ?? BG;

  const avatarColor = colorForName(displayName, colorSeed);
  const avatar = new Graphics();
  avatar.eventMode = "none";
  avatar.circle(centerX, centerY, size / 2);
  avatar.fill({ color: avatarColor });
  parent.addChild(avatar);

  const initial = (displayName || "?").charAt(0).toUpperCase() || "?";
  const avatarLetter = new Text({
    text: initial,
    style: {
      fontFamily: FONT,
      fontSize: Math.max(9, Math.round(size * 0.42)),
      fontWeight: "bold",
      fill: 0xffffff,
      align: "center",
    },
    resolution: RESOLUTION,
  });
  avatarLetter.eventMode = "none";
  avatarLetter.anchor.set(0.5);
  avatarLetter.x = centerX;
  avatarLetter.y = centerY;
  parent.addChild(avatarLetter);

  if (avatarUrl) {
    Assets.load({ src: avatarUrl, alias: cacheKey })
      .then((texture) => {
        if (parent.destroyed) return;
        const avatarSprite = new Sprite(texture);
        avatarSprite.eventMode = "none";
        avatarSprite.width = size;
        avatarSprite.height = size;
        avatarSprite.x = centerX - size / 2;
        avatarSprite.y = centerY - size / 2;

        const spriteMask = new Graphics();
        spriteMask.circle(centerX, centerY, size / 2);
        spriteMask.fill({ color: 0xffffff });
        parent.addChild(spriteMask);
        avatarSprite.mask = spriteMask;
        parent.addChild(avatarSprite);

        avatar.visible = false;
        avatarLetter.visible = false;
      })
      .catch((err) => {
        log.warn("social.avatar", "avatar image failed to load, showing fallback:", cacheKey, err);
      });
  }

  if (online !== undefined) {
    const dotColor = online ? ONLINE_COLOR : OFFLINE_COLOR;
    const dotCx = centerX + size / 2 - ONLINE_DOT_SIZE / 2 + 1;
    const dotCy = centerY + size / 2 - ONLINE_DOT_SIZE / 2 + 1;

    const onlineDot = new Graphics();
    onlineDot.eventMode = "none";
    // border ring (matches parent background)
    onlineDot.circle(dotCx, dotCy, ONLINE_DOT_SIZE / 2 + ONLINE_DOT_BORDER);
    onlineDot.fill({ color: dotBorderColor });
    // inner dot
    onlineDot.circle(dotCx, dotCy, ONLINE_DOT_SIZE / 2);
    onlineDot.fill({ color: dotColor });
    parent.addChild(onlineDot);
  }
}
