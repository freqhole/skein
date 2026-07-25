// tauri-only settings UI, designed to render full-window inside a dedicated
// tauri WebviewWindow (`label = "settings"`). entry point is `settings.html`
// → `src/standalone/settings-entry.ts` → `mountTauriSettingsWindow()`.
//
// fully self-contained: builds its own pixi `Application`, fills the viewport,
// resizes with the window. no coupling to the main canvas / widget system /
// automerge repo.

import { Application, Container, Graphics, Text } from "pixi.js";
import { getVersion } from "@tauri-apps/api/app";

import { isTauriMode } from "../p2p/tauri-transport";

const TAG = "[tauri-settings]";

const PANEL_PADDING = 20;
const PANEL_GAP = 12;
const HEART_SIZE = 13;

const COLOR_BG = 0x0d0d0d;
const COLOR_PANEL = 0x1a1a1a;
const COLOR_BORDER = 0x333333;
const COLOR_TEXT = 0xeeeeee;
const COLOR_DIM = 0x999999;
const COLOR_LINK = 0xdda6ff;
const FONT_FAMILY = "ui-monospace, SFMono-Regular, monospace";

const REPO_URL = "https://github.com/freqhole/skein";
const COPIED_MESSAGE_MS = 5000;

// same heart glyph used in tomb's about window (client/charnel/public/about.html)
const HEART_SVG =
  '<svg viewBox="0 0 24 24"><path d="M12 4.248C8.852-1.154 0 .423 0 7.192 0 11.853 5.571 16.619 12 23c6.43-6.381 12-11.147 12-15.808C24 .423 15.125-1.154 12 4.248z" fill="#ff00ff" /></svg>';

/**
 * mount the settings UI into the given parent (defaults to document.body),
 * filling the viewport. returns a disposer.
 *
 * in non-tauri builds this is a no-op and returns a noop disposer.
 */
export function mountTauriSettingsWindow(parent?: HTMLElement): () => void {
  if (!isTauriMode()) return () => {};

  const host = parent ?? document.body;
  Object.assign(document.body.style, {
    margin: "0",
    padding: "0",
    background: "#0d0d0d",
    overflow: "hidden",
  } as Partial<CSSStyleDeclaration>);

  const app = new Application();
  let disposed = false;
  let onResize: (() => void) | null = null;

  const teardown = () => {
    if (disposed) return;
    disposed = true;
    if (onResize) window.removeEventListener("resize", onResize);
    try {
      app.destroy({ removeView: true }, { children: true });
    } catch (err) {
      console.warn(TAG, "pixi destroy failed:", err);
    }
  };

  app
    .init({
      backgroundColor: COLOR_BG,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      width: window.innerWidth,
      height: window.innerHeight,
      resizeTo: window,
    })
    .then(() => {
      if (disposed) {
        try {
          app.destroy({ removeView: true }, { children: true });
        } catch {}
        return;
      }
      const canvas = app.canvas as HTMLCanvasElement;
      canvas.style.display = "block";
      host.appendChild(canvas);

      const ui = buildPanel(app);

      getVersion()
        .then((version) => {
          if (!disposed) ui.setVersion(version);
        })
        .catch((err) => {
          console.warn(TAG, "getVersion failed:", err);
        });

      onResize = () => ui.relayout(app.renderer.width, app.renderer.height);
      window.addEventListener("resize", onResize);
      ui.relayout(app.renderer.width, app.renderer.height);
    })
    .catch((err) => {
      console.error(TAG, "pixi init failed:", err);
      teardown();
    });

  window.addEventListener("beforeunload", teardown, { once: true });
  return teardown;
}

// -- pixi panel --------------------------------------------------------------

interface PanelUi {
  setVersion(version: string): void;
  relayout(viewW: number, viewH: number): void;
}

