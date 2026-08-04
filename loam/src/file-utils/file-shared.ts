/**
 * shared types and leaf helpers for the file-widget subsystem (upload,
 * snatch, blob locality, thumbnails, blob i/o). every other module under
 * widgets/{transfer-queue,blob-canvas-refs,thumbnail-utils,document-pages,
 * blob-locality,blob-io,upload,snatch}.ts depends on this file — this file
 * depends on none of them, only external packages.
 */

import { getStoredIdentity } from "../p2p/identity";

const PEER_TIMEOUT_MS = 8000;

/** minimal extension -> mime guesser used when the tauri native file picker
 *  hands us only a path (no mime). intentionally tiny: just covers the file
 *  types the canvas widgets actually render. unknown extensions fall back
 *  to application/octet-stream and the file widget treats them as opaque. */
export function guessMimeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "pdf":
      return "application/pdf";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "m4v":
      return "video/mp4";
    case "flv":
      return "video/x-flv";
    case "wmv":
      return "video/x-ms-wmv";
    case "3gp":
      return "video/3gpp";
    case "3g2":
      return "video/3gpp2";
    case "ts":
    case "mts":
    case "m2ts":
      return "video/mp2t";
    case "mpg":
    case "mpeg":
      return "video/mpeg";
    case "ogv":
      return "video/ogg";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "opus":
      return "audio/opus";
    case "wma":
      return "audio/x-ms-wma";
    case "aiff":
    case "aif":
      return "audio/aiff";
    case "txt":
      return "text/plain";
    case "md":
    case "markdown":
      return "text/markdown";
    case "epub":
      return "application/epub+zip";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "odt":
      return "application/vnd.oasis.opendocument.text";
    case "rtf":
      return "application/rtf";
    case "html":
    case "htm":
      return "text/html";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/** magic-byte sniffing for video containers, used when a blob's mime is
 *  missing/generic (`application/octet-stream` or empty) and the filename
 *  has no (or an unknown) extension to guess from — this happens for
 *  "snatched" (p2p-transferred) video files, since a browser's own `File`
 *  object reports an empty `type` for extensionless files, and that empty
 *  mime is what ends up synced into the widget's automerge doc and
 *  re-used at snatch/download time. without a real mime, `<video>`
 *  elements refuse to play the resulting blob: URL — browsers don't sniff
 *  media container formats themselves the way they sniff e.g. images.
 *  only covers the two container formats skein's own upload paths
 *  actually produce (mp4/mov and webm) — returns null for anything else,
 *  so callers should keep whatever mime they already had in that case. */
export function sniffVideoMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  // webm/mkv: EBML magic number 0x1A45DFA3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }

  // mp4/mov/quicktime: an "ftyp" box at byte offset 4
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return brand.startsWith("qt") ? "video/quicktime" : "video/mp4";
  }

  return null;
}

/** decode a base64 string to a fresh Uint8Array. browser-native, no deps. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** coerce automerge Text objects (or any value) to a plain JS string.
 *  automerge stores strings as Text objects which have toString() but lack
 *  string methods like slice(). wrapping in String() normalizes them. */
export function coerceStr(v: unknown): string {
  // eslint-disable-next-line eqeqeq -- intentional: catches both null and undefined
  if (v == null) return "";
  return String(v);
}

