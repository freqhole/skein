/**
 * a small "clipboard stack" badge that follows the pointer, offset beside
 * it — shown whenever there's copied skein widget content waiting to be
 * pasted. deliberately NOT a native CSS cursor: other code paths (resize
 * handles, drag states, pan) set `canvasElement.style.cursor` freely and
 * would constantly stomp a custom cursor image, so this renders as its
 * own pixi overlay on `app.stage` instead (same "HUD, unaffected by
 * viewport pan/zoom" layer the toolbar/property tray already use) and
 * just tracks the pointer rather than replacing it.
 *
 * card count in the badge: 1-4 draws that many solid stacked cards; 5+
 * draws just 2 (a solid front card, a half-transparent back card standing
 * in for "more than a few, unspecified count").
 */

import { Container, Graphics, Text, type Application } from "pixi.js";
import type { SkeinTheme } from "../theme/skein-theme";
import { onClipboardChange } from "./widget-clipboard";

const CARD_W = 16;
const CARD_H = 20;
const OFFSET = 4;
const RADIUS = 3;
/** offset from the actual pointer tip so the badge sits beside the
 *  cursor, not on top of it. */
const BADGE_OFFSET_X = 14;
const BADGE_OFFSET_Y = 14;
const BADGE_Z_INDEX = 999_999;

function buildCard(layerIndex: number, faded: boolean): Graphics {
  const g = new Graphics();
  const pos = layerIndex * OFFSET;
  g.roundRect(pos, pos, CARD_W, CARD_H, RADIUS);
  g.fill(0x000000);
  g.stroke({ width: 2, color: 0xd946ef, alpha: faded ? 0.5 : 1 });
  return g;
}

function buildBadge(count: number, theme: SkeinTheme): Container {
  const container = new Container();
  container.eventMode = "none";
  if (count > 4) {
    // back (faded, "more than a few"), front (solid) — exactly 2 layers.
    container.addChild(buildCard(1, true));
    container.addChild(buildCard(0, false));
  } else {
    // draw back-to-front so the front card ends up on top.
    for (let i = Math.min(count, 4) - 1; i >= 0; i--) {
      container.addChild(buildCard(i, false));
    }
  }

  // the actual count, always shown regardless of how many card layers are
  // drawn (e.g. still "12" even though 5+ only ever draws 2 cards).
  const label = new Text({
    text: String(count),
    resolution: theme.textResolution,
    style: { fontFamily: theme.fontFamily, fontSize: 11, fill: 0xffffff, fontWeight: "700" },
  });
  label.anchor.set(0.5);
  label.x = CARD_W / 2;
  label.y = CARD_H / 2;
  container.addChild(label);

  return container;
}

/** attach the clipboard-follower badge to `app`'s stage, tracking pointer
 *  position over `canvasElement`. returns a cleanup function. */
export function attachClipboardCursor(app: Application, canvasElement: HTMLCanvasElement, theme: SkeinTheme): () => void {
  app.stage.sortableChildren = true;
  let badge: Container | null = null;

  const rebuild = (count: number) => {
    if (badge) {
      app.stage.removeChild(badge);
      badge.destroy({ children: true });
      badge = null;
    }
    if (count <= 0) return;
    badge = buildBadge(count, theme);
    badge.zIndex = BADGE_Z_INDEX;
    badge.visible = false; // positioned (and shown) on the next pointermove
    app.stage.addChild(badge);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!badge) return;
    const rect = canvasElement.getBoundingClientRect();
    badge.x = e.clientX - rect.left + BADGE_OFFSET_X;
    badge.y = e.clientY - rect.top + BADGE_OFFSET_Y;
    badge.visible = true;
  };
  canvasElement.addEventListener("pointermove", onPointerMove);

  const unsubscribe = onClipboardChange(rebuild);

  return () => {
    unsubscribe();
    canvasElement.removeEventListener("pointermove", onPointerMove);
    if (badge) {
      app.stage.removeChild(badge);
      badge.destroy({ children: true });
      badge = null;
    }
  };
}

