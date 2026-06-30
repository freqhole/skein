import { ButtonContainer } from "@pixi/ui";
import {
  Assets,
  Container,
  FillGradient,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  type Application,
} from "pixi.js";
import type { SkeinTheme } from "../theme/skein-theme";
import type { WidgetRegistry } from "../widgets/widget-registry";
import type { CanvasStore } from "./canvas-store";
import type { InputRouter } from "./input-router";
import { isTauriMode } from "../p2p/tauri-transport";

export interface ToolbarOptions {
  /** if true, this toolbar is in the narthex (home screen) */
  isNarthex?: boolean;
  /** callback to navigate to the narthex — shows a home button when set */
  onNavigateHome?: () => void;
  /** callback to share the current canvas — shows a share button when set */
  onShare?: () => void;
  /** callback for the avatar (social) button — shows the social overlay */
  onToggleSocial?: () => void;
  /** callback for the messages button — shows the messagez overlay */
  onToggleMessages?: () => void;
  /** if false, the share button is hidden even when onShare is set */
  hasIdentity?: boolean;
}

/** a single segment of the breadcrumb trail shown in the toolbar */
export interface BreadcrumbItem {
  /** display label for this crumb */
  label: string;
  /** click handler — if omitted, this crumb is the current context (non-clickable, muted) */
  onClick?: () => void;
}

/**
 * pure PixiJS toolbar rendered at the top-right of the stage.
 *
 * provides:
 * - "+" button that opens a flyout menu of widget types
 * - delete button (remove selected widget, visible when selection exists)
 *
 * no DOM elements are used. everything is rendered with pixi containers,
 * graphics, text, and @pixi/ui ButtonContainer for interactivity.
 */
export class Toolbar {
  readonly root: Container;

  private readonly app: Application;
  private readonly inputRouter: InputRouter;
  private readonly store: CanvasStore;
  private readonly registry: WidgetRegistry;
  private readonly theme: SkeinTheme;

  private readonly background: Graphics;
  private readonly addBtn: ButtonContainer;
  private readonly deleteBtn: ButtonContainer;
  private breadcrumbContainer: Container;
  private breadcrumbs: BreadcrumbItem[] = [];
  private readonly shareBtn: ButtonContainer | null;
  private readonly socialBtn: Container | null;
  private readonly messagesBtn: Container | null;
  private socialBadge: Container | null = null;
  private messagesBadge: Container | null = null;
  private avatarSprite: Sprite | null = null;
  private avatarMask: Graphics | null = null;
  private readonly options: ToolbarOptions;

  // flyout menu state
  private readonly flyout: Container;
  private readonly flyoutBg: Graphics;
  private flyoutOpen = false;
  private stageDismissHandler: ((e: any) => void) | null = null;
  private flyoutBackdrop: Graphics | null = null;

  private unsubs: (() => void)[] = [];
  private widgetCounter = 0;
  private pendingPlacement: { x: number; y: number } | null = null;

