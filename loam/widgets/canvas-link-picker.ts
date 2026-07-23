// ---------------------------------------------------------------------------
// "link to canvas" picker widget — placeable on ANY writable canvas (not
// just the narthex). lets the user pick one of their own already-known
// canvases (sourced from their narthex's `canvas-card` widgets — see
// src/canvas/canvas-directory.ts) and adds a `canvas-card`-shaped widget
// pointing at it to the CURRENTLY open canvas. a canvas can never link to
// itself — enforced both here (candidate filtering excludes the current
// canvas doc id) and again, defensively, in the boot.ts handler that
// actually performs the add (see `SkeinRouter.linkCanvasToCurrent()`).
//
// this is a transient, wizard-style widget (mirrors canvas-wizard.ts /
// join-canvas.ts): picking a row dispatches a "skein:link-canvas" event and
// the widget removes itself, same "wizardWidgetId" self-cleanup convention
// those two widgets already use for "skein:create-canvas"/"skein:join-canvas".
//
// v1 scope, deliberately narrow: substring (case-insensitive) title filter,
// simple prev/next pagination over a plain row list — no fuzzy-ranking
// autocomplete, no real pixi scrolling (this codebase has no existing
// ScrollBox usage to build on; a paginated row list mirrors the established
// `widgets/narthex/social/canvas-bin.ts` pattern instead).
// ---------------------------------------------------------------------------

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { z } from "zod";
import {
  getCanvasesForPicker,
  type CanvasPickerCandidate,
} from "../src/canvas/canvas-directory";
import { createSkeinInput, type SkeinInputHandle } from "../src/widgets/skein-input";
import { registerWidgetBridge, unregisterWidgetBridge } from "../src/dev/test-bridge-registry";
import {
  safeColor,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../src/widgets/widget-types";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export const canvasLinkPickerSchema = z.object({
  filter: z.string().default(""),
});

export type CanvasLinkPickerState = z.infer<typeof canvasLinkPickerSchema>;

/** test hooks for one instance of this widget, keyed by widget id (see
 *  test-bridge-registry.ts's `registerWidgetBridge()` convention). */
export interface CanvasLinkPickerTestHooks {
  getCandidates(): CanvasPickerCandidate[];
  getFilteredCandidates(): CanvasPickerCandidate[];
  setFilter(text: string): void;
  getPage(): number;
  getTotalPages(): number;
  nextPage(): void;
  prevPage(): void;
  selectCandidate(canvasDocId: string): void;
  cancel(): void;
}

// ---------------------------------------------------------------------------
// visual constants (matches canvas-wizard.ts / join-canvas.ts)
// ---------------------------------------------------------------------------

const BG = 0x1a1a24;
const BORDER = 0x2a2a3e;
const FIELD_BG = 0x12121a;
const FIELD_BORDER = 0x333348;
const TEXT_COLOR = 0xf0f0ff;
const MUTED_TEXT = 0x666678;
const ACCENT = 0x6366f1;

const CARD_RADIUS = 6;
const BUTTON_RADIUS = 4;
const PADDING_X = 16;
const PADDING_Y = 14;
const FIELD_HEIGHT = 28;
const HEADER_SIZE = 14;
const FIELD_GAP = 10;
const BUTTON_HEIGHT = 30;
const FONT = "system-ui, sans-serif";
const RESOLUTION = 3;

