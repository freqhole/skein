/**
 * create a new `file` widget on a canvas from a blob that's already local
 * (dragged in from the filez tab 2 "local files" list) — no upload needed,
 * since the bytes already exist on this machine.
 *
 * mirrors the tail end of `file.ts`'s own upload-completion handler: stamps
 * `snatchedBy` with the local node id (so peers on this canvas can target us
 * for downloads immediately, same as a freshly-completed upload) and
 * registers a `blob-canvas-refs` row for this canvas (so future purges/
 * `unregisterBlobFromAllCanvases` calls know to clean up this widget too).
 */

import type { Repo } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import type { CanvasStore } from "../canvas/canvas-store";
import { fileSchema } from "../../widgets/file";
import { classifyDomain } from "../storage/blob-store";
import { getThumbnailDataUrl } from "./thumbnail-utils";
import { probeMediaDuration } from "./media-duration";
import { getMediaPlaybackUrl } from "../media/media-urls";
import { addBlobCanvasRef } from "./blob-canvas-refs";
import { getLocalNodeId } from "./file-shared";

const TAG = "file-utils.create-file-widget";

const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 200;

/** default `file` widget footprint — exported so callers positioning a drop
 *  (e.g. filez-widget.ts's drag-out-to-canvas) can center the new widget
 *  under the drop point without duplicating these numbers. */
export const CREATE_FILE_WIDGET_DEFAULT_WIDTH = DEFAULT_WIDTH;
export const CREATE_FILE_WIDGET_DEFAULT_HEIGHT = DEFAULT_HEIGHT;

export interface CreateFileWidgetFromBlobOptions {
  blobId: string;
  filename?: string;
  mime?: string;
  size?: number;
  blake3?: string | null;
  /** drop position on the canvas — defaults to (100, 100). */
  x?: number;
  y?: number;
}

/**
 * create a `file` widget bound to an existing local blob and add it to
 * `store`. returns the new widget's id.
 */
export async function createFileWidgetFromBlob(
  repo: Repo,
  store: CanvasStore,
  options: CreateFileWidgetFromBlobOptions
): Promise<string> {
  const { blobId, filename = "", mime = "", size = 0, blake3, x = 100, y = 100 } = options;
  const domain = classifyDomain(mime);
  const localNodeId = await getLocalNodeId();

  let thumbnailDataUrl = "";
  try {
    thumbnailDataUrl = (await getThumbnailDataUrl(blobId, { size: 200 })) ?? "";
  } catch (err) {
    log.debug(TAG, `thumbnail fetch failed for ${blobId.slice(0, 12)}... (non-fatal):`, err);
  }

  // probe duration upfront (mirrors file.ts's own post-upload
  // probeAndWriteDuration()) so an audio/video widget created this way is
  // immediately capturable as an animaniac segment (frame-capture.ts
  // requires `duration > 0`) instead of needing to wait for file.ts's own
  // mount-time probe to catch up first — matters when the caller (e.g.
  // filez-widget.ts's drag-out-to-canvas) may try dropping the brand-new
  // widget straight onto another widget's drop target right after this
  // resolves.
  let duration = 0;
  if (domain === "audio" || domain === "video") {
    try {
      const url = await getMediaPlaybackUrl(blobId, { category: domain, mime: mime || undefined, blake3: blake3 || undefined });
      if (url) duration = await probeMediaDuration(url, domain);
    } catch (err) {
      log.debug(TAG, `duration probe failed for ${blobId.slice(0, 12)}... (non-fatal):`, err);
    }
  }

  const widgetDoc = fileSchema.parse({
    blobId,
    domain,
    filename,
    mime,
    size,
    blake3: blake3 ?? "",
    thumbnailDataUrl,
    duration,
    snatchedBy: localNodeId ? [localNodeId] : [],
  });

  const handle = repo.create(widgetDoc);
  const widgetId = crypto.randomUUID();
  const zIndex = 1 + Math.max(0, ...store.allWidgets().map((w) => w.zIndex || 0));

  store.addWidget({
    id: widgetId,
    type: "file",
    x,
    y,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    zIndex,
    props: {},
    collapsed: false,
    docId: handle.documentId,
    parentId: null,
  });

  const canvasDocId = store.handle.documentId;
  addBlobCanvasRef(blobId, blake3 ?? "", canvasDocId).catch((err) => {
    log.debug(TAG, `addBlobCanvasRef failed (non-fatal) for ${blobId.slice(0, 12)}...:`, err);
  });

  return widgetId;
}