  constructor(
    app: Application,
    inputRouter: InputRouter,
    store: CanvasStore,
    registry: WidgetRegistry,
    theme: SkeinTheme,
    options?: ToolbarOptions
  ) {
    this.app = app;
    this.inputRouter = inputRouter;
    this.store = store;
    this.registry = registry;
    this.theme = theme;
    this.options = options ?? {};

    // ensure stage sorts children by zIndex so the backdrop layer works
    app.stage.sortableChildren = true;

    // root container lives on the stage at a high zIndex
    this.root = new Container();
    this.root.zIndex = 10000;
    this.root.eventMode = "static";

    // background drawn behind all buttons
    this.background = new Graphics();
    this.root.addChild(this.background);

    // "+" button to open the widget flyout
    const add = this.createButton("+", { color: theme.accent });
    this.addBtn = add.btn;
    this.addBtn.visible = true;
    this.addBtn.onPress.connect(() => {
      this.toggleFlyout();
    });
    this.root.addChild(this.addBtn);

    // delete button (red-tinted, hidden by default)
    const del = this.createButton("delete", {
      color: 0x3a1a1a,
      textColor: theme.error,
    });
    this.deleteBtn = del.btn;
    this.deleteBtn.visible = false;
    this.deleteBtn.onPress.connect(() => {
      const ids = [...this.inputRouter.selectedWidgetIds];
      if (ids.length > 0) {
        this.inputRouter.selectWidget(null);
        for (const id of ids) {
          this.store.removeWidget(id);
        }
      }
    });
    this.root.addChild(this.deleteBtn);

    // breadcrumb trail (updated externally via setBreadcrumbs)
    this.breadcrumbContainer = new Container();
    this.breadcrumbContainer.eventMode = "static";
    this.root.addChild(this.breadcrumbContainer);

    // share button — visible when onShare is provided and identity is established
    if (this.options.onShare && this.options.hasIdentity !== false) {
      const share = this.createButton("share");
      this.shareBtn = share.btn;
      this.shareBtn.onPress.connect(() => {
        this.options.onShare?.();
      });
      this.root.addChild(this.shareBtn);
    } else {
      this.shareBtn = null;
    }

    // ── messages button ──────────────────────────────────────────────────────
    if (this.options.onToggleMessages) {
      this.messagesBtn = this.createMessagesButton();
      this.messagesBtn.on("pointertap", () => this.options.onToggleMessages?.());
      this.messagesBtn.eventMode = "static";
      this.messagesBtn.cursor = "pointer";
      this.root.addChild(this.messagesBtn);
    } else {
      this.messagesBtn = null;
    }

    // ── avatar circle button ─────────────────────────────────────────────────
    if (this.options.onToggleSocial) {
      this.socialBtn = this.createAvatarButton();
      this.socialBtn.on("pointertap", () => this.options.onToggleSocial?.());
      this.socialBtn.eventMode = "static";
      this.socialBtn.cursor = "pointer";
      this.root.addChild(this.socialBtn);
    } else {
      this.socialBtn = null;
    }

    // flyout menu container (hidden by default)
    this.flyout = new Container();
    this.flyout.visible = false;
    this.flyout.eventMode = "static";
    this.flyout.zIndex = 10001;

    this.flyoutBg = new Graphics();
    this.flyout.addChild(this.flyoutBg);

    this.root.addChild(this.flyout);

    // add root to stage
    app.stage.addChild(this.root);

    // subscribe to selection changes
    this.unsubs.push(this.inputRouter.onSelectionChange((id) => this.updateSelection(id)));
    // also listen to multi-selection so delete button shows for lasso selections
    this.unsubs.push(
      this.inputRouter.onMultiSelectionChange(() => {
        this.deleteBtn.visible = this.inputRouter.selectedWidgetIds.size > 0;
        this.layout();
      })
    );

    // set initial state then lay out
    this.updateSelection(this.inputRouter.selectedWidgetId);
    this.layout();
  }

  // -- button factory -------------------------------------------------------

  private createButton(
    label: string,
    options?: { color?: number; textColor?: number }
  ): { btn: ButtonContainer; bg: Graphics; text: Text } {
    const padding = { h: 8, v: 3 };

    const text = new Text({
      text: label,
      style: {
        fontFamily: this.theme.fontFamily,
        fontSize: this.theme.fontSizeSmall,
        fill: options?.textColor ?? 0xffffff,
      },
      resolution: this.theme.textResolution,
    });
    // transparent to pointer events so clicks reach the button
    text.eventMode = "none";

    const bg = new Graphics();
    const width = text.width + padding.h * 2;
    const height = text.height + padding.v * 2;
    bg.roundRect(0, 0, width, height, 4);
    bg.fill({ color: options?.color ?? this.theme.frameBorder });

    const view = new Container();
    view.addChild(bg);
    text.x = padding.h;
    text.y = padding.v;
    view.addChild(text);

    const btn = new ButtonContainer(view);
    btn.cursor = "pointer";

    return { btn, bg, text };
  }

