/**
 * file picking + uploading. supports two runtime modes: Tauri mode (native
 * file dialogs + IPC invoke for uploads) and browser mode (hidden <input>
 * file picker; upload requires Tauri). also classifies picked files by
 * extension so multi-file drops can route text/markdown/document files to
 * the right widget type. depends on file-shared.ts and transfer-queue.ts
 * (upload slot gating) among the new widget files.
 */

import { log } from "@freqhole/reliquary/utils";
import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { classifyDomain, storeBlobFromFile, getBlobDomain } from "../storage/blob-store";
import {
  guessMimeFromFilename,
  base64ToBytes,
  type PickedFile,
  type FileUploadResult,
  type UploadOptions,
} from "./file-shared";
import { generateThumbnailDataUrl } from "./thumbnail-utils";
import { acquireUploadSlot, releaseUploadSlot } from "./transfer-queue";
import { formatFileSize } from "../widgets/format";

const TAG = "widgets.upload";

// ---------------------------------------------------------------------------
// pickFiles
// ---------------------------------------------------------------------------

/**
 * pick multiple files via the native file picker.
 * returns an array of picked files, or an empty array on cancel.
 */
export async function pickFiles(): Promise<PickedFile[]> {
  if (isTauriMode()) {
    return pickFilesTauri();
  }
  return pickFilesBrowser();
}

/** extensions the peedeeeff widget can rasterize directly via magick+gs —
 *  kept in sync with `pickDocumentFile`'s dialog filter/accept list below.
 *  always available in tauri mode (gated separately at boot by
 *  `pdf_check_available`, which hides the whole widget if magick/gs are
 *  missing) and always offered in browser mode (rendering is delegated to
 *  a hub/tauri peer regardless — see document-pages.ts's `getDocumentPages`).
 *  plain text is NOT in this set — see `PLAIN_TEXT_EXTENSIONS` below, which
 *  routes those to a notepad widget instead of rasterization. */
const DOCUMENT_EXTENSIONS = new Set(["pdf", "ps", "eps"]);

/** extensions routed to a `notepad` widget (raw text dropped straight into
 *  its `text` field) instead of the peedeeeff rasterization pipeline — a
 *  per-page magick `caption:` render used to be used for these, but that
 *  meant one subprocess invocation per ~54 lines, which could take minutes
 *  for a large file for no real benefit over just... showing the text. */
const PLAIN_TEXT_EXTENSIONS = new Set(["txt", "rtf", "log", "csv", "tsv", "json", "xml", "yaml", "yml"]);

/**
 * true if `filename`'s extension should be routed to a notepad widget
 * (raw text, no rasterization) during multi-file-upload document routing.
 */
export function isPlainTextFilename(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return !!ext && PLAIN_TEXT_EXTENSIONS.has(ext);
}

/**
 * read a picked file's full contents as a utf-8 string — used to seed a
 * notepad widget's initial text for a plain-text file pick/drop. in
 * browser mode reads the `File` object directly; in tauri mode dispatches
 * to rust's `read_text_file` (the file only ever has a `path`, never a
 * `File`, in that mode).
 */
export async function readPickedFileText(picked: PickedFile): Promise<string> {
  if (picked.file) {
    return await picked.file.text();
  }
  if (picked.path) {
    const result = (await dispatch("read_text_file", { path: picked.path })) as { text: string };
    return result.text;
  }
  throw new Error("readPickedFileText: no file content available (no path or File)");
}

/** extensions routed to the `markdown` widget (raw markdown dropped
 *  straight into its `text` field, rendered natively) instead of the
 *  pandoc+peedeeeff rasterization pipeline. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/**
 * true if `filename`'s extension should be routed to a markdown widget
 * during multi-file-upload document routing.
 */
export function isMarkdownFilename(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return !!ext && MARKDOWN_EXTENSIONS.has(ext);
}

/** additional formats rasterizable only when `pandoc` + `typst` are both
 *  available (converted to pdf first, then rasterized via the same
 *  magick+gs pipeline as a native pdf — see tauri's `pdf.rs`). gated by
 *  `pandocFormatsAvailable` in tauri mode (probed at boot, see boot.ts's
 *  `pandoc_check_available` dispatch); always offered in browser mode,
 *  since rendering there is always delegated to a peer anyway. */
const PANDOC_DOCUMENT_EXTENSIONS = new Set([
  "epub",
  "docx",
  "odt",
  "html",
  "htm",
]);