const ROW_HEIGHT = 38;
const ROW_GAP = 6;
const PAGE_SIZE = 4;
const PAGER_HEIGHT = 20;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1).trimEnd() + "\u2026";
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export const canvasLinkPickerWidget: WidgetFactory<typeof canvasLinkPickerSchema> = {
  type: "canvas-link-picker",
  metadata: {
    name: "link to canvas",
    description: "link this canvas to another one you already know about",
    version: "0.1.0",
    category: "canvas",
    defaultWidth: 320,
    defaultHeight: 380,
  },
  schema: canvasLinkPickerSchema,
  editableProps: [],

  create(ctx: WidgetMountContext<typeof canvasLinkPickerSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let allCandidates: CanvasPickerCandidate[] = [];
    let status: "loading" | "ready" | "unavailable" | "read-only" = "loading";
    let page = 0;

    const isReadOnly = !!ctx.canvasStore?.isLocalViewer();

    // ---------------------------------------------------------------------
    // background card
    // ---------------------------------------------------------------------

    const cardBg = new Graphics();
    container.addChild(cardBg);

    const drawCard = (w: number, h: number) => {
      cardBg.clear();
      cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
      cardBg.fill({ color: BG });
      cardBg.stroke({ color: BORDER, width: 1 });
    };

    // ---------------------------------------------------------------------
    // header
    // ---------------------------------------------------------------------

    const headerText = new Text({
      text: "link to canvas",
      style: { fontFamily: FONT, fontSize: HEADER_SIZE, fontWeight: "bold", fill: TEXT_COLOR },
      resolution: RESOLUTION,
    });
    headerText.eventMode = "none";
    container.addChild(headerText);

    const headerSep = new Graphics();
    container.addChild(headerSep);

    // ---------------------------------------------------------------------
    // filter field
    // ---------------------------------------------------------------------

    const filterField: SkeinInputHandle = createSkeinInput({
      canvasElement: ctx.canvasElement,
      width: currentWidth - PADDING_X * 2,
      height: FIELD_HEIGHT,
      placeholder: "filter by title...",
      value: ctx.doc.current.filter || "",
      onChange: (value: string) => {
        ctx.doc.change((draft) => {
          draft.filter = value;
        });
        page = 0;
        layout(currentWidth, currentHeight);
      },
    });
    container.addChild(filterField.input);

    // ---------------------------------------------------------------------
    // status text (loading / empty / no-matches / read-only)
    // ---------------------------------------------------------------------

    const statusText = new Text({
      text: "",
      style: {
        fontFamily: FONT,
        fontSize: 11,
        fill: MUTED_TEXT,
        wordWrap: true,
        wordWrapWidth: currentWidth - PADDING_X * 2,
      },
      resolution: RESOLUTION,
    });
    statusText.eventMode = "none";
    statusText.visible = false;
    container.addChild(statusText);

    // ---------------------------------------------------------------------
    // row list
    // ---------------------------------------------------------------------

    const listContainer = new Container();
    container.addChild(listContainer);

    // ---------------------------------------------------------------------
    // pager
    // ---------------------------------------------------------------------

    const prevBtn = new Text({
      text: "\u2039 prev",
      style: { fontFamily: FONT, fontSize: 11, fill: ACCENT },
      resolution: RESOLUTION,
    });
    prevBtn.eventMode = "static";
    prevBtn.cursor = "pointer";
    prevBtn.visible = false;
    container.addChild(prevBtn);

    const pageLabel = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 11, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    pageLabel.eventMode = "none";
    pageLabel.visible = false;
    container.addChild(pageLabel);

    const nextBtn = new Text({
      text: "next \u203a",
      style: { fontFamily: FONT, fontSize: 11, fill: ACCENT },
      resolution: RESOLUTION,
    });
    nextBtn.eventMode = "static";
    nextBtn.cursor = "pointer";
    nextBtn.visible = false;
    container.addChild(nextBtn);

    prevBtn.on("pointertap", (e) => {
      e.stopPropagation();
      goToPage(page - 1);
    });
    nextBtn.on("pointertap", (e) => {
      e.stopPropagation();
      goToPage(page + 1);
    });

    // ---------------------------------------------------------------------
    // cancel button
    // ---------------------------------------------------------------------

    const cancelBtn = new Container();
    cancelBtn.eventMode = "static";
    cancelBtn.cursor = "pointer";
    const cancelBg = new Graphics();
    cancelBtn.addChild(cancelBg);
    const cancelText = new Text({
      text: "cancel",
      style: { fontFamily: FONT, fontSize: 12, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    cancelText.eventMode = "none";
    cancelBtn.addChild(cancelText);
    container.addChild(cancelBtn);

    cancelBtn.on("pointertap", (e) => {
      e.stopPropagation();
      cancel();
    });

    // ---------------------------------------------------------------------
    // behavior
    // ---------------------------------------------------------------------

    function getFiltered(): CanvasPickerCandidate[] {
      const q = ctx.doc.current.filter.trim().toLowerCase();
      if (!q) return allCandidates;
      return allCandidates.filter((c) => c.title.toLowerCase().includes(q));
    }

    function getTotalPages(): number {
      return Math.max(1, Math.ceil(getFiltered().length / PAGE_SIZE));
    }

    function goToPage(next: number): void {
      const clamped = Math.max(0, Math.min(getTotalPages() - 1, next));
      if (clamped === page) return;
      page = clamped;
      layout(currentWidth, currentHeight);
    }

    function selectCandidate(candidate: CanvasPickerCandidate): void {
      filterField.blur();
      window.dispatchEvent(
        new CustomEvent("skein:link-canvas", {
          detail: {
            canvasDocId: candidate.canvasDocId,
            title: candidate.title,
            description: candidate.description,
            previewUrl: candidate.previewUrl,
            color: candidate.color,
            wizardWidgetId: ctx.widgetId,
          },
        })
      );
    }

    function cancel(): void {
      filterField.blur();
      window.dispatchEvent(
        new CustomEvent("skein:remove-widget", {
          detail: { widgetId: ctx.widgetId },
        })
      );
    }

    function refreshCandidates(): void {
      if (isReadOnly) {
        status = "read-only";
        layout(currentWidth, currentHeight);
        return;
      }
      const repo = ctx.canvasStore?.repo;
      if (!repo) {
        status = "unavailable";
        layout(currentWidth, currentHeight);
        return;
      }
      status = "loading";
      layout(currentWidth, currentHeight);
      const excludeId = ctx.canvasStore?.handle.documentId;
      getCanvasesForPicker(repo, excludeId)
        .then((list) => {
          allCandidates = list;
          status = "ready";
          page = 0;
          layout(currentWidth, currentHeight);
        })
        .catch(() => {
          allCandidates = [];
          status = "ready";
          layout(currentWidth, currentHeight);
        });
    }

    function renderRows(rowWidth: number): void {
      while (listContainer.children.length > 0) {
        listContainer.removeChildAt(0).destroy({ children: true });
      }

      const filtered = getFiltered();
      const start = page * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);

      if (pageItems.length === 0) {
        statusText.visible = true;
        statusText.text =
          allCandidates.length === 0
            ? "no canvases to link yet \u2014 create or join one first"
            : "no matches";
        return;
      }
      statusText.visible = false;

      for (let i = 0; i < pageItems.length; i++) {
        const candidate = pageItems[i];
        const row = new Container();
        row.eventMode = "static";
        row.cursor = "pointer";
        row.y = i * (ROW_HEIGHT + ROW_GAP);
        row.hitArea = new Rectangle(0, 0, rowWidth, ROW_HEIGHT);

        const rowBg = new Graphics();
        rowBg.roundRect(0, 0, rowWidth, ROW_HEIGHT, 4);
        rowBg.fill({ color: FIELD_BG });
        rowBg.stroke({ color: FIELD_BORDER, width: 1 });
        row.addChild(rowBg);

        const swatch = new Graphics();
        swatch.roundRect(0, 0, 6, ROW_HEIGHT - 12, 2);
        swatch.fill({ color: safeColor(candidate.color) });
        swatch.x = 8;
        swatch.y = 6;
        row.addChild(swatch);

        const titleText = new Text({
          text: truncate(candidate.title || "untitled canvas", 34),
          style: { fontFamily: FONT, fontSize: 12, fontWeight: "bold", fill: TEXT_COLOR },
          resolution: RESOLUTION,
        });
        titleText.eventMode = "none";
        titleText.x = 20;
        titleText.y = 5;
        row.addChild(titleText);

        if (candidate.description) {
          const descText = new Text({
            text: truncate(candidate.description, 44),
            style: { fontFamily: FONT, fontSize: 10, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          descText.eventMode = "none";
          descText.x = 20;
          descText.y = 5 + titleText.height + 2;
          row.addChild(descText);
        }

        row.on("pointertap", (e) => {
          e.stopPropagation();
          selectCandidate(candidate);
        });

        listContainer.addChild(row);
      }
    }

    // ---------------------------------------------------------------------
    // layout
    // ---------------------------------------------------------------------

    const layout = (w: number, h: number) => {
      currentWidth = w;
      currentHeight = h;
      const contentW = w - PADDING_X * 2;
      let y = PADDING_Y;

      drawCard(w, h);

      headerText.x = PADDING_X;
      headerText.y = y;
      y += HEADER_SIZE + 8;

      headerSep.clear();
      headerSep.moveTo(PADDING_X, y);
      headerSep.lineTo(w - PADDING_X, y);
      headerSep.stroke({ color: BORDER, width: 1, alpha: 0.6 });
      y += 10;

      // cancel button — anchored to the bottom, laid out first so we know
      // how much vertical space remains for everything above it
      const cancelY = h - PADDING_Y - BUTTON_HEIGHT;
      cancelBg.clear();
      cancelBg.roundRect(0, 0, contentW, BUTTON_HEIGHT, BUTTON_RADIUS);
      cancelBg.fill({ color: FIELD_BG });
      cancelBg.stroke({ color: FIELD_BORDER, width: 1 });
      cancelBtn.x = PADDING_X;
      cancelBtn.y = cancelY;
      cancelText.x = (contentW - cancelText.width) / 2;
      cancelText.y = (BUTTON_HEIGHT - cancelText.height) / 2;

      if (status === "read-only" || status === "unavailable") {
        filterField.input.visible = false;
        listContainer.visible = false;
        prevBtn.visible = false;
        nextBtn.visible = false;
        pageLabel.visible = false;
        statusText.visible = true;
        statusText.style.wordWrapWidth = contentW;
        statusText.text =
          status === "read-only"
            ? "you don't have permission to link canvases on this canvas"
            : "canvas directory unavailable";
        statusText.x = PADDING_X;
        statusText.y = y;
        return;
      }

      filterField.input.visible = true;
      filterField.input.x = PADDING_X;
      filterField.input.y = y;
      filterField.setWidth(contentW);
      if (!filterField.isEditing) {
        filterField.value = ctx.doc.current.filter;
      }
      y += FIELD_HEIGHT + FIELD_GAP;

      if (status === "loading") {
        listContainer.visible = false;
        prevBtn.visible = false;
        nextBtn.visible = false;
        pageLabel.visible = false;
        statusText.visible = true;
        statusText.style.wordWrapWidth = contentW;
        statusText.text = "loading canvases...";
        statusText.x = PADDING_X;
        statusText.y = y;
        return;
      }

      listContainer.visible = true;
      listContainer.x = PADDING_X;
      listContainer.y = y;

      const totalPages = getTotalPages();
      const showPager = totalPages > 1;
      const pagerHeight = showPager ? PAGER_HEIGHT + FIELD_GAP : 0;
      const listAreaHeight = Math.max(
        ROW_HEIGHT,
        cancelY - FIELD_GAP - pagerHeight - y
      );

      renderRows(contentW);
      statusText.x = PADDING_X;
      statusText.y = y;
      void listAreaHeight;

      if (showPager) {
        const pagerY = cancelY - FIELD_GAP - PAGER_HEIGHT;
        prevBtn.visible = page > 0;
        nextBtn.visible = page < totalPages - 1;
        pageLabel.visible = true;
        pageLabel.text = `page ${page + 1} / ${totalPages}`;
        prevBtn.x = PADDING_X;
        prevBtn.y = pagerY;
        pageLabel.x = PADDING_X + (contentW - pageLabel.width) / 2;
        pageLabel.y = pagerY;
        nextBtn.x = PADDING_X + contentW - nextBtn.width;
        nextBtn.y = pagerY;
      } else {
        prevBtn.visible = false;
        nextBtn.visible = false;
        pageLabel.visible = false;
      }
    };

    registerWidgetBridge(ctx.widgetId, {
      getCandidates: () => [...allCandidates],
      getFilteredCandidates: () => getFiltered(),
      setFilter: (text: string) => {
        ctx.doc.change((draft) => {
          draft.filter = text;
        });
        page = 0;
        layout(currentWidth, currentHeight);
      },
      getPage: () => page,
      getTotalPages: () => getTotalPages(),
      nextPage: () => goToPage(page + 1),
      prevPage: () => goToPage(page - 1),
      selectCandidate: (canvasDocId: string) => {
        const candidate = allCandidates.find((c) => c.canvasDocId === canvasDocId);
        if (candidate) selectCandidate(candidate);
      },
      cancel,
    } satisfies CanvasLinkPickerTestHooks);

    refreshCandidates();
    layout(currentWidth, currentHeight);

    return {
      container,
      resize(width: number, height: number) {
        layout(width, height);
      },
      destroy() {
        unregisterWidgetBridge(ctx.widgetId);
        filterField.destroy();
        container.destroy({ children: true });
      },
    };
  },
};