  /** draw the avatar circle button — circle with magenta→purple→orange gradient */
  private createAvatarButton(): Container {
    const BTN_SIZE = 28;
    const radius = BTN_SIZE / 2;

    const c = new Container();
    // explicit hit area so the container is clickable even when the child
    // Graphics has eventMode="none"
    c.hitArea = new Rectangle(0, 0, BTN_SIZE, BTN_SIZE);

    // gradient background (FillGradient coords are normalized 0–1 in local space)
    const g = new Graphics();
    const grad = new FillGradient(0, 0, 1, 1); // diagonal, top-left → bottom-right
    grad.addColorStop(0, 0xd946ef); // magenta
    grad.addColorStop(0.5, 0x7c3aed); // purple
    grad.addColorStop(1, 0xf97316); // orange
    g.circle(radius, radius, radius);
    g.fill(grad);
    g.eventMode = "none";
    c.addChild(g);

    return c;
  }

  /**
   * update the avatar circle button to show a profile image.
   * uses the PixiJS Assets cache so subsequent navigations apply the
   * texture synchronously — preventing the gradient flash on re-navigation.
   */
  setAvatarUrl(url: string | null): void {
    if (!this.socialBtn) return;

    // always tear down the old sprite first (synchronous)
    if (this.avatarSprite) {
      this.socialBtn.removeChild(this.avatarSprite);
      this.avatarSprite.mask = null;
      this.avatarSprite.destroy();
      this.avatarSprite = null;
    }
    if (this.avatarMask) {
      this.socialBtn.removeChild(this.avatarMask);
      this.avatarMask.destroy();
      this.avatarMask = null;
    }

    if (!url) return;

    // check the global Assets cache first — if the texture was loaded during
    // a previous canvas session it’s available synchronously, so we can apply
    // it immediately without ever showing the gradient placeholder
    const cached = Assets.get(url) as Texture | undefined;
    if (cached instanceof Texture) {
      this.applyAvatarSprite(cached);
      return;
    }

    // not cached yet (first time) — async load, gradient shows briefly
    Assets.load<Texture>(url)
      .then((tex) => {
        this.applyAvatarSprite(tex);
      })
      .catch(() => {
        // failed to load — gradient placeholder stays
      });
  }

  private applyAvatarSprite(texture: Texture): void {
    if (!this.socialBtn) return;

    const BTN_SIZE = 28;
    const radius = BTN_SIZE / 2;

    const mask = new Graphics();
    mask.circle(radius, radius, radius);
    mask.fill({ color: 0xffffff });
    mask.eventMode = "none";
    this.socialBtn.addChild(mask);

    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.x = radius;
    sprite.y = radius;
    sprite.width = BTN_SIZE;
    sprite.height = BTN_SIZE;
    sprite.mask = mask;
    sprite.eventMode = "none";
    this.socialBtn.addChild(sprite);

    this.avatarSprite = sprite;
    this.avatarMask = mask;
  }

  /** draw the messages button — a simple envelope icon */
  private createMessagesButton(): Container {
    const BTN_SIZE = 28;
    const radius = BTN_SIZE / 2;

    const c = new Container();

    // rounded background circle (same size as avatar)
    const bg = new Graphics();
    bg.circle(radius, radius, radius);
    bg.fill({ color: this.theme.frameBorder });
    c.addChild(bg);

    // envelope icon drawn with graphics
    const icon = new Graphics();
    const pad = 7;
    const w = BTN_SIZE - pad * 2;
    const h = w * 0.65;
    const ix = pad;
    const iy = (BTN_SIZE - h) / 2;
    // envelope body
    icon.roundRect(ix, iy, w, h, 2);
    icon.fill({ color: 0x000000, alpha: 0 }); // transparent fill to define path
    icon.stroke({ color: 0xffffff, width: 1.5, alpha: 0.9 });
    // envelope flap V
    icon.moveTo(ix, iy);
    icon.lineTo(ix + w / 2, iy + h * 0.55);
    icon.lineTo(ix + w, iy);
    icon.stroke({ color: 0xffffff, width: 1.5, alpha: 0.9 });
    c.addChild(icon);

    return c;
  }

