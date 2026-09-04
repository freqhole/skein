import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  type FederatedPointerEvent,
} from "pixi.js";
import { ScrollBox } from "@pixi/ui";
import { z } from "zod";
import type { DocumentId } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import type { CanvasDocument } from "../../src/canvas/canvas-doc";
import { resolveDocReadyCached } from "../../src/p2p/doc-ready";
import type { WidgetController, WidgetFactory, WidgetMountContext } from "../../src/widgets/widget-types";
import {
  cancelTransfer,
  clearCompletedTransfers,
  pauseTransfer,
} from "../../src/file-utils/pending-transfers";
import { subscribeToLocalFiles, type LocalFilesResult } from "../../src/file-utils/local-files";
import type { LocalBlobItem } from "../../src/file-utils/local-blobs";
import { getBlobCanvasRefs } from "../../src/file-utils/blob-canvas-refs";
import { freeUpLocalBlobCopy } from "../../src/file-utils/blob-locality";
import { unregisterBlobFromAllCanvases } from "../../src/file-utils/unregister-blob";
import {
  createFileWidgetFromBlob,
  CREATE_FILE_WIDGET_DEFAULT_WIDTH,
  CREATE_FILE_WIDGET_DEFAULT_HEIGHT,
} from "../../src/file-utils/create-file-widget";
import { createSkeinInput } from "../../src/widgets/skein-input";
import { formatFileSize, formatRelativeTime } from "../../src/widgets/format";
import { classifyDomain } from "../../src/storage/blob-store";
import { getThumbnailDataUrl } from "../../src/file-utils/thumbnail-utils";

const TAG = "widgets.filez";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

// mirrors pending-transfers.ts's PendingTransferItem — this widget never
// mutates the doc itself (state is driven entirely by boot.ts's
// subscribeToPendingTransfers wiring), the schema exists only to type
// ctx.doc.current for the ephemeral overlay mount (see mountCanvasInfoOverlay's
// pattern in boot.ts, which this widget follows).
const pendingTransferItemSchema = z.object({
  id: z.string(),
  direction: z.enum(["upload", "download", "serving"]),
  state: z.enum(["queued", "active", "completed"]),
  blobId: z.string().optional(),
  filename: z.string().optional(),
  peerId: z.string().optional(),
  peerName: z.string().optional(),
  canvasIds: z.array(z.string()).optional(),
  fraction: z.number().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  canPause: z.boolean(),
  canCancel: z.boolean(),
});

export const filezSchema = z.object({
  items: z.array(pendingTransferItemSchema).default([]),
});

export type FilezState = z.infer<typeof filezSchema>;
type FilezItem = z.infer<typeof pendingTransferItemSchema>;

// ---------------------------------------------------------------------------
// layout constants
// ---------------------------------------------------------------------------

const BG = 0x1a1a24;
const BORDER = 0x2a2a3e;
const TEXT_COLOR = 0xf0f0ff;
const MUTED_TEXT = 0x666678;
const ACCENT_COLOR = 0xd946ef;
const CARD_RADIUS = 6;
const PADDING_X = 16;
const PADDING_Y = 14;
const HEADER_HEIGHT = 30;
const ROW_HEIGHT = 62;
const ROW_PADDING_X = 10;
const COLOR_STRIPE_WIDTH = 3;
const TITLE_FONT_SIZE = 12;
const ROW_NAME_SIZE = 11;
const ROW_SUB_SIZE = 9;
const ROW_ALT_BG = 0x1f1f2c;
const CTRL_BTN_W = 44;
const CTRL_BTN_H = 16;
const CTRL_BTN_GAP = 6;
const FONT = "system-ui, sans-serif";
const RESOLUTION = 3;
const TAB_GAP = 16;
const FILTER_ROW_HEIGHT = 26;
const FILTER_GAP = 12;
const LOCAL_ROW_HEIGHT = 62;
const LOCAL_PAGE_SIZE = 50;
const LOAD_MORE_ROW_HEIGHT = 24;
const CONFIRM_TIMEOUT_MS = 5000;
const SEARCH_DEBOUNCE_MS = 300;

// local-files row thumbnail (image/video-frame/audio-waveform preview, or a
// domain icon fallback when no preview is available)
const LOCAL_THUMB_SIZE = 42;
const LOCAL_THUMB_GAP = 10;

// domain filter (multi-select) dropdown, tab 2 filter row
const DOMAIN_FILTER_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "photo", label: "photo" },
  { key: "video", label: "video" },
  { key: "audio", label: "audio" },
  { key: "document", label: "document" },
  { key: "file", label: "other" },
];
const DOMAIN_FILTER_ROW_H = 20;
const DOMAIN_FILTER_POPUP_W = 120;

// drag-out-to-canvas (local files tab only) — mirrors bin-drag.ts's ghost
// drag pattern, since both convert a global pointer position to world-space
// coordinates via `world.toLocal()` on a container that shares the same
// PixiJS stage as the widget frames.
const DRAG_THRESHOLD = 5;
const GHOST_WIDTH = 140;
const GHOST_HEIGHT = 28;
const GHOST_RADIUS = 4;
const GHOST_BG = 0x2a2a2a;
const GHOST_TEXT_COLOR = 0xe0e0e0;
const GHOST_ALPHA = 0.85;
const GHOST_FONT_SIZE = 10;

const DIRECTION_INFO: Record<FilezItem["direction"], { label: string; color: number }> = {
  upload: { label: "upload", color: 0x3b82f6 },
  download: { label: "download", color: 0x22c55e },
  serving: { label: "serving", color: 0x8b5cf6 },
};

// domain icon fallback (shown until/unless a real thumbnail loads) — glyph
// left blank for "file" so the caller falls back to the filename's first
// letter, matching the bin widget's existing generic-file fallback.
const DOMAIN_ICON_INFO: Record<string, { glyph: string; color: number }> = {
  photo: { glyph: "\u25a7", color: 0x22c55e },
  video: { glyph: "\u25b6", color: 0x06b6d4 },
  audio: { glyph: "\u266a", color: 0x8b5cf6 },
  document: { glyph: "\u25a4", color: 0xf59e0b },
  file: { glyph: "", color: MUTED_TEXT },
};

function domainIconGlyph(domain: string, filename: string): string {
  const glyph = DOMAIN_ICON_INFO[domain]?.glyph;
  return glyph || (filename.charAt(0) || "?").toUpperCase();
}

function domainIconColor(domain: string): number {
  return DOMAIN_ICON_INFO[domain]?.color ?? MUTED_TEXT;
}

