// tauri-only settings UI, designed to render full-window inside a dedicated
// tauri WebviewWindow (`label = "settings"`). entry point is `settings.html`
// → `src/standalone/settings-entry.ts` → `mountTauriSettingsWindow()`.
//
// fully self-contained: builds its own pixi `Application`, fills the viewport,
// resizes with the window. all rust communication goes through `dispatch()`
// from `tauri-transport.ts`. no coupling to the main canvas / widget system /
// automerge repo.

import { Application, Container, Graphics, Text } from "pixi.js";

import { dispatch, isTauriMode } from "../p2p/tauri-transport";

const TAG = "[tauri-settings]";

const PANEL_PADDING = 20;
const PANEL_GAP = 12;
const TOGGLE_W = 96;
const TOGGLE_H = 32;
const POLL_MS = 5000;

const COLOR_BG = 0x0d0d0d;
const COLOR_PANEL = 0x1a1a1a;
const COLOR_BORDER = 0x333333;
const COLOR_TEXT = 0xeeeeee;
const COLOR_DIM = 0x999999;
const COLOR_ERROR = 0xff8a8a;
const COLOR_RUNNING = 0x5a2222; // stop = red
const COLOR_STOPPED = 0x22442a; // start = green
const FONT_FAMILY = "ui-monospace, SFMono-Regular, monospace";