  /** create or update a notification badge on a button container */
  private makeBadge(count: number): Container | null {
    if (count <= 0) return null;

    const badge = new Container();
    badge.eventMode = "none";

    const r = 8;
    const bg = new Graphics();
    bg.circle(r, r, r);
    bg.fill({ color: 0xef4444 }); // red
    badge.addChild(bg);

    const label = new Text({
      text: count > 99 ? "99+" : String(count),
      resolution: this.theme.textResolution,
      style: {
        fontFamily: this.theme.fontFamily,
        fontSize: 9,
        fill: 0xffffff,
        fontWeight: "bold",
      },
    });
    label.anchor.set(0.5, 0.5);
    label.x = r;
    label.y = r;
    badge.addChild(label);

    return badge;
  }

  private refreshBadge(
    current: Container | null,
    count: number,
    parent: Container,
    parentW: number
  ): Container | null {
    if (current) {
      parent.removeChild(current);
      current.destroy({ children: true });
    }
    const badge = this.makeBadge(count);
    if (badge) {
      badge.x = parentW - 8;
      badge.y = -8;
      parent.addChild(badge);
    }
    return badge;
  }

  // -- flyout ----------------------------------------------------------------

  /** build the vertical list of widget type entries inside the flyout. */
  private buildFlyoutItems(): void {
    // collect widget types already on the canvas so we can hide singletons
    const typesOnCanvas = new Set(this.store.allWidgets().map((w) => w.type));

    const factories = this.registry.all().filter((f) => {
      if (f.metadata.hidden) return false;
      // hide tauri-only widgets in browser mode
      if (f.metadata.tauriOnly && !isTauriMode()) return false;
      // hide singleton/unique types that are already placed on the canvas
      if ((f.metadata.singleton || f.metadata.unique) && typesOnCanvas.has(f.type)) return false;
      return true;
    });
    const itemPadH = 10;
    const itemPadV = 6;
    const itemGap = 2;
    let maxItemWidth = 0;
    let y = itemPadV;

    const items: Container[] = [];

    for (const factory of factories) {
      const item = new Container();
      item.eventMode = "static";
      item.cursor = "pointer";

      // name text
      const nameText = new Text({
        text: factory.metadata.name,
        style: {
          fontFamily: this.theme.fontFamily,
          fontSize: this.theme.fontSizeSmall,
          fill: 0xffffff,
        },
        resolution: this.theme.textResolution,
      });
      nameText.x = Math.round(itemPadH);
      nameText.y = Math.round(itemPadV);
      // transparent to pointer events so clicks reach the item container
      nameText.eventMode = "none";

      let itemHeight = nameText.height + itemPadV * 2;

      // optional description text
      let descText: Text | null = null;
      if (factory.metadata.description) {
        descText = new Text({
          text: factory.metadata.description,
          style: {
            fontFamily: this.theme.fontFamily,
            fontSize: this.theme.fontSizeSmall - 1,
            fill: 0x808080,
          },
          resolution: this.theme.textResolution,
        });
        descText.x = Math.round(itemPadH);
        descText.y = Math.round(nameText.y + nameText.height + 2);
        // transparent to pointer events so clicks reach the item container
        descText.eventMode = "none";
        itemHeight = descText.y + descText.height + itemPadV;
      }

      const textWidth = Math.max(nameText.width, descText ? descText.width : 0);
      const itemWidth = textWidth + itemPadH * 2;
      if (itemWidth > maxItemWidth) {
        maxItemWidth = itemWidth;
      }

      // hover background (drawn later once we know the max width)
      const hoverBg = new Graphics();
      item.addChild(hoverBg);
      item.addChild(nameText);
      if (descText) {
        item.addChild(descText);
      }

      // store dimensions for later background drawing
      (item as any)._itemHeight = itemHeight;
      (item as any)._hoverBg = hoverBg;

      item.y = Math.round(y);
      y += itemHeight + itemGap;

      // click handler: add widget and close flyout
      const widgetType = factory.type;
      const singletonId = factory.metadata.singletonId;
      item.on("pointerdown", (e: any) => {
        e.stopPropagation();
        this.addWidget(widgetType, singletonId);
        this.closeFlyout();
      });

      // hover effects
      item.on("pointerover", () => {
        hoverBg.clear();
        hoverBg.roundRect(0, 0, maxItemWidth, (item as any)._itemHeight, 4);
        hoverBg.fill({ color: this.theme.accent, alpha: 0.15 });
      });
      item.on("pointerout", () => {
        hoverBg.clear();
      });

      items.push(item);
      this.flyout.addChild(item);
    }

    // now draw all hover backgrounds at the correct max width and draw the flyout bg
    const flyoutPad = 4;
    const flyoutWidth = maxItemWidth + flyoutPad * 2;
    const flyoutHeight = y - itemGap + itemPadV + flyoutPad;

    // offset items horizontally for flyout padding
    for (const item of items) {
      item.x = flyoutPad;
      const hoverBg = (item as any)._hoverBg as Graphics;
      const h = (item as any)._itemHeight as number;
      // pre-draw transparent so the hit area is correct
      hoverBg.roundRect(0, 0, maxItemWidth, h, 4);
      hoverBg.fill({ color: 0x000000, alpha: 0 });
      // explicit hitArea so PixiJS hit-testing doesn't depend on the
      // alpha-0 fill (which some versions skip during picking)
      item.hitArea = new Rectangle(0, 0, maxItemWidth, h);
    }

    this.flyoutBg.clear();
    this.flyoutBg.roundRect(0, 0, flyoutWidth, flyoutHeight, 6);
    this.flyoutBg.fill({ color: this.theme.toolbarBg, alpha: 0.96 });
    this.flyoutBg.stroke({ color: this.theme.toolbarBorder, width: 1 });
  }

