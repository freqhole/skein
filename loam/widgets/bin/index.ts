import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { Container, Graphics, Sprite, Text, Texture, Assets } from "pixi.js";

import { log, pickImageAsDataUrl } from "@freqhole/reliquary/utils";
import {
  getThumbnailDataUrl,
  isDocumentFilename,
  pickFiles,
  uploadFile,
} from "../../src/widgets/file-utils";
import { fileSchema } from "../file";
import { kickOffDocumentProcessing } from "../peedeeeff/render-client";
import { peedeeeffSchema } from "../peedeeeff/types";
import { snatchAllInBin } from "./bin-actions";
import type { WidgetRegistry } from "../../src/widgets/widget-registry";
import type {
  CompactInfo,
  HeaderAction,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../../src/widgets/widget-types";
import { BIN_PADDING, TEXT_MUTED, type SlotScale } from "./bin-constants";
import { createBinDragHandler } from "./bin-drag";
import {
  autoFitCols,
  computeGridBounds,
  computeRows,
  contentDimensions,
  firstEmptySlot,
  hitTestSlot,
  resolveCellBorderWidth,
  resolveScale,
  type BinMode,
  type SlotSizeOptions,
} from "./bin-layout";
import { BinMediaController } from "./bin-media";
import { BinRenderer, type CardInteractionCallbacks } from "./bin-renderer";

import { binSchema, type BinState } from "./bin-schema";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

// -----------------------------------------------------------------------
// widget factory
// -----------------------------------------------------------------------

export const binWidget: WidgetFactory<typeof binSchema> = {
  type: "bin",

  metadata: {
    name: "bin",
    description: "container that groups widgets in compact layouts",
    version: "0.1.0",
    category: "layout",
    defaultWidth: 320,
    defaultHeight: 240,
  },

  schema: binSchema,

  editableProps: [
    {
      key: "mode",
      label: "layout",
      type: "select",
      options: ["grid", "shelf", "crate", "drawer"],
      default: "grid",
    },
    {
      key: "slotScale",
      label: "slot size",
      type: "select",
      options: ["s", "m", "l", "xl"],
      default: "m",
    },
    {      key: "bgColor",
      label: "background",
      type: "color",
      default: -1,
    },
    {      key: "shelfTextOrigin",
      label: "shelf text",
      type: "select",
      options: ["top", "bottom"],
      default: "top",
      visibleWhen: { key: "mode", value: "shelf" },
    },
    {
      key: "borderWidth",
      label: "border width",
      type: "number",
      default: 0,
    },
    {
      key: "borderColor",
      label: "border color",
      type: "color",
      default: -1,
    },
    {
      key: "cellBorders",
      label: "cell borders",
      type: "boolean",
      default: false,
    },
  ],

  getCompactInfo: (state: BinState): CompactInfo => {
    const count = state.items.length;
    const label = state.title || `bin (${count} item${count !== 1 ? "s" : ""})`;
    return { label, thumbnailUrl: state.coverThumbnailDataUrl || undefined };
  },

  create(ctx: WidgetMountContext<typeof binSchema>): WidgetController {
    const container = new Container();
    container.label = "bin-widget";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let destroyed = false;

    // -- resolve dependencies ------------------------------------------------
    // the bin needs access to the automerge repo and widget registry to read
    // child widget docs and call getCompactInfo(). these come from the
    // canvas store (which exposes the repo) and the widget registry (which
    // the mount context doesn't directly provide — but the canvas store's
    // repo is available).

    const store = ctx.canvasStore ?? null;
    const repo: Repo | null = store?.repo ?? null;

    // -- background ------------------------------------------------------------
    // an optional solid fill for the bin itself, drawn behind the cover
    // thumbnail and outer border — -1 means transparent (no fill).

    const bgGfx = new Graphics();
    container.addChildAt(bgGfx, 0);

    function drawBg(width: number, height: number) {
      const state = ctx.doc.current;
      bgGfx.clear();
      if (state.bgColor === -1) return;
      bgGfx.rect(0, 0, width, height).fill({ color: state.bgColor });
    }

    // -- outer border ---------------------------------------------------------
    // drawn behind everything else except the background fill — visible
    // whenever borderWidth > 0 and borderColor isn't -1 ("none"). independent
    // of the empty-state dashed border, which is only shown while the bin has
    // no children.

    const outerBorder = new Graphics();
    container.addChildAt(outerBorder, 1);

    function drawOuterBorder(width: number, height: number) {
      const state = ctx.doc.current;
      outerBorder.clear();
      if (state.borderWidth <= 0 || state.borderColor === -1) return;
      const w = state.borderWidth;
      outerBorder
        .rect(w / 2, w / 2, width - w, height - w)
        .stroke({ width: w, color: state.borderColor });
    }

    // -- cover thumbnail -------------------------------------------------------
    // an optional background image for the bin, drawn behind everything else
    // (including the outer border). set via a widget action (pick a file,
    // auto-copy the first eligible child's thumbnail, or remove). also used as
    // this bin's own compact-card thumbnail (see getCompactInfo above).

    const coverSprite = new Sprite(Texture.EMPTY);
    coverSprite.visible = false;
    container.addChildAt(coverSprite, 1);
    let lastCoverUrl = "";

    function fitCoverSprite(width: number, height: number) {
      const tex = coverSprite.texture;
      if (!tex || tex === Texture.EMPTY || !tex.width || !tex.height) return;
      const scale = Math.max(width / tex.width, height / tex.height);
      coverSprite.width = tex.width * scale;
      coverSprite.height = tex.height * scale;
      coverSprite.x = (width - coverSprite.width) / 2;
      coverSprite.y = (height - coverSprite.height) / 2;
    }

    async function updateCoverSprite(width: number, height: number) {
      const url = ctx.doc.current.coverThumbnailDataUrl;
      if (!url) {
        coverSprite.visible = false;
        lastCoverUrl = "";
        return;
      }

      if (url !== lastCoverUrl) {
        lastCoverUrl = url;
        try {
          const texture = await Assets.load<Texture>(url);
          // bail if the doc moved on to a different cover (or the widget was
          // destroyed) while the texture was decoding
          if (destroyed || ctx.doc.current.coverThumbnailDataUrl !== url) return;
          coverSprite.texture = texture;
        } catch (err) {
          log.warn("bin", "failed to load cover thumbnail", err);
          coverSprite.visible = false;
          return;
        }
      }

      coverSprite.visible = true;
      fitCoverSprite(width, height);
    }

    // we need the widget registry to call getCompactInfo on child factories.
    // the registry isn't on the mount context, so we reconstruct a lightweight
    // lookup using the store. this is a known gap — for now we store a
    // reference that gets populated when the renderer is constructed.
    // TODO: consider adding registry to WidgetMountContext in a future refactor.
    let registry: WidgetRegistry | null = null;
    let renderer: BinRenderer | null = null;

    // -- snatch state --------------------------------------------------------

    let snatchInProgress = false;
    let snatchAbortController: AbortController | null = null;
    let snatchLabel = "snatch all";

    // -- tidy ----------------------------------------------------------------

    function handleTidy() {
      const state = ctx.doc.current;
      const mode = state.mode as BinMode;
      const scale = resolveScale(state.slotScale as SlotScale);
      const contentWidth = currentWidth - BIN_PADDING * 2;
      const cellBorderWidth = resolveCellBorderWidth(state.cellBorders, state.borderWidth);
      const cols = autoFitCols(mode, contentWidth, { scale, cellBorderWidth });
      const rows = computeRows(state.items.length, cols);

      ctx.doc.change((draft) => {
        for (let i = 0; i < draft.items.length; i++) {
          draft.items[i].slot = {
            col: i % cols,
            row: Math.floor(i / cols),
          };
        }
        draft.cols = cols;
        draft.rows = rows;
      });

      // resize the bin widget itself to the ideal size for this tidy layout —
      // fits exactly the tidied grid instead of leaving leftover empty space
      if (store) {
        const dims = contentDimensions(mode, cols, rows, contentWidth, { scale, cellBorderWidth });
        const idealWidth = Math.round(dims.width + BIN_PADDING * 2);
        const idealHeight = Math.round(dims.height + BIN_PADDING * 2);
        store.resizeWidget(ctx.widgetId, idealWidth, idealHeight);
      }
    }

    // -- header actions ------------------------------------------------------

    function buildHeaderActions(): HeaderAction[] {
      const state = ctx.doc.current;
      const count = state.items.length;
      const actions: HeaderAction[] = [];

      // viewers can't add files to a bin — don't even wire the button.
      if (!ctx.canvasStore?.isLocalViewer()) {
        actions.push({
          id: "add",
          label: "+ add",
          onClick: handleAddFiles,
        });
      }

      actions.push({
        id: "snatch",
        label: snatchLabel,
        onClick: () => {
          if (snatchInProgress) {
            snatchAbortController?.abort();
          } else {
            handleSnatchAll();
          }
        },
      });

      actions.push({
        id: "count",
        label: `${count} item${count !== 1 ? "s" : ""}`,
        isInfo: true,
      });

      return actions;
    }

    // -- empty state ---------------------------------------------------------

    const emptyContainer = new Container();
    emptyContainer.label = "bin-empty";
    container.addChild(emptyContainer);

    const emptyBorder = new Graphics();
    emptyContainer.addChild(emptyBorder);

    const emptyText = new Text({
      text: "drop widgets here\nor click + add",
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 11,
        fill: TEXT_MUTED,
        align: "center",
      },
      resolution: TEXT_RESOLUTION,
    });
    emptyContainer.addChild(emptyText);

    // -- content area --------------------------------------------------------

    const contentContainer = new Container();
    contentContainer.label = "bin-content";
    contentContainer.x = BIN_PADDING;
    contentContainer.y = BIN_PADDING;
    container.addChild(contentContainer);

    // -- card interaction callbacks -------------------------------------------
    // (created below in the init section after registry is resolved)

    // -- layout and render ---------------------------------------------------

    function drawEmpty(width: number, height: number) {
      const contentH = height;

      emptyBorder.clear();
      emptyBorder
        .roundRect(BIN_PADDING, BIN_PADDING, width - BIN_PADDING * 2, contentH - BIN_PADDING * 2, 4)
        // invisible fill (alpha 0) so the whole empty-state box is a real hit
        // target, not just the stroke outline — otherwise hovering the
        // interior misses pixi's bounds-based hit test (no drawn geometry
        // there) and the widget frame's header/toolbar never shows.
        .fill({ color: 0x000000, alpha: 0 })
        .stroke({ width: 1, color: 0x2a2a2a, alpha: 0.6 });

      emptyText.anchor.set(0.5);
      emptyText.x = width / 2;
      emptyText.y = contentH / 2;
    }

    function layout(width: number, height: number) {
      if (destroyed) return;

      drawBg(width, height);
      drawOuterBorder(width, height);
      void updateCoverSprite(width, height);

      const state = ctx.doc.current;
      const items = state.items;
      const mode = state.mode as BinMode;

      const scale = resolveScale(state.slotScale as SlotScale);
      const contentWidth = width - BIN_PADDING * 2;
      const layoutOptions: SlotSizeOptions = {
        scale,
        cellBorderWidth: resolveCellBorderWidth(state.cellBorders, state.borderWidth),
      };

      const minCols = autoFitCols(mode, contentWidth, layoutOptions);
      const bounds = computeGridBounds(items, minCols);
      const cols = bounds.cols;
      const rows = Math.max(bounds.rows, computeRows(items.length, cols));

      // auto-update rows in the doc if it diverged
      if (state.rows !== rows) {
        ctx.doc.change((draft) => {
          draft.rows = rows;
        });
      }

      // sync auto-computed cols to the doc so drop target can read it
      if (state.cols !== cols) {
        ctx.doc.change((draft) => {
          draft.cols = cols;
        });
      }

      const hasItems = items.length > 0;
      emptyContainer.visible = !hasItems;
      contentContainer.visible = hasItems;

      if (!hasItems) {
        drawEmpty(width, height);
        return;
      }

      if (renderer) {
        renderer.shelfTextOrigin = (state.shelfTextOrigin as "top" | "bottom") ?? "top";
        renderer.cellBordersEnabled = state.cellBorders ?? false;
        renderer.cellBorderWidth = state.borderWidth ?? 0;
        renderer.cellBorderColor = state.borderColor ?? -1;
        const visibleHeight = height - BIN_PADDING * 2;
        renderer.render(items, mode, cols, rows, contentWidth, visibleHeight, scale);
      }
    }

    // -- add files flow ------------------------------------------------------

    async function handleAddFiles() {
      if (!store || !repo) return;
      if (store.isLocalViewer()) return;

      const picked = await pickFiles();
      if (!picked || picked.length === 0) return;

      const state = ctx.doc.current;
      const scale = resolveScale(state.slotScale as SlotScale);
      const contentWidth = currentWidth - BIN_PADDING * 2;
      const cols = autoFitCols(state.mode as BinMode, contentWidth, {
        scale,
        cellBorderWidth: resolveCellBorderWidth(state.cellBorders, state.borderWidth),
      });
      const currentItems = [...state.items];

      for (const file of picked) {
        // find the next empty slot
        const occupiedSet = new Set(currentItems.map((i) => `${i.slot.col},${i.slot.row}`));
        const totalRows = computeRows(currentItems.length + 1, cols);
        let slot: { col: number; row: number } | null = null;
        for (let r = 0; r < totalRows; r++) {
          for (let c = 0; c < cols; c++) {
            if (!occupiedSet.has(`${c},${r}`)) {
              slot = { col: c, row: r };
              break;
            }
          }
          if (slot) break;
        }
        if (!slot) {
          // all slots full — expand rows
          slot = { col: 0, row: totalRows };
        }

        // create a child widget entry in the canvas doc — document files
        // (pdf/ps/eps/txt) become peedeeeff children instead of plain file
        // children, per the multi-file-upload auto-doc-widget feature.
        const childId = crypto.randomUUID();
        const isDoc = isDocumentFilename(file.filename);
        store.addWidget({
          id: childId,
          type: isDoc ? "peedeeeff" : "file",
          x: 0,
          y: 0,
          width: 200,
          height: 160,
          zIndex: 0,
          props: {},
          collapsed: false,
          docId: null,
          parentId: ctx.widgetId,
        });

        // the widget manager skips widgets with parentId, so no automerge doc
        // was created during reconcile. create the per-widget doc ourselves.
        const defaults = isDoc ? peedeeeffSchema.parse({}) : fileSchema.parse({});
        const docHandle = repo.create(defaults);
        store.setDocId(childId, docHandle.documentId);

        // upload the file and write result into the child's automerge doc.
        // on failure, clean up the child widget so we don't leave empty cards.
        try {
          const result = await uploadFile(file, { waitForCompletion: true });

          if (isDoc) {
            docHandle.change((draft: any) => {
              draft.blobId = result.blobId;
              draft.filename = file.filename;
              draft.mime = result.mime;
              draft.size = result.size;
              draft.blake3 = result.blake3 ?? "";
            });

            // best-effort persisted thumbnail — see peedeeeff's
            // thumbnailDataUrl doc comment for why this is needed at all
            // (bins never mount a child's full widget lifecycle).
            try {
              const thumbDataUrl = await getThumbnailDataUrl(result.blobId, { size: 200 });
              if (thumbDataUrl) {
                docHandle.change((draft: any) => {
                  draft.thumbnailDataUrl = thumbDataUrl;
                });
              }
            } catch {
              log.debug("bin", "doc thumbnail generation failed for", result.blobId);
            }

            // kick off page rendering (hub/peer proxy in browser mode, local
            // dispatch in tauri mode) — fire-and-forget so it doesn't block
            // the rest of the batch; nobody will ever mount this widget to
            // trigger it otherwise, since it lives in a bin.
            void kickOffDocumentProcessing(
              {
                current: () => docHandle.doc(),
                change: (fn) => docHandle.change(fn),
              },
              result.blobId,
              store
            );
          } else {
            // write directly into the handle we already hold (no re-find needed)
            docHandle.change((draft: any) => {
              draft.blobId = result.blobId;
              draft.domain = result.domain;
              draft.filename = file.filename;
              draft.mime = result.mime;
              draft.size = result.size;
              draft.blake3 = result.blake3 ?? "";
              draft.thumbnailDataUrl = result.thumbnailDataUrl ?? "";
            });

            // video/audio/pdf thumbnails need ffmpeg/magick, so they're never
            // ready synchronously at upload time. a bin never mounts its
            // children's full widget lifecycle (it only reads the persisted
            // doc via getCompactInfo), so nothing else will ever generate and
            // persist one later - fetch and write it now, best-effort.
            if (!result.thumbnailDataUrl) {
              try {
                const thumbDataUrl = await getThumbnailDataUrl(result.blobId, { size: 200 });
                if (thumbDataUrl) {
                  docHandle.change((draft: any) => {
                    draft.thumbnailDataUrl = thumbDataUrl;
                  });
                }
              } catch {
                // thumbnail generation is best-effort — don't fail the upload
                log.debug("bin", "thumbnail generation failed for", result.blobId);
              }
            }
          }

          // add the item to the bin's items list only on success
          currentItems.push({ widgetId: childId, slot });
          ctx.doc.change((draft) => {
            draft.items.push({ widgetId: childId, slot });
            draft.rows = computeRows(draft.items.length, cols);
          });
        } catch (err) {
          log.warn("bin", `upload failed for ${file.filename}:`, err);
          // clean up the child widget entry — upload failed, no point keeping it
          store.removeWidget(childId);
        }
      }

      // re-layout after all files are added
      layout(currentWidth, currentHeight);
    }

    // -- snatch all flow -----------------------------------------------------

    async function handleSnatchAll() {
      if (!store || !repo || snatchInProgress) return;

      snatchInProgress = true;
      snatchAbortController = new AbortController();
      snatchLabel = "cancel";
      ctx.setHeaderActions?.(buildHeaderActions());

      try {
        const peers = store.peers();

        await snatchAllInBin(ctx.widgetId, store, repo, peers, {
          signal: snatchAbortController.signal,
          onProgress: (progress) => {
            if (progress.done) {
              snatchLabel = "snatch all";
            } else {
              const done = progress.snatched + progress.failed + progress.alreadyLocal;
              snatchLabel = `${done}/${progress.total}`;
            }
            ctx.setHeaderActions?.(buildHeaderActions());
          },
        });
      } catch (err) {
        log.warn("bin", "snatch all failed:", err);
      } finally {
        snatchInProgress = false;
        snatchAbortController = null;
        snatchLabel = "snatch all";
        ctx.setHeaderActions?.(buildHeaderActions());
      }
    }

    // -- cover thumbnail actions -----------------------------------------------

    async function handleSetCoverFromFile() {
      if (!ctx.canvasStore || ctx.canvasStore.isLocalViewer()) return;
      const dataUrl = await pickImageAsDataUrl({ maxWidth: 500, maxHeight: 500 });
      if (!dataUrl) return;
      ctx.doc.change((draft) => {
        draft.coverThumbnailDataUrl = dataUrl;
      });
    }

    function handleRemoveCover() {
      if (ctx.canvasStore?.isLocalViewer()) return;
      ctx.doc.change((draft) => {
        draft.coverThumbnailDataUrl = "";
      });
    }

    // -- init ----------------------------------------------------------------

    // try to get the registry from a well-known location.
    // the bin widget is registered in the same registry that creates it,
    // so we stash a module-level reference during registration.
    registry = _binWidgetRegistry;

    // create drag handler for dragging cards out of the bin.
    // falls back to empty callbacks when dependencies are missing.
    const cardCallbacks: CardInteractionCallbacks =
      store && repo && registry
        ? createBinDragHandler({
            binContainer: container,
            binContentContainer: contentContainer,
            binWidgetId: ctx.widgetId,
            store,
            repo,
            registry,
            onDragOut: (childWidgetId: string) => {
              ctx.doc.change((draft) => {
                const idx = draft.items.findIndex((i: any) => i.widgetId === childWidgetId);
                if (idx !== -1) {
                  draft.items.splice(idx, 1);
                  draft.rows = computeRows(draft.items.length, Math.max(1, draft.cols));
                }
              });
            },

            onInternalMove: (widgetId: string, worldX: number, worldY: number): boolean => {
              const entry = store.getWidget(ctx.widgetId);
              if (!entry) return false;

              // check if the drop point is within the bin's frame bounds
              if (
                worldX < entry.x ||
                worldX > entry.x + entry.width ||
                worldY < entry.y ||
                worldY > entry.y + entry.height
              ) {
                return false; // outside the bin — let the drag handler un-nest
              }

              const state = ctx.doc.current;
              const mode = state.mode as BinMode;
              const scale = resolveScale(state.slotScale as SlotScale);
              const cols = Math.max(1, state.cols);
              const contentWidth = entry.width - BIN_PADDING * 2;
              const layoutOptions: SlotSizeOptions = {
                scale,
                cellBorderWidth: resolveCellBorderWidth(state.cellBorders, state.borderWidth),
              };

              // convert to content-local coordinates
              const localX = worldX - entry.x - BIN_PADDING;
              let localY = worldY - entry.y - BIN_PADDING;

              // account for drawer scroll
              if (mode === "drawer" && renderer) {
                localY += renderer.getScrollOffset();
              }

              const bounds = computeGridBounds(state.items, cols);
              const rows = Math.max(bounds.rows, computeRows(state.items.length, cols)) + 1;
              let slot = hitTestSlot(mode, localX, localY, cols, rows, contentWidth, layoutOptions);

              if (!slot) {
                // pointer not on a valid slot — find the first empty
                const occupied = state.items.map((i: any) => i.slot);
                slot = firstEmptySlot(occupied, cols, rows);
              }

              if (!slot) return false; // no valid target

              // find the item being moved
              const itemIdx = state.items.findIndex((i: any) => i.widgetId === widgetId);
              if (itemIdx === -1) return false; // not in this bin (shouldn't happen)

              // check if it's the same slot (no-op)
              const currentSlot = state.items[itemIdx].slot;
              if (currentSlot.col === slot.col && currentSlot.row === slot.row) {
                return true; // dropped on same slot — still counts as handled
              }

              // check if target slot is occupied by another item
              const targetKey = `${slot.col},${slot.row}`;

              ctx.doc.change((draft) => {
                const occupantIdx = draft.items.findIndex(
                  (i: any, idx: number) =>
                    idx !== itemIdx && `${i.slot.col},${i.slot.row}` === targetKey
                );

                if (occupantIdx !== -1) {
                  // swap: move occupant to the dragged item's original slot
                  draft.items[occupantIdx].slot = { col: currentSlot.col, row: currentSlot.row };
                }

                // move the dragged item to the target slot
                draft.items[itemIdx].slot = slot!;
              });

              return true;
            },

            onDragMove: (_widgetId: string, worldX: number, worldY: number): void => {
              if (!renderer) return;
              const entry = store.getWidget(ctx.widgetId);
              if (!entry) return;

              // check if pointer is within the bin
              if (
                worldX < entry.x ||
                worldX > entry.x + entry.width ||
                worldY < entry.y ||
                worldY > entry.y + entry.height
              ) {
                renderer.showSlotHighlight(null);
                return;
              }

              const state = ctx.doc.current;
              const mode = state.mode as BinMode;
              const scale = resolveScale(state.slotScale as SlotScale);
              const cols = Math.max(1, state.cols);
              const contentWidth = entry.width - BIN_PADDING * 2;
              const layoutOptions: SlotSizeOptions = {
                scale,
                cellBorderWidth: resolveCellBorderWidth(state.cellBorders, state.borderWidth),
              };

              const localX = worldX - entry.x - BIN_PADDING;
              let localY = worldY - entry.y - BIN_PADDING;

              if (mode === "drawer" && renderer) {
                localY += renderer.getScrollOffset();
              }

              const bounds = computeGridBounds(state.items, cols);
              const rows = Math.max(bounds.rows, computeRows(state.items.length, cols)) + 1;
              const slot = hitTestSlot(
                mode,
                localX,
                localY,
                cols,
                rows,
                contentWidth,
                layoutOptions
              );

              if (slot) {
                renderer.showSlotHighlight(slot);
              } else {
                const occupied = state.items.map((i: any) => i.slot);
                const empty = firstEmptySlot(occupied, cols, rows);
                renderer.showSlotHighlight(empty);
              }
            },

            onDragEnd: (): void => {
              renderer?.showSlotHighlight(null);
            },
          })
        : {};

    // media controller for audio/video playback on compact cards
    let mediaController: BinMediaController | null = null;

    // add onCardTap: for media cards (audio/video), route through the media
    // controller for play/pause. for other cards, call onCompactActivate
    // on the factory (e.g., canvas-card navigates to the canvas).
    // cardCallbacks is the same object returned by createBinDragHandler,
    // so we just add the onCardTap property.
    if (store && repo && registry) {
      (cardCallbacks as CardInteractionCallbacks).onCardTap = (widgetId: string) => {
        // try media controller first — returns true if it handled the tap
        if (mediaController?.handleTap(widgetId)) {
          return;
        }

        // fall through to onCompactActivate for non-media cards
        const entry = store.getWidget(widgetId);
        if (!entry) return;

        const factory = registry!.get(entry.type);
        if (!factory?.onCompactActivate || !entry.docId) return;

        try {
          const handle = repo!.handles[entry.docId as DocumentId];
          if (!handle) return;
          const rawDoc = handle.doc();
          if (!rawDoc) return;
          const state = factory.schema ? factory.schema.parse(rawDoc) : rawDoc;
          factory.onCompactActivate(state);
        } catch {
          // best-effort — don't break the bin on activation errors
        }
      };
    }

    if (repo && registry && store) {
      renderer = new BinRenderer(repo, registry, store, cardCallbacks);
      contentContainer.addChild(renderer.container);

      // create media controller for audio/video card playback
      mediaController = new BinMediaController({
        canvasElement: ctx.canvasElement,
        getCard: (wid) => renderer?.getCard(wid),
        getPeers: () => {
          const peers = ctx.canvasStore?.peers();
          return peers as Record<string, { nodeId: string }> | undefined;
        },
      });
      renderer.setMediaController(mediaController);
      renderer.setGetPeers(() => {
        const peers = ctx.canvasStore?.peers();
        return peers as Record<string, { nodeId: string }> | undefined;
      });
    }

    // initial layout
    layout(currentWidth, currentHeight);

    // subscribe to doc changes
    const unsub = ctx.doc.on("change", () => {
      layout(currentWidth, currentHeight);
      ctx.setHeaderActions?.(buildHeaderActions());
    });

    // -- controller ----------------------------------------------------------

    return {
      container,

      headerActions: buildHeaderActions(),

      widgetActions: [
        { id: "tidy", label: "tidy", onClick: handleTidy },
        { id: "cover-pick", label: "choose bg image", onClick: handleSetCoverFromFile },
        { id: "cover-remove", label: "remove bg image", onClick: handleRemoveCover },
      ],

      resize(width: number, height: number) {
        currentWidth = width;
        currentHeight = height;
        layout(width, height);
      },

      destroy() {
        destroyed = true;
        unsub();
        mediaController?.destroy();
        mediaController = null;
        renderer?.destroy();
        container.destroy({ children: true });
      },

      setMaximized(_maximized: boolean) {
        layout(currentWidth, currentHeight);
      },

      dropTarget: store
        ? {
            hitTest(worldX: number, worldY: number): boolean {
              // check if the point is within the bin widget's frame bounds.
              // the widget entry in the canvas store has the current x, y, width, height.
              const entry = store.getWidget(ctx.widgetId);
              if (!entry) return false;
              return (
                worldX >= entry.x &&
                worldX <= entry.x + entry.width &&
                worldY >= entry.y &&
                worldY <= entry.y + entry.height
              );
            },

            onHover(worldX: number, worldY: number, _draggedWidgetId: string): void {
              if (!renderer) return;
              const entry = store.getWidget(ctx.widgetId);
              if (!entry) return;

              const state = ctx.doc.current;
              const mode = state.mode as BinMode;
              const scale = resolveScale(state.slotScale as SlotScale);
              const cols = Math.max(1, state.cols);
              const contentWidth = entry.width - BIN_PADDING * 2;
              const layoutOptions: SlotSizeOptions = {
                scale,
                cellBorderWidth: resolveCellBorderWidth(state.cellBorders, state.borderWidth),
              };

              // convert world coordinates to content-local coordinates.
              // the content area starts at (entry.x + BIN_PADDING, entry.y + BIN_PADDING).
              const localX = worldX - entry.x - BIN_PADDING;
              let localY = worldY - entry.y - BIN_PADDING;

              // in drawer mode, account for scroll offset so hit testing matches visible content
              if (mode === "drawer" && renderer) {
                localY += renderer.getScrollOffset();
              }

              // account for existing item positions and extra room for the incoming item
              const bounds = computeGridBounds(state.items, cols);
              const rows = Math.max(bounds.rows, computeRows(state.items.length + 1, cols)) + 1;
              const slot = hitTestSlot(
                mode,
                localX,
                localY,
                cols,
                rows,
                contentWidth,
                layoutOptions
              );

              if (slot) {
                // always highlight the slot under the cursor — even if occupied
                // (dropping on an occupied slot will swap the occupant out)
                renderer.showSlotHighlight(slot);
              } else {
                // pointer is in the bin area but not on a valid slot — find the first empty
                const empty = firstEmptySlot(
                  state.items.map((i: any) => i.slot),
                  cols,
                  rows
                );
                renderer.showSlotHighlight(empty);
              }
            },

            onLeave(): void {
              renderer?.showSlotHighlight(null);
            },

            onDrop(draggedWidgetId: string, worldX: number, worldY: number): boolean {
              if (!store) return false;

              const entry = store.getWidget(ctx.widgetId);
              if (!entry) return false;

              const state = ctx.doc.current;
              const mode = state.mode as BinMode;
              const scale = resolveScale(state.slotScale as SlotScale);
              const cols = Math.max(1, state.cols);
              const contentWidth = entry.width - BIN_PADDING * 2;
              const layoutOptions: SlotSizeOptions = {
                scale,
                cellBorderWidth: resolveCellBorderWidth(state.cellBorders, state.borderWidth),
              };

              // convert to content-local coordinates
              const localX = worldX - entry.x - BIN_PADDING;
              let localY = worldY - entry.y - BIN_PADDING;

              // in drawer mode, account for scroll offset
              if (mode === "drawer" && renderer) {
                localY += renderer.getScrollOffset();
              }

              // find a slot for the dropped widget
              const dropBounds = computeGridBounds(state.items, cols);
              const rows = Math.max(dropBounds.rows, computeRows(state.items.length + 1, cols)) + 1;
              const occupied = state.items.map((i: any) => i.slot);
              let slot = hitTestSlot(mode, localX, localY, cols, rows, contentWidth, layoutOptions);

              if (!slot) {
                // pointer not on a valid slot — find the first empty
                slot = firstEmptySlot(occupied, cols, rows);
              }

              // fallback: append to a new row
              if (!slot) {
                slot = { col: 0, row: rows };
              }

              // nest the widget: set parentId and add to the bin's items
              store.setParentId(draggedWidgetId, ctx.widgetId);

              // if the target slot is occupied, swap the occupant to the first empty slot
              const occupiedSet = new Set(occupied.map((s: any) => `${s.col},${s.row}`));
              const targetKey = `${slot.col},${slot.row}`;

              ctx.doc.change((draft) => {
                if (occupiedSet.has(targetKey)) {
                  // find the occupant and move it to the first available slot
                  const occupantIdx = draft.items.findIndex(
                    (i: any) => `${i.slot.col},${i.slot.row}` === targetKey
                  );
                  if (occupantIdx !== -1) {
                    // compute empty slot excluding the target (which the new widget will take)
                    const allOccupied = draft.items
                      .filter((_: any, idx: number) => idx !== occupantIdx)
                      .map((i: any) => i.slot);
                    // also exclude the target slot itself
                    allOccupied.push(slot);
                    const itemSlots = draft.items.map((i: any) => ({
                      slot: { col: i.slot.col, row: i.slot.row },
                    }));
                    const swapBounds = computeGridBounds(itemSlots, Math.max(1, draft.cols));
                    const swapRows =
                      Math.max(
                        swapBounds.rows,
                        computeRows(draft.items.length + 1, Math.max(1, draft.cols))
                      ) + 1;
                    const emptySlot = firstEmptySlot(
                      allOccupied,
                      Math.max(1, draft.cols),
                      swapRows
                    );
                    if (emptySlot) {
                      draft.items[occupantIdx].slot = emptySlot;
                    } else {
                      // no empty slot — push occupant to a new row
                      draft.items[occupantIdx].slot = { col: 0, row: swapRows };
                    }
                  }
                }

                draft.items.push({ widgetId: draggedWidgetId, slot });
                draft.rows = computeRows(draft.items.length, Math.max(1, draft.cols));
              });

              renderer?.showSlotHighlight(null);
              return true;
            },
          }
        : undefined,
    };
  },
};

// -----------------------------------------------------------------------
// registry bootstrapping
// -----------------------------------------------------------------------

// module-level reference set by registerBinWidget() so the bin's create()
// can access the widget registry (needed to call getCompactInfo on children).
let _binWidgetRegistry: WidgetRegistry | null = null;

/**
 * register the bin widget and stash the registry reference so the widget
 * can look up child factories at runtime.
 */
export function registerBinWidget(registry: WidgetRegistry): void {
  _binWidgetRegistry = registry;
  registry.register(binWidget);
}