export async function withPeerTimeout<T>(promise: Promise<T>, ms = PEER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("peer timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** result from picking a file */
export interface PickedFile {
  /** file path (Tauri mode only — null in browser mode) */
  path: string | null;
  /** filename with extension */
  filename: string;
  /** file size in bytes (0 when unknown, e.g. Tauri mode before upload) */
  size: number;
  /** the raw File object (browser mode only — null in Tauri mode) */
  file: File | null;
}

/** result from uploading a file */
export interface FileUploadResult {
  blobId: string;
  domain: string;
  jobId: string | null;
  sha256: string;
  blake3: string | null;
  size: number;
  mime: string;
  existing: boolean;
  /** embedded thumbnail data URL (browser-generated or fetched from grimoire) */
  thumbnailDataUrl?: string | null;
}

/** blob locality — whether the blob exists in the local grimoire DB */
export type BlobLocality = "local" | "remote" | "unknown";

/** result from checking blob locality */
export interface BlobLocalityInfo {
  /** whether the blob is in the local grimoire DB */
  locality: BlobLocality;
  /** blob metadata (only present when local) */
  metadata?: {
    id: string;
    mime?: string;
    filename?: string;
    size?: number;
    blake3?: string;
    /** blob-level metadata JSON — check source field for snatch detection */
    blobMetadata?: Record<string, unknown>;
  };
}

/** metadata about a blob needed for snatch operations */
export interface SnatchBlobInfo {
  blobId: string;
  filename: string;
  mime: string;
  size: number;
  blake3: string;
  domain: string;
}

/** options for snatch operations */
export interface SnatchOptions {
  /** called with progress updates during download (0.0 to 1.0, or -1 if total unknown) */
  onProgress?: (fraction: number) => void;
  /** abort signal to cancel an in-progress snatch */
  signal?: AbortSignal;
  /** check whether a peer nodeId is currently connected at the transport level.
   *  when provided, enables parallel probe-then-download: all peers are probed
   *  in parallel, the first responsive peer wins, then download starts from it. */
  isPeerOnline?: (nodeId: string) => boolean;
  /** called when switching to a new peer attempt. useful for UI feedback like
   *  "trying peer 2/3..." between download attempts. */
  onPeerAttempt?: (peerIndex: number, peerCount: number, online: boolean) => void;
  /** opaque id registered with the midden worker for this download — pass the
   *  same id to pauseSnatchDownload() to pause the in-flight transfer. the
   *  partial stays in the persistent store (pinned against gc), so a later
   *  snatch of the same blake3 resumes: only the missing ranges transfer. */
  downloadId?: string;
}

/** options for file upload */
export interface UploadOptions {
  title?: string;
  description?: string;
  metadata?: string;
  /** wait for thumbnail job to complete before returning (default: true) */
  waitForCompletion?: boolean;
  /**
   * incremental progress during upload, 0..1. tauri mode reports the
   * rust-side streaming hash pass (`blob-insert-progress` events); browser
   * mode reports bytes streamed into OPFS for large files (small files
   * complete in one shot and only report 1 at the end).
   */
  onProgress?: (fraction: number) => void;
  /** abort signal — cancels the upload. browser mode aborts the worker
   *  upload session between chunks; tauri mode dispatches
   *  blob_insert_cancel for the in-flight hashing pass. a cancelled upload
   *  rejects with a DOMException AbortError (browser) or an error whose
   *  message contains "upload cancelled" (tauri). */
  signal?: AbortSignal;
}

/** options for thumbnail fetching */
export interface ThumbnailOptions {
  /** thumbnail size in pixels (default: 200) */
  size?: number;
  /** canvas peers to try for P2P fallback — keys are peer IDs, values have nodeId */
  peers?: Record<string, { nodeId: string }>;
  /** center-crop to a square instead of preserving aspect ratio (default: false) */
  square?: boolean;
  /** force generation to treat the blob as this mime instead of whatever's
   *  stored on its record — for a manually-picked domain override (auto-
   *  detection got the mime wrong, so retrying with the SAME mime would
   *  fail identically; this makes local/peer generation actually attempt
   *  the right codepath, e.g. ffmpeg doesn't care about the mime label,
   *  only real file bytes). */
  mimeOverride?: string;
}

/** peers map type — extracted for reuse across functions */
export type PeersMap = Record<string, { nodeId: string }>;

// ---------------------------------------------------------------------------
// peer node ID helper (cached)
// ---------------------------------------------------------------------------

let _cachedLocalNodeId: string | null | undefined = undefined;

export async function getLocalNodeId(): Promise<string | null> {
  if (_cachedLocalNodeId !== undefined) return _cachedLocalNodeId;
  try {
    const identity = await getStoredIdentity();
    _cachedLocalNodeId = identity?.node_id ?? null;
  } catch {
    _cachedLocalNodeId = null;
  }
  return _cachedLocalNodeId;
}

/** extract peer node IDs from the peers map, filtering out the local node */
export async function getPeerNodeIds(
  peers: PeersMap | Record<string, { nodeId: string }>
): Promise<string[]> {
  const localNodeId = await getLocalNodeId();
  return Object.values(peers)
    .map((p) => String(p.nodeId))
    .filter((id): id is string => Boolean(id) && id !== localNodeId);
}