  /** clear and rebuild flyout items so singleton filtering is up to date. */
  private rebuildFlyout(): void {
    // remove all children except the background
    while (this.flyout.children.length > 1) {
      this.flyout.removeChildAt(1).destroy({ children: true });
    }
    this.buildFlyoutItems();
  }

  /**
   * open the widget type flyout at a specific screen position.
   * when the user picks a widget type, it will be placed at (worldX, worldY)
   * instead of the default stagger position.
   * used by the double-click-on-canvas handler.
   */
  openFlyoutAtPosition(screenX: number, screenY: number, worldX: number, worldY: number): void {
    this.pendingPlacement = { x: worldX, y: worldY };

    // open the flyout (reuse openFlyout logic but position at screen coords)
    if (this.flyoutOpen) {
      this.closeFlyout();
    }
    this.rebuildFlyout();
    this.flyoutOpen = true;
    this.flyout.visible = true;

    this.positionFlyoutAtScreen(screenX, screenY);

    this.showFlyoutBackdrop();
  }

  /** position the flyout near given screen coordinates, clamped to viewport. */
  private positionFlyoutAtScreen(screenX: number, screenY: number): void {
    const margin = 8;
    const vv = window.visualViewport;
    const screenW = vv ? vv.width : window.innerWidth;
    const screenH = vv ? vv.height : window.innerHeight;
    const flyoutW = this.flyoutBg.width;
    const flyoutH = this.flyoutBg.height;

    // position flyout with its top-left near the click, but offset slightly
    // so the cursor isn't covering the first item
    let x = screenX + 8 - this.root.x;
    let y = screenY - 4 - this.root.y;

    // clamp right edge
    if (this.root.x + x + flyoutW > screenW - margin) {
      x = screenW - margin - this.root.x - flyoutW;
    }
    // clamp left edge
    if (this.root.x + x < margin) {
      x = margin - this.root.x;
    }
    // clamp bottom edge
    if (this.root.y + y + flyoutH > screenH - margin) {
      y = screenH - margin - this.root.y - flyoutH;
    }
    // clamp top edge
    if (this.root.y + y < margin) {
      y = margin - this.root.y;
    }

    this.flyout.x = Math.round(x);
    this.flyout.y = Math.round(y);
  }