/** whether the local tauri host has `pandoc` + `typst` available — set once
 *  at boot (see boot.ts) via a `pandoc_check_available` dispatch. defaults
 *  to `true` so browser mode (which never calls the setter, since it has no
 *  local backend to probe and always delegates rendering to a peer instead)
 *  offers the broader format list unconditionally. */
let pandocFormatsAvailable = true;

/** set from boot.ts once the local `pandoc_check_available` capability
 *  probe resolves (tauri mode only). */
export function setPandocFormatsAvailable(available: boolean): void {
  pandocFormatsAvailable = available;
}

/**
 * true if `filename`'s extension matches a format the peedeeeff widget can
 * rasterize (pdf, postscript, and — when pandoc+typst are available —
 * epub/docx/odt/html). used to route document files to an
 * auto-created peedeeeff widget during multi-file uploads.
 */
export function isDocumentFilename(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return false;
  if (DOCUMENT_EXTENSIONS.has(ext)) return true;
  return pandocFormatsAvailable && PANDOC_DOCUMENT_EXTENSIONS.has(ext);
}

/**
 * open a file picker filtered to document formats the peedeeeff widget can
 * rasterize: pdf, postscript (ps/eps), and — when pandoc+typst are
 * available — epub/docx/odt/html (converted to pdf first). in
 * Tauri mode, uses the native dialog with an extension filter. in browser
 * mode, uses a hidden input with a matching `accept` list. returns null if
 * the user cancels.
 */
export async function pickDocumentFile(): Promise<PickedFile | null> {
  if (isTauriMode()) {
    return pickDocumentFileTauri();
  }
  return pickDocumentFileBrowser();
}

function documentPickerExtensions(): string[] {
  const extensions = [...DOCUMENT_EXTENSIONS];
  if (pandocFormatsAvailable) {
    extensions.push(...PANDOC_DOCUMENT_EXTENSIONS);
  }
  return extensions;
}

async function pickDocumentFileTauri(): Promise<PickedFile | null> {
  try {
    const result = await open({
      multiple: false,
      filters: [{ name: "documents", extensions: documentPickerExtensions() }],
    });

    if (result === null) return null;

    const filePath = Array.isArray(result) ? result[0] : result;
    if (!filePath) return null;

    const filename = filePath.split(/[\\/]/).pop() ?? filePath;

    return {
      path: filePath,
      filename,
      size: 0,
      file: null,
    };
  } catch (err) {
    log.error(TAG, "document file picker failed:", err);
    return null;
  }
}

async function pickDocumentFileBrowser(): Promise<PickedFile | null> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = documentPickerExtensions()
    .map((ext) => `.${ext}`)
    .join(",");
  input.style.display = "none";

  document.body.appendChild(input);

  try {
    input.click();

    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener("change", () => {
        resolve(input.files?.[0] ?? null);
      });

      const onFocus = () => {
        window.removeEventListener("focus", onFocus);
        setTimeout(() => resolve(null), 300);
      };
      window.addEventListener("focus", onFocus);
    });

    if (!file) return null;

    return {
      path: null,
      filename: file.name,
      size: file.size,
      file,
    };
  } catch (err) {
    log.error(TAG, "browser PDF file picker failed:", err);
    return null;
  } finally {
    input.remove();
  }
}

/**
 * pick one or more `.json` files at once — used by stfu's "load reference
 * data..." action so a diarization + transcript (+ combined) file can all be
 * grabbed in a single dialog instead of one at a time. returns [] on cancel.
 */
export async function pickJsonFiles(): Promise<PickedFile[]> {
  if (isTauriMode()) {
    return pickJsonFilesTauri();
  }
  return pickJsonFilesBrowser();
}

async function pickJsonFilesTauri(): Promise<PickedFile[]> {
  try {
    const result = await open({
      multiple: true,
      filters: [{ name: "json", extensions: ["json"] }],
    });

    if (result === null) return [];

    const paths = Array.isArray(result) ? result : [result];
    return paths
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((filePath) => ({
        path: filePath,
        filename: filePath.split(/[\\/]/).pop() ?? filePath,
        size: 0,
        file: null,
      }));
  } catch (err) {
    log.error(TAG, "multi json file picker failed:", err);
    return [];
  }
}