/** truncate a string so it fits within a rough character budget. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1).trimEnd() + "\u2026";
}

function truncateId(id: string, len = 10): string {
  return id.length > len ? `${id.slice(0, len)}\u2026` : id;
}


function sortFieldLabel(field: "created_at" | "size" | "filename"): string {
  return field === "created_at" ? "date" : field === "size" ? "size" : "name";
}

/** relative-time label for a completed row's completedAt timestamp. */
function formatCompletedAgo(completedAt: number | undefined): string {
  if (!completedAt) return "done";
  const deltaMs = Date.now() - completedAt;
  if (deltaMs < 60_000) return "done just now";
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 60) return `done ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `done ${hours}h ago`;
}

// ---------------------------------------------------------------------------
// widget factory
// ---------------------------------------------------------------------------

export const filezWidget: WidgetFactory<typeof filezSchema> = {
  type: "filez",
  metadata: {
    name: "filez",
    description: "pending uploads, downloads, and outgoing transfers",
    version: "0.1.0",
    category: "narthex",
    hidden: true,
    singleton: true,
    singletonId: "skein-filez",
    defaultWidth: 560,
    defaultHeight: 340,
  },
  schema: filezSchema,
  editableProps: [],

  create(ctx: WidgetMountContext<typeof filezSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let destroyed = false;

    // which of the two tabs is currently shown. not persisted — resets to
    // "pending" every time the overlay is (re)mounted, same as scroll
    // position.
    let activeTab: "pending" | "local" = "pending";

    // -------------------------------------------------------------------
    // tab 1 ("pending transfers") state
    // -------------------------------------------------------------------

    // canvas title lookups are best-effort/async (repo.find always returns
    // a Promise) — cache resolved titles and re-layout once they arrive,
    // rather than blocking row rendering on them. undefined = not yet
    // attempted, null = attempted and unresolvable. shared with tab 2's
    // canvas-refs subtitle line below.
    const canvasTitleCache = new Map<string, string | null>();
    const resolvingCanvasIds = new Set<string>();

    // tracks a pause/cancel click that's in flight for a given item id, so
    // the row can show "pausing…"/"cancelling…" and ignore a second click
    // instead of leaving the button looking inert until the next poll tick
    // (300ms away) actually changes the item's state.
    const pendingActions = new Map<string, "pause" | "cancel">();

    function resolveCanvasTitle(canvasDocId: string): string | null {
      if (canvasTitleCache.has(canvasDocId)) return canvasTitleCache.get(canvasDocId) ?? null;
      if (!ctx.canvasStore || resolvingCanvasIds.has(canvasDocId)) return null;
      resolvingCanvasIds.add(canvasDocId);
      resolveDocReadyCached<CanvasDocument>(ctx.canvasStore.repo, canvasDocId as DocumentId, {
        timeoutMs: 4000,
      })
        .then((handle) => {
          resolvingCanvasIds.delete(canvasDocId);
          const title = handle?.isReady() ? handle.doc()?.title || null : null;
          canvasTitleCache.set(canvasDocId, title);
          if (!destroyed) layout(currentWidth, currentHeight);
        })
        .catch(() => {
          resolvingCanvasIds.delete(canvasDocId);
          canvasTitleCache.set(canvasDocId, null);
        });
      return null;
    }

    // -------------------------------------------------------------------
    // tab 2 ("local files") state
    // -------------------------------------------------------------------

    let localItems: LocalBlobItem[] = [];
    let localTotalCount = 0;
    let localTotalSize = 0;
    let localLoading = false;
    let localError: string | null = null;
    let localSort: "created_at" | "size" | "filename" = "created_at";
    let localDirection: "asc" | "desc" = "desc";
    let localSearch = "";
    let localOrphansOnly = false;
    let localDomainFilter = new Set<string>();
    let domainFilterOpen = false;
    let localAppendMode = false;
    let localHasMore = true;
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    // resolved thumbnail textures for local-files rows, keyed by blake3 (or
    // blobId when blake3 is absent) — same cache-then-relayout shape as
    // blobRefsCache/resolveBlobRefs below. `null` means "resolved, no
    // preview available" (non-previewable domain, or the fetch/decode
    // failed) — falls back to the domain icon.
    const localThumbCache = new Map<string, Texture | null>();
    const resolvingLocalThumbs = new Set<string>();

    // blob -> referencing-canvas-ids, resolved best-effort/async (same
    // cache-then-relayout shape as resolveCanvasTitle above) so the orphan
    // filter and per-row canvas-refs line don't block row rendering on it.
    // null once resolved with zero refs (orphan); undefined-equivalent
    // (absent from map) = not yet resolved.
    const blobRefsCache = new Map<string, string[]>();
    const resolvingBlobRefs = new Set<string>();

    const pendingPurges = new Set<string>();
    let confirmPurgeId: string | null = null;
    let confirmPurgeTimer: ReturnType<typeof setTimeout> | null = null;
    let confirmBulkPurge = false;
    let confirmBulkPurgeTimer: ReturnType<typeof setTimeout> | null = null;

    // "add to canvas" — a click-driven alternative to dragging a row onto
    // the canvas (see startRowDrag below), for the same drop target.
    const addingToCanvas = new Set<string>();

    /** returns cached canvas-refs for a blob, kicking off (and caching) an
     *  async lookup on a cache miss. returns `null` while unresolved so
     *  callers can render a neutral state until the real answer arrives. */
    function resolveBlobRefs(blobId: string, blake3: string | undefined): string[] | null {
      const key = blake3 || blobId;
      if (blobRefsCache.has(key)) return blobRefsCache.get(key)!;
      if (resolvingBlobRefs.has(key)) return null;
      resolvingBlobRefs.add(key);
      getBlobCanvasRefs(blobId, blake3)
        .then((refs) => {
          resolvingBlobRefs.delete(key);
          blobRefsCache.set(key, refs);
          if (!destroyed) layout(currentWidth, currentHeight);
        })
        .catch(() => {
          resolvingBlobRefs.delete(key);
          blobRefsCache.set(key, []);
        });
      return null;
    }

    function isOrphan(item: LocalBlobItem): boolean | null {
      const refs = resolveBlobRefs(item.blobId, item.blake3);
      if (refs === null) return null; // not resolved yet — don't count either way
      return refs.length === 0;
    }

    /** returns a cached thumbnail texture for a local-files row, kicking off
     *  (and caching) an async fetch+decode on a cache miss. returns `null`
     *  while unresolved OR once resolved-with-no-preview — either way the
     *  caller falls back to the domain icon until a real texture arrives. */
    function resolveLocalThumbTexture(item: LocalBlobItem): Texture | null {
      const key = item.blake3 || item.blobId;
      if (localThumbCache.has(key)) return localThumbCache.get(key)!;
      if (resolvingLocalThumbs.has(key)) return null;

      const domain = classifyDomain(item.mime ?? "");
      if (domain !== "photo" && domain !== "video" && domain !== "audio") {
        // not a previewable domain — resolve immediately, no fetch needed
        localThumbCache.set(key, null);
        return null;
      }

      resolvingLocalThumbs.add(key);
      (async () => {
        try {
          const dataUrl = await getThumbnailDataUrl(item.blobId, {
            size: LOCAL_THUMB_SIZE * 2,
            square: true,
          });
          if (!dataUrl) {
            localThumbCache.set(key, null);
            return;
          }
          const tex = await Assets.load<Texture>(dataUrl);
          localThumbCache.set(key, tex && tex.source?.style ? tex : null);
        } catch (err) {
          log.debug(TAG, `resolveLocalThumbTexture: failed for ${key.slice(0, 12)}...`, err);
          localThumbCache.set(key, null);
        } finally {
          resolvingLocalThumbs.delete(key);
          if (!destroyed) layout(currentWidth, currentHeight);
        }
      })();
      return null;
    }

    const localFilesSub = subscribeToLocalFiles((result: LocalFilesResult) => {
      localLoading = false;
      if (result.ok) {
        localItems = localAppendMode ? [...localItems, ...result.items] : result.items;
        localTotalCount = result.totalCount;
        localTotalSize = result.totalSize;
        localHasMore = localItems.length < result.totalCount;
        localError = null;
        maybeAutoLoadForFilter();
      } else {
        localError = result.error;
      }
      if (!destroyed) layout(currentWidth, currentHeight);
    });

    /** (re)query tab 2's data. `append: true` fetches the next page and
     *  keeps what's already loaded; `append: false` (a fresh search/sort/
     *  tab-switch) replaces the list from offset 0. */
    function queryLocalFiles(opts: { append: boolean }): void {
      localAppendMode = opts.append;
      localLoading = true;
      if (!opts.append && !destroyed) layout(currentWidth, currentHeight);
      void localFilesSub.query({
        sort: localSort,
        direction: localDirection,
        search: localSearch || undefined,
        limit: LOCAL_PAGE_SIZE,
        offset: opts.append ? localItems.length : 0,
      });
    }

    /** the orphan/domain filters only ever match within already-loaded
     *  pages (see renderLocalRows) — while either is active, keep fetching
     *  subsequent pages automatically so the filtered view (and the
     *  "load more" footer's visibility) reflects the FULL local library
     *  instead of stopping partway through it. */
    function maybeAutoLoadForFilter(): void {
      const filterActive = localOrphansOnly || localDomainFilter.size > 0;
      if (filterActive && localHasMore && !localLoading) {
        queryLocalFiles({ append: true });
      }
    }

    function switchTab(tab: "pending" | "local"): void {
      if (activeTab === tab) return;
      activeTab = tab;
      if (tab === "local" && localItems.length === 0 && !localLoading) {
        queryLocalFiles({ append: false });
      }
      scrollBox.scrollTop();
      layout(currentWidth, currentHeight);
    }

    function handleSortClick(field: "created_at" | "size" | "filename"): void {
      if (localSort === field) {
        localDirection = localDirection === "asc" ? "desc" : "asc";
      } else {
        localSort = field;
        localDirection = field === "filename" ? "asc" : "desc";
      }
      scrollBox.scrollTop();
      queryLocalFiles({ append: false });
    }

    function handleOrphanToggle(): void {
      localOrphansOnly = !localOrphansOnly;
      maybeAutoLoadForFilter();
      layout(currentWidth, currentHeight);
    }

    /** free a blob's local bytes, after cross-canvas snatchedBy cleanup
     *  (phase 3) so peers stop targeting us for downloads of a blob we no
     *  longer have. optimistic on success: removes the row locally instead
     *  of re-querying the whole page (cheaper, avoids reshuffling offsets
     *  mid-scroll). external files (tauri-only, user-picked outside
     *  skein's managed dir) are only ever "forgotten" here — the actual
     *  file on disk is never touched, `freeUpLocalBlobCopy` already knows
     *  the difference. */
    async function executePurge(item: LocalBlobItem): Promise<void> {
      pendingPurges.add(item.blobId);
      layout(currentWidth, currentHeight);
      try {
        if (ctx.canvasStore) {
          await unregisterBlobFromAllCanvases(ctx.canvasStore.repo, item.blobId, item.blake3).catch(
            (err) => log.debug(TAG, "unregisterBlobFromAllCanvases failed (non-fatal):", err)
          );
        }
        await freeUpLocalBlobCopy(item.blobId, item.blake3);
        localItems = localItems.filter((i) => i.blobId !== item.blobId);
        localTotalCount = Math.max(0, localTotalCount - 1);
        localTotalSize = Math.max(0, localTotalSize - item.size);
        blobRefsCache.delete(item.blake3 || item.blobId);
      } catch (err) {
        log.warn(TAG, `purge failed for ${item.blobId.slice(0, 12)}...:`, err);
      } finally {
        pendingPurges.delete(item.blobId);
        if (!destroyed) layout(currentWidth, currentHeight);
      }
    }

    function handlePurgeClick(item: LocalBlobItem): void {
      if (pendingPurges.has(item.blobId)) return;
      if (confirmPurgeId === item.blobId) {
        if (confirmPurgeTimer !== null) clearTimeout(confirmPurgeTimer);
        confirmPurgeTimer = null;
        confirmPurgeId = null;
        void executePurge(item);
        return;
      }
      confirmPurgeId = item.blobId;
      if (confirmPurgeTimer !== null) clearTimeout(confirmPurgeTimer);
      confirmPurgeTimer = setTimeout(() => {
        confirmPurgeId = null;
        confirmPurgeTimer = null;
        if (!destroyed) layout(currentWidth, currentHeight);
      }, CONFIRM_TIMEOUT_MS);
      layout(currentWidth, currentHeight);
    }

    function cancelPurgeClick(): void {
      if (confirmPurgeTimer !== null) clearTimeout(confirmPurgeTimer);
      confirmPurgeTimer = null;
      confirmPurgeId = null;
      layout(currentWidth, currentHeight);
    }

    /** create a `file` widget from an already-local blob on the currently
     *  open canvas, at the default drop position — see create-file-widget.ts.
     *  hidden entirely when `canDragOut()` is false (narthex / viewer /
     *  overlay not wired with `world`/`canvasStore`, see below). */
    function handleAddToCanvas(item: LocalBlobItem): void {
      if (addingToCanvas.has(item.blobId) || !ctx.canvasStore) return;
      const store = ctx.canvasStore;
      addingToCanvas.add(item.blobId);
      layout(currentWidth, currentHeight);
      createFileWidgetFromBlob(store.repo, store, {
        blobId: item.blobId,
        filename: item.filename,
        mime: item.mime,
        size: item.size,
        blake3: item.blake3,
      })
        .catch((err) => {
          log.warn(TAG, `add-to-canvas: failed to create file widget from blob ${item.blobId}:`, err);
        })
        .finally(() => {
          addingToCanvas.delete(item.blobId);
          if (!destroyed) layout(currentWidth, currentHeight);
        });
    }

    /** purge every currently-*loaded* orphaned row in one go (bounded to
     *  what's actually fetched so far — the orphan filter only ever
     *  filters the loaded page(s) client-side, see renderLocalRows). */
    function handleBulkPurgeClick(): void {
      const orphans = localItems.filter((i) => isOrphan(i) === true);
      if (orphans.length === 0) return;
      if (confirmBulkPurge) {
        if (confirmBulkPurgeTimer !== null) clearTimeout(confirmBulkPurgeTimer);
        confirmBulkPurgeTimer = null;
        confirmBulkPurge = false;
        void Promise.allSettled(orphans.map((item) => executePurge(item)));
        return;
      }
      confirmBulkPurge = true;
      if (confirmBulkPurgeTimer !== null) clearTimeout(confirmBulkPurgeTimer);
      confirmBulkPurgeTimer = setTimeout(() => {
        confirmBulkPurge = false;
        confirmBulkPurgeTimer = null;
        if (!destroyed) layout(currentWidth, currentHeight);
      }, CONFIRM_TIMEOUT_MS);
      layout(currentWidth, currentHeight);
    }

    // -------------------------------------------------------------------
    // background card
    // -------------------------------------------------------------------

    const cardBg = new Graphics();
    container.addChild(cardBg);

    const drawCard = (w: number, h: number) => {
      cardBg.clear();
      cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
      cardBg.fill({ color: BG });
      cardBg.stroke({ color: BORDER, width: 1 });
    };

    // -------------------------------------------------------------------
    // header: tab switch (left) + tab-specific summary/actions (right)
    // -------------------------------------------------------------------

    function buildTabLabel(label: string, tab: "pending" | "local"): Text {
      const text = new Text({
        text: label,
        style: { fontFamily: FONT, fontSize: TITLE_FONT_SIZE, fill: TEXT_COLOR },
        resolution: RESOLUTION,
      });
      text.eventMode = "static";
      text.cursor = "pointer";
      text.on("pointertap", (e) => {
        e.stopPropagation();
        switchTab(tab);
      });
      return text;
    }

    const pendingTabText = buildTabLabel("pending", "pending");
    container.addChild(pendingTabText);
    const localTabText = buildTabLabel("local", "local");
    container.addChild(localTabText);
    const tabUnderline = new Graphics();
    container.addChild(tabUnderline);

    const countText = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    countText.eventMode = "none";
    container.addChild(countText);

    // tab 1 only — visible while there's at least one completed row to clear.
    const clearCompletedBtn = new Text({
      text: "clear completed",
      style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    clearCompletedBtn.eventMode = "static";
    clearCompletedBtn.cursor = "pointer";
    clearCompletedBtn.on("pointertap", (e) => {
      e.stopPropagation();
      clearCompletedTransfers();
    });
    container.addChild(clearCompletedBtn);

    // tab 2 only — visible while the orphan filter is on and at least one
    // loaded row qualifies.
    const bulkPurgeBtn = new Text({
      text: "purge orphans",
      style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    bulkPurgeBtn.eventMode = "static";
    bulkPurgeBtn.cursor = "pointer";
    bulkPurgeBtn.on("pointertap", (e) => {
      e.stopPropagation();
      handleBulkPurgeClick();
    });
    container.addChild(bulkPurgeBtn);

    // -------------------------------------------------------------------
    // tab 2 filter row: search box, sort buttons, orphan-only toggle
    // -------------------------------------------------------------------

    const searchInputHandle = createSkeinInput({
      canvasElement: ctx.canvasElement,
      width: 140,
      height: 20,
      placeholder: "search filename\u2026",
      onChange: (value) => {
        if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          searchDebounceTimer = null;
          localSearch = value;
          scrollBox.scrollTop();
          queryLocalFiles({ append: false });
        }, SEARCH_DEBOUNCE_MS);
      },
    });
    container.addChild(searchInputHandle.input);

    function buildSortLabel(field: "created_at" | "size" | "filename"): Text {
      const text = new Text({
        text: sortFieldLabel(field),
        style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      text.eventMode = "static";
      text.cursor = "pointer";
      text.on("pointertap", (e) => {
        e.stopPropagation();
        handleSortClick(field);
      });
      return text;
    }

    const sortLabels: Array<{ field: "created_at" | "size" | "filename"; text: Text }> = [
      { field: "created_at", text: buildSortLabel("created_at") },
      { field: "size", text: buildSortLabel("size") },
      { field: "filename", text: buildSortLabel("filename") },
    ];
    for (const { text } of sortLabels) container.addChild(text);

    const orphanToggle = new Text({
      text: "\u25a1 orphans only",
      style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    orphanToggle.eventMode = "static";
    orphanToggle.cursor = "pointer";
    orphanToggle.on("pointertap", (e) => {
      e.stopPropagation();
      handleOrphanToggle();
    });
    container.addChild(orphanToggle);

    // domain-type multi-select filter — the clickable label lives in the
    // filter row; the popup + backdrop are added further below (after the
    // scroll list) so they render on top of it.
    const domainFilterLabel = new Text({
      text: "type \u25be",
      style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    domainFilterLabel.eventMode = "static";
    domainFilterLabel.cursor = "pointer";
    domainFilterLabel.on("pointertap", (e) => {
      e.stopPropagation();
      domainFilterOpen = !domainFilterOpen;
      layout(currentWidth, currentHeight);
    });
    container.addChild(domainFilterLabel);

    // -------------------------------------------------------------------
    // list area (scrollable) — shared by both tabs via @pixi/ui's
    // ScrollBox (see hub-profile-panel.ts for why: three earlier
    // hand-rolled wheel/hitArea attempts across this codebase didn't
    // scroll reliably in production; ScrollBox's document-capture wheel
    // listener + isOver gating solves the whole class of problem). only
    // one tab's rows are ever in `inner` at a time — rebuilt on every
    // layout() call.
    // -------------------------------------------------------------------

    let listAreaY = 0;
    let listAreaHeight = 0;
    let scrollBoxW = 0;
    let scrollBoxH = 0;
    // ScrollBox.setSize() always calls its own scrollTop() internally, so
    // it must only be called when the size actually changes — otherwise
    // every content-only re-layout (an async canvas-title/blob-ref
    // resolution, a doc change, a purge settling) would silently reset the
    // user's scroll position to the top.
    let lastScrollBoxW = -1;
    let lastScrollBoxH = -1;

    // ScrollBox needs a document-level capture-phase wheel listener
    // registered BEFORE construction: the canvas viewport's own pan
    // handler lives on the canvas element and was registered at app boot,
    // so a same-target listener can't jump that queue — only a
    // document-level ancestor capture-phase listener runs first. this also
    // primes ScrollBox's `isOver` state for the common case where the
    // pointer is already over the panel when it mounts (ScrollBox only
    // flips `isOver` on a pointerover crossing).
    const onNativeWheel = (e: WheelEvent) => {
      if (destroyed) return;
      if (!scrollBox.visible) return;
      const rect = ctx.canvasElement.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const g = scrollBox.getGlobalPosition();
      const inside = px >= g.x && px <= g.x + scrollBoxW && py >= g.y && py <= g.y + scrollBoxH;
      (scrollBox as unknown as { isOver: boolean }).isOver = inside;
      if (inside) {
        (e as WheelEvent & { _skeinWidgetScroll?: boolean })._skeinWidgetScroll = true;
      }
    };
    document.addEventListener("wheel", onNativeWheel, { capture: true, passive: true });

    const scrollBox = new ScrollBox({
      width: 10,
      height: 10,
      background: BG,
      globalScroll: false,
      disableEasing: true,
    });
    container.addChild(scrollBox);

    const inner = new Container();
    inner.eventMode = "static";
    const innerSizingRect = new Graphics();
    innerSizingRect.rect(0, 0, 1, 1);
    innerSizingRect.fill({ color: 0x000000, alpha: 0.0001 });
    inner.addChild(innerSizingRect);
    scrollBox.addItem(inner);

    const emptyText = new Text({
      text: "no transfers",
      style: { fontFamily: FONT, fontSize: 11, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    emptyText.eventMode = "none";
    container.addChild(emptyText);

    // domain filter popup — added after the scroll list so it renders on
    // top of it (pixi z-order follows child order; no sortableChildren
    // needed here since these two are the last children added).
    const domainFilterBackdrop = new Graphics();
    domainFilterBackdrop.eventMode = "static";
    domainFilterBackdrop.visible = false;
    domainFilterBackdrop.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      domainFilterOpen = false;
      layout(currentWidth, currentHeight);
    });
    container.addChild(domainFilterBackdrop);

    const domainFilterPopup = new Container();
    domainFilterPopup.eventMode = "static";
    domainFilterPopup.visible = false;
    domainFilterPopup.on("pointerdown", (e: FederatedPointerEvent) => e.stopPropagation());
    container.addChild(domainFilterPopup);

    const domainFilterPopupH = DOMAIN_FILTER_OPTIONS.length * DOMAIN_FILTER_ROW_H + 8;
    const domainFilterPopupBg = new Graphics();
    domainFilterPopupBg.roundRect(0, 0, DOMAIN_FILTER_POPUP_W, domainFilterPopupH, 4);
    domainFilterPopupBg.fill({ color: BG, alpha: 0.98 });
    domainFilterPopupBg.stroke({ color: ROW_ALT_BG, width: 1 });
    domainFilterPopup.addChild(domainFilterPopupBg);

    const domainFilterRows = DOMAIN_FILTER_OPTIONS.map((opt, idx) => {
      const rowY = 4 + idx * DOMAIN_FILTER_ROW_H;
      const bg = new Graphics();
      bg.eventMode = "static";
      bg.cursor = "pointer";
      domainFilterPopup.addChild(bg);

      const check = new Text({
        text: "\u2610",
        style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      check.eventMode = "none";
      check.x = 8;
      check.y = rowY + 3;
      domainFilterPopup.addChild(check);

      const label = new Text({
        text: opt.label,
        style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      label.eventMode = "none";
      label.x = 22;
      label.y = rowY + 3;
      domainFilterPopup.addChild(label);

      bg.on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        if (localDomainFilter.has(opt.key)) {
          localDomainFilter.delete(opt.key);
        } else {
          localDomainFilter.add(opt.key);
        }
        scrollBox.scrollTop();
        maybeAutoLoadForFilter();
        layout(currentWidth, currentHeight);
      });

      return { key: opt.key, rowY, bg, check, label };
    });

    function finishInnerLayout(contentHeight: number): void {
      innerSizingRect.clear();
      innerSizingRect.rect(0, 0, Math.max(1, scrollBoxW), Math.max(1, contentHeight));
      innerSizingRect.fill({ color: 0x000000, alpha: 0.0001 });
      scrollBox.resize(true);
    }

    // -------------------------------------------------------------------
    // tab 1 row rendering — pending transfers
    // -------------------------------------------------------------------

    function renderPendingRows(items: FilezItem[], contentW: number): void {
      while (inner.children.length > 1) {
        inner.removeChildAt(1).destroy({ children: true }); // keep innerSizingRect (index 0)
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const dirInfo = DIRECTION_INFO[item.direction];
        const rowY = i * ROW_HEIGHT;

        const rowContainer = new Container();
        rowContainer.eventMode = "static";
        rowContainer.y = rowY;
        inner.addChild(rowContainer);

        // alternating row background
        const rowBg = new Graphics();
        rowBg.eventMode = "none";
        if (i % 2 === 1) {
          rowBg.rect(0, 0, contentW, ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
        }
        rowContainer.addChild(rowBg);

        // color stripe on left edge (direction)
        const stripe = new Graphics();
        stripe.eventMode = "none";
        stripe.rect(0, 0, COLOR_STRIPE_WIDTH, ROW_HEIGHT);
        stripe.fill({ color: dirInfo.color });
        rowContainer.addChild(stripe);

        // controls (pause/cancel) reserve space on the right — real,
        // clickable buttons, see the render loop below.
        const showPause = item.canPause;
        const showCancel = item.canCancel;
        const controlsW =
          (showPause ? CTRL_BTN_W : 0) +
          (showCancel ? CTRL_BTN_W : 0) +
          (showPause && showCancel ? CTRL_BTN_GAP : 0);
        const controlsReserved = controlsW > 0 ? controlsW + CTRL_BTN_GAP : 0;

        const textLeft = COLOR_STRIPE_WIDTH + ROW_PADDING_X;
        const textW = Math.max(20, contentW - textLeft - ROW_PADDING_X - controlsReserved);

        // line 1: direction + filename
        const filename = item.filename ?? (item.blobId ? truncateId(item.blobId) : "unknown file");
        const dirLabel = new Text({
          text: dirInfo.label,
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: dirInfo.color, fontWeight: "bold" },
          resolution: RESOLUTION,
        });
        dirLabel.eventMode = "none";
        dirLabel.x = textLeft;
        dirLabel.y = 8;
        rowContainer.addChild(dirLabel);

        const filenameMaxChars = Math.max(
          4,
          Math.floor((textW - dirLabel.width - 8) / (ROW_NAME_SIZE * 0.55))
        );
        const filenameText = new Text({
          text: truncate(filename, filenameMaxChars),
          style: { fontFamily: FONT, fontSize: ROW_NAME_SIZE, fill: TEXT_COLOR },
          resolution: RESOLUTION,
        });
        filenameText.eventMode = "none";
        filenameText.x = textLeft + dirLabel.width + 8;
        filenameText.y = 7;
        rowContainer.addChild(filenameText);

        // line 2: peer/hub + canvas (canvas omitted if unresolvable)
        const peerDisplay = item.peerName ?? (item.peerId ? truncateId(item.peerId) : "\u2014");
        let subtitle = `with: ${peerDisplay}`;
        if (item.canvasIds && item.canvasIds.length > 0) {
          const names = item.canvasIds
            .map((id) => resolveCanvasTitle(id))
            .filter((n): n is string => !!n);
          if (names.length > 0) {
            subtitle += ` \u2022 in: ${names.join(", ")}`;
          }
        }
        const subtitleMaxChars = Math.max(4, Math.floor(textW / (ROW_SUB_SIZE * 0.55)));
        const subtitleText = new Text({
          text: truncate(subtitle, subtitleMaxChars),
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        subtitleText.eventMode = "none";
        subtitleText.x = textLeft;
        subtitleText.y = 26;
        rowContainer.addChild(subtitleText);

        // line 3: progress readout — completed rows show a relative-time
        // "done" label instead (see PendingTransferItem's doc comment for
        // why upload/download have no live fraction while queued/in-flight).
        let progressLabel = "";
        if (item.state === "completed") {
          progressLabel = formatCompletedAgo(item.completedAt);
        } else if (item.fraction !== undefined) {
          progressLabel = `${Math.round(item.fraction * 100)}%`;
        } else if (item.state === "queued") {
          progressLabel = "queued";
        }
        if (progressLabel) {
          const progressText = new Text({
            text: progressLabel,
            style: {
              fontFamily: FONT,
              fontSize: ROW_SUB_SIZE,
              fill: item.fraction !== undefined ? ACCENT_COLOR : MUTED_TEXT,
            },
            resolution: RESOLUTION,
          });
          progressText.eventMode = "none";
          progressText.x = textLeft;
          progressText.y = 42;
          rowContainer.addChild(progressText);
        }

        // pause/cancel — real actions, wired to pending-transfers.ts's
        // cancelTransfer()/pauseTransfer() (which in turn drive an actual
        // AbortController / snatch.ts's pauseSnatchDownload). only rendered
        // when the row's own canPause/canCancel say it's possible — always
        // false for completed/serving rows. buttons disable and relabel
        // themselves the moment they're clicked (see runAction/pendingActions
        // above) rather than waiting on the next poll tick for feedback.
        let ctrlX = contentW - ROW_PADDING_X - controlsW;
        const ctrlY = (ROW_HEIGHT - CTRL_BTN_H) / 2;
        const pending = pendingActions.get(item.id);
        if (showPause) {
          const isPending = pending === "pause";
          rowContainer.addChild(
            buildActionButton(isPending ? "pausing…" : "pause", ctrlX, ctrlY, isPending, () =>
              runAction(item, "pause")
            )
          );
          ctrlX += CTRL_BTN_W + CTRL_BTN_GAP;
        }
        if (showCancel) {
          const isPending = pending === "cancel";
          rowContainer.addChild(
            buildActionButton(isPending ? "cancelling…" : "cancel", ctrlX, ctrlY, isPending, () =>
              runAction(item, "cancel")
            )
          );
        }

        // completed rows are dimmed to visually separate them from live
        // transfers, without hiding them outright.
        rowContainer.alpha = item.state === "completed" ? 0.55 : 1;
      }

      finishInnerLayout(items.length * ROW_HEIGHT);
    }

    /**
     * fire a pause/cancel click: logs the attempt (visible with dev-build
     * debug logging — see log.ts), marks the item pending so its button
     * relabels/disables immediately, then clears the pending flag and
     * re-layouts once the call settles either way. ignores a second click
     * while one's already in flight for this item.
     */
    function runAction(item: FilezItem, action: "pause" | "cancel"): void {
      if (pendingActions.has(item.id)) return;
      pendingActions.set(item.id, action);
      log.debug(
        TAG,
        `${action} requested: id=${item.id} direction=${item.direction} blob=${item.blobId ?? "?"}`
      );
      if (!destroyed) layout(currentWidth, currentHeight);

      const run = action === "pause" ? pauseTransfer(item) : cancelTransfer(item);
      void run
        .then((ok) => {
          log.debug(TAG, `${action} ${ok ? "succeeded" : "reported nothing to do"}: id=${item.id}`);
        })
        .catch((err) => {
          log.debug(TAG, `${action} failed: id=${item.id}`, err);
        })
        .finally(() => {
          pendingActions.delete(item.id);
          if (!destroyed) layout(currentWidth, currentHeight);
        });
    }

    function buildActionButton(
      label: string,
      x: number,
      y: number,
      disabled: boolean,
      onClick: () => void,
      width: number = CTRL_BTN_W
    ): Container {
      const btn = new Container();
      btn.x = x;
      btn.y = y;
      btn.eventMode = disabled ? "none" : "static";
      btn.cursor = disabled ? "default" : "pointer";

      const bg = new Graphics();
      bg.roundRect(0, 0, width, CTRL_BTN_H, 4);
      bg.fill({ color: disabled ? 0x14141c : BORDER });
      btn.addChild(bg);

      const text = new Text({
        text: label,
        style: {
          fontFamily: FONT,
          fontSize: label.length > 6 ? 7 : 8,
          fill: disabled ? MUTED_TEXT : TEXT_COLOR,
        },
        resolution: RESOLUTION,
      });
      text.anchor.set(0.5, 0.5);
      text.x = width / 2;
      text.y = CTRL_BTN_H / 2;
      btn.addChild(text);

      if (!disabled) {
        btn.on("pointertap", (e) => {
          e.stopPropagation();
          onClick();
        });
      }

      return btn;
    }

    // -------------------------------------------------------------------
    // tab 2 row rendering — local files
    // -------------------------------------------------------------------

    const LOCAL_CTRL_RESERVED = CTRL_BTN_W * 2 + CTRL_BTN_GAP; // sized for the widest (2-button confirm) state so text doesn't reflow when clicked

    // drag-out-to-canvas: dragging a local-files row onto the canvas creates
    // a new `file` widget bound to the already-local blob at the drop point
    // (see create-file-widget.ts). only available when the overlay was
    // wired with `world`/`canvasStore` (boot.ts's mountFilezOverlay) and the
    // current canvas isn't the narthex — the narthex is a private per-user
    // index of canvas cards and intentionally never shows file widgets.
    function canDragOut(): boolean {
      return (
        !!ctx.world &&
        !!ctx.canvasStore &&
        !ctx.canvasStore.isLocalViewer() &&
        ctx.canvasStore.handle.documentId !== ctx.narthexDocId
      );
    }

    // cleanup for whichever row-drag is currently in flight, if any — let
    // destroy() abandon it cleanly if the overlay closes mid-drag.
    let activeDragCleanup: (() => void) | null = null;

    function createDragGhost(label: string): Container {
      const c = new Container();
      c.alpha = GHOST_ALPHA;
      c.label = "filez-drag-ghost";

      const bg = new Graphics();
      bg.roundRect(0, 0, GHOST_WIDTH, GHOST_HEIGHT, GHOST_RADIUS).fill({ color: GHOST_BG });
      c.addChild(bg);

      const text = new Text({
        text: label,
        style: { fontFamily: FONT, fontSize: GHOST_FONT_SIZE, fill: GHOST_TEXT_COLOR },
        resolution: RESOLUTION,
      });
      text.x = 6;
      text.y = Math.round((GHOST_HEIGHT - GHOST_FONT_SIZE) / 2);
      c.addChild(text);

      return c;
    }

    function startRowDrag(pe: FederatedPointerEvent, item: LocalBlobItem): void {
      if (!canDragOut()) return;
      const world = ctx.world!;
      const store = ctx.canvasStore!;

      // track via native window pointer events, not pixi's own target-
      // bound pointerup/pointerupoutside — the row is a pixi Container that
      // can be destroyed mid-drag by an unrelated relayout (e.g. the
      // pending-transfers doc's "change" firing while the local tab is
      // active, or an async blob-refs/canvas-title resolve completing —
      // both call layout() unconditionally, which rebuilds every row).
      // pixi never fires pointerup/pointerupoutside for a target that's
      // been destroyed, so the drag would silently end early — dropping a
      // widget wherever the pointer happened to be at that moment instead
      // of where the user actually released the mouse. native window
      // events don't care about pixi's scene graph at all.
      const rectOf = () => ctx.canvasElement.getBoundingClientRect();
      const startX = pe.global.x;
      const startY = pe.global.y;
      let dragging = false;
      let ghost: Container | null = null;

      const cleanup = () => {
        window.removeEventListener("pointermove", moveHandler);
        window.removeEventListener("pointerup", upHandler);
        window.removeEventListener("pointercancel", cancelHandler);
        if (ghost) {
          ghost.parent?.removeChild(ghost);
          ghost.destroy({ children: true });
          ghost = null;
        }
      };

      const globalFromClient = (clientX: number, clientY: number) => {
        const rect = rectOf();
        return { x: clientX - rect.left, y: clientY - rect.top };
      };

      const moveHandler = (moveEvent: PointerEvent) => {
        const g = globalFromClient(moveEvent.clientX, moveEvent.clientY);
        const dx = g.x - startX;
        const dy = g.y - startY;

        if (!dragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
          dragging = true;
          ghost = createDragGhost(truncate(item.filename || truncateId(item.blobId), 24));
          world.addChild(ghost);
        }

        if (dragging && ghost) {
          const local = world.toLocal(g);
          ghost.x = local.x;
          ghost.y = local.y;
        }
      };

      const upHandler = (upEvent: PointerEvent) => {
        if (dragging) {
          const g = globalFromClient(upEvent.clientX, upEvent.clientY);
          const local = world.toLocal(g);
          createFileWidgetFromBlob(store.repo, store, {
            blobId: item.blobId,
            filename: item.filename,
            mime: item.mime,
            size: item.size,
            blake3: item.blake3,
            x: local.x - CREATE_FILE_WIDGET_DEFAULT_WIDTH / 2,
            y: local.y - CREATE_FILE_WIDGET_DEFAULT_HEIGHT / 2,
          })
            .then((widgetId) => {
              // the widget's own drop target contract (DropTargetHandler)
              // needs a real, already-existing widget id — there's no
              // widget at all until the line above creates one, so (unlike
              // bin-drag.ts, which drags an existing widget out) this
              // always creates the standalone file widget FIRST, then
              // immediately offers it to whatever's at the drop point.
              // e.g. dropping straight onto animaniac's timeline captures
              // it as a clip and deletes this just-created widget as part
              // of consuming the drop; otherwise it just stays put as a
              // normal file widget.
              store.tryDropOnWidgetAt(widgetId, local.x, local.y);
            })
            .catch((err) => {
              log.warn(TAG, `drag-out: failed to create file widget from blob ${item.blobId}:`, err);
            });
        }
        cleanup();
        activeDragCleanup = null;
      };

      // interrupted (e.g. alt-tab, touch cancel) — abandon, no widget.
      const cancelHandler = () => {
        cleanup();
        activeDragCleanup = null;
      };

      activeDragCleanup?.(); // safety: abandon any still-active drag first
      activeDragCleanup = cleanup;
      window.addEventListener("pointermove", moveHandler);
      window.addEventListener("pointerup", upHandler);
      window.addEventListener("pointercancel", cancelHandler);
    }

    /** @returns the number of rows actually rendered (after the client-side
     *  orphan filter, if on), so layout() can decide whether to show the
     *  empty-state message. */
    function renderLocalRows(contentW: number): number {
      while (inner.children.length > 1) {
        inner.removeChildAt(1).destroy({ children: true });
      }

      // the orphan filter can only ever be applied to the currently-loaded
      // page(s) — phase 2's list options have no server-side orphan flag,
      // and blob-canvas-refs is a separate app-level index the storage
      // backends don't know about. totals shown in the header therefore
      // reflect ALL local files, not just orphans, while this filter is on.
      // the domain filter is likewise purely client-side, over whatever
      // pages are already loaded.
      const visible = localItems.filter((i) => {
        if (localOrphansOnly && isOrphan(i) !== true) return false;
        if (localDomainFilter.size > 0 && !localDomainFilter.has(classifyDomain(i.mime ?? ""))) return false;
        return true;
      });

      for (let i = 0; i < visible.length; i++) {
        const item = visible[i];
        const rowY = i * LOCAL_ROW_HEIGHT;

        const rowContainer = new Container();
        rowContainer.eventMode = "static";
        rowContainer.hitArea = new Rectangle(0, 0, contentW, LOCAL_ROW_HEIGHT);
        rowContainer.y = rowY;
        if (canDragOut()) {
          rowContainer.cursor = "grab";
          rowContainer.on("pointerdown", (e: FederatedPointerEvent) => {
            // desktop: a row drag starts a file-drag-out gesture instead of
            // panning the list — touch keeps its native drag-to-scroll.
            if (e.pointerType !== "mouse") return;
            e.stopPropagation();
            startRowDrag(e, item);
          });
        }
        inner.addChild(rowContainer);

        const rowBg = new Graphics();
        rowBg.eventMode = "none";
        if (i % 2 === 1) {
          rowBg.rect(0, 0, contentW, LOCAL_ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
        }
        rowContainer.addChild(rowBg);

        // thumbnail (image / video-frame / audio-waveform preview) or a
        // domain-icon fallback when no preview is available yet/at all.
        const domain = classifyDomain(item.mime ?? "");
        const filename = item.filename || truncateId(item.blobId);
        const thumbBox = new Container();
        thumbBox.eventMode = "none";
        thumbBox.x = ROW_PADDING_X;
        thumbBox.y = Math.round((LOCAL_ROW_HEIGHT - LOCAL_THUMB_SIZE) / 2);
        rowContainer.addChild(thumbBox);

        const thumbTex = resolveLocalThumbTexture(item);
        if (thumbTex) {
          const thumbMask = new Graphics();
          thumbMask.roundRect(0, 0, LOCAL_THUMB_SIZE, LOCAL_THUMB_SIZE, 4).fill({ color: 0xffffff });
          thumbBox.addChild(thumbMask);
          const sprite = new Sprite(thumbTex);
          sprite.width = LOCAL_THUMB_SIZE;
          sprite.height = LOCAL_THUMB_SIZE;
          sprite.mask = thumbMask;
          thumbBox.addChild(sprite);
        } else {
          const iconBg = new Graphics();
          iconBg
            .roundRect(0, 0, LOCAL_THUMB_SIZE, LOCAL_THUMB_SIZE, 4)
            .fill({ color: domainIconColor(domain), alpha: 0.18 });
          thumbBox.addChild(iconBg);
          const iconText = new Text({
            text: domainIconGlyph(domain, filename),
            style: { fontFamily: FONT, fontSize: Math.round(LOCAL_THUMB_SIZE * 0.42), fill: domainIconColor(domain) },
            resolution: RESOLUTION,
          });
          iconText.anchor.set(0.5);
          iconText.x = LOCAL_THUMB_SIZE / 2;
          iconText.y = LOCAL_THUMB_SIZE / 2;
          thumbBox.addChild(iconText);
        }

        const textLeft = ROW_PADDING_X + LOCAL_THUMB_SIZE + LOCAL_THUMB_GAP;
        const textW = Math.max(20, contentW - textLeft - ROW_PADDING_X - LOCAL_CTRL_RESERVED - CTRL_BTN_GAP);

        // line 1: filename + size
        const filenameMaxChars = Math.max(4, Math.floor((textW * 0.6) / (ROW_NAME_SIZE * 0.55)));
        const filenameText = new Text({
          text: truncate(filename, filenameMaxChars),
          style: { fontFamily: FONT, fontSize: ROW_NAME_SIZE, fill: TEXT_COLOR },
          resolution: RESOLUTION,
        });
        filenameText.eventMode = "none";
        filenameText.x = textLeft;
        filenameText.y = 7;
        rowContainer.addChild(filenameText);

        const sizeText = new Text({
          text: formatFileSize(item.size),
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        sizeText.eventMode = "none";
        sizeText.x = textLeft + textW - sizeText.width;
        sizeText.y = 9;
        rowContainer.addChild(sizeText);

        // line 2: created date + canvas refs / orphan badge
        const refs = resolveBlobRefs(item.blobId, item.blake3);
        let subtitle = `created ${formatRelativeTime(item.createdAt)}`;
        if (item.external) subtitle += " \u2022 external";
        if (refs !== null) {
          if (refs.length === 0) {
            subtitle += " \u2022 orphaned";
          } else {
            const names = refs.map((id) => resolveCanvasTitle(id)).filter((n): n is string => !!n);
            if (names.length > 0) subtitle += ` \u2022 in: ${names.join(", ")}`;
          }
        }
        const subtitleMaxChars = Math.max(4, Math.floor(textW / (ROW_SUB_SIZE * 0.55)));
        const subtitleText = new Text({
          text: truncate(subtitle, subtitleMaxChars),
          style: {
            fontFamily: FONT,
            fontSize: ROW_SUB_SIZE,
            fill: refs !== null && refs.length === 0 ? ACCENT_COLOR : MUTED_TEXT,
          },
          resolution: RESOLUTION,
        });
        subtitleText.eventMode = "none";
        subtitleText.x = textLeft;
        subtitleText.y = 26;
        rowContainer.addChild(subtitleText);

        // line 3: domain classification — surfaced mainly so the "type"
        // filter dropdown above is easy to sanity-check against.
        const typeText = new Text({
          text: domain,
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: domainIconColor(domain) },
          resolution: RESOLUTION,
        });
        typeText.eventMode = "none";
        typeText.x = textLeft;
        typeText.y = 41;
        rowContainer.addChild(typeText);

        // remove/purge — confirm-then-execute (mirrors hub-profile-panel.ts's
        // handleHardDeleteAllClick), one active confirmation at a time. an
        // "add to canvas" button stacks underneath in the idle state only
        // (hidden during pendingPurges/confirm, and whenever canDragOut()
        // is false — narthex / viewer / no drop target wired).
        const ctrlX = contentW - ROW_PADDING_X - LOCAL_CTRL_RESERVED;
        const showAddToCanvas =
          canDragOut() && !pendingPurges.has(item.blobId) && confirmPurgeId !== item.blobId;
        const ctrlGapY = 4;
        const ctrlStackH = showAddToCanvas ? CTRL_BTN_H * 2 + ctrlGapY : CTRL_BTN_H;
        const ctrlTopY = (LOCAL_ROW_HEIGHT - ctrlStackH) / 2;
        if (pendingPurges.has(item.blobId)) {
          const removingText = new Text({
            text: "removing\u2026",
            style: { fontFamily: FONT, fontSize: 8, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          removingText.x = ctrlX;
          removingText.y = ctrlTopY + 2;
          rowContainer.addChild(removingText);
        } else if (confirmPurgeId === item.blobId) {
          rowContainer.addChild(buildActionButton("confirm", ctrlX, ctrlTopY, false, () => handlePurgeClick(item)));
          rowContainer.addChild(
            buildActionButton("cancel", ctrlX + CTRL_BTN_W + CTRL_BTN_GAP, ctrlTopY, false, cancelPurgeClick)
          );
        } else {
          rowContainer.addChild(
            buildActionButton(
              item.external ? "remove" : "purge",
              ctrlX + CTRL_BTN_W + CTRL_BTN_GAP,
              ctrlTopY,
              false,
              () => handlePurgeClick(item)
            )
          );
          if (showAddToCanvas) {
            rowContainer.addChild(
              buildActionButton(
                addingToCanvas.has(item.blobId) ? "adding\u2026" : "add to canvas",
                ctrlX,
                ctrlTopY + CTRL_BTN_H + ctrlGapY,
                addingToCanvas.has(item.blobId),
                () => handleAddToCanvas(item),
                LOCAL_CTRL_RESERVED
              )
            );
          }
        }
      }

      let contentHeight = visible.length * LOCAL_ROW_HEIGHT;

      // "load more" footer — scoped to the raw (unfiltered) list so paging
      // still works while the orphan filter is on (more orphans may exist
      // on later pages).
      if (localItems.length > 0 && localHasMore) {
        const loadMoreText = new Text({
          text: localLoading ? "loading\u2026" : "load more",
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: ACCENT_COLOR },
          resolution: RESOLUTION,
        });
        loadMoreText.y = contentHeight + 8;
        if (!localLoading) {
          loadMoreText.eventMode = "static";
          loadMoreText.cursor = "pointer";
          loadMoreText.on("pointertap", (e) => {
            e.stopPropagation();
            queryLocalFiles({ append: true });
          });
        }
        loadMoreText.x = (contentW - loadMoreText.width) / 2;
        inner.addChild(loadMoreText);
        contentHeight += LOAD_MORE_ROW_HEIGHT;
      }

      finishInnerLayout(contentHeight);
      return visible.length;
    }

    // -------------------------------------------------------------------
    // layout
    // -------------------------------------------------------------------

    const layout = (w: number, h: number) => {
      currentWidth = w;
      currentHeight = h;
      drawCard(w, h);

      // -- header: tab switch --
      pendingTabText.x = PADDING_X;
      pendingTabText.y = PADDING_Y - 2;
      pendingTabText.style.fill = activeTab === "pending" ? TEXT_COLOR : MUTED_TEXT;

      localTabText.x = pendingTabText.x + pendingTabText.width + TAB_GAP;
      localTabText.y = PADDING_Y - 2;
      localTabText.style.fill = activeTab === "local" ? TEXT_COLOR : MUTED_TEXT;

      const activeTabText = activeTab === "pending" ? pendingTabText : localTabText;
      tabUnderline.clear();
      tabUnderline.moveTo(activeTabText.x, activeTabText.y + activeTabText.height + 2);
      tabUnderline.lineTo(activeTabText.x + activeTabText.width, activeTabText.y + activeTabText.height + 2);
      tabUnderline.stroke({ color: ACCENT_COLOR, width: 2 });

      const pendingItems = ctx.doc.current.items;
      const completedCount = pendingItems.filter((i) => i.state === "completed").length;
      const liveCount = pendingItems.length - completedCount;

      countText.visible = true;
      countText.text =
        activeTab === "pending"
          ? liveCount > 0
            ? `${liveCount} active`
            : ""
          : localTotalCount > 0
            ? `${localTotalCount} files \u00b7 ${formatFileSize(localTotalSize)}`
            : "";
      countText.x = w - PADDING_X - countText.width;
      countText.y = PADDING_Y + 1;

      clearCompletedBtn.visible = activeTab === "pending" && completedCount > 0;
      if (clearCompletedBtn.visible) {
        clearCompletedBtn.x = countText.x - clearCompletedBtn.width - 12;
        clearCompletedBtn.y = PADDING_Y + 1;
      }

      bulkPurgeBtn.visible =
        activeTab === "local" && localOrphansOnly && localItems.some((i) => isOrphan(i) === true);
      if (bulkPurgeBtn.visible) {
        bulkPurgeBtn.text = confirmBulkPurge ? "confirm purge?" : "purge orphans";
        bulkPurgeBtn.style.fill = confirmBulkPurge ? ACCENT_COLOR : MUTED_TEXT;
        bulkPurgeBtn.x = countText.x - bulkPurgeBtn.width - 12;
        bulkPurgeBtn.y = PADDING_Y + 1;
      }

      const contentW = Math.max(0, w - PADDING_X * 2);

      // -- filter row (tab 2 only) --
      const showFilterRow = activeTab === "local";
      searchInputHandle.input.visible = showFilterRow;
      for (const { text } of sortLabels) text.visible = showFilterRow;
      orphanToggle.visible = showFilterRow;
      domainFilterLabel.visible = showFilterRow;
      if (!showFilterRow) domainFilterOpen = false;
      domainFilterBackdrop.visible = showFilterRow && domainFilterOpen;
      domainFilterPopup.visible = showFilterRow && domainFilterOpen;

      let listTop = HEADER_HEIGHT + 6;
      if (showFilterRow) {
        const filterY = listTop;
        const searchWidth = Math.min(140, Math.max(60, contentW * 0.35));
        searchInputHandle.setWidth(searchWidth);
        searchInputHandle.input.x = PADDING_X;
        searchInputHandle.input.y = filterY;

        let sortX = PADDING_X + searchWidth + FILTER_GAP;
        for (const { field, text } of sortLabels) {
          const active = localSort === field;
          text.style.fill = active ? ACCENT_COLOR : MUTED_TEXT;
          text.text = active
            ? `${sortFieldLabel(field)} ${localDirection === "asc" ? "\u25b2" : "\u25bc"}`
            : sortFieldLabel(field);
          text.x = sortX;
          text.y = filterY + 3;
          sortX += text.width + FILTER_GAP;
        }

        orphanToggle.text = localOrphansOnly ? "\u25a0 orphans only" : "\u25a1 orphans only";
        orphanToggle.style.fill = localOrphansOnly ? ACCENT_COLOR : MUTED_TEXT;
        orphanToggle.x = w - PADDING_X - orphanToggle.width;
        orphanToggle.y = filterY + 3;

        domainFilterLabel.text =
          localDomainFilter.size > 0
            ? truncate(
                `type: ${DOMAIN_FILTER_OPTIONS.filter((o) => localDomainFilter.has(o.key))
                  .map((o) => o.label)
                  .join(", ")} \u25be`,
                20
              )
            : "type \u25be";
        domainFilterLabel.style.fill = localDomainFilter.size > 0 ? ACCENT_COLOR : MUTED_TEXT;
        domainFilterLabel.x = orphanToggle.x - FILTER_GAP - domainFilterLabel.width;
        domainFilterLabel.y = filterY + 3;

        if (domainFilterOpen) {
          domainFilterBackdrop.clear();
          domainFilterBackdrop.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.0001 });

          domainFilterPopup.x = Math.max(
            PADDING_X,
            Math.min(domainFilterLabel.x, w - PADDING_X - DOMAIN_FILTER_POPUP_W)
          );
          domainFilterPopup.y = filterY + FILTER_ROW_HEIGHT + 2;

          for (const row of domainFilterRows) {
            const active = localDomainFilter.has(row.key);
            row.bg.clear();
            row.bg.roundRect(4, row.rowY, DOMAIN_FILTER_POPUP_W - 8, DOMAIN_FILTER_ROW_H, 3);
            row.bg.fill({ color: active ? ACCENT_COLOR : 0x000000, alpha: active ? 0.15 : 0 });
            row.check.text = active ? "\u2611" : "\u2610";
            row.check.style.fill = active ? ACCENT_COLOR : MUTED_TEXT;
            row.label.style.fill = active ? ACCENT_COLOR : MUTED_TEXT;
          }
        }

        listTop += FILTER_ROW_HEIGHT;
      }

      listAreaY = listTop;
      listAreaHeight = Math.max(0, h - listAreaY - PADDING_Y);
      scrollBoxW = contentW;
      scrollBoxH = listAreaHeight;

      scrollBox.x = PADDING_X;
      scrollBox.y = listAreaY;
      if (scrollBoxW !== lastScrollBoxW || scrollBoxH !== lastScrollBoxH) {
        scrollBox.setSize(scrollBoxW, scrollBoxH);
        lastScrollBoxW = scrollBoxW;
        lastScrollBoxH = scrollBoxH;
      }

      const visibleCount =
        activeTab === "pending"
          ? (renderPendingRows(pendingItems, contentW), pendingItems.length)
          : renderLocalRows(contentW);

      if (activeTab === "pending") {
        emptyText.visible = visibleCount === 0;
        emptyText.text = "no transfers";
      } else {
        emptyText.visible = visibleCount === 0;
        emptyText.text = localError
          ? localError
          : localLoading && localItems.length === 0
            ? "loading\u2026"
            : localOrphansOnly
              ? "no orphaned files loaded"
              : "no local files";
      }
      if (emptyText.visible) {
        emptyText.x = PADDING_X + (contentW - emptyText.width) / 2;
        emptyText.y = listAreaY + (listAreaHeight - emptyText.height) / 2;
      }
    };

    layout(currentWidth, currentHeight);

    const unsub = ctx.doc.on("change", () => layout(currentWidth, currentHeight));

    return {
      container,

      destroy() {
        destroyed = true;
        unsub();
        activeDragCleanup?.();
        document.removeEventListener("wheel", onNativeWheel, { capture: true } as EventListenerOptions);
        if (confirmPurgeTimer !== null) clearTimeout(confirmPurgeTimer);
        if (confirmBulkPurgeTimer !== null) clearTimeout(confirmBulkPurgeTimer);
        if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
        localFilesSub.unsubscribe();
        searchInputHandle.destroy();
        container.destroy({ children: true });
      },

      resize(width: number, height: number) {
        currentWidth = width;
        currentHeight = height;
        layout(width, height);
      },
    };
  },
};
