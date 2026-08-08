/**
 * reusable "collapsed trigger expands in-place into a panel, dismissed by
 * clicking outside it" mechanism — ports the _design_ (not the code) of
 * trek-minus-paris's `editor.js` `createCutModeControl()`/
 * `createSegmentsViewControl()` expand/collapse+backdrop pattern into a
 * generic pixi helper any widget can reuse (stfu's cut-playback-mode picker
 * first; stfu's "manage revisions" panel later — see docs/stfu-widget-plan.md).
 *
 * unlike trek-minus-paris's version (which reparents the control up to the
 * whole app's `stage` so its click-away backdrop can cover the entire
 * canvas), this helper only ever needs to cover `overlayParent`'s own local
 * bounds — mirrors the existing `filez-widget.ts` domain-filter-popup
 * convention (a widget-scoped backdrop, not a canvas-wide one), since each
 * skein widget already owns its own bounded container. callers should pass
 * a container that's already the topmost element in its own sibling order
 * (or at least topmost among the content the panel should cover) so the
 * panel+backdrop render above everything they need to obscure while open.
 */

import { Container, Graphics } from "pixi.js";

export interface ExpandingPanelOptions {
  /** backdrop + panel are added here (in that z-order) — pick a container
   *  that's already topmost among its siblings so both render above
   *  whatever the panel needs to cover while open. */
  overlayParent: Container;
  /** the panel's own content — caller builds/positions/updates this;
   *  hidden until `open()`/`toggle()` makes it visible. */
  panel: Container;
  onOpenChange?: (open: boolean) => void;
}

export interface ExpandingPanelHandle {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** redraw the backdrop to cover (0, 0, width, height) in `overlayParent`'s
   *  local space — call whenever the covered area's size changes. */
  resize(width: number, height: number): void;
  destroy(): void;
}

export function createExpandingPanel(options: ExpandingPanelOptions): ExpandingPanelHandle {
  const { overlayParent, panel, onOpenChange } = options;

  let open = false;
  let width = 0;
  let height = 0;

  const backdrop = new Graphics();
  backdrop.eventMode = "static";
  backdrop.visible = false;
  backdrop.on("pointerdown", (e) => {
    e.stopPropagation();
    close();
  });
  overlayParent.addChild(backdrop);

  panel.visible = false;
  overlayParent.addChild(panel);

  function drawBackdrop(): void {
    backdrop.clear();
    if (width <= 0 || height <= 0) return;
    // visibly dims whatever's behind the panel (matches trek-minus-paris's
    // editor.js `createSegmentsViewControl()`/dialog backdrops), and still
    // catches pointer events for click-away.
    backdrop.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.4 });
  }

  // keeps the panel fully inside (0, 0, width, height) — every skein widget
  // clips its own content to its bounds (see widget-frame.ts), so a panel
  // positioned/sized without regard for the covered area would get cut off
  // rather than just overlapping sibling content.
  function clampPanelPosition(): void {
    if (width > 0) panel.x = Math.min(Math.max(0, panel.x), Math.max(0, width - panel.width));
    if (height > 0) panel.y = Math.min(Math.max(0, panel.y), Math.max(0, height - panel.height));
  }

  function open_(): void {
    if (open) return;
    open = true;
    backdrop.visible = true;
    panel.visible = true;
    clampPanelPosition();
    onOpenChange?.(true);
  }

  function close(): void {
    if (!open) return;
    open = false;
    backdrop.visible = false;
    panel.visible = false;
    onOpenChange?.(false);
  }

  return {
    get isOpen() {
      return open;
    },
    open: open_,
    close,
    toggle() {
      if (open) close();
      else open_();
    },
    resize(newWidth: number, newHeight: number) {
      width = Math.max(0, newWidth);
      height = Math.max(0, newHeight);
      drawBackdrop();
      clampPanelPosition();
    },
    destroy() {
      backdrop.destroy();
      panel.destroy();
    },
  };
}