async function pickJsonFilesBrowser(): Promise<PickedFile[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.multiple = true;
  input.style.display = "none";

  document.body.appendChild(input);

  try {
    input.click();

    const files = await new Promise<FileList | null>((resolve) => {
      input.addEventListener("change", () => {
        resolve(input.files);
      });

      const onFocus = () => {
        window.removeEventListener("focus", onFocus);
        setTimeout(() => resolve(null), 300);
      };
      window.addEventListener("focus", onFocus);
    });

    if (!files || files.length === 0) return [];

    return Array.from(files).map((file) => ({
      path: null,
      filename: file.name,
      size: file.size,
      file,
    }));
  } catch (err) {
    log.error(TAG, "browser multi json file picker failed:", err);
    return [];
  } finally {
    input.remove();
  }
}

/**
 * pick an entire directory and return every `.json` file directly inside it
 * (non-recursive), plus every file inside any `*_speaker_samples/`
 * subdirectory (`process.py`'s per-speaker sample clips + thumbnails) --
 * used by stfu's "load project folder..." action to bulk-load a whole
 * trek-minus-paris project folder in one go, instead of picking each file
 * by hand. returns empty arrays if the user cancels or the folder has
 * neither.
 */
export interface PickedReferenceDirectory {
  jsonFiles: PickedFile[];
  sampleFiles: PickedFile[];
}

const SPEAKER_SAMPLES_DIR_RE = /_speaker_samples[\\/]/;

export async function pickReferenceDirectory(): Promise<PickedReferenceDirectory> {
  if (isTauriMode()) {
    return pickReferenceDirectoryTauri();
  }
  return pickReferenceDirectoryBrowser();
}

async function pickReferenceDirectoryTauri(): Promise<PickedReferenceDirectory> {
  try {
    const result = await open({ directory: true, multiple: false });
    if (result === null) return { jsonFiles: [], sampleFiles: [] };

    const dirPath = Array.isArray(result) ? result[0] : result;
    if (!dirPath) return { jsonFiles: [], sampleFiles: [] };

    const [{ files: jsonEntries }, { files: sampleEntries }] = await Promise.all([
      dispatch("list_json_files_in_dir", { path: dirPath }) as Promise<{
        files: { path: string; filename: string }[];
      }>,
      dispatch("list_speaker_samples", { path: dirPath }) as Promise<{
        files: { path: string; filename: string }[];
      }>,
    ]);
    return {
      jsonFiles: jsonEntries.map((f) => ({ path: f.path, filename: f.filename, size: 0, file: null })),
      sampleFiles: sampleEntries.map((f) => ({ path: f.path, filename: f.filename, size: 0, file: null })),
    };
  } catch (err) {
    log.error(TAG, "reference directory picker failed:", err);
    return { jsonFiles: [], sampleFiles: [] };
  }
}

async function pickReferenceDirectoryBrowser(): Promise<PickedReferenceDirectory> {
  const input = document.createElement("input");
  input.type = "file";
  // non-standard, but supported by every major browser — lets the user pick
  // a whole folder instead of individual files. recurses into
  // subdirectories (e.g. `*_speaker_samples/`), exposing each file's
  // relative path via `webkitRelativePath`.
  input.webkitdirectory = true;
  input.style.display = "none";

  document.body.appendChild(input);

  try {
    input.click();

    const files = await new Promise<FileList | null>((resolve) => {
      input.addEventListener("change", () => {
        resolve(input.files);
      });

      const onFocus = () => {
        window.removeEventListener("focus", onFocus);
        setTimeout(() => resolve(null), 300);
      };
      window.addEventListener("focus", onFocus);
    });

    if (!files || files.length === 0) return { jsonFiles: [], sampleFiles: [] };

    const jsonFiles: PickedFile[] = [];
    const sampleFiles: PickedFile[] = [];
    for (const file of Array.from(files)) {
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (file.name.toLowerCase().endsWith(".json")) {
        jsonFiles.push({ path: null, filename: file.name, size: file.size, file });
      } else if (SPEAKER_SAMPLES_DIR_RE.test(relPath)) {
        sampleFiles.push({ path: null, filename: file.name, size: file.size, file });
      }
    }
    return { jsonFiles, sampleFiles };
  } catch (err) {
    log.error(TAG, "browser directory picker failed:", err);
    return { jsonFiles: [], sampleFiles: [] };
  } finally {
    input.remove();
  }
}

/** Tauri-mode multi-file picker — uses @tauri-apps/plugin-dialog with multiple: true */
async function pickFilesTauri(): Promise<PickedFile[]> {
  try {
    const result = await open({ multiple: true });

    if (result === null) {
      return [];
    }

    // open() with multiple:true returns string[] | null
    const paths = Array.isArray(result) ? result : [result];
    return paths
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((filePath) => ({
        path: filePath,
        filename: filePath.split(/[\\/]/).pop() ?? filePath,
        size: 0,
        file: null,
      }));
  } catch (err) {
    log.error(TAG, "native multi-file picker failed:", err);
    return [];
  }
}