  /** position the flyout so it stays fully within the visible viewport. */
  private positionFlyout(): void {
    const margin = 8;
    const vv = window.visualViewport;
    const screenW = vv ? vv.width : window.innerWidth;
    const screenH = vv ? vv.height : window.innerHeight;
    const flyoutW = this.flyoutBg.width;
    const flyoutH = this.flyoutBg.height;

    // preferred position: below the "+" button, right-aligned to its right edge
    const addBtnRight = this.addBtn.x + this.addBtn.width;
    let x = addBtnRight - flyoutW;
    let y = this.addBtn.y + this.addBtn.height + 4;

    // clamp so the flyout stays within screen bounds.
    // convert local coords to screen coords, clamp, convert back.
    // screen position = root position + local position.

    // right edge: root.x + x + flyoutW <= screenW - margin
    const maxX = screenW - margin - this.root.x - flyoutW;
    // left edge: root.x + x >= margin
    const minX = margin - this.root.x;
    x = Math.max(minX, Math.min(maxX, x));

    // bottom edge: root.y + y + flyoutH <= screenH - margin
    const maxY = screenH - margin - this.root.y - flyoutH;
    if (y > maxY) {
      // try flipping above the toolbar instead of below
      const aboveY = -flyoutH - 4;
      if (this.root.y + aboveY >= margin) {
        y = aboveY;
      } else {
        // just clamp to the max
        y = Math.max(0, maxY);
      }
    }

    this.flyout.x = Math.round(x);
    this.flyout.y = Math.round(y);
  }

  /** toggle the flyout open or closed. */
  private toggleFlyout(): void {
    if (this.flyoutOpen) {
      this.closeFlyout();
    } else {
      this.openFlyout();
    }
  }

  /** open the flyout and attach a stage dismiss listener. */
  private openFlyout(): void {
    if (this.flyoutOpen) return;
    this.rebuildFlyout();
    this.flyoutOpen = true;
    this.flyout.visible = true;

    this.positionFlyout();

    this.showFlyoutBackdrop();
  }

  /** close the flyout and remove the stage dismiss listener. */
  private closeFlyout(): void {
    if (!this.flyoutOpen) return;
    this.flyoutOpen = false;
    this.flyout.visible = false;
    this.pendingPlacement = null;

    this.removeFlyoutBackdrop();

    if (this.stageDismissHandler) {
      this.app.stage.off("pointerdown", this.stageDismissHandler);
      this.stageDismissHandler = null;
    }
  }

  /** create a full-screen transparent overlay behind the flyout.
   *  clicking the backdrop closes the flyout. */
  private showFlyoutBackdrop(): void {
    this.removeFlyoutBackdrop();

    const backdrop = new Graphics();
    backdrop.rect(-20000, -20000, 40000, 40000);
    backdrop.fill({ color: 0x000000, alpha: 0.001 }); // near-invisible but catches events
    backdrop.eventMode = "static";
    backdrop.cursor = "default";
    backdrop.zIndex = 9999; // below toolbar root (10000) but above everything else
    backdrop.on("pointerdown", (e: any) => {
      e.stopPropagation();
      this.closeFlyout();
    });

    this.app.stage.addChild(backdrop);
    this.flyoutBackdrop = backdrop;
  }

  /** remove the flyout backdrop overlay */
  private removeFlyoutBackdrop(): void {
    if (this.flyoutBackdrop) {
      this.flyoutBackdrop.destroy();
      this.flyoutBackdrop = null;
    }
  }

  // -- layout ----------------------------------------------------------------