function buildPanel(app: Application): PanelUi {
  const root = new Container();
  app.stage.addChild(root);

  const panelBg = new Graphics();
  root.addChild(panelBg);

  const headingText = new Text({
    text: "skein desktop",
    style: { fontFamily: FONT_FAMILY, fontSize: 18, fontWeight: "600", fill: COLOR_TEXT },
  });
  root.addChild(headingText);

  const versionText = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: COLOR_DIM },
  });
  root.addChild(versionText);

  // "made with <heart> in NYC" row
  const taglineRow = new Container();
  root.addChild(taglineRow);

  const taglineBefore = new Text({
    text: "made with",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: COLOR_DIM },
  });
  taglineRow.addChild(taglineBefore);

  const heart = new Graphics().svg(HEART_SVG);
  heart.scale.set(HEART_SIZE / 24); // svg viewBox is 0 0 24 24
  taglineRow.addChild(heart);

  const taglineAfter = new Text({
    text: "in NYC",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: COLOR_DIM },
  });
  taglineRow.addChild(taglineAfter);

  const linkText = new Text({
    text: "github.com/freqhole/skein",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: COLOR_LINK },
  });
  linkText.eventMode = "static";
  linkText.cursor = "pointer";
  linkText.on("pointerover", () => {
    linkText.style.fill = COLOR_TEXT;
  });
  linkText.on("pointerout", () => {
    linkText.style.fill = COLOR_LINK;
  });
  root.addChild(linkText);

  const copiedText = new Text({
    text: "copied to clipboard!",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: COLOR_DIM },
  });
  copiedText.visible = false;
  root.addChild(copiedText);

  let viewW = 0;
  let viewH = 0;
  let copiedTimeout: number | null = null;

  linkText.on("pointertap", () => {
    navigator.clipboard.writeText(REPO_URL).catch((err) => {
      console.warn(TAG, "clipboard write failed:", err);
    });
    if (copiedTimeout !== null) window.clearTimeout(copiedTimeout);
    copiedText.visible = true;
    relayout(viewW, viewH);
    copiedTimeout = window.setTimeout(() => {
      copiedTimeout = null;
      copiedText.visible = false;
      relayout(viewW, viewH);
    }, COPIED_MESSAGE_MS);
  });

  const relayout = (w: number, h: number) => {
    viewW = w;
    viewH = h;

    const margin = 24;
    const panelW = Math.max(280, viewW - margin * 2);

    let y = PANEL_PADDING;
    headingText.x = PANEL_PADDING;
    headingText.y = y;
    y += headingText.height + 2;

    versionText.x = PANEL_PADDING;
    versionText.y = y;
    y += versionText.height + PANEL_GAP * 1.5;

    taglineBefore.x = 0;
    taglineBefore.y = 0;
    heart.x = taglineBefore.width + 5;
    heart.y = (taglineBefore.height - HEART_SIZE) / 2;
    taglineAfter.x = heart.x + HEART_SIZE + 5;
    taglineAfter.y = 0;
    taglineRow.x = PANEL_PADDING;
    taglineRow.y = y;
    y += taglineBefore.height + PANEL_GAP;

    linkText.x = PANEL_PADDING;
    linkText.y = y;
    y += linkText.height;

    if (copiedText.visible) {
      copiedText.x = PANEL_PADDING;
      copiedText.y = y + 4;
      y += copiedText.height + 4;
    }

    const panelH = y + PANEL_PADDING;

    panelBg.clear();
    panelBg.roundRect(0, 0, panelW, panelH, 10);
    panelBg.fill({ color: COLOR_PANEL });
    panelBg.stroke({ color: COLOR_BORDER, width: 1 });

    root.x = (viewW - panelW) / 2;
    root.y = Math.max(margin, (viewH - panelH) / 2);
  };

  const ui: PanelUi = {
    setVersion(version) {
      versionText.text = `v${version}`;
      relayout(viewW, viewH);
    },
    relayout,
  };

  return ui;
}