/** browser-mode multi-file picker — uses a hidden <input type="file" multiple> */
async function pickFilesBrowser(): Promise<PickedFile[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";

  document.body.appendChild(input);

  try {
    input.click();

    const files = await new Promise<FileList | null>((resolve) => {
      input.addEventListener("change", () => {
        resolve(input.files);
      });

      const onFocus = () => {
        window.removeEventListener("focus", onFocus);
        setTimeout(() => resolve(null), 300);
      };
      window.addEventListener("focus", onFocus);
    });

    if (!files || files.length === 0) {
      return [];
    }

    return Array.from(files).map((file) => ({
      path: null,
      filename: file.name,
      size: file.size,
      file,
    }));
  } catch (err) {
    log.error(TAG, "browser multi-file picker failed:", err);
    return [];
  } finally {
    input.remove();
  }
}

// ---------------------------------------------------------------------------
// formatUploadError
// ---------------------------------------------------------------------------

/**
 * turn an upload failure (a plain string from a rejected tauri `dispatch()`
 * call, an Error, or anything else) into a short, user-facing message.
 * widgets have very little room for text, so this stays terse (~60 chars)
 * rather than surfacing the full rust error chain.
 */
export function formatUploadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("no space left") || lower.includes("enospc")) {
    return "upload failed: not enough disk space";
  }
  if (lower.includes("permission denied") || lower.includes("eacces")) {
    return "upload failed: permission denied";
  }
  if (
    lower.includes("no such file or directory") ||
    lower.includes("enoent")
  ) {
    return "upload failed: file not found (moved or deleted?)";
  }
  if (lower.includes("must be an absolute path")) {
    return "upload failed: invalid file path";
  }

  const trimmed = raw.trim();
  if (!trimmed) return "upload failed";
  return trimmed.length > 60
    ? `upload failed: ${trimmed.slice(0, 57)}...`
    : `upload failed: ${trimmed}`;
}

// ---------------------------------------------------------------------------
// uploadFile
// ---------------------------------------------------------------------------

/**
 * upload a picked file to grimoire via the ingest pipeline.
 * in Tauri mode, passes the file path directly (no data copy needed).
 * in browser mode, reads the file as base64 and sends the data.
 *
 * NOTE: upload currently requires Tauri mode. browser-only upload will
 * be supported once an HTTP fallback is implemented.
 */
export async function uploadFile(
  picked: PickedFile,
  options?: UploadOptions
): Promise<FileUploadResult> {
  // wrap the caller's signal (if any) in our own controller so this
  // upload stays cancellable via cancelPendingTransfer(id) even when the
  // caller never passed a signal of its own — see transfer-queue.ts's
  // controller registry (used by the filez widget's cancel button).
  const controller = new AbortController();
  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      const callerSignal = options.signal;
      callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), {
        once: true,
      });
    }
  }
  const effectiveOptions: UploadOptions = { ...(options ?? {}), signal: controller.signal };

  // every upload call site funnels through here — gating it is enough to
  // cap upload concurrency app-wide without touching every call site.
  const slotId = await acquireUploadSlot(controller.signal, {
    filename: picked.filename,
    controller,
  });
  try {
    return await uploadFileUnqueued(picked, effectiveOptions);
  } finally {
    releaseUploadSlot(slotId);
  }
}