  /** position all visible buttons horizontally and redraw the toolbar background. */
  private layout(): void {
    const BTN_SIZE = 28; // circle button diameter
    const gap = 6;
    const pad = { h: 8, v: 4 };

    // compute a unified row height that fits both text buttons and circle buttons
    const textBtnH = this.addBtn.height;
    const contentH = Math.max(textBtnH, BTN_SIZE);
    const totalHeight = contentH + pad.v * 2;

    // y offsets that visually center each type within the row
    const textBtnY = Math.round(pad.v + (contentH - textBtnH) / 2);
    const circleBtnY = Math.round(pad.v + (contentH - BTN_SIZE) / 2);

    let x = pad.h;

    // breadcrumb trail (left side)
    if (this.breadcrumbContainer.children.length > 0) {
      this.breadcrumbContainer.x = x;
      this.breadcrumbContainer.y = textBtnY + 3;
      x += this.breadcrumbContainer.width + gap + 4;
    }

    // share button
    if (this.shareBtn) {
      this.shareBtn.x = x;
      this.shareBtn.y = textBtnY;
      x += this.shareBtn.width + gap;
    }

    // "+" button
    this.addBtn.x = x;
    this.addBtn.y = textBtnY;
    x += this.addBtn.width + gap;

    // delete button
    if (this.deleteBtn.visible) {
      this.deleteBtn.x = x;
      this.deleteBtn.y = textBtnY;
      x += this.deleteBtn.width + gap;
    }

    // messages button (circle)
    if (this.messagesBtn) {
      this.messagesBtn.x = x;
      this.messagesBtn.y = circleBtnY;
      x += BTN_SIZE + gap;
    }

    // avatar circle button
    if (this.socialBtn) {
      this.socialBtn.x = x;
      this.socialBtn.y = circleBtnY;
      x += BTN_SIZE + gap;
    }

    // total toolbar width
    const totalWidth = x - gap + pad.h;

    // redraw the toolbar background
    this.background.clear();
    this.background.roundRect(0, 0, totalWidth, totalHeight, 6);
    this.background.fill({ color: this.theme.toolbarBg, alpha: 0.92 });
    this.background.stroke({ color: this.theme.toolbarBorder, width: 1 });

    // pin to top-right with margin
    const margin = 8;
    this.root.x = Math.round(this.app.screen.width - totalWidth - margin);
    this.root.y = margin;

    // responsive truncation: if toolbar extends past left edge, truncate breadcrumbs
    if (this.root.x < margin && this.breadcrumbs.length > 2) {
      this.truncateBreadcrumbs();
    }

    // reposition flyout if open
    if (this.flyoutOpen) {
      this.positionFlyout();
    }
  }

  // -- breadcrumbs -----------------------------------------------------------

  /** update the breadcrumb trail displayed in the toolbar.
   *  the last crumb should have no onClick (it represents the current context). */
  setBreadcrumbs(crumbs: BreadcrumbItem[]): void {
    this.breadcrumbs = crumbs;
    this.renderBreadcrumbs();
    this.layout();
  }

  /** rebuild the breadcrumb pixi elements from `this.breadcrumbs` */
  private renderBreadcrumbs(): void {
    // tear down previous crumb elements
    this.breadcrumbContainer.removeChildren();

    let x = 0;
    const gap = 4;
    const sepColor = 0x666666;

    for (let i = 0; i < this.breadcrumbs.length; i++) {
      const crumb = this.breadcrumbs[i];
      const isLast = i === this.breadcrumbs.length - 1;
      const isClickable = !!crumb.onClick;

      const text = new Text({
        text: crumb.label,
        style: {
          fontFamily: this.theme.fontFamily,
          fontSize: this.theme.fontSizeSmall,
          fill: isLast ? 0x888888 : isClickable ? 0xcccccc : 0x888888,
        },
        resolution: this.theme.textResolution,
      });

      if (isClickable) {
        text.eventMode = "static";
        text.cursor = "pointer";

        const handler = crumb.onClick!;
        text.on("pointerover", () => {
          text.style.fill = this.theme.accent;
        });
        text.on("pointerout", () => {
          text.style.fill = 0xcccccc;
        });
        text.on("pointertap", (e: any) => {
          e.stopPropagation();
          handler();
        });
      } else {
        text.eventMode = "none";
      }

      text.x = x;
      this.breadcrumbContainer.addChild(text);
      x += text.width + gap;

      // add separator after all but the last crumb
      if (!isLast) {
        const sep = new Text({
          text: ">",
          style: {
            fontFamily: this.theme.fontFamily,
            fontSize: this.theme.fontSizeSmall,
            fill: sepColor,
          },
          resolution: this.theme.textResolution,
        });
        sep.eventMode = "none";
        sep.x = x;
        this.breadcrumbContainer.addChild(sep);
        x += sep.width + gap;
      }
    }
  }

