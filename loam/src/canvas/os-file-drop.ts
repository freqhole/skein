/**
 * OS-level file drag-and-drop onto the canvas.
 *
 * dropping a file from the native file manager (Finder/Explorer) onto the
 * window creates a new `file` widget at the drop point. dropping onto the
 * narthex is special-cased two ways: dropping directly onto a canvas-card
 * routes the file to THAT card's target canvas instead (opened via
 * `CanvasStore.open()`, the same lightweight "read/write an inactive canvas
 * without mounting its full UI" pattern boot.ts already uses all over);
 * dropping onto the narthex background just adds the file to local storage
 * — no widget is ever created on the narthex itself, matching
 * filez-widget.ts's `canDragOut()` rule for the local-files drag-out
 * feature.
 *
 * two mutually-exclusive wiring paths, chosen once at setup:
 *  - browser mode: standard HTML5 dragenter/dragover/drop + DataTransfer.files
 *    (real File objects, bytes readable directly).
 *  - tauri mode: tauri's own webview-level drag-drop interception is on by
 *    default (see tauri/src/lib.rs's WebviewWindowBuilder — no
 *    `.disable_drag_drop_handler()` call), which swallows the browser's
 *    native DnD events before `drop`/`dataTransfer` ever fire, and instead
 *    hands back real absolute file PATHS (no bytes) via
 *    `getCurrentWebview().onDragDropEvent()` — matches how the native file
 *    picker already works in upload.ts's `pickFilesTauri()`.
 */

import type { Repo, DocumentId } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import type { SkeinCanvas } from "./init";
import { CanvasStore } from "./canvas-store";
import { isTauriMode } from "../p2p/tauri-transport";
import { uploadFile } from "../file-utils/upload";
import type { PickedFile } from "../file-utils/file-shared";
import {
  createFileWidgetFromBlob,
  CREATE_FILE_WIDGET_DEFAULT_WIDTH,
  CREATE_FILE_WIDGET_DEFAULT_HEIGHT,
} from "../file-utils/create-file-widget";

const TAG = "canvas.os-file-drop";

export interface OsFileDropContext {
  repo: Repo;
  /** null while no canvas is mounted yet (still booting) — drops are ignored. */
  getCurrentCanvas(): SkeinCanvas | null;
  getNarthexDocId(): string | null;
}

/** wires OS-level file drag-and-drop for the app's whole lifetime. call
 *  once from boot() — safe to call before any canvas is mounted. */