async function uploadFileUnqueued(
  picked: PickedFile,
  options?: UploadOptions
): Promise<FileUploadResult> {
  if (!isTauriMode()) {
    if (!picked.file) {
      throw new Error("no File object available in browser mode");
    }

    const domain = classifyDomain(picked.file.type || "application/octet-stream");
    const record = await storeBlobFromFile(
      picked.file,
      { metadata: { domain } },
      {
        onProgress: options?.onProgress,
        signal: options?.signal,
      }
    );

    if (options?.signal?.aborted) {
      throw new DOMException("upload cancelled", "AbortError");
    }

    // generate browser-side thumbnail for images
    let thumbnailDataUrl: string | null = null;
    if (picked.file) {
      thumbnailDataUrl = await generateThumbnailDataUrl(picked.file);
    }

    return {
      blobId: record.blob_id,
      domain: getBlobDomain(record),
      jobId: null,
      sha256: record.sha256 ?? "",
      blake3: record.blake3 || "",
      size: record.size,
      mime: record.mime,
      existing: false,
      thumbnailDataUrl,
    };
  }

  // ---- tauri mode --------------------------------------------------------
  // routes the file through rust's `blobz::Store::register_path()`, which
  // streams it through blake3 in fixed-size chunks and registers it as an
  // "external" reference (the file stays exactly where the native picker
  // found it) — never loads the whole file into memory, unlike the old
  // read-the-whole-file-then-base64-round-trip path this replaced (see
  // docs/narthex-widgets-and-file-transfer-plan.md section 7 for the full
  // "three copies of a multi-gigabyte file in memory" root-cause writeup).
  //
  // no OPFS/IndexedDB mirror here — tauri never reads blobs back through
  // the browser blob-store (media playback, locality checks, and preview
  // data all go through rust dispatch calls like `blob_get_path`/`blob_get`,
  // see blob-io.ts's getLocalBlobUrl()/getMediaPlaybackUrl()/blob-locality.ts's
  // checkBlobLocality()), and the browser blob worker's blake3 hasher has
  // no midden module to hash with in a tauri build (it always degrades to
  // an empty string), so a mirror write here was keyed under a bogus id
  // and, once OPFS started rejecting empty names outright, threw and
  // failed the whole upload even though rust had already stored the blob
  // successfully.

  if (!picked.path) {
    throw new Error("tauri uploadFile requires picked.path");
  }

  const mime = guessMimeFromFilename(picked.filename);
  const uploadId = crypto.randomUUID();

  // wire cancellation: flag the rust-side hashing pass by upload id. the
  // dispatch rejects with "upload cancelled" in its message when the flag
  // lands before the pass finishes.
  let onAbort: (() => void) | null = null;
  if (options?.signal) {
    onAbort = () => {
      void dispatch("blob_insert_cancel", { upload_id: uploadId }).catch((err) => {
        log.debug(TAG, "blob_insert_cancel dispatch failed (non-fatal):", err);
      });
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let unlisten: (() => void) | null = null;
  if (options?.onProgress) {
    const onProgress = options.onProgress;
    try {
      unlisten = await listen<{ uploadId: string; bytesRead: number; total: number }>(
        "blob-insert-progress",
        (event) => {
          if (event.payload.uploadId !== uploadId) return;
          if (event.payload.total <= 0) return;
          onProgress(Math.min(1, event.payload.bytesRead / event.payload.total));
        }
      );
    } catch (err) {
      // progress is a nice-to-have — a failure to subscribe must not block
      // the actual upload.
      log.debug(TAG, "failed to subscribe to blob-insert-progress:", err);
    }
  }

  let response: {
    meta: {
      blake3: string;
      iroh_hash: string;
      filename: string | null;
      mime: string | null;
      size: number;
      created_at: number;
    };
    data: string | null;
  };
  try {
    response = (await dispatch("blob_insert_from_path", {
      local_path: picked.path,
      filename: picked.filename,
      mime,
      upload_id: uploadId,
    })) as typeof response;
  } catch (err) {
    if (options?.signal?.aborted) {
      throw new DOMException("upload cancelled", "AbortError");
    }
    throw new Error(formatUploadError(err));
  } finally {
    unlisten?.();
    if (onAbort && options?.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  const meta = response.meta;
  const resolvedMime = meta.mime || mime;
  const domain = classifyDomain(resolvedMime);

  let thumbnailDataUrl: string | null = null;

  if (response.data !== null) {
    const bytes = base64ToBytes(response.data);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;

    // generate a thumbnail data url for images so the widget can paint
    // immediately without a follow-up fetch.
    if (resolvedMime.startsWith("image/")) {
      try {
        const blob = new Blob([new Uint8Array(buffer)], { type: resolvedMime });
        thumbnailDataUrl = await generateThumbnailDataUrl(blob);
      } catch (err) {
        log.debug(TAG, "tauri thumbnail generation failed:", err);
      }
    }
  } else {
    log.debug(
      TAG,
      `blob ${meta.blake3.slice(0, 8)}... (${formatFileSize(meta.size)}) exceeded the mirror-to-browser-storage threshold — staying rust-only`
    );
  }

  return {
    blobId: meta.blake3,
    domain,
    jobId: null,
    sha256: "",
    blake3: meta.blake3,
    size: meta.size,
    mime: resolvedMime,
    existing: false,
    thumbnailDataUrl,
  };
}