  /** truncate breadcrumbs from the left when toolbar is too wide for the screen */
  private truncateBreadcrumbs(): void {
    if (this.breadcrumbs.length <= 2) return;

    const truncated: BreadcrumbItem[] = [{ label: "..." }, ...this.breadcrumbs.slice(-2)];
    const full = this.breadcrumbs;
    this.breadcrumbs = truncated;
    this.renderBreadcrumbs();

    // re-run positioning (mirrors layout(), but without recursing into truncateBreadcrumbs)
    const BTN_SIZE = 28;
    const gap = 6;
    const pad = { h: 8, v: 4 };

    const textBtnH = this.addBtn.height;
    const contentH = Math.max(textBtnH, BTN_SIZE);
    const totalHeight = contentH + pad.v * 2;
    const textBtnY = Math.round(pad.v + (contentH - textBtnH) / 2);
    const circleBtnY = Math.round(pad.v + (contentH - BTN_SIZE) / 2);

    let x = pad.h;

    if (this.breadcrumbContainer.children.length > 0) {
      this.breadcrumbContainer.x = x;
      this.breadcrumbContainer.y = textBtnY + 3;
      x += this.breadcrumbContainer.width + gap + 4;
    }

    if (this.shareBtn) {
      this.shareBtn.x = x;
      this.shareBtn.y = textBtnY;
      x += this.shareBtn.width + gap;
    }

    this.addBtn.x = x;
    this.addBtn.y = textBtnY;
    x += this.addBtn.width + gap;

    if (this.deleteBtn.visible) {
      this.deleteBtn.x = x;
      this.deleteBtn.y = textBtnY;
      x += this.deleteBtn.width + gap;
    }

    if (this.messagesBtn) {
      this.messagesBtn.x = x;
      this.messagesBtn.y = circleBtnY;
      x += BTN_SIZE + gap;
    }

    if (this.socialBtn) {
      this.socialBtn.x = x;
      this.socialBtn.y = circleBtnY;
      x += BTN_SIZE + gap;
    }

    const totalWidth = x - gap + pad.h;

    this.background.clear();
    this.background.roundRect(0, 0, totalWidth, totalHeight, 6);
    this.background.fill({ color: this.theme.toolbarBg, alpha: 0.92 });
    this.background.stroke({ color: this.theme.toolbarBorder, width: 1 });

    const margin = 8;
    this.root.x = Math.round(this.app.screen.width - totalWidth - margin);
    this.root.y = margin;

    this.breadcrumbs = full;

    if (this.flyoutOpen) {
      this.positionFlyout();
    }
  }

  // -- state updates ---------------------------------------------------------

  private updateSelection(_id: string | null): void {
    this.deleteBtn.visible = this.inputRouter.selectedWidgetIds.size > 0;
    this.layout();
  }

  // -- widget creation -------------------------------------------------------

  /** add a widget of the given type at a default staggered position. */
  private addWidget(type: string, singletonId?: string): void {
    this.widgetCounter++;
    const id = singletonId ?? crypto.randomUUID();
    const pos = this.pendingPlacement ?? {
      x: 100 + this.widgetCounter * 20,
      y: 100 + this.widgetCounter * 20,
    };
    this.pendingPlacement = null;
    const factory = this.registry.get(type);
    const width = factory?.metadata.defaultWidth ?? 200;
    const height = factory?.metadata.defaultHeight ?? 150;
    this.store.addWidget({
      id,
      type,
      x: pos.x,
      y: pos.y,
      width,
      height,
      zIndex: this.widgetCounter,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  }

  // -- cleanup ---------------------------------------------------------------

  /** update the notification count badge on the social/avatar button */
  updateSocialBadge(count: number): void {
    if (this.socialBtn) {
      this.socialBadge = this.refreshBadge(this.socialBadge, count, this.socialBtn, 28);
    }
  }

  /** update the notification count badge on the messages button */
  updateMessagesBadge(count: number): void {
    if (this.messagesBtn) {
      this.messagesBadge = this.refreshBadge(this.messagesBadge, count, this.messagesBtn, 28);
    }
  }

  /** unsubscribe from all listeners and remove the toolbar from the stage. */
  destroy(): void {
    this.closeFlyout();
    this.removeFlyoutBackdrop();
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
    // avatar sprite / mask are children of socialBtn and destroyed with it
    this.avatarSprite = null;
    this.avatarMask = null;
    this.socialBtn?.destroy({ children: true });
    this.messagesBtn?.destroy({ children: true });
    this.root.destroy({ children: true });
  }
}
