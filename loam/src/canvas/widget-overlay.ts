import { Container, Graphics, type Application } from "pixi.js";
import type { SkeinTheme } from "../theme/skein-theme";
import type { WidgetController } from "../widgets/widget-types";

export const SOCIAL_OVERLAY_W = 300;
export const SOCIAL_OVERLAY_H = 520;
export const MESSAGES_OVERLAY_W = 560;
export const MESSAGES_OVERLAY_H = 300;
export const CANVAS_INFO_OVERLAY_W = 300;
export const CANVAS_INFO_OVERLAY_H = 360;

export class WidgetOverlay {
  private readonly panel: Container;
  private readonly bg: Graphics;
  private readonly ctrl: WidgetController;
  private readonly panelW: number;
  private readonly panelH: number;
  private readonly theme: SkeinTheme;
  private currentW: number;
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
    this.panelH = height;
    this.theme = theme;
    this.currentW = width;

    app.stage.sortableChildren = true;

    this.panel = new Container();
    this.panel.zIndex = 11000;
    this.panel.visible = false;
    this.panel.eventMode = "static";

    this.bg = new Graphics();
    this.drawBg(width);
    this.panel.addChild(this.bg);

    ctrl.container.x = 0;
    ctrl.container.y = 0;
    this.panel.addChild(ctrl.container);

    app.stage.addChild(this.panel);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

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

  layout(screenW: number): void {
    if (this._isOpen) this.reposition(screenW);
  }

  destroy(): void {
    this.ctrl.destroy();
    this.panel.destroy({ children: true });
  }

  private drawBg(w: number): void {
    this.bg.clear();
    this.bg.roundRect(0, 0, w, this.panelH, 8);
    this.bg.fill({ color: this.theme.frameHeaderBg, alpha: 0.97 });
    this.bg.stroke({ color: this.theme.frameBorder, width: 1 });
  }

  private reposition(screenW: number): void {
    const effectiveW = Math.min(this.panelW, Math.max(200, screenW - 32));
    if (effectiveW !== this.currentW) {
      this.currentW = effectiveW;
      this.drawBg(effectiveW);
      this.ctrl.resize?.(effectiveW, this.panelH);
    }
    this.panel.x = Math.round(screenW - effectiveW - 16);
    this.panel.y = 52;
  }
}
