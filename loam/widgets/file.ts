import { Assets, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import { z } from "zod";
import { log, pickImageAsDataUrl } from "@freqhole/reliquary/utils";
import { getMediaPlaybackUrl } from "../src/media";
import { isTauriMode } from "../src/p2p/tauri-transport";
import { getLocalNodeId, type PeersMap, type PickedFile, type ThumbnailOptions } from "../src/file-utils/file-shared";
import { formatFileSize } from "../src/widgets/format";
import { addBlobCanvasRef, removeBlobCanvasRef } from "../src/file-utils/blob-canvas-refs";
import { checkBlobLocality, freeUpLocalBlobCopy, getLocalBlobByteSize } from "../src/file-utils/blob-locality";
import { getLocalBlobUrl, revealBlobInFinder, saveBlobToDisk } from "../src/file-utils/blob-io";
import { getDocumentPages } from "../src/file-utils/document-pages";
import { getThumbnailDataUrl, ensureThumbnailPersisted } from "../src/file-utils/thumbnail-utils";
import {
  isDocumentFilename,
  isMarkdownFilename,
  isPlainTextFilename,
  formatUploadError,
  pickFiles,
  readPickedFileText,
  uploadFile,
} from "../src/file-utils/upload";
import { discardPausedDownload, pauseSnatchDownload, snatchBlob, BlobAccessDeniedError } from "../src/file-utils/snatch";
import { sendFriendRequest } from "../src/p2p/friendz-bridge";
import { registerPendingBlobRetry } from "../src/p2p/pending-blob-access";
import { createInlinePlayer, type InlinePlayerHandle } from "../src/widgets/inline-media";
import { createMediaOverlay, type MediaOverlayHandle } from "../src/widgets/media-overlay";
import { createGifHoverOverlay, type GifHoverOverlayHandle } from "../src/widgets/gif-hover-overlay";
import { peerNameFor } from "../src/canvas/peer-names";
import { subscribeTransferProgress } from "../src/p2p/transfer-progress";
import {
  cancelDomainIngest,
  runDomainIngest,
  type DomainIngestDoc,
} from "./file-domain-ingest";
import { kickOffDocumentProcessing } from "./peedeeeff/render-client";
import { peedeeeffSchema, type PeedeeeffState } from "./peedeeeff/types";
import { markdownSchema } from "./markdown";
import { notepadSchema } from "./notepad";
import type { DocHandle } from "@automerge/automerge-repo";
import type {
  CompactInfo,
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
  WidgetPropDef,
} from "../src/widgets/widget-types";

export const fileSchema = z.object({
  /** media blob ID from grimoire */
  blobId: z.string().default(""),
  /** media domain: audio, photo, video, document, file */
  domain: z.string().default(""),
  /** original filename */
  filename: z.string().default(""),
  /** optional display title — preferred over filename when set */
  title: z.string().default(""),
  /** MIME type */
  mime: z.string().default(""),
  /** file size in bytes */
  size: z.number().default(0),
  /** blake3 content hash (for P2P verified fetch) */
  blake3: z.string().default(""),
  /** embedded thumbnail as a data URL (written after upload/snatch for instant render) */
  thumbnailDataUrl: z.string().default(""),
  /** list of node IDs that have snatched (or uploaded) this blob.
   *  used to target blob downloads — only probe peers in this list. */
  snatchedBy: z.array(z.string()).default([]),
  /** upload lock: node id of the peer currently uploading into this widget
   *  (empty = none). peers render a locked progress view and refuse to
   *  start a competing upload while a fresh lock is held. */
  uploadingBy: z.string().default(""),
  /** upload progress 0..1, written (throttled) by the uploading peer */
  uploadingProgress: z.number().default(0),
  /** ms epoch of the last uploadingBy/uploadingProgress write — locks older
   *  than the staleness window are ignored (crashed uploader recovery) */
  uploadingAt: z.number().default(0),
  /** domain-ingest status for a manually-picked (not auto-detected) domain:
   *  "" idle, "processing", or "failed" (transient — cleared back to "" the
   *  same tick `domain` reverts to ""). see file-domain-ingest.ts. */
  domainIngestState: z.string().default(""),
  /** best-effort claim so only one peer attempts domain ingest at a time —
   *  same pattern as peedeeeff's processingClaimedBy/processingClaimedAt. */
  domainIngestClaimedBy: z.string().default(""),
  domainIngestClaimedAt: z.number().default(0),
});

export type FileState = z.infer<typeof fileSchema>;

/** `classifyDomain()` (src/storage/blob-store.ts) never returns "" — it
 *  falls back to the generic "file" bucket for anything it can't
 *  recognize, so `domain` is realistically never actually empty. "file" is
 *  that fallback/unclassified state, same as truly unset. */
function isDomainEditable(domain: string): boolean {
  return !domain || domain === "file";
}

/** instance-level editable props: the "file type" select only appears while
 *  the domain is still the generic/unclassified "file" bucket (or, for
 *  legacy widgets predating this field, truly unset) — it's a fill-in-the-
 *  blank control, not a general override for a domain that auto-detection
 *  already pinned down to something more specific. */
function fileEditableProps(domain: string): WidgetPropDef[] {
  const props: WidgetPropDef[] = [{ key: "title", label: "title", type: "string", default: "" }];
  if (isDomainEditable(domain)) {
    props.push({
      key: "domain",
      label: "file type",
      type: "select",
      options: ["file", "photo", "video", "audio", "document"],
      default: "file",
      // the property tray only rebuilds this control list when the widget
      // *selection* changes, not on every doc write — so a pick that lands
      // while the tray stays open needs this live, reactive check to hide
      // the select immediately (rather than leaving a stale control
      // showing through the whole processing run, and after a failure
      // reverts `domain` back to "" - though it re-appearing then is correct).
      visibleWhen: { key: "domain", value: ["", "file"] },
    });
  }
  return props;
}

type LoadState = "empty" | "loading" | "loaded" | "error";

/** tracks whether the blob is local, remote, or just snatched this session */
type ActionState =
  | "checking"
  | "local"
  | "remote"
  | "snatched"
  | "saving"
  | "snatching"
  | "paused"
  | "needs-friend" // only non-friend peers have the blob; tap to send a friend request
  | "friend-requested"; // friend request sent; waiting to retry the snatch

const INFO_BAR_HEIGHT = 48;
const ACTION_BAR_HEIGHT = 28;
const THUMB_PADDING = 4;
const BUTTON_H = 20;
const BUTTON_PAD_H = 8;
const BUTTON_PAD_V = 2;
const BUTTON_RADIUS = 3;
const BUTTON_FONT_SIZE = 10;

/** an upload lock whose last heartbeat is older than this is considered
 *  abandoned (uploader crashed / closed the tab) and can be taken over. */
const UPLOAD_LOCK_STALE_MS = 30_000;

/**
 * truncate a string to a maximum length, appending "..." if truncated.
 */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * pick a fill color for the domain badge background.
 */
function domainBadgeColor(domain: string): number {
  switch (domain) {
    case "audio":
      return 0x2d5a27;
    case "photo":
      return 0x27455a;
    case "video":
      return 0x5a2745;
    case "document":
      return 0x4a4a27;
    default:
      return 0x3a3a4a;
  }
}

/**
 * returns true if the domain supports full-screen preview/playback.
 */
function isPreviewableDomain(domain: string): boolean {
  return domain === "photo" || domain === "video" || domain === "audio";
}

/**
 * map domain to the media overlay type.
 */
function domainToOverlayType(domain: string): "photo" | "video" | "audio" {
  if (domain === "video") return "video";
  if (domain === "audio") return "audio";
  return "photo";
}

// ---------------------------------------------------------------------------
// pill button helper — creates a small rounded-rect button with text
// ---------------------------------------------------------------------------

interface PillButton {
  container: Container;
  bg: Graphics;
  label: Text;
  setLabel(text: string): void;
  setColor(fill: number): void;
  setVisible(v: boolean): void;
  getWidth(): number;
}

function createPillButton(text: string, fill: number, onClick: () => void): PillButton {
  const c = new Container();
  c.eventMode = "static";
  c.cursor = "pointer";

  const bg = new Graphics();
  c.addChild(bg);

  const label = new Text({
    text,
    style: {
      fontFamily: "system-ui, sans-serif",
      fontSize: BUTTON_FONT_SIZE,
      fill: 0xddddee,
      align: "center",
    },
    resolution: 2,
  });
  c.addChild(label);

  const redraw = () => {
    if (c.destroyed) return;
    const w = label.width + BUTTON_PAD_H * 2;
    bg.clear();
    bg.roundRect(0, 0, w, BUTTON_H, BUTTON_RADIUS);
    bg.fill({ color: fill });
    label.x = BUTTON_PAD_H;
    label.y = BUTTON_PAD_V + 1;
  };

  redraw();
  c.on("pointertap", (e) => {
    e.stopPropagation();
    onClick();
  });

  return {
    container: c,
    bg,
    label,
    setLabel(t: string) {
      label.text = t;
      redraw();
    },
    setColor(f: number) {
      fill = f;
      redraw();
    },
    setVisible(v: boolean) {
      c.visible = v;
    },
    getWidth() {
      return label.width + BUTTON_PAD_H * 2;
    },
  };
}

// ---------------------------------------------------------------------------
// file widget factory
// ---------------------------------------------------------------------------

export const fileWidget: WidgetFactory<typeof fileSchema> = {
  type: "file",
  metadata: {
    name: "file",
    description: "upload and display any file with thumbnail preview",
    version: "0.2.0",
    category: "basics",
    defaultWidth: 280,
    defaultHeight: 200,
  },
  schema: fileSchema,
  editableProps: [{ key: "title", label: "title", type: "string" as const, default: "" }],

  getCompactInfo: (state: FileState): CompactInfo => ({
    label: (state.title && state.title.trim()) || state.filename || "untitled",
    thumbnailUrl: state.thumbnailDataUrl || undefined,
    accentColor: domainBadgeColor(state.domain),
    domain: state.domain || undefined,
    blobId: state.blobId || undefined,
    mime: state.mime || undefined,
    filename: state.filename || undefined,
    blake3: state.blake3 || undefined,
    size: state.size || undefined,
    snatchedBy: state.snatchedBy?.length ? state.snatchedBy.map(String) : undefined,
  }),

  create(ctx: WidgetMountContext<typeof fileSchema>): WidgetController {
    const container = new Container();
    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let loadState: LoadState = "empty";
    let actionState: ActionState = "checking";
    let currentTexture: Texture | null = null;
    let thumbSprite: Sprite | null = null;
    let loadingAbort: AbortController | null = null;
    let snatchAbort: AbortController | null = null;
    let snatchCancelled = false;
    let snatchProgressText = "";
    let snatchHovered = false;
    // the blake3 the in-flight/paused snatch actually targets — captured at
    // handleSnatch's start, NOT re-read from ctx.doc.current, because
    // cancelSnatch/pauseSnatch/discardPausedSnatch can be invoked from the
    // doc-change subscriber's blobId-change branch, where ctx.doc.current
    // already reflects the NEW state by the time they run. reading the doc
    // there would tell rust/the worker to cancel the wrong (new) blake3,
    // leaving the real in-flight download for the OLD blake3 orphaned.
    let activeSnatchBlake3: string | null = null;
    // pause/resume: paused downloads keep their partial in the persistent
    // store (pinned against gc) — resume re-dispatches the snatch and only
    // the missing ranges transfer. downloadId keys the worker-side cancel
    // token; pausedPct is the last progress label shown on the resume button.
    let snatchPaused = false;
    let snatchDownloadId: string | null = null;
    let snatchPausedPct = "";
    // upload cancel + cross-peer lock state. uploadAbort cancels the local
    // in-flight upload; remoteUploadLock mirrors a fresh uploadingBy claim
    // from ANOTHER peer (renders the locked progress view).
    let uploadAbort: AbortController | null = null;
    let uploadCancelled = false;
    // only the peer who created this widget can use the initial "click to
    // upload" step — widgets with no recorded creator (pre-existing widgets
    // from before this field existed) are unrestricted.
    const iAmCreator = !ctx.canvasStore || ctx.canvasStore.isLocalWidgetCreator(ctx.widgetId);
    let lastRequestedBlobId = "";
    let loadedAssetKey = "";
    let activeOverlay: MediaOverlayHandle | null = null;
    let activePlayer: InlinePlayerHandle | null = null;
    let hoverOverlay: Container | null = null;
    let hoverOverlayVisible = false;
    let activeGifHover: GifHoverOverlayHandle | null = null;
    // friend-gated snatch: the peer known to have the blob but not (yet) a
    // friend, and the pending-retry-on-friend-accept unregister function —
    // see requestFriendAndRetry() and file-utils.ts's BlobAccessDeniedError.
    let deniedPeerNodeId: string | null = null;
    let unregisterPendingRetry: (() => void) | null = null;

    // flag: true when the user uploaded the file through this widget instance.
    // prevents showing "save to disk" for files the user just uploaded.
    let uploadedLocally = false;

    // actual on-disk byte size of the local copy (null = no local copy known
    // yet, or the check hasn't resolved). shown in the property tray so users
    // can spot a 0-byte/corrupt local copy left behind by an interrupted
    // snatch — see refreshLocalByteSize().
    let localByteSize: number | null = null;

    // instance-level editable props (see fileEditableProps) — recomputed
    // whenever `domain` changes so the "file type" select appears/disappears
    // as soon as auto-detection fills it in.
    let currentEditableProps: WidgetPropDef[] = fileEditableProps(ctx.doc.current.domain);

    // set when the widget is destroyed; async handlers check this to bail out
    let destroyed = false;

    // -- background -----------------------------------------------------------

    const bg = new Graphics();
    container.addChild(bg);

    const drawBg = (w: number, h: number) => {
      bg.clear();
      bg.roundRect(0, 0, w, h, 4);
      bg.fill({ color: 0x1a1a2e });
      bg.stroke({ color: 0x2a2a3e, width: 1 });
    };
    drawBg(currentWidth, currentHeight);

    // thumbnail hover hit area — shows the preview overlay on hover
    const thumbHitArea = new Graphics();
    thumbHitArea.eventMode = "static";
    thumbHitArea.cursor = "pointer";
    thumbHitArea.visible = false; // shown when loaded + previewable
    container.addChild(thumbHitArea);

    const drawThumbHitArea = (w: number, h: number) => {
      const extra = actionBarExtra();
      const thumbAreaH = h - INFO_BAR_HEIGHT - extra;
      thumbHitArea.clear();
      thumbHitArea.rect(0, 0, w, Math.max(0, thumbAreaH)).fill({ color: 0x000000, alpha: 0.001 });
    };

    thumbHitArea.on("pointerenter", () => {
      const state = ctx.doc.current;
      if (!isPreviewableDomain(state.domain || "file")) return;
      if (loadState !== "loaded") return;
      if (actionState !== "local" && actionState !== "snatched") return;
      hoverOverlayVisible = true;
      if (hoverOverlay) hoverOverlay.visible = true;

      // a gif thumbnail is normally a pre-rendered static image (see
      // thumbnail.rs) — fetch the real bytes and animate them while hovered.
      if (state.domain === "photo" && state.mime === "image/gif" && state.blobId) {
        const blobId = state.blobId;
        const blake3 = state.blake3;
        void getLocalBlobUrl(blobId, blake3).then((src) => {
          if (!src || !hoverOverlayVisible || activeGifHover) return;
          if (ctx.doc.current.blobId !== blobId) return;
          const extra = actionBarExtra();
          const thumbAreaH = Math.max(0, currentHeight - INFO_BAR_HEIGHT - extra);
          activeGifHover = createGifHoverOverlay({
            container,
            canvasElement: ctx.canvasElement,
            width: currentWidth,
            height: thumbAreaH,
            src,
          });
        });
      }
    });

    thumbHitArea.on("pointerleave", () => {
      hoverOverlayVisible = false;
      if (hoverOverlay) hoverOverlay.visible = false;
      activeGifHover?.remove();
      activeGifHover = null;
    });

    thumbHitArea.on("pointertap", (e: any) => {
      e.stopPropagation();
      handlePreview();
    });

    // -- placeholder (empty state) --------------------------------------------

    const placeholderBorder = new Graphics();
    const drawPlaceholderBorder = (w: number, h: number) => {
      const inset = 12;
      placeholderBorder.clear();
      placeholderBorder.rect(inset, inset, w - inset * 2, h - inset * 2);
      placeholderBorder.stroke({ color: 0x444460, width: 1 });
      // hit area covers the WHOLE widget, not just the drawn inset rect's
      // stroke line — a stroke-only Graphics (no fill) only hit-tests along
      // the stroke itself by default, so clicking inside the dashed box
      // (or anywhere else on the widget) previously missed entirely. a real
      // reported issue: only the exact text label reliably registered clicks.
      placeholderBorder.hitArea = new Rectangle(0, 0, w, h);
    };
    drawPlaceholderBorder(currentWidth, currentHeight);
    placeholderBorder.eventMode = "static";
    placeholderBorder.cursor = iAmCreator ? "pointer" : "default";
    container.addChild(placeholderBorder);

    const placeholderText = new Text({
      text: iAmCreator ? "click to upload file" : "waiting for file",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        fill: 0x666680,
        align: "center",
      },
      resolution: 2,
    });
    placeholderText.anchor.set(0.5);
    placeholderText.x = currentWidth / 2;
    placeholderText.y = currentHeight / 2;
    placeholderText.eventMode = "static";
    placeholderText.cursor = iAmCreator ? "pointer" : "default";
    container.addChild(placeholderText);

    // -- loading text ---------------------------------------------------------

    const loadingText = new Text({
      text: "loading...",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        fill: 0x888899,
        align: "center",
      },
      resolution: 2,
    });
    loadingText.anchor.set(0.5);
    loadingText.x = currentWidth / 2;
    loadingText.y = currentHeight / 2;
    loadingText.visible = false;
    // tapping the loading text cancels a LOCAL in-flight upload (no-op for
    // the remote-peer locked view, where uploadAbort is null)
    loadingText.eventMode = "static";
    loadingText.cursor = "pointer";
    loadingText.on("pointertap", (e) => {
      e.stopPropagation();
      if (uploadAbort) {
        uploadCancelled = true;
        uploadAbort.abort();
      }
    });
    container.addChild(loadingText);

    // -- outgoing serve-progress text ------------------------------------------
    //
    // distinct from `loadingText`'s doc-backed "peer uploading... NN%"
    // label above (someone else uploading bytes TO this widget) — this one
    // shows THIS node serving the blob OUT to other peers/hubs snatching
    // it, fed by `transfer-progress.ts`'s tauri-only poll (see its module
    // doc comment). up to `MAX_VISIBLE_TRANSFERS_PER_BLOB` lines, hub(s)
    // first, "+N more" appended when there's more traffic than that.
    const servingText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fill: 0x888899,
        align: "center",
      },
      resolution: 2,
    });
    servingText.anchor.set(0.5, 1);
    servingText.x = currentWidth / 2;
    servingText.visible = false;
    // added to `container` after the info bar below (not here) so it draws
    // ON TOP of the info bar's near-opaque background instead of being
    // hidden underneath it - see the addChild call right after actionContainer.

    // backing so the text stays legible over a thumbnail image - redrawn to
    // fit servingText's current bounds each time it's shown.
    const servingTextBg = new Graphics();
    servingTextBg.visible = false;

    const drawServingTextBg = () => {
      const paddingX = 6;
      const paddingY = 3;
      const w = servingText.width + paddingX * 2;
      const h = servingText.height + paddingY * 2;
      servingTextBg.clear();
      servingTextBg.roundRect(servingText.x - w / 2, servingText.y - h, w, h, 4);
      servingTextBg.fill({ color: 0x141422, alpha: 0.85 });
    };

    let unsubTransferProgress: (() => void) | null = null;
    function updateTransferProgressSubscription(blake3: string | undefined) {
      unsubTransferProgress?.();
      unsubTransferProgress = null;
      servingText.visible = false;
      servingTextBg.visible = false;
      if (!blake3) return;
      unsubTransferProgress = subscribeTransferProgress(
        blake3,
        (peerId) => ctx.canvasStore?.isHubNode(peerId) ?? false,
        (entries, truncatedCount) => {
          if (entries.length === 0) {
            servingText.visible = false;
            servingTextBg.visible = false;
            return;
          }
          const lines = entries.map((entry) => {
            const isHub = ctx.canvasStore?.isHubNode(entry.peerId) ?? false;
            const name = peerNameFor(entry.peerId) ?? `${entry.peerId.slice(0, 12)}...`;
            return `${isHub ? "hub" : "peer"}: ${name} ${Math.round(entry.fraction * 100)}%`;
          });
          if (truncatedCount > 0) {
            lines.push(`+${truncatedCount} more`);
          }
          servingText.text = lines.join("\n");
          drawServingTextBg();
          servingText.visible = true;
          servingTextBg.visible = true;
        }
      );
    }

    // -- error text -----------------------------------------------------------

    const errorText = new Text({
      text: "load failed",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        fill: 0xdd4444,
        align: "center",
        wordWrap: true,
        wordWrapWidth: currentWidth - 16,
      },
      resolution: 2,
    });
    errorText.anchor.set(0.5);
    errorText.x = currentWidth / 2;
    errorText.y = currentHeight / 2;
    errorText.visible = false;
    container.addChild(errorText);

    // -- info bar (loaded state) ----------------------------------------------

    const infoContainer = new Container();
    infoContainer.visible = false;
    container.addChild(infoContainer);

    const infoBarBg = new Graphics();
    infoContainer.addChild(infoBarBg);

    const drawInfoBarBg = (w: number, h: number, extraHeight: number) => {
      const totalH = INFO_BAR_HEIGHT + extraHeight;
      infoBarBg.clear();
      infoBarBg.rect(0, h - totalH, w, totalH);
      infoBarBg.fill({ color: 0x141422, alpha: 0.85 });
    };

    const filenameText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fill: 0xccccdd,
        align: "left",
      },
      resolution: 2,
    });
    infoContainer.addChild(filenameText);

    const sizeText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 10,
        fill: 0x888899,
        align: "right",
      },
      resolution: 2,
    });
    infoContainer.addChild(sizeText);

    const domainBadgeBg = new Graphics();
    infoContainer.addChild(domainBadgeBg);

    const domainText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 9,
        fill: 0xaaaacc,
        align: "left",
      },
      resolution: 2,
    });
    infoContainer.addChild(domainText);

    // -- action buttons -------------------------------------------------------

    const actionContainer = new Container();
    actionContainer.visible = false;
    infoContainer.addChild(actionContainer);

    // added after infoContainer (not alongside loadingText/errorText above) so
    // it draws on top of the info bar's background instead of being hidden
    // underneath it - the info bar covers the bottom of the widget whenever a
    // file is loaded, which is where this text is positioned (just above it).
    container.addChild(servingTextBg);
    container.addChild(servingText);

    // snatch button — shown when blob is remote (doubles as resume when
    // paused, or "send friend request" when only a non-friend peer has it)
    const snatchBtn = createPillButton("snatch", 0x2d5a27, () => {
      if (actionState === "snatching") {
        cancelSnatch();
      } else if (actionState === "needs-friend") {
        void requestFriendAndRetry();
      } else if (actionState === "friend-requested") {
        // request already sent — retry fires automatically once accepted
      } else {
        handleSnatch();
      }
    });
    actionContainer.addChild(snatchBtn.container);

    // pause button — shown while snatching (pause) and while paused (discard).
    // pause keeps the partial in the persistent store; discard releases it.
    const pauseBtn = createPillButton("pause", 0x4a4527, () => {
      if (actionState === "snatching") {
        void pauseSnatch();
      } else if (actionState === "paused") {
        discardPausedSnatch();
      }
    });
    actionContainer.addChild(pauseBtn.container);

    snatchBtn.container.on("pointerover", () => {
      if (actionState === "snatching") {
        snatchHovered = true;
        snatchBtn.setLabel("cancel");
        snatchBtn.setColor(0x5a2727);
      }
    });
    snatchBtn.container.on("pointerout", () => {
      if (actionState === "snatching") {
        snatchHovered = false;
        snatchBtn.setLabel(snatchProgressText || "snatching...");
        snatchBtn.setColor(0x555555);
      }
    });

    // save to disk button — shown after snatch (blob is local but not "on disk")
    const saveBtn = createPillButton(
      isTauriMode() ? "reveal" : "save",
      0x27455a,
      isTauriMode() ? handleRevealInFinder : handleSaveToDisk
    );
    actionContainer.addChild(saveBtn.container);

    // -- fallback icon (when no thumbnail is available) -----------------------

    const fallbackIcon = new Container();
    fallbackIcon.visible = false;
    container.addChild(fallbackIcon);

    const fallbackRect = new Graphics();
    fallbackIcon.addChild(fallbackRect);

    const fallbackText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        fill: 0xaaaacc,
        align: "center",
      },
      resolution: 2,
    });
    fallbackText.anchor.set(0.5);
    fallbackIcon.addChild(fallbackText);

    let hasThumbnail = false;

    // -- domain-ingest status overlay ------------------------------------------
    // shown while file-domain-ingest.ts's runDomainIngest() is processing a
    // manually-picked domain (thumbnail generation / document conversion), so
    // the user isn't left staring at a static fallback icon with no feedback —
    // mirrors peedeeeff/index.ts's statusText pattern, plus a cancel
    // affordance peedeeeff doesn't have (explicitly wanted for this UX).
    const ingestStatusText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fill: 0x999999,
        align: "center",
      },
      resolution: 2,
    });
    ingestStatusText.anchor.set(0.5);
    ingestStatusText.visible = false;
    container.addChild(ingestStatusText);

    const ingestCancelBtn = createPillButton("cancel", 0x5a2727, () => {
      cancelDomainIngest(domainIngestDoc);
    });
    ingestCancelBtn.container.visible = false;
    container.addChild(ingestCancelBtn.container);

    // -- action state helpers -------------------------------------------------

    /** check whether any action buttons should be visible */
    function hasVisibleActions(): boolean {
      if (actionState === "checking" || loadState !== "loaded") return false;
      if (actionState === "remote") return true;
      if (actionState === "snatched") return true;
      if (actionState === "local" && !uploadedLocally) return true;
      if (actionState === "saving" || actionState === "snatching" || actionState === "paused")
        return true;
      // no action buttons when the user uploaded locally
      if (actionState === "local" && uploadedLocally) {
        return false;
      }
      return false;
    }

    /** get the extra height needed for the action bar */
    function actionBarExtra(): number {
      return hasVisibleActions() ? ACTION_BAR_HEIGHT : 0;
    }

    /** sync action button visibility based on current actionState */
    function syncActionButtons() {
      if (destroyed) return;

      // snatch: visible when remote, actively snatching, paused (resume), or
      // when the only peer(s) with the blob aren't friends yet
      snatchBtn.setVisible(
        actionState === "remote" ||
          actionState === "snatching" ||
          actionState === "paused" ||
          actionState === "needs-friend" ||
          actionState === "friend-requested"
      );
      if (actionState === "snatching") {
        // label is managed by the progress callback in handleSnatch
        snatchBtn.setColor(0x555555);
      } else if (actionState === "paused") {
        snatchBtn.setLabel(snatchPausedPct ? `resume (${snatchPausedPct})` : "resume");
        snatchBtn.setColor(0x2d5a27);
      } else if (actionState === "needs-friend") {
        snatchBtn.setLabel("add friend to fetch");
        snatchBtn.setColor(0x5a2727);
      } else if (actionState === "friend-requested") {
        snatchBtn.setLabel("request sent…");
        snatchBtn.setColor(0x555555);
      } else {
        snatchBtn.setLabel("snatch");
        snatchBtn.setColor(0x2d5a27);
      }

      // pause/discard: only during an active or paused snatch
      pauseBtn.setVisible(actionState === "snatching" || actionState === "paused");
      if (actionState === "paused") {
        pauseBtn.setLabel("discard");
        pauseBtn.setColor(0x5a2727);
      } else {
        pauseBtn.setLabel("pause");
        pauseBtn.setColor(0x4a4527);
      }

      // save: visible when snatched or local (but not uploaded locally), or saving
      const showSave =
        actionState === "snatched" ||
        actionState === "saving" ||
        (actionState === "local" && !uploadedLocally);
      saveBtn.setVisible(showSave);
      if (actionState === "saving") {
        saveBtn.setLabel("saving...");
        saveBtn.setColor(0x555555);
      } else {
        saveBtn.setLabel(isTauriMode() ? "reveal" : "save");
        saveBtn.setColor(0x27455a);
      }

      actionContainer.visible = hasVisibleActions();

      // update thumbnail hover overlay visibility — depends on action state
      const overlayDomain = ctx.doc.current.domain || "file";
      thumbHitArea.visible =
        loadState === "loaded" &&
        isPreviewableDomain(overlayDomain) &&
        (actionState === "local" || actionState === "snatched");
    }

    /** reflect `domainIngestState`/`domainIngestClaimedBy` as a status
     *  overlay + cancel button on top of the thumb area — called from the
     *  doc-change subscription whenever either field changes. */
    function syncIngestStatusUI() {
      if (destroyed) return;
      const state = ctx.doc.current;
      const processing = state.domainIngestState === "processing";
      ingestStatusText.visible = processing;
      ingestCancelBtn.container.visible = processing;
      if (processing) {
        const claimant = state.domainIngestClaimedBy;
        const localId = ctx.canvasStore?.localNodeId ?? "";
        const who = !claimant || claimant === localId ? "this device" : (peerNameFor(claimant) ?? "a peer");
        ingestStatusText.text = `processing ${state.domain || "file"}... (${who})`;
      }
      positionFallbackIcon(currentWidth, currentHeight);
    }

    // -- layout helpers -------------------------------------------------------

    const positionInfoBar = (w: number, h: number) => {
      const extra = actionBarExtra();
      drawInfoBarBg(w, h, extra);

      const state = ctx.doc.current;
      const totalBarH = INFO_BAR_HEIGHT + extra;
      const barTop = h - totalBarH;

      const maxFilenameChars = Math.max(8, Math.floor((w - 80) / 6));
      filenameText.text = truncateText(state.filename || "unknown", maxFilenameChars);
      filenameText.x = 8;
      filenameText.y = barTop + 6;

      sizeText.text = formatFileSize(state.size);
      sizeText.x = w - 8 - sizeText.width;
      sizeText.y = barTop + 6;

      // just above the info bar, not at the widget's bottom edge - the info
      // bar's own background would otherwise paint over it (see the addChild
      // ordering comment above `actionContainer`).
      servingText.y = Math.max(0, barTop - 4);
      if (servingText.visible) drawServingTextBg();

      const domain = state.domain || "file";
      domainText.text = domain;

      domainBadgeBg.clear();
      const badgeX = 8;
      const badgeY = barTop + 24;
      const badgePadH = 6;
      const badgePadV = 2;
      const badgeW = domainText.width + badgePadH * 2;
      const badgeH = domainText.height + badgePadV * 2;
      domainBadgeBg.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
      domainBadgeBg.fill({ color: domainBadgeColor(domain) });

      domainText.x = badgeX + badgePadH;
      domainText.y = badgeY + badgePadV;

      // position action buttons
      if (hasVisibleActions()) {
        const actionY = h - ACTION_BAR_HEIGHT + 2;
        let xCursor = 8;

        const buttons = [snatchBtn, pauseBtn, saveBtn];
        for (const btn of buttons) {
          if (btn.container.visible) {
            btn.container.x = xCursor;
            btn.container.y = actionY;
            xCursor += btn.getWidth() + 6;
          }
        }
      }
    };

    const positionFallbackIcon = (w: number, h: number) => {
      const extra = actionBarExtra();
      const thumbAreaH = h - INFO_BAR_HEIGHT - extra;
      const iconSize = Math.min(60, thumbAreaH - 16, w - 16);
      if (iconSize <= 0) return;

      fallbackRect.clear();
      const rx = (w - iconSize) / 2;
      const ry = (thumbAreaH - iconSize) / 2;
      fallbackRect.roundRect(rx, ry, iconSize, iconSize, 6);
      fallbackRect.fill({ color: 0x2a2a3e });
      fallbackRect.stroke({ color: 0x3a3a5e, width: 1 });

      const state = ctx.doc.current;
      fallbackText.text = (state.domain || "file").toUpperCase();
      fallbackText.x = w / 2;
      fallbackText.y = thumbAreaH / 2;

      // domain-ingest status overlay shares the thumb area — position it
      // regardless of current visibility, cheap and keeps it correct the
      // instant syncIngestStatusUI() shows it.
      ingestStatusText.x = w / 2;
      ingestStatusText.y = Math.max(16, thumbAreaH / 2 - 14);
      ingestCancelBtn.container.x = Math.round((w - ingestCancelBtn.getWidth()) / 2);
      ingestCancelBtn.container.y = Math.min(
        Math.max(0, thumbAreaH - BUTTON_H - 4),
        thumbAreaH / 2 + 10
      );
    };

    // -- sprite management ----------------------------------------------------

    const fitSprite = (w: number, h: number) => {
      if (!thumbSprite || !currentTexture) return;

      const extra = actionBarExtra();
      const thumbAreaH = h - INFO_BAR_HEIGHT - extra;
      const imageWidth = currentTexture.width;
      const imageHeight = currentTexture.height;
      if (imageWidth === 0 || imageHeight === 0) return;

      const availW = w - THUMB_PADDING * 2;
      const availH = thumbAreaH - THUMB_PADDING * 2;
      const scale = Math.min(availW / imageWidth, availH / imageHeight);

      thumbSprite.width = imageWidth * scale;
      thumbSprite.height = imageHeight * scale;
      thumbSprite.x = (w - thumbSprite.width) / 2;
      thumbSprite.y = (thumbAreaH - thumbSprite.height) / 2;
    };

    /** draw (or redraw) the hover overlay for preview-eligible files */
    function drawHoverOverlay(w: number, h: number): void {
      const state = ctx.doc.current;
      const domain = state.domain || "file";
      if (!isPreviewableDomain(domain) || loadState !== "loaded") {
        if (hoverOverlay) {
          hoverOverlay.visible = false;
        }
        return;
      }

      const extra = actionBarExtra();
      const thumbAreaH = h - INFO_BAR_HEIGHT - extra;
      if (thumbAreaH <= 0) return;

      // destroy and recreate on resize (simpler than rescaling icons)
      if (hoverOverlay) {
        container.removeChild(hoverOverlay);
        hoverOverlay.destroy({ children: true });
      }

      hoverOverlay = new Container();
      hoverOverlay.label = "file-hover-overlay";
      hoverOverlay.visible = hoverOverlayVisible;
      hoverOverlay.eventMode = "none"; // clicks pass through to thumbnail/bg

      // semi-transparent background
      const overlayBg = new Graphics();
      overlayBg.rect(0, 0, w, thumbAreaH).fill({ color: 0x000000, alpha: 0.45 });
      hoverOverlay.addChild(overlayBg);

      const iconSize = Math.max(16, Math.min(w, thumbAreaH) * 0.3);
      const cx = w / 2;
      const cy = thumbAreaH / 2;

      const icon = new Graphics();

      if (domain === "audio" || domain === "video") {
        // play triangle
        const triH = iconSize;
        const triW = iconSize * 0.866;
        icon.poly([
          { x: cx - triW / 3, y: cy - triH / 2 },
          { x: cx + (triW * 2) / 3, y: cy },
          { x: cx - triW / 3, y: cy + triH / 2 },
        ]);
        icon.fill({ color: 0xffffff, alpha: 0.9 });
      } else {
        // expand icon (diagonal arrow pointing upper-right + corner bracket)
        const half = iconSize / 2;
        const strokeW = Math.max(1.5, iconSize * 0.12);

        icon.moveTo(cx - half, cy + half);
        icon.lineTo(cx + half, cy - half);
        icon.stroke({ width: strokeW, color: 0xffffff, alpha: 0.9 });

        const headLen = half * 0.5;
        icon.moveTo(cx + half - headLen, cy - half);
        icon.lineTo(cx + half, cy - half);
        icon.lineTo(cx + half, cy - half + headLen);
        icon.stroke({ width: strokeW, color: 0xffffff, alpha: 0.9 });

        const cornerLen = half * 0.35;
        icon.moveTo(cx - half + cornerLen, cy + half);
        icon.lineTo(cx - half, cy + half);
        icon.lineTo(cx - half, cy + half - cornerLen);
        icon.stroke({ width: strokeW, color: 0xffffff, alpha: 0.7 });
      }
      hoverOverlay.addChild(icon);

      // insert above the thumbnail sprite but below the info container
      const infoIdx = container.getChildIndex(infoContainer);
      container.addChildAt(hoverOverlay, infoIdx);
    }

    // max data URL length we're willing to hand to PixiJS (~10 MB base64)
    const MAX_DATA_URL_LENGTH = 10 * 1024 * 1024;

    const isValidImageDataUrl = (url: string): boolean => {
      if (!url || typeof url !== "string") return false;
      if (!url.startsWith("data:image/")) return false;
      if (url.length > MAX_DATA_URL_LENGTH) return false;
      // must have the base64 comma separator
      if (!url.includes(",")) return false;
      return true;
    };

    const destroySprite = () => {
      try {
        if (thumbSprite) {
          container.removeChild(thumbSprite);
          thumbSprite.destroy();
          thumbSprite = null;
        }
      } catch (err) {
        // sprite/texture destruction can fail if the WebGL context was lost
        log.warn("file-widget", "destroySprite: sprite cleanup failed", err);
        thumbSprite = null;
      }
      if (loadedAssetKey) {
        const keyToUnload = loadedAssetKey;
        // defer unload to next frame so the render loop doesn't access a destroyed texture.
        // skip data: URLs entirely — they're small thumbnails that may be shared with
        // the bin renderer (which loads the same data URL from the asset cache). unloading
        // here would destroy the shared texture source and cause addressModeU crashes.
        if (!keyToUnload.startsWith("data:")) {
          requestAnimationFrame(() => {
            // guard: if the same key was re-loaded between destroySprite and this RAF,
            // skip unload — the texture is back in use by a new sprite.
            if (loadedAssetKey === keyToUnload) return;
            try {
              Assets.unload(keyToUnload);
            } catch (err) {
              log.warn("file-widget", "destroySprite: asset unload failed", err);
            }
            if (keyToUnload.startsWith("blob:")) {
              URL.revokeObjectURL(keyToUnload);
            }
          });
        }
        loadedAssetKey = "";
      }
      currentTexture = null;
      hasThumbnail = false;
    };

    // -- visibility management ------------------------------------------------

    const syncVisibility = () => {
      placeholderText.visible = loadState === "empty";
      placeholderBorder.visible = loadState === "empty";
      loadingText.visible = loadState === "loading";
      errorText.visible = loadState === "error";
      infoContainer.visible = loadState === "loaded";
      fallbackIcon.visible = false;
      if (thumbSprite) {
        thumbSprite.visible = loadState === "loaded" && hasThumbnail;
      }
      syncActionButtons();

      // show thumb hit area when loaded + previewable
      const domain = ctx.doc.current.domain || "file";
      thumbHitArea.visible =
        loadState === "loaded" &&
        isPreviewableDomain(domain) &&
        (actionState === "local" || actionState === "snatched");
    };

    // -- blob locality checking -----------------------------------------------

    /** re-fetch the local copy's actual on-disk byte size (not the doc's
     *  possibly-stale `size` field). no-op if the widget has moved on to a
     *  different blob or been destroyed by the time it resolves. */
    const refreshLocalByteSize = async (blobId: string, blake3: string) => {
      const bytes = await getLocalBlobByteSize(blobId, blake3);
      if (destroyed || ctx.doc.current.blobId !== blobId) return;
      localByteSize = bytes;
      positionInfoBar(currentWidth, currentHeight);
    };

    const checkLocality = async (blobId: string) => {
      if (!blobId) {
        actionState = "checking";
        syncActionButtons();
        return;
      }

      actionState = "checking";
      syncActionButtons();

      const info = await checkBlobLocality(blobId, ctx.doc.current.blake3);
      log.debug("file-widget", "checkBlobLocality result:", {
        blobId,
        locality: info.locality,
        metadata: info.metadata,
        blake3: ctx.doc.current.blake3,
      });
      // make sure we're still looking at the same blob
      if (ctx.doc.current.blobId !== blobId) return;

      // treat both "remote" and "unknown" as remote — show the snatch button
      // so the user always has an action available. "unknown" means the lookup
      // failed (IPC error, OPFS exception, etc.) but that doesn't mean the
      // blob is local, so offering snatch is the safe fallback.
      if (info.locality === "local") {
        actionState = "local";
        void refreshLocalByteSize(blobId, ctx.doc.current.blake3);
        // record that this canvas references the blob whenever we confirm
        // it's actually present locally — covers every path that can land
        // a blobId here (upload, snatch, or a widget that arrived via
        // automerge sync already pointing at a blob this device also has),
        // not just the ones that write blobId themselves.
        const refCanvasDocId = ctx.canvasStore?.handle.documentId;
        if (refCanvasDocId) {
          void addBlobCanvasRef(blobId, ctx.doc.current.blake3, refCanvasDocId);
        }
      } else {
        localByteSize = null;
        actionState = "remote";
        // blob is not local — remove ourselves from snatchedBy so peers
        // don't try to download from us
        const localNodeId = await getLocalNodeId();
        if (localNodeId) {
          const currentSnatchedBy = (ctx.doc.current.snatchedBy ?? []).map(String);
          if (currentSnatchedBy.includes(localNodeId)) {
            ctx.doc.change((draft) => {
              if (draft.snatchedBy) {
                const idx = draft.snatchedBy.findIndex((id: string) => String(id) === localNodeId);
                if (idx >= 0) draft.snatchedBy.splice(idx, 1);
              }
            });
          }
        }
      }
      log.debug("file-widget", "final actionState:", actionState, "for blobId:", blobId);
      syncActionButtons();

      // re-layout unconditionally — actionState may have just made a button
      // visible for the first time, and skipping this when loadState isn't
      // (yet) "loaded" would leave it at its default (0,0) position once it
      // does become visible. positionInfoBar/fitSprite/etc. are all safe to
      // call before the widget is loaded (they no-op or gate internally).
      positionInfoBar(currentWidth, currentHeight);
      fitSprite(currentWidth, currentHeight);
      if (!hasThumbnail) {
        positionFallbackIcon(currentWidth, currentHeight);
      }
      drawHoverOverlay(currentWidth, currentHeight);
      drawThumbHitArea(currentWidth, currentHeight);
    };

    // -- thumbnail loading ----------------------------------------------------

    const loadThumbnail = async (blobId: string) => {
      if (loadingAbort) {
        loadingAbort.abort();
        loadingAbort = null;
      }

      if (!blobId) {
        destroySprite();
        loadState = "empty";
        syncVisibility();
        return;
      }

      lastRequestedBlobId = blobId;
      loadState = "loading";
      syncVisibility();
      loadingText.text = "loading...";

      const abort = new AbortController();
      loadingAbort = abort;

      try {
        // only check cache + local — never contact peers during render.
        // peers that can generate thumbnails (Tauri w/ ffmpeg) write
        // thumbnailDataUrl back into the automerge doc after snatch,
        // which triggers the fast embedded path above on all peers.
        const thumbOpts: ThumbnailOptions = {
          size: 200,
        };
        const dataUrl = await getThumbnailDataUrl(blobId, thumbOpts);

        if (abort.signal.aborted || lastRequestedBlobId !== blobId) {
          return;
        }

        // persist a freshly-computed thumbnail (video/audio/pdf need ffmpeg
        // or magick, so it's rarely ready at upload time) back into the doc.
        // without this, only this mounted instance's in-memory texture ever
        // sees it — any other consumer that reads the persisted state
        // directly instead of mounting the full widget (e.g. a bin's card
        // preview via getCompactInfo) would never see a thumbnail at all.
        if (
          dataUrl &&
          !destroyed &&
          ctx.doc.current.blobId === blobId &&
          ctx.doc.current.thumbnailDataUrl !== dataUrl
        ) {
          // update prevThumbDataUrl *before* writing, so the doc-change
          // subscription (which fires synchronously from ctx.doc.change)
          // doesn't see it as "new" and re-enter with a nested
          // loadEmbeddedThumbnail() call while we're still mid-flight here —
          // that reentrancy corrupts the sprite/texture/loadState this call
          // is about to finish setting up, leaving the widget stuck on
          // "loading..." forever. same suppression pattern handleUpload
          // already uses for prevBlobId.
          prevThumbDataUrl = dataUrl;
          ctx.doc.change((draft) => {
            draft.thumbnailDataUrl = dataUrl;
          });
        }

        destroySprite();

        if (dataUrl && isValidImageDataUrl(dataUrl)) {
          let texture: Texture | null = null;
          try {
            texture = await Assets.load<Texture>(dataUrl);
          } catch (texErr) {
            log.warn("file-widget", "loadThumbnail: Assets.load failed for", blobId, texErr);
            texture = null;
          }

          // validate the texture has a usable WebGL source — Assets.load can
          // return a Texture whose underlying source or style is null/invalid
          // (e.g. malformed image data, GPU resource lost). this causes an
          // "addressModeU" crash during the render frame when PixiJS tries to
          // bind the texture. treat it as a failed load instead.
          if (texture && !texture.source?.style) {
            log.warn("file-widget", "loadThumbnail: texture has invalid source, skipping", blobId);
            // only unload non-data: URLs — data: thumbnails are shared with the
            // bin renderer via the asset cache; unloading destroys the shared source.
            if (!dataUrl.startsWith("data:")) {
              try {
                Assets.unload(dataUrl);
              } catch {
                /* ignored */
              }
            }
            texture = null;
          }

          if (abort.signal.aborted || lastRequestedBlobId !== blobId) {
            if (texture && !dataUrl.startsWith("data:")) {
              try {
                Assets.unload(dataUrl);
              } catch {
                /* ignored */
              }
            }
            return;
          }

          if (texture) {
            currentTexture = texture;
            loadedAssetKey = dataUrl;
            thumbSprite = new Sprite(currentTexture);
            // insert above bg but below info container and overlays
            container.addChildAt(thumbSprite, 1);
            hasThumbnail = true;

            // make thumbnail clickable for preview when the domain supports it
            const domain = ctx.doc.current.domain || "file";
            thumbSprite.eventMode = "static";
            thumbSprite.cursor = isPreviewableDomain(domain) ? "pointer" : "default";
            thumbSprite.on("pointertap", (e) => {
              e.stopPropagation();
              handlePreview();
            });

            drawHoverOverlay(currentWidth, currentHeight);
            drawThumbHitArea(currentWidth, currentHeight);
          } else {
            // texture failed to load — show fallback icon
            hasThumbnail = false;
            positionFallbackIcon(currentWidth, currentHeight);
            drawHoverOverlay(currentWidth, currentHeight);
            drawThumbHitArea(currentWidth, currentHeight);
          }
        } else {
          // no thumbnail available — show fallback icon with domain name
          hasThumbnail = false;
          positionFallbackIcon(currentWidth, currentHeight);
          drawHoverOverlay(currentWidth, currentHeight);
          drawThumbHitArea(currentWidth, currentHeight);
        }

        loadState = "loaded";
        syncVisibility();
        positionInfoBar(currentWidth, currentHeight);
        fitSprite(currentWidth, currentHeight);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (lastRequestedBlobId !== blobId) return;

        destroySprite();
        loadState = "error";
        syncVisibility();
      } finally {
        if (loadingAbort === abort) {
          loadingAbort = null;
        }
      }
    };

    // -- embedded thumbnail (from automerge doc data URL) ---------------------

    const loadEmbeddedThumbnail = async (dataUrl: string) => {
      if (!dataUrl) return;

      // abort any in-flight loadThumbnail so it doesn't clobber our sprite later
      if (loadingAbort) {
        loadingAbort.abort();
        loadingAbort = null;
      }

      if (!isValidImageDataUrl(dataUrl)) {
        log.warn(
          "file-widget",
          "loadEmbeddedThumbnail: malformed data URL, falling back to async fetch"
        );
        loadThumbnail(ctx.doc.current.blobId);
        return;
      }

      try {
        destroySprite();

        let texture: Texture | null = null;
        try {
          texture = await Assets.load<Texture>(dataUrl);
        } catch (texErr) {
          log.warn("file-widget", "loadEmbeddedThumbnail: Assets.load failed", texErr);
          texture = null;
        }

        // validate the texture has a usable WebGL source (same guard as loadThumbnail)
        if (texture && !texture.source?.style) {
          log.warn("file-widget", "loadEmbeddedThumbnail: texture has invalid source, skipping");
          if (!dataUrl.startsWith("data:")) {
            try {
              Assets.unload(dataUrl);
            } catch {
              /* ignored */
            }
          }
          texture = null;
        }

        // check we haven't been superseded while loading
        if (ctx.doc.current.thumbnailDataUrl !== dataUrl) {
          if (texture && !dataUrl.startsWith("data:")) {
            try {
              Assets.unload(dataUrl);
            } catch {
              /* ignored */
            }
          }
          return;
        }

        if (!texture) {
          // texture load failed — fall back to the async thumbnail fetch
          loadThumbnail(ctx.doc.current.blobId);
          return;
        }

        currentTexture = texture;
        loadedAssetKey = dataUrl;
        thumbSprite = new Sprite(currentTexture);
        // insert above bg but below info container and overlays
        container.addChildAt(thumbSprite, 1);
        hasThumbnail = true;

        // make thumbnail clickable for preview when the domain supports it
        const domain = ctx.doc.current.domain || "file";
        thumbSprite.eventMode = "static";
        thumbSprite.cursor = isPreviewableDomain(domain) ? "pointer" : "default";
        thumbSprite.on("pointertap", (e) => {
          e.stopPropagation();
          handlePreview();
        });

        syncVisibility();
        fitSprite(currentWidth, currentHeight);
        drawHoverOverlay(currentWidth, currentHeight);
        drawThumbHitArea(currentWidth, currentHeight);
      } catch {
        // unexpected error — fall back to the async thumbnail fetch
        loadThumbnail(ctx.doc.current.blobId);
      }
    };

    // -- upload flow ----------------------------------------------------------

    /**
     * when multiple files are picked, replace this file widget with a new bin
     * widget containing all the selected files as children.
     */
    const handleMultiFileUpload = async (picked: PickedFile[]) => {
      const store = ctx.canvasStore;
      if (!store) return;

      // read this widget's position/size so the bin appears in the same spot
      const selfEntry = store.getWidget(ctx.widgetId);
      if (!selfEntry) return;

      // create the bin widget at the same position as this file widget.
      // make it a bit wider/taller to accommodate multiple items.
      const binId = crypto.randomUUID();
      const cols = Math.min(picked.length, 3);
      store.addWidget({
        id: binId,
        type: "bin",
        x: selfEntry.x,
        y: selfEntry.y,
        width: Math.max(selfEntry.width, 320),
        height: Math.max(selfEntry.height, 240),
        zIndex: selfEntry.zIndex,
        props: {},
        collapsed: false,
        docId: null,
        parentId: null,
      });

      // wait a tick so the widget manager can create the bin's automerge doc
      // via reconcile. after this, the bin's docId will be set.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const binEntry = store.getWidget(binId);
      if (!binEntry?.docId) {
        log.warn("file-widget", "bin doc not created after auto-bin, aborting");
        return;
      }

      // get the bin's doc handle
      const repo = store.repo;
      const binDocHandle = repo.handles[binEntry.docId as any];
      if (!binDocHandle) {
        log.warn("file-widget", "bin doc handle not found, aborting");
        return;
      }

      // upload each file and create child widgets in the bin. document
      // files (pdf/ps/eps) become peedeeeff children, markdown files
      // become markdown children, plain text files (txt/log/csv/etc)
      // become notepad children (raw text, no rasterization) — see
      // isDocumentFilename/isMarkdownFilename/isPlainTextFilename's doc
      // comments. single-file uploads (picked.length === 1, handled
      // elsewhere in this function) are NOT affected by this — this
      // auto-doc-widget behavior is multi-file-batch-only, per the
      // feature's design.
      const items: Array<{ widgetId: string; slot: { col: number; row: number } }> = [];

      for (let i = 0; i < picked.length; i++) {
        const file = picked[i];
        const slot = { col: i % cols, row: Math.floor(i / cols) };
        const childId = crypto.randomUUID();
        const isMarkdown = isMarkdownFilename(file.filename);
        const isPlainText = !isMarkdown && isPlainTextFilename(file.filename);
        const isDoc = !isMarkdown && !isPlainText && isDocumentFilename(file.filename);

        // create a child widget entry nested in the bin
        store.addWidget({
          id: childId,
          type: isMarkdown ? "markdown" : isPlainText ? "notepad" : isDoc ? "peedeeeff" : "file",
          x: 0,
          y: 0,
          width: 200,
          height: 160,
          zIndex: 0,
          props: {},
          collapsed: false,
          docId: null,
          parentId: binId,
        });

        // the widget manager skips widgets with parentId, so no automerge doc
        // was created during reconcile. create the per-widget doc ourselves.
        const childDefaults = isMarkdown
          ? markdownSchema.parse({})
          : isPlainText
            ? notepadSchema.parse({})
            : isDoc
              ? peedeeeffSchema.parse({})
              : fileSchema.parse({});
        const childDocHandle = repo.create(childDefaults);
        store.setDocId(childId, childDocHandle.documentId);

        // add the item to the bin immediately so it appears as a card
        items.push({ widgetId: childId, slot });

        if (isMarkdown || isPlainText) {
          // no blob upload for markdown/plain text — read it straight into
          // the widget's own text field.
          readPickedFileText(file)
            .then((text) => {
              childDocHandle.change((draft: any) => {
                draft.text = text;
              });
            })
            .catch((err) => {
              log.warn("file-widget", `auto-bin notepad/markdown read failed for ${file.filename}:`, err);
            });
          continue;
        }

        if (isDoc) {
          // fire-and-forget upload — don't await each one sequentially
          uploadFile(file, { waitForCompletion: true })
            .then(async (result) => {
              childDocHandle.change((draft: any) => {
                draft.blobId = result.blobId;
                draft.filename = file.filename;
                draft.mime = result.mime;
                draft.blake3 = result.blake3 ?? "";
                draft.size = result.size;
              });
              const refCanvasDocId = store.handle.documentId;
              if (refCanvasDocId) {
                void addBlobCanvasRef(result.blobId, result.blake3, refCanvasDocId);
              }

              // best-effort persisted thumbnail — see peedeeeff's
              // thumbnailDataUrl doc comment for why this is needed at all
              // (bins never mount a child's full widget lifecycle). cast:
              // childDocHandle's declared type is a union across all bin
              // child widget types, but we're inside the isDoc branch here
              // (a file being uploaded, ahead of a possible peedeeeff
              // conversion below) so it's always file-shaped at runtime.
              const fileDocHandle = childDocHandle as unknown as DocHandle<FileState>;
              await ensureThumbnailPersisted(
                { current: () => fileDocHandle.doc(), change: (fn) => fileDocHandle.change(fn) },
                result.blobId,
                { size: 200, square: true }
              );

              // kick off page rendering (hub/peer proxy in browser mode,
              // local dispatch in tauri mode) — nobody will ever mount this
              // widget to trigger it otherwise, since it lives in a bin.
              // childDocHandle's declared type is a union (isDoc ? peedeeeff : file
              // schema) so it needs a narrowing cast here — we're inside the isDoc
              // branch, so it's always a peedeeeff doc at runtime.
              const peedeeeffDocHandle = childDocHandle as unknown as DocHandle<PeedeeeffState>;
              await kickOffDocumentProcessing(
                {
                  current: () => peedeeeffDocHandle.doc(),
                  change: (fn) => peedeeeffDocHandle.change(fn),
                },
                result.blobId,
                store
              );
            })
            .catch((err) => {
              log.warn("file-widget", `auto-bin doc upload failed for ${file.filename}:`, err);
            });
          continue;
        }

        // fire-and-forget upload — don't await each one sequentially for better UX
        uploadFile(file, { waitForCompletion: true })
          .then(async (result) => {
            const localNodeId = await getLocalNodeId();
            childDocHandle.change((draft: any) => {
              draft.blobId = result.blobId;
              draft.domain = result.domain;
              draft.filename = file.filename;
              draft.mime = result.mime;
              draft.size = result.size;
              draft.blake3 = result.blake3 ?? "";
              draft.thumbnailDataUrl = result.thumbnailDataUrl ?? "";
              if (localNodeId) {
                if (!draft.snatchedBy) draft.snatchedBy = [];
                if (!draft.snatchedBy.includes(localNodeId)) {
                  draft.snatchedBy.push(localNodeId);
                }
              }
            });
            const refCanvasDocId = store.handle.documentId;
            if (refCanvasDocId) {
              void addBlobCanvasRef(result.blobId, result.blake3, refCanvasDocId);
            }

            // video/audio/pdf thumbnails need ffmpeg/magick, so they're never
            // ready synchronously at upload time. a bin never mounts its
            // children's full widget lifecycle (it only reads the persisted
            // doc via getCompactInfo), so nothing else will ever generate and
            // persist one later - fetch and write it now, best-effort. cast:
            // this branch always creates a plain file child, so childDocHandle
            // is always file-shaped at runtime (see cast comment above).
            const fileDocHandle = childDocHandle as unknown as DocHandle<FileState>;
            await ensureThumbnailPersisted(
              { current: () => fileDocHandle.doc(), change: (fn) => fileDocHandle.change(fn) },
              result.blobId,
              { size: 200 }
            );
          })
          .catch((err) => {
            log.warn("file-widget", `auto-bin upload failed for ${file.filename}:`, err);
            // leave the child widget in place — it will show as empty
          });
      }

      // write all items into the bin's doc at once
      const rows = Math.ceil(picked.length / cols);
      binDocHandle.change((draft: any) => {
        draft.items = items;
        draft.cols = cols;
        draft.rows = rows;
        draft.title = "";
        draft.mode = "grid";
      });

      // remove this file widget — the bin replaces it
      store.removeWidget(ctx.widgetId);
    };

    /**
     * tauri-only: poll for a pdf's rendered pages, then replace this file
     * widget with a peedeeeff widget holding them. shared by the upload
     * flow (called unconditionally once a pdf finishes uploading) and the
     * manual domain-pick ingest path (see runDomainIngest / kickOffDomainIngest
     * below) — used to be duplicated inline at the upload call site.
     * returns false on failure/timeout instead of throwing.
     */
    async function convertToDocumentWidget(
      blobId: string,
      filename: string,
      mime: string,
      blake3: string,
      size: number
    ): Promise<boolean> {
      if (!ctx.canvasStore || !isTauriMode()) return false;
      const store = ctx.canvasStore;

      const maxAttempts = 120; // poll for up to ~2 minutes
      const pollIntervalMs = 1000;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (destroyed) return false;
        await new Promise((r) => setTimeout(r, pollIntervalMs));

        const pages = await getDocumentPages(blobId);
        if (pages.length > 0) {
          if (destroyed) return false;
          const selfEntry = store.getWidget(ctx.widgetId);
          if (!selfEntry) return false;

          const blobIds = pages.map((p) => p.page_blob_id);
          const totalPages = pages[0]?.total_pages ?? pages.length;

          // best-effort thumbnail from the first page — bins never mount a
          // peedeeeff widget's full lifecycle, so this needs to be
          // persisted at creation time (see peedeeeff's thumbnailDataUrl
          // doc comment).
          let firstPageThumb = "";
          try {
            firstPageThumb = (await getThumbnailDataUrl(blobIds[0], { size: 200, square: true })) ?? "";
          } catch {
            log.debug(
              "file-widget",
              "peedeeeff first-page thumbnail generation failed for",
              blobIds[0]?.slice(0, 8)
            );
          }

          const pdfId = crypto.randomUUID();
          store.addWidget({
            id: pdfId,
            type: "peedeeeff",
            x: selfEntry.x,
            y: selfEntry.y,
            width: Math.max(selfEntry.width, 480),
            height: Math.max(selfEntry.height, 640),
            zIndex: selfEntry.zIndex,
            title: filename.replace(/\.pdf$/i, ""),
            props: {
              blobId,
              filename,
              mime,
              blake3,
              size,
              pageCount: totalPages,
              pageBlobIds: blobIds,
              pageBlake3s: pages.map((p) => p.blake3 || ""),
              thumbnailDataUrl: firstPageThumb,
            },
            collapsed: false,
            docId: null,
            parentId: null,
          });

          // remove this file widget — the peedeeeff widget replaces it
          store.removeWidget(ctx.widgetId);
          return true;
        }
      }
      // timed out — pages may still be rendering, leave file widget in place
      log.warn("file-widget", "PDF page rendering timed out for", blobId.slice(0, 8));
      return false;
    }

    /** minimal doc-access wrapper for file-domain-ingest.ts's claim/release
     *  helpers — adapts `ctx.doc`'s property-getter `current` into the
     *  method shape those helpers expect (mirrors peedeeeff's RenderableDoc
     *  wrapper around a DocHandle). */
    const domainIngestDoc: DomainIngestDoc = {
      current: () => ctx.doc.current,
      change: (fn) => ctx.doc.change(fn),
    };

    /** triggered when a user fills in a previously-unset `domain` via the
     *  property tray (see the `state.domain !== prevDomain` handling in the
     *  doc-change subscription below). no-op if a fresh upload/snatch set
     *  domain+blobId together instead — see `domainJustFilledIn`'s guard. */
    function kickOffDomainIngest(domain: string) {
      const state = ctx.doc.current;
      if (!state.blobId) return;
      void runDomainIngest(domainIngestDoc, state.blobId, domain, state.mime, ctx.canvasStore, {
        isDestroyed: () => destroyed,
        convertToDocument:
          domain === "document" && state.mime === "application/pdf"
            ? (blobId) => convertToDocumentWidget(blobId, state.filename, state.mime, state.blake3, state.size)
            : undefined,
      });
    }

    const handleUpload = async () => {
      if (loadState !== "empty") return;
      if (ctx.canvasStore?.isLocalViewer()) return;
      if (!iAmCreator) return;

      // respect another peer's fresh upload lock — no competing uploads.
      // stale locks (crashed uploader) are ignored via the staleness window.
      const localNodeId = await getLocalNodeId();
      const cur = ctx.doc.current;
      if (
        cur.uploadingBy &&
        cur.uploadingBy !== localNodeId &&
        Date.now() - (cur.uploadingAt || 0) < UPLOAD_LOCK_STALE_MS
      ) {
        log.debug("file-widget", "upload refused — another peer holds the upload lock");
        return;
      }

      try {
        const picked = await pickFiles();
        if (!picked || picked.length === 0) return;

        // single markdown/plain-text file: no blob upload — replace this
        // file widget with a markdown/notepad widget holding the raw text,
        // same as the bin/multi-file routing (see isMarkdownFilename,
        // isPlainTextFilename).
        if (picked.length === 1) {
          const file = picked[0];
          const isMarkdown = isMarkdownFilename(file.filename);
          const isPlainText = !isMarkdown && isPlainTextFilename(file.filename);
          if (isMarkdown || isPlainText) {
            const store = ctx.canvasStore;
            if (!store) return;

            const selfEntry = store.getWidget(ctx.widgetId);
            if (!selfEntry) return;

            const text = await readPickedFileText(file);
            store.addWidget({
              id: crypto.randomUUID(),
              type: isMarkdown ? "markdown" : "notepad",
              x: selfEntry.x,
              y: selfEntry.y,
              width: selfEntry.width,
              height: selfEntry.height,
              zIndex: selfEntry.zIndex,
              title: file.filename.replace(/\.[^.]+$/, ""),
              props: { text },
              collapsed: false,
              docId: null,
              parentId: null,
            });
            store.removeWidget(ctx.widgetId);
            return;
          }
        }

        // single file: upload into this widget as before
        if (picked.length === 1) {
          const file = picked[0];
          loadState = "loading";
          syncVisibility();
          loadingText.text = "uploading... (tap to cancel)";

          uploadCancelled = false;
          uploadAbort = new AbortController();

          // claim the upload lock so peers see progress and don't race
          if (localNodeId) {
            ctx.doc.change((draft) => {
              draft.uploadingBy = localNodeId;
              draft.uploadingProgress = 0;
              draft.uploadingAt = Date.now();
            });
          }

          // throttled lock heartbeat: write on >=5% delta or >=1s elapsed,
          // so a big upload doesn't spam the automerge doc every chunk
          let lastLockFraction = 0;
          let lastLockWrite = Date.now();

          const releaseLock = () => {
            if (!localNodeId) return;
            ctx.doc.change((draft) => {
              draft.uploadingBy = "";
              draft.uploadingProgress = 0;
              draft.uploadingAt = 0;
            });
          };

          let result: Awaited<ReturnType<typeof uploadFile>>;
          try {
            result = await uploadFile(file, {
              waitForCompletion: true,
              signal: uploadAbort.signal,
              onProgress: (fraction) => {
                if (loadState !== "loading" || uploadCancelled) return;
                loadingText.text = `uploading... ${Math.round(fraction * 100)}% (tap to cancel)`;
                const now = Date.now();
                if (
                  localNodeId &&
                  (fraction - lastLockFraction >= 0.05 || now - lastLockWrite >= 1000)
                ) {
                  lastLockFraction = fraction;
                  lastLockWrite = now;
                  ctx.doc.change((draft) => {
                    draft.uploadingProgress = fraction;
                    draft.uploadingAt = now;
                  });
                }
              },
            });
          } catch (err) {
            releaseLock();
            if (
              uploadCancelled ||
              (err instanceof DOMException && err.name === "AbortError")
            ) {
              log.debug("file-widget", "upload cancelled by user");
              loadState = "empty";
              syncVisibility();
              return;
            }
            throw err;
          } finally {
            uploadAbort = null;
          }

          // if the uploaded file is a PDF (in Tauri mode), poll for rendered
          // page images in the background. once pages are available, replace
          // this file widget with a peedeeeff widget that has all pageBlobIds
          // populated. the file widget stays visible as a normal file in the
          // meantime (with thumbnail, filename, actions, etc.)
          if (result.mime === "application/pdf" && ctx.canvasStore && isTauriMode()) {
            // fire-and-forget: poll for pages without blocking the upload flow
            void convertToDocumentWidget(
              result.blobId,
              file.filename,
              result.mime,
              result.blake3 ?? "",
              result.size
            );
          }

          // mark as locally uploaded so we don't show "save to disk".
          // suppress the doc-change subscription by updating prevBlobId first,
          // otherwise the subscription resets uploadedLocally to false.
          uploadedLocally = true;
          prevBlobId = result.blobId;
          actionState = "local";

          ctx.doc.change((draft) => {
            draft.blobId = result.blobId;
            draft.domain = result.domain;
            draft.filename = file.filename;
            draft.mime = result.mime;
            draft.size = result.size;
            draft.blake3 = result.blake3 ?? "";
            draft.thumbnailDataUrl = result.thumbnailDataUrl ?? "";
            if (!draft.title || !draft.title.trim()) {
              draft.title = file.filename;
            }
            // release the upload lock in the same change that publishes the
            // result — peers atomically see "upload done + file present"
            draft.uploadingBy = "";
            draft.uploadingProgress = 0;
            draft.uploadingAt = 0;
            if (localNodeId) {
              if (!draft.snatchedBy) draft.snatchedBy = [];
              if (!draft.snatchedBy.includes(localNodeId)) {
                draft.snatchedBy.push(localNodeId);
              }
            }
          });
          {
            const refCanvasDocId = ctx.canvasStore?.handle.documentId;
            if (refCanvasDocId) {
              void addBlobCanvasRef(result.blobId, result.blake3, refCanvasDocId);
            }
          }

          // use the embedded thumbnail if the upload produced one, otherwise
          // fall back to the async thumbnail fetch from grimoire/peers
          if (result.thumbnailDataUrl) {
            loadState = "loaded";
            syncVisibility();
            positionInfoBar(currentWidth, currentHeight);
            positionFallbackIcon(currentWidth, currentHeight);
            loadEmbeddedThumbnail(result.thumbnailDataUrl);
          } else {
            loadThumbnail(result.blobId);
          }
          return;
        }

        // multiple files: replace this file widget with a bin
        await handleMultiFileUpload(picked);
      } catch (err) {
        log.error("file-widget", "upload failed:", err);
        errorText.text = formatUploadError(err);
        loadState = "error";
        syncVisibility();
      }
    };

    placeholderText.on("pointertap", handleUpload);
    placeholderBorder.on("pointertap", handleUpload);

    // -- snatch handler -------------------------------------------------------

    function cancelSnatch() {
      if (actionState !== "snatching") return;
      snatchCancelled = true;
      if (snatchAbort) {
        snatchAbort.abort();
        snatchAbort = null;
      }
      // best-effort: also flag the in-flight wasm transfer so it stops at
      // the next chunk boundary instead of running to completion in the
      // background, then release the gc pin the cancel left behind.
      const blake3 = activeSnatchBlake3 ?? String(ctx.doc.current.blake3 || "");
      void pauseSnatchDownload({
        downloadId: snatchDownloadId ?? undefined,
        blake3: blake3 || null,
      }).then(() => discardPausedDownload(blake3));
      activeSnatchBlake3 = null;
      snatchDownloadId = null;
      snatchHovered = false;
      snatchProgressText = "";
      actionState = "remote";
      snatchBtn.setLabel("snatch");
      snatchBtn.setColor(0x2d5a27);
      syncActionButtons();
      positionInfoBar(currentWidth, currentHeight);
      log.debug("file-widget", "snatch cancelled by user");
    }

    /** pause the in-flight snatch: the transfer stops at the next chunk
     *  boundary and the partial stays in the persistent store (gc-pinned).
     *  the snatchBlob promise rejects with a cancelled error — handleSnatch's
     *  catch sees snatchPaused and lands in the "paused" state. */
    async function pauseSnatch() {
      if (actionState !== "snatching") return;
      snatchPaused = true;
      snatchPausedPct = snatchProgressText.endsWith("%") ? snatchProgressText : "";
      // stop between-peer stages (probe/retry) too
      if (snatchAbort) {
        snatchAbort.abort();
        snatchAbort = null;
      }
      const blake3 = activeSnatchBlake3 ?? String(ctx.doc.current.blake3 || "");
      await pauseSnatchDownload({
        downloadId: snatchDownloadId ?? undefined,
        blake3: blake3 || null,
      });
      log.debug("file-widget", "snatch paused by user");
    }

    /** discard a paused snatch: release the gc pin on the partial and go
     *  back to plain "remote". */
    function discardPausedSnatch() {
      if (actionState !== "paused") return;
      void discardPausedDownload(activeSnatchBlake3 ?? String(ctx.doc.current.blake3 || ""));
      activeSnatchBlake3 = null;
      snatchPaused = false;
      snatchPausedPct = "";
      snatchProgressText = "";
      snatchDownloadId = null;
      actionState = "remote";
      syncActionButtons();
      positionInfoBar(currentWidth, currentHeight);
      log.debug("file-widget", "paused snatch discarded by user");
    }

    async function handleSnatch() {
      // "paused" re-entry is the resume path: the persistent store still has
      // the partial, so the downloader only fetches the missing ranges.
      if (actionState !== "remote" && actionState !== "paused") return;

      const state = ctx.doc.current;
      const allPeers = ctx.canvasStore?.peers();
      if (!allPeers || Object.keys(allPeers).length === 0) {
        log.warn("file-widget", "no peers available for snatch");
        return;
      }

      // prefer peers listed in snatchedBy — they're known to have the blob.
      // fall back to all canvas peers when snatchedBy is empty or none match.
      const snatchedBy = (state.snatchedBy ?? []).map(String);
      let peers: typeof allPeers;
      if (snatchedBy.length > 0) {
        const filtered: typeof allPeers = {};
        for (const [key, value] of Object.entries(allPeers)) {
          if (snatchedBy.includes(String(value.nodeId))) {
            filtered[key] = value;
          }
        }
        peers = Object.keys(filtered).length > 0 ? filtered : allPeers;
      } else {
        peers = allPeers;
      }

      snatchCancelled = false;
      snatchPaused = false;
      snatchDownloadId = crypto.randomUUID();
      snatchAbort = new AbortController();
      activeSnatchBlake3 = String(state.blake3 || "") || null;

      actionState = "snatching";
      snatchBtn.setLabel("snatching...");
      snatchBtn.setColor(0x555555);
      syncActionButtons();
      // pauseBtn just became visible for the first time — its x/y default
      // to (0,0), so it must be positioned now, not left for loadState-gated
      // callers to pick up later (see checkLocality's re-layout below).
      positionInfoBar(currentWidth, currentHeight);

      // show "probing..." while the parallel probe runs (before download starts)
      snatchProgressText = "probing...";
      if (!snatchHovered) {
        snatchBtn.setLabel(snatchProgressText);
      }

      try {
        const result = await snatchBlob(
          {
            blobId: String(state.blobId || ""),
            filename: String(state.filename || ""),
            mime: String(state.mime || ""),
            size: state.size,
            blake3: String(state.blake3 || ""),
            domain: String(state.domain || ""),
          },
          peers as PeersMap,
          {
            onProgress: (fraction) => {
              if (snatchCancelled) return;
              if (fraction >= 0) {
                const pct = Math.round(fraction * 100);
                snatchProgressText = `${pct}%`;
                if (!snatchHovered) {
                  snatchBtn.setLabel(snatchProgressText);
                }
              } else {
                snatchProgressText = "snatching...";
                if (!snatchHovered) {
                  snatchBtn.setLabel(snatchProgressText);
                }
              }
            },
            signal: snatchAbort?.signal,
            downloadId: snatchDownloadId,
            isPeerOnline: ctx.canvasStore
              ? (nodeId: string) => ctx.canvasStore!.isPeerOnline(nodeId)
              : undefined,
            onPeerAttempt: (peerIndex, peerCount, online) => {
              if (snatchCancelled) return;
              const label =
                peerCount > 1
                  ? `peer ${peerIndex + 1}/${peerCount}${online ? "" : " (offline)"}`
                  : "snatching...";
              snatchProgressText = label;
              if (!snatchHovered) {
                snatchBtn.setLabel(snatchProgressText);
              }
            },
          }
        );

        if (snatchCancelled) {
          log.debug("file-widget", "snatch result discarded (cancelled)");
          return;
        }

        // the widget may have been deleted while the snatch was in flight.
        // aborting snatchAbort (in destroy()) does NOT actually cancel the
        // underlying WASM/iroh-blobs download call — the abort signal is
        // only polled between attempts, never threaded into the in-flight
        // transfer itself — so this promise can still resolve well after
        // destroy() already tore down the pixi container and unsubscribed
        // from doc changes. bail out before touching ctx.doc (writing to an
        // orphaned widget doc) or any destroyed pixi object.
        if (destroyed) {
          log.debug("file-widget", "snatch result discarded (widget destroyed)");
          return;
        }

        // update the doc if the blob ID changed (SHA256 dedup might map to existing)
        // suppress the doc-change subscription so it doesn't overwrite
        // "snatched" with a re-check that resolves to "local"
        prevBlobId = result.blobId;
        actionState = "snatched";
        activeSnatchBlake3 = null;
        // release any gc pin left behind by an earlier pause of this blob —
        // the content is now safely persisted outside the midden store
        void discardPausedDownload(String(state.blake3 || ""));
        snatchDownloadId = null;
        snatchPausedPct = "";
        void refreshLocalByteSize(result.blobId, result.blake3 ?? "");

        if (result.blobId !== state.blobId) {
          ctx.doc.change((draft) => {
            draft.blobId = result.blobId;
            draft.domain = result.domain;
            draft.mime = result.mime;
            draft.size = result.size;
            draft.blake3 = result.blake3 ?? "";
          });
          const refCanvasDocId = ctx.canvasStore?.handle.documentId;
          if (refCanvasDocId) {
            if (state.blobId) {
              void removeBlobCanvasRef(state.blobId, state.blake3, refCanvasDocId);
            }
            void addBlobCanvasRef(result.blobId, result.blake3, refCanvasDocId);
          }
        }
        if (!state.title || !state.title.trim()) {
          ctx.doc.change((draft) => {
            draft.title = state.filename;
          });
        }

        // record this node as a snatcher so other peers can target us for downloads
        const localNodeId = await getLocalNodeId();
        if (localNodeId) {
          ctx.doc.change((draft) => {
            if (!draft.snatchedBy) draft.snatchedBy = [];
            if (!draft.snatchedBy.includes(localNodeId)) {
              draft.snatchedBy.push(localNodeId);
            }
          });
        }

        syncActionButtons();

        // re-layout
        positionInfoBar(currentWidth, currentHeight);
        fitSprite(currentWidth, currentHeight);
        if (!hasThumbnail) {
          positionFallbackIcon(currentWidth, currentHeight);
        }

        // generate thumbnail locally and write to doc if possible.
        // writing thumbnailDataUrl to the doc triggers loadEmbeddedThumbnail
        // via the doc-change subscription — single code path, no race.
        // if local generation fails (e.g. audio in browser — no ffmpeg),
        // fall back to loadThumbnail which checks cache + local only.
        try {
          if (!ctx.doc.current.thumbnailDataUrl) {
            const thumbDataUrl = await getThumbnailDataUrl(result.blobId, {
              size: 200,
            });
            // re-check: the widget can be destroyed during this await too.
            if (destroyed) return;
            if (thumbDataUrl && ctx.doc.current.blobId === result.blobId) {
              ctx.doc.change((draft) => {
                draft.thumbnailDataUrl = thumbDataUrl;
              });
              // doc-change subscription will call loadEmbeddedThumbnail
            } else {
              // no thumbnail generated — try loading from local/cache
              loadThumbnail(result.blobId);
            }
          } else {
            // doc already has a thumbnail (maybe peer wrote it) — load it
            loadEmbeddedThumbnail(ctx.doc.current.thumbnailDataUrl);
          }
        } catch {
          // thumbnail generation failed — try loading from local/cache
          if (!destroyed) loadThumbnail(result.blobId);
        }
      } catch (err) {
        if (snatchPaused) {
          // deliberate pause — the partial is gc-pinned in the store; the
          // snatch button becomes "resume" and re-entry only fetches the
          // missing ranges
          if (destroyed) return;
          actionState = "paused";
          snatchHovered = false;
          syncActionButtons();
          positionInfoBar(currentWidth, currentHeight);
          log.debug("file-widget", "snatch paused — partial retained for resume");
          return;
        }
        if (snatchCancelled) {
          log.debug("file-widget", "snatch aborted (cancelled)");
          return;
        }
        if (destroyed) {
          log.debug("file-widget", "snatch failed after widget destroyed:", err);
          return;
        }
        if (err instanceof BlobAccessDeniedError) {
          log.debug("file-widget", "snatch denied — no friend has this blob yet:", err.message);
          deniedPeerNodeId = err.peerNodeId;
          actionState = "needs-friend";
          activeSnatchBlake3 = null;
          syncActionButtons();
          positionInfoBar(currentWidth, currentHeight);
          return;
        }
        log.error("file-widget", "snatch failed:", err);
        actionState = "remote";
        activeSnatchBlake3 = null;
        syncActionButtons();
      } finally {
        snatchAbort = null;
      }
    }

    /** send a friend request to the peer holding this blob, then
     *  automatically retry the snatch once the request is accepted (see
     *  pending-blob-access.ts). session-only — if the widget is destroyed
     *  before the request is accepted, the retry is simply dropped. */
    async function requestFriendAndRetry() {
      if (actionState !== "needs-friend") return;
      const peerNodeId = deniedPeerNodeId;
      if (!peerNodeId) return;

      unregisterPendingRetry?.();
      try {
        await sendFriendRequest(peerNodeId);
      } catch (err) {
        log.error("file-widget", "sendFriendRequest failed:", err);
        return;
      }
      if (destroyed) return;

      actionState = "friend-requested";
      syncActionButtons();
      positionInfoBar(currentWidth, currentHeight);

      unregisterPendingRetry = registerPendingBlobRetry(peerNodeId, () => {
        unregisterPendingRetry = null;
        if (destroyed) return;
        actionState = "remote";
        void handleSnatch();
      });
    }

    // -- save to disk handler -------------------------------------------------

    async function handleRevealInFinder() {
      if (actionState !== "snatched" && actionState !== "local") return;
      const state = ctx.doc.current;
      const revealed = await revealBlobInFinder(state.blobId);
      if (!revealed) {
        log.warn("file-widget", "could not reveal blob in finder, falling back to save dialog");
        handleSaveToDisk();
      }
    }

    async function handleSaveToDisk() {
      if (actionState !== "snatched" && actionState !== "local") return;

      const state = ctx.doc.current;
      const prevState = actionState;

      actionState = "saving";
      syncActionButtons();

      try {
        const saved = await saveBlobToDisk(state.blobId, state.filename || "file");
        if (saved) {
          log.debug("file-widget", "saved to disk successfully");
        }
      } catch (err) {
        log.error("file-widget", "save to disk failed:", err);
      }

      actionState = prevState;
      syncActionButtons();
      positionInfoBar(currentWidth, currentHeight);
    }

    // -- preview handler ------------------------------------------------------

    async function handlePreview() {
      const state = ctx.doc.current;
      log.debug("file-widget", "handlePreview called", {
        blobId: state.blobId,
        domain: state.domain,
        actionState,
        loadState,
        hasThumbnail,
        isPreviewable: isPreviewableDomain(state.domain),
      });
      if (!state.blobId || !isPreviewableDomain(state.domain)) {
        log.debug("file-widget", "bail: no blobId or not previewable domain");
        return;
      }
      if (actionState !== "local" && actionState !== "snatched") {
        log.debug("file-widget", "bail: actionState is", actionState, "(need local or snatched)");
        return;
      }

      const overlayType = domainToOverlayType(state.domain);
      log.debug("file-widget", "overlayType:", overlayType);

      // photos use the fullscreen overlay — inline at widget scale isn't useful
      if (overlayType === "photo") {
        // close any existing overlay/player
        if (activeOverlay && !activeOverlay.closed) {
          activeOverlay.close();
        }
        if (activePlayer && !activePlayer.closed) {
          activePlayer.close();
          activePlayer = null;
        }

        let src: string | null = null;
        // local-first: only preview from local sources, no peer fetch
        log.debug(
          "file-widget",
          "photo: calling getLocalBlobUrl for",
          state.blobId,
          "blake3:",
          state.blake3?.slice(0, 12)
        );
        src = await getLocalBlobUrl(state.blobId, state.blake3);
        log.debug(
          "file-widget",
          "photo: getLocalBlobUrl returned",
          src ? `${src.slice(0, 80)}...` : null
        );

        if (!src) {
          log.warn(
            "file-widget",
            "could not resolve blob data for photo preview, blobId:",
            state.blobId
          );
          return;
        }

        activeOverlay = createMediaOverlay({
          type: "photo",
          src,
          filename: state.filename,
          mime: state.mime,
          onClose: () => {
            activeOverlay = null;
          },
        });
        return;
      }

      // video/audio use the inline player positioned over the widget
      // close any existing overlay/player
      if (activeOverlay && !activeOverlay.closed) {
        activeOverlay.close();
        activeOverlay = null;
      }
      if (activePlayer && !activePlayer.closed) {
        activePlayer.close();
        activePlayer = null;
      }

      // use the unified media URL resolver — handles asset:// on macOS,
      // blob: URL workaround on Linux WebKitGTK, and OPFS in browser mode
      // local-first: try local URL without peer fallback
      log.debug(
        "file-widget",
        "audio/video: calling getMediaPlaybackUrl for",
        state.blobId,
        "mime:",
        state.mime
      );
      const src = await getMediaPlaybackUrl(state.blobId, {
        category: overlayType as "video" | "audio",
        mime: state.mime,
        blake3: state.blake3,
        // no peers — preview only uses local sources
      });
      log.debug(
        "file-widget",
        "audio/video: getMediaPlaybackUrl returned",
        src ? `${src.slice(0, 80)}...` : null
      );

      if (!src) {
        log.warn(
          "file-widget",
          "could not resolve blob data for preview, blobId:",
          state.blobId,
          "domain:",
          state.domain
        );
        return;
      }

      // hide thumbnail while player is active
      if (thumbSprite) {
        thumbSprite.visible = false;
      }

      activePlayer = createInlinePlayer({
        type: overlayType as "video" | "audio",
        src,
        mime: state.mime,
        container,
        canvasElement: ctx.canvasElement,
        width: currentWidth,
        height: currentHeight,
        onClose: () => {
          activePlayer = null;
          // re-show thumbnail
          if (thumbSprite) {
            thumbSprite.visible = true;
          }
        },
      });
    }

    // -- overlay repositioning ------------------------------------------------

    const repositionOverlays = (w: number, h: number) => {
      placeholderText.x = w / 2;
      placeholderText.y = h / 2;
      loadingText.x = w / 2;
      loadingText.y = h / 2;
      errorText.x = w / 2;
      errorText.y = h / 2;
      errorText.style.wordWrapWidth = Math.max(40, w - 16);
      servingText.x = w / 2;
      servingText.y = Math.max(0, h - 4);
    };

    // -- doc change subscription ----------------------------------------------

    // cached for the sync doc-change callback (getLocalNodeId is async)
    let localNodeIdCached = "";
    void getLocalNodeId().then((id) => {
      localNodeIdCached = id ?? "";
    });

    /** true when ANOTHER peer holds a fresh upload lock on this widget */
    function remoteUploadLockActive(state: FileState): boolean {
      return (
        !!state.uploadingBy &&
        state.uploadingBy !== localNodeIdCached &&
        Date.now() - (state.uploadingAt || 0) < UPLOAD_LOCK_STALE_MS
      );
    }

    let prevBlobId = ctx.doc.current.blobId;
    let prevThumbDataUrl = ctx.doc.current.thumbnailDataUrl;
    // blobId is always blake3 for any blob stored via storeBlobFromFile()/
    // storeBlob() (see reliquary's blob store) - fall back to it for
    // widgets whose own `blake3` field was never backfilled (e.g. created
    // before that field existed).
    let prevBlake3 = ctx.doc.current.blake3;
    updateTransferProgressSubscription(ctx.doc.current.blake3 || ctx.doc.current.blobId);
    // the widget frame's toolbar title comes from the canvas entry's
    // `entry.title` (set via the property tray's generic title control),
    // but file.ts declares its OWN doc-backed "title" editableProp instead
    // (needed so the bin label — which reads `state.title` — has something
    // to show), which suppresses that generic control entirely (see
    // property-tray.ts's `hasOwnTitleProp`). mirror doc-backed title changes
    // into `entry.title` here so the toolbar stays in sync the same way it
    // does for every other widget type.
    let prevTitle = ctx.doc.current.title;
    let prevDomain = ctx.doc.current.domain;
    let prevDomainIngestState = ctx.doc.current.domainIngestState;
    let prevDomainIngestClaimedBy = ctx.doc.current.domainIngestClaimedBy;
    const unsub = ctx.doc.on("change", (state) => {
      if (state.title !== prevTitle) {
        prevTitle = state.title;
        ctx.canvasStore?.setWidgetTitle(ctx.widgetId, state.title);
      }

      // a domain picked away from the generic/unclassified "file" bucket
      // while the file was already loaded (blobId unchanged) means the user
      // just chose one via the property tray's fill-in-the-blank select —
      // kick off ingest for it below. a domain that arrives bundled with a
      // brand-new blobId (upload/snatch completion) is auto-detected and
      // handled by that flow already, not here — see the
      // `state.blobId !== prevBlobId` branch further down.
      const domainJustPicked = isDomainEditable(prevDomain) && !isDomainEditable(state.domain);
      if (state.domain !== prevDomain) {
        prevDomain = state.domain;
        currentEditableProps = fileEditableProps(state.domain);
      }

      if (
        state.domainIngestState !== prevDomainIngestState ||
        state.domainIngestClaimedBy !== prevDomainIngestClaimedBy
      ) {
        prevDomainIngestState = state.domainIngestState;
        prevDomainIngestClaimedBy = state.domainIngestClaimedBy;
        syncIngestStatusUI();
      }

      drawBg(currentWidth, currentHeight);

      // cross-peer upload lock: while another peer uploads into this widget,
      // render a locked progress view (and handleUpload refuses to start).
      // only relevant before a blob lands — once blobId is set the normal
      // loaded path below takes over.
      if (!state.blobId && !uploadAbort) {
        if (remoteUploadLockActive(state)) {
          loadState = "loading";
          syncVisibility();
          loadingText.text = `peer uploading... ${Math.round((state.uploadingProgress || 0) * 100)}%`;
          return;
        }
        if (loadState === "loading") {
          // the lock cleared without a blob (uploader cancelled/failed)
          loadState = "empty";
          syncVisibility();
          return;
        }
      }

      if (state.blake3 !== prevBlake3 && state.blobId === prevBlobId) {
        // blake3 backfilled/changed independently of blobId (e.g. a legacy
        // widget whose blake3 was never set finally gets one) - resubscribe
        // without touching the rest of the blobId-change branch below.
        prevBlake3 = state.blake3;
        updateTransferProgressSubscription(state.blake3 || state.blobId);
      }

      if (state.blobId !== prevBlobId) {
        // the OLD blobId is no longer referenced by this widget doc — drop
        // its canvas ref (if this device ever recorded one) so the index
        // doesn't keep protecting bytes nothing here points at anymore.
        if (prevBlobId) {
          const refCanvasDocId = ctx.canvasStore?.handle.documentId;
          if (refCanvasDocId) {
            void removeBlobCanvasRef(prevBlobId, prevBlake3, refCanvasDocId);
          }
        }

        // an in-flight/paused snatch targets the OLD blobId — if it's left
        // running, checkLocality() below resets actionState out from under
        // it (hiding the pause button), but the snatch promise's onProgress
        // callback only checks `snatchCancelled`, not actionState, so it
        // keeps clobbering the snatch button's label with stale progress
        // forever. cancel/discard it first so it stops cleanly.
        if (actionState === "snatching") {
          cancelSnatch();
        } else if (actionState === "paused") {
          discardPausedSnatch();
        }

        prevBlobId = state.blobId;
        prevBlake3 = state.blake3;
        prevThumbDataUrl = state.thumbnailDataUrl;
        updateTransferProgressSubscription(state.blake3 || state.blobId);
        // reset uploaded flag when blobId changes (e.g. from a peer's change)
        uploadedLocally = false;

        // immediately show metadata from the new state
        if (state.blobId) {
          loadState = "loaded";
          syncVisibility();
          positionInfoBar(currentWidth, currentHeight);
          positionFallbackIcon(currentWidth, currentHeight);

          if (state.thumbnailDataUrl) {
            loadEmbeddedThumbnail(state.thumbnailDataUrl);
          } else {
            loadThumbnail(state.blobId);
          }
        } else {
          loadThumbnail(state.blobId);
        }
        checkLocality(state.blobId);
      } else if (state.thumbnailDataUrl && state.thumbnailDataUrl !== prevThumbDataUrl) {
        // a peer (or Tauri snatch) wrote a new thumbnail — load it
        prevThumbDataUrl = state.thumbnailDataUrl;
        loadEmbeddedThumbnail(state.thumbnailDataUrl);
      } else if (loadState === "loaded") {
        // metadata changed (e.g. title, or a user-picked domain override) —
        // refresh info bar + anything else keyed off domain
        syncActionButtons();
        positionInfoBar(currentWidth, currentHeight);
        drawHoverOverlay(currentWidth, currentHeight);
        drawThumbHitArea(currentWidth, currentHeight);

        if (domainJustPicked) {
          kickOffDomainIngest(state.domain);
        }
      }
    });

    // sync the toolbar title once at mount too — covers widgets that already
    // had a doc-backed title before this fix landed, or whose `entry.title`
    // has drifted out of sync for any other reason.
    if (ctx.doc.current.title !== (ctx.canvasStore?.getWidget(ctx.widgetId)?.title ?? "")) {
      ctx.canvasStore?.setWidgetTitle(ctx.widgetId, ctx.doc.current.title);
    }

    // kick off initial load if a blob ID is already set
    if (ctx.doc.current.blobId) {
      // immediately show metadata (filename, size, domain badge) — no async needed
      loadState = "loaded";
      syncVisibility();
      positionInfoBar(currentWidth, currentHeight);
      positionFallbackIcon(currentWidth, currentHeight);
      syncIngestStatusUI();

      // if we have an embedded thumbnail, load it (fast — it's a data URL, already local)
      if (ctx.doc.current.thumbnailDataUrl) {
        loadEmbeddedThumbnail(ctx.doc.current.thumbnailDataUrl);
      } else {
        // fall back to the old async thumbnail fetch from grimoire/peers
        loadThumbnail(ctx.doc.current.blobId);
      }

      checkLocality(ctx.doc.current.blobId);
    } else if (remoteUploadLockActive(ctx.doc.current)) {
      // mounted mid-upload (another peer holds a fresh lock) — show the
      // locked progress view instead of the upload placeholder
      loadState = "loading";
      syncVisibility();
      loadingText.text = `peer uploading... ${Math.round((ctx.doc.current.uploadingProgress || 0) * 100)}%`;
    }

    // -- return controller ----------------------------------------------------

    /** user-chosen thumbnail override — replaces whatever auto-generated
     *  thumbnail (embedded on upload, or tauri video-frame/pdf-first-page
     *  capture) would otherwise show, both on this widget's own face and as
     *  its compact-card thumbnail when nested inside a bin. */
    async function handleChooseThumbnail() {
      if (ctx.canvasStore?.isLocalViewer()) return;
      const dataUrl = await pickImageAsDataUrl({ maxWidth: 500, maxHeight: 500 });
      if (!dataUrl) return;
      ctx.doc.change((draft) => {
        draft.thumbnailDataUrl = dataUrl;
      });
    }

    /** clear a user-chosen thumbnail override, falling back to whatever
     *  auto-generated thumbnail is available (cache/local only — never
     *  contacts peers, same as the normal load path). */
    function handleRemoveThumbnail() {
      if (ctx.canvasStore?.isLocalViewer()) return;
      ctx.doc.change((draft) => {
        draft.thumbnailDataUrl = "";
      });
      loadThumbnail(ctx.doc.current.blobId);
    }

    /** delete the LOCAL copy of the blob to reclaim disk space — the widget
     *  stays on the canvas and the blob flips back to "remote" (snatchable
     *  from whoever still has it, e.g. a hub peer). */
    async function handleFreeUpSpace() {
      const state = ctx.doc.current;
      if (!state.blobId) return;
      if (actionState !== "local" && actionState !== "snatched") {
        log.debug("file-widget", "free up space: no local copy to remove");
        return;
      }
      try {
        await freeUpLocalBlobCopy(String(state.blobId), String(state.blake3 || "") || null);
      } catch (err) {
        log.warn("file-widget", "free up space failed:", err);
        return;
      }
      // remove ourselves from snatchedBy so peers stop probing us for a
      // blob we no longer have
      const me = await getLocalNodeId();
      if (me) {
        ctx.doc.change((draft) => {
          if (draft.snatchedBy) {
            const idx = draft.snatchedBy.indexOf(me);
            if (idx >= 0) draft.snatchedBy.splice(idx, 1);
          }
        });
      }
      if (destroyed) return;
      uploadedLocally = false;
      localByteSize = null;
      actionState = "remote";
      syncActionButtons();
      positionInfoBar(currentWidth, currentHeight);
      log.debug("file-widget", "local copy freed — blob is remote again");
    }

    /** convert this existing file widget into a peedeeeff widget — same
     *  end state as uploading a pdf directly (see the tauri single-pdf
     *  upload flow above), but starting from an already-uploaded document
     *  file. page rendering happens after mount, via peedeeeff's own
     *  resumeProcessingIfNeeded() (it self-heals whenever blobId is set
     *  but pageBlobIds is empty) — no need to duplicate that here. */
    function handleConvertToPeedeeeff() {
      const state = ctx.doc.current;
      const store = ctx.canvasStore;
      if (!store || store.isLocalViewer()) return;
      if (!state.blobId || !isDocumentFilename(state.filename)) return;

      const selfEntry = store.getWidget(ctx.widgetId);
      if (!selfEntry) return;

      store.addWidget({
        id: crypto.randomUUID(),
        type: "peedeeeff",
        x: selfEntry.x,
        y: selfEntry.y,
        width: Math.max(selfEntry.width, 480),
        height: Math.max(selfEntry.height, 640),
        zIndex: selfEntry.zIndex,
        title: (state.title && state.title.trim()) || state.filename.replace(/\.[^./\\]+$/, ""),
        props: {
          blobId: state.blobId,
          filename: state.filename,
          mime: state.mime,
          blake3: state.blake3 ?? "",
          size: state.size,
          thumbnailDataUrl: state.thumbnailDataUrl ?? "",
        },
        collapsed: false,
        docId: null,
        parentId: null,
      });

      // remove this file widget — the peedeeeff widget replaces it
      store.removeWidget(ctx.widgetId);
    }

    return {
      container,
      // "file type" select only appears while `domain` is unset (fill-in-
      // the-blank for auto-detection misses) — see fileEditableProps().
      get editableProps() {
        return currentEditableProps;
      },
      // property-tray extras: thumbnail override actions (all file types —
      // audio/video/pdf/whatever), "purge local copy" (frees the local
      // OPFS/blobz copy — e.g. to retry a snatch that left a corrupt/0-byte
      // file — without disturbing the widget doc), and who-has-this-file info rows
      widgetActions: [
        { id: "choose-thumbnail", label: "choose thumbnail", onClick: () => void handleChooseThumbnail() },
        { id: "remove-thumbnail", label: "remove thumbnail", onClick: handleRemoveThumbnail },
        ...(ctx.doc.current.blobId && isDocumentFilename(ctx.doc.current.filename)
          ? [
              {
                id: "convert-to-peedeeeff",
                label: "convert to peedeeeff",
                onClick: handleConvertToPeedeeeff,
              },
            ]
          : []),
        {
          id: "purge-local-copy",
          label: "purge local copy",
          onClick: () => {
            void handleFreeUpSpace();
          },
        },
      ],
      widgetInfoRows: () => {
        const state = ctx.doc.current;
        if (!state.blobId) return [];
        const rows: { label: string; value: string }[] = [];
        // local-only stat (not tracked in the automerge doc) — lets a user
        // spot a 0-byte/corrupt local copy left behind by an interrupted
        // snatch, which "purge local copy" + re-snatch repairs.
        if (localByteSize !== null) {
          rows.push({
            label: "local size",
            value:
              localByteSize === 0
                ? "0 B — looks corrupt, try purge local copy"
                : formatFileSize(localByteSize),
          });
        }
        // dedupe: concurrent CRDT inserts of the same node id (e.g. two
        // racing "record myself as a snatcher" writes) can leave the same
        // id in `snatchedBy` more than once.
        const holders = [...new Set((state.snatchedBy ?? []).map(String))];
        if (holders.length === 0) {
          rows.push({ label: "have it", value: "nobody yet" });
          return rows;
        }
        // one row per holder, by username where known (session peer-name
        // registry, fed from the social doc) — node ids only as fallback.
        // hubs are labeled; any number of hubs may have synced it.
        for (const id of holders) {
          const isHub = ctx.canvasStore?.isHubNode(id) ?? false;
          const you = id === localNodeIdCached;
          const name = peerNameFor(id) ?? `${id.slice(0, 12)}...`;
          rows.push({
            label: isHub ? "hub" : "peer",
            value: `${name}${you ? " (you)" : ""}`,
          });
        }
        return rows;
      },
      destroy() {
        if (loadingAbort) {
          loadingAbort.abort();
          loadingAbort = null;
        }
        if (uploadAbort) {
          uploadCancelled = true;
          uploadAbort.abort();
          uploadAbort = null;
        }
        if (snatchAbort) {
          snatchAbort.abort();
          snatchAbort = null;
        }
        if (activeOverlay && !activeOverlay.closed) {
          activeOverlay.close();
          activeOverlay = null;
        }
        if (activePlayer && !activePlayer.closed) {
          activePlayer.close();
          activePlayer = null;
        }
        unsub();
        unsubTransferProgress?.();
        unsubTransferProgress = null;
        destroyed = true;
        unregisterPendingRetry?.();
        unregisterPendingRetry = null;
        destroySprite();
        if (hoverOverlay) {
          hoverOverlay.destroy({ children: true });
          hoverOverlay = null;
        }
        activeGifHover?.remove();
        activeGifHover = null;
        container.destroy({ children: true });
      },
      resize(width: number, height: number) {
        currentWidth = width;
        currentHeight = height;
        drawBg(width, height);
        drawPlaceholderBorder(width, height);
        repositionOverlays(width, height);
        if (activePlayer && !activePlayer.closed) {
          activePlayer.reposition(width, height);
        }
        fitSprite(width, height);
        drawHoverOverlay(width, height);
        drawThumbHitArea(width, height);
        // a stale-sized hover overlay would show the gif at the wrong rect —
        // simplest to drop it; the pointer re-entering redraws it correctly.
        activeGifHover?.remove();
        activeGifHover = null;
        if (loadState === "loaded") {
          syncActionButtons();
          positionInfoBar(width, height);
          if (!hasThumbnail) {
            positionFallbackIcon(width, height);
          }
        }
      },
    };
  },
};