export function setupOsFileDrop(ctx: OsFileDropContext): void {
  const overlay = createDropOverlay();

  function showOverlay(): void {
    overlay.style.display = "flex";
  }
  function hideOverlay(): void {
    overlay.style.display = "none";
  }

  function screenToWorld(canvas: SkeinCanvas, clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.app.canvas.getBoundingClientRect();
    return canvas.world.toLocal({ x: clientX - rect.left, y: clientY - rect.top });
  }

  /** a canvas-card widget under the drop point, narthex only —
   *  `canvasDocId` is mirrored onto the WidgetEntry's own `props` at
   *  creation time, so this never needs to open the card's own child doc
   *  just to hit-test (see friendz-wiring.test.ts / canvas-card.integration.test.ts). */
  function hitTestCanvasCard(canvas: SkeinCanvas, clientX: number, clientY: number): string | null {
    const { x, y } = screenToWorld(canvas, clientX, clientY);
    for (const w of canvas.store.allWidgets()) {
      if (w.type !== "canvas-card") continue;
      if (x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) {
        const docId = (w.props as { canvasDocId?: string } | undefined)?.canvasDocId;
        if (docId) return docId;
      }
    }
    return null;
  }

  async function handleDroppedFiles(picked: PickedFile[], clientX: number, clientY: number): Promise<void> {
    if (picked.length === 0) return;
    const canvas = ctx.getCurrentCanvas();
    if (!canvas) return;

    const isNarthex = canvas.store.handle.documentId === ctx.getNarthexDocId();
    const targetCardDocId = isNarthex ? hitTestCanvasCard(canvas, clientX, clientY) : null;

    for (let i = 0; i < picked.length; i++) {
      const file = picked[i];
      const stagger = i * 24; // keep multi-file drops from stacking exactly
      try {
        const result = await uploadFile(file);

        if (isNarthex && !targetCardDocId) {
          // narthex background: just add to local storage — the narthex
          // never shows file widgets (same rule as filez-widget.ts's
          // canDragOut()).
          continue;
        }

        if (isNarthex && targetCardDocId) {
          const targetStore = await CanvasStore.open(ctx.repo, targetCardDocId as DocumentId);
          await createFileWidgetFromBlob(ctx.repo, targetStore, {
            blobId: result.blobId,
            filename: file.filename,
            mime: result.mime,
            size: result.size,
            blake3: result.blake3,
            x: 100 + stagger,
            y: 100 + stagger,
          });
          continue;
        }

        const local = screenToWorld(canvas, clientX, clientY);
        await createFileWidgetFromBlob(ctx.repo, canvas.store, {
          blobId: result.blobId,
          filename: file.filename,
          mime: result.mime,
          size: result.size,
          blake3: result.blake3,
          x: local.x - CREATE_FILE_WIDGET_DEFAULT_WIDTH / 2 + stagger,
          y: local.y - CREATE_FILE_WIDGET_DEFAULT_HEIGHT / 2 + stagger,
        });
      } catch (err) {
        log.warn(TAG, `failed to add dropped file "${file.filename}":`, err);
      }
    }
  }

  if (isTauriMode()) {
    void setupTauriDragDrop(handleDroppedFiles, showOverlay, hideOverlay);
  } else {
    setupBrowserDragDrop(handleDroppedFiles, showOverlay, hideOverlay);
  }
}

function setupBrowserDragDrop(
  onDrop: (files: PickedFile[], clientX: number, clientY: number) => Promise<void>,
  showOverlay: () => void,
  hideOverlay: () => void
): void {
  let depth = 0; // dragenter/dragleave nest over child elements — only hide at depth 0

  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");

  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    showOverlay();
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // required to allow a drop at all
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hideOverlay();
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    hideOverlay();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const picked: PickedFile[] = files.map((file) => ({
      path: null,
      filename: file.name,
      size: file.size,
      file,
    }));
    void onDrop(picked, e.clientX, e.clientY);
  });
}

async function setupTauriDragDrop(
  onDrop: (files: PickedFile[], clientX: number, clientY: number) => Promise<void>,
  showOverlay: () => void,
  hideOverlay: () => void
): Promise<void> {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        showOverlay();
        return;
      }
      if (payload.type === "leave") {
        hideOverlay();
        return;
      }
      // "drop"
      hideOverlay();
      if (payload.paths.length === 0) return;
      const picked: PickedFile[] = payload.paths.map((p) => ({
        path: p,
        filename: p.split(/[\\/]/).pop() ?? p,
        size: 0,
        file: null,
      }));
      // despite the `PhysicalPosition` type, tauri's webview drag-drop
      // position is already in CSS/logical px matching clientX/clientY
      // (same space getBoundingClientRect() uses) — dividing by
      // devicePixelRatio here previously shrank it, dragging the drop
      // point toward the canvas origin (reported as "far north/west" on
      // retina displays, worse when zoomed in since world.toLocal()
      // amplifies a pre-transform offset by 1/zoom).
      void onDrop(picked, payload.position.x, payload.position.y);
    });
  } catch (err) {
    log.warn(TAG, "failed to wire up tauri drag-drop:", err);
  }
}

function createDropOverlay(): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "os-file-drop-overlay");
  Object.assign(el.style, {
    position: "fixed",
    inset: "0",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(10, 10, 14, 0.75)",
    border: "3px dashed #d946ef",
    boxSizing: "border-box",
    zIndex: "999999",
    pointerEvents: "none",
    fontFamily: "system-ui, sans-serif",
    fontSize: "20px",
    color: "#e0e0e0",
  });
  el.textContent = "drop file to add";
  document.body.appendChild(el);
  return el;
}
