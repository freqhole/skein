import { Container, Graphics, type Application } from "pixi.js";
import type { SkeinTheme } from "../theme/skein-theme";
import type { WidgetController } from "../widgets/widget-types";

// ---------------------------------------------------------------------------
// overlay panel dimensions
// ---------------------------------------------------------------------------

export const SOCIAL_OVERLAY_W = 300;
export const SOCIAL_OVERLAY_H = 520;
export const MESSAGES_OVERLAY_W = 560;
export const MESSAGES_OVERLAY_H = 300;
export const CANVAS_INFO_OVERLAY_W = 300;
export const CANVAS_INFO_OVERLAY_H = 360;

// ---------------------------------------------------------------------------
// WidgetOverlay
// ---------------------------------------------------------------------------

/**
 * floating overlay panel that mounts a widget's UI directly on app.stage.
 *
 * used for social, messages, and canvas-info — accessed via toolbar icon
 * buttons rather than as world-space canvas widgets.  the panel floats at a
 * fixed position (top-right, below the toolbar) and toggles open/closed.
 */
export class WidgetOverlay {
  private readonly panel: Container;
  private readonly ctrl: WidgetController;
  private readonly panelW: number;
  private _isOpen = false;

  constructor(
    app: Application,
    ctrl: WidgetController,
    width: number,
    height: number,
    theme: SkeinTheme
  ) {
    this.ctrl = ctrl;
    this.panelW = width;

    // ensure stage sorts by zIndex so the overlay sits above the toolbar
    app.stage.sortableChildren = true;

    this.panel = new Container();
    this.panel.zIndex = 11000; // above toolbar (10000) and its flyout (10001)
    this.panel.visible = false;
    this.panel.eventMode = "static";

    // panel background
    const bg = new Graphics();
    bg.roundRect(0, 0, width, height, 8);
    bg.fill({ color: theme.frameHeaderBg, alpha: 0.97 });
    bg.stroke({ color: theme.frameBorder, width: 1 });
    this.panel.addChild(bg);

    // widget container sits at (0, 0) inside the panel
    ctrl.container.x = 0;
    ctrl.container.y = 0;
    this.panel.addChild(ctrl.container);

    app.stage.addChild(this.panel);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  /**
   * toggle the panel.  pass the current screen width so the panel can be
   * right-aligned by default (pinned 16px from the right edge, 52px below the
   * toolbar).  optionally pass explicit (x, y) to override the default position
   * — used by the canvas-info overlay which opens bottom-left near the
   * connection-status pill instead.
   */
  toggle(screenW: number, anchorX?: number, anchorY?: number): void {
    this._isOpen = !this._isOpen;
    this.panel.visible = this._isOpen;
    if (this._isOpen) {
      if (anchorX !== undefined && anchorY !== undefined) {
        this.panel.x = Math.round(anchorX);
        this.panel.y = Math.round(anchorY);
      } else {
        this.reposition(screenW);
      }
    }
  }

  close(): void {
    this._isOpen = false;
    this.panel.visible = false;
  }

  /** call on window resize so the panel stays pinned to the right edge */
  layout(screenW: number): void {
    if (this._isOpen) this.reposition(screenW);
  }

  destroy(): void {
    this.ctrl.destroy();
    this.panel.destroy({ children: true });
  }

  // ---------------------------------------------------------------------------

  private reposition(screenW: number): void {
    this.panel.x = Math.round(screenW - this.panelW - 16);
    this.panel.y = 52; // below toolbar (~40px) + gap
  }
}