interface HubStatus {
  running: boolean;
  node_id?: string;
  uptime_s?: number;
}

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
  let pollHandle: number | null = null;
  let onResize: (() => void) | null = null;

  const teardown = () => {
    if (disposed) return;
    disposed = true;
    if (pollHandle !== null) clearInterval(pollHandle);
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

      const refresh = async () => {
        if (disposed) return;
        try {
          const status = (await dispatch("hub_status")) as HubStatus;
          ui.applyStatus(status);
        } catch (err) {
          console.warn(TAG, "hub_status failed:", err);
          ui.applyError(String(err));
        }
      };

      ui.onToggleHub = async () => {
        ui.setBusy(true);
        try {
          const current = (await dispatch("hub_status")) as HubStatus;
          await dispatch(current.running ? "hub_stop" : "hub_start");
          await refresh();
        } catch (err) {
          console.error(TAG, "hub toggle failed:", err);
          ui.applyError(String(err));
        } finally {
          ui.setBusy(false);
        }
      };

      onResize = () => ui.relayout(app.renderer.width, app.renderer.height);
      window.addEventListener("resize", onResize);
      ui.relayout(app.renderer.width, app.renderer.height);

      refresh();
      pollHandle = window.setInterval(refresh, POLL_MS);
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
  applyStatus(status: HubStatus): void;
  applyError(msg: string): void;
  setBusy(busy: boolean): void;
  relayout(viewW: number, viewH: number): void;
  onToggleHub: () => void;
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

  const subheadingText = new Text({
    text: "settings",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: COLOR_DIM },
  });
  root.addChild(subheadingText);

  const nodeIdLabel = new Text({
    text: "node id",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: COLOR_DIM },
  });
  root.addChild(nodeIdLabel);

  const nodeIdValue = new Text({
    text: "—",
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      fill: COLOR_TEXT,
      wordWrap: true,
      wordWrapWidth: 100, // updated in relayout
      breakWords: true,
    },
  });
  root.addChild(nodeIdValue);

  const hubLabel = new Text({
    text: "hub peer",
    style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: COLOR_TEXT },
  });
  root.addChild(hubLabel);

  const hubSubLabel = new Text({
    text: "in-process iroh hub for self-hosting",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: COLOR_DIM },
  });
  root.addChild(hubSubLabel);

  const toggleContainer = new Container();
  toggleContainer.eventMode = "static";
  toggleContainer.cursor = "pointer";
  root.addChild(toggleContainer);
  const toggleBg = new Graphics();
  toggleContainer.addChild(toggleBg);
  const toggleLabel = new Text({
    text: "—",
    style: { fontFamily: FONT_FAMILY, fontSize: 13, fill: COLOR_TEXT },
  });
  toggleLabel.anchor.set(0.5);
  toggleContainer.addChild(toggleLabel);

  const statusLine = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: COLOR_DIM },
  });
  root.addChild(statusLine);

  const errorLine = new Text({
    text: "",
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: 11,
      fill: COLOR_ERROR,
      wordWrap: true,
      wordWrapWidth: 100, // updated in relayout
      breakWords: true,
    },
  });
  errorLine.visible = false;
  root.addChild(errorLine);

  let toggleColor = COLOR_STOPPED;
  let busy = false;
  let viewW = 0;
  let viewH = 0;

  const drawToggle = () => {
    toggleBg.clear();
    toggleBg.roundRect(0, 0, TOGGLE_W, TOGGLE_H, 5);
    toggleBg.fill({ color: busy ? COLOR_BORDER : toggleColor });
    toggleBg.stroke({ color: COLOR_BORDER, width: 1 });
    toggleLabel.x = TOGGLE_W / 2;
    toggleLabel.y = TOGGLE_H / 2;
  };

  const relayout = (w: number, h: number) => {
    viewW = w;
    viewH = h;

    const margin = 24;
    const panelW = Math.max(280, viewW - margin * 2);
    const innerW = panelW - PANEL_PADDING * 2;
    nodeIdValue.style.wordWrapWidth = innerW;
    errorLine.style.wordWrapWidth = innerW;

    let y = PANEL_PADDING;
    headingText.x = PANEL_PADDING;
    headingText.y = y;
    y += headingText.height + 2;

    subheadingText.x = PANEL_PADDING;
    subheadingText.y = y;
    y += subheadingText.height + PANEL_GAP * 1.5;

    nodeIdLabel.x = PANEL_PADDING;
    nodeIdLabel.y = y;
    y += nodeIdLabel.height + 4;

    nodeIdValue.x = PANEL_PADDING;
    nodeIdValue.y = y;
    y += nodeIdValue.height + PANEL_GAP * 1.5;

    hubLabel.x = PANEL_PADDING;
    hubLabel.y = y;
    toggleContainer.x = panelW - PANEL_PADDING - TOGGLE_W;
    toggleContainer.y = y;

    y += hubLabel.height + 4;
    hubSubLabel.x = PANEL_PADDING;
    hubSubLabel.y = y;

    const rowEnd = Math.max(y + hubSubLabel.height, (toggleContainer.y as number) + TOGGLE_H);
    y = rowEnd + PANEL_GAP;

    statusLine.x = PANEL_PADDING;
    statusLine.y = y;
    y += statusLine.height + 4;

    if (errorLine.visible) {
      errorLine.x = PANEL_PADDING;
      errorLine.y = y;
      y += errorLine.height + 4;
    }

    const panelH = y + PANEL_PADDING;

    panelBg.clear();
    panelBg.roundRect(0, 0, panelW, panelH, 10);
    panelBg.fill({ color: COLOR_PANEL });
    panelBg.stroke({ color: COLOR_BORDER, width: 1 });

    root.x = (viewW - panelW) / 2;
    root.y = Math.max(margin, (viewH - panelH) / 2);
  };

  drawToggle();

  const ui: PanelUi = {
    applyStatus(status) {
      errorLine.visible = false;
      if (status.node_id) nodeIdValue.text = status.node_id;
      if (status.running) {
        toggleLabel.text = "stop";
        toggleColor = COLOR_RUNNING;
        const uptime = typeof status.uptime_s === "number" ? `${status.uptime_s}s` : "—";
        statusLine.text = `hub running · uptime ${uptime}`;
      } else {
        toggleLabel.text = "start";
        toggleColor = COLOR_STOPPED;
        statusLine.text = "hub stopped";
      }
      drawToggle();
      relayout(viewW, viewH);
    },
    applyError(msg) {
      errorLine.text = msg;
      errorLine.visible = true;
      relayout(viewW, viewH);
    },
    setBusy(b) {
      busy = b;
      toggleContainer.cursor = b ? "default" : "pointer";
      drawToggle();
    },
    relayout,
    onToggleHub: () => {},
  };

  toggleContainer.on("pointertap", () => {
    if (!busy) ui.onToggleHub();
  });

  return ui;
}
