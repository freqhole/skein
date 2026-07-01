/**
 * shared utilities for picking image files from the user's device
 * and converting them to small WebP data URLs.
 */

import { resizeImageToWebpDataUrl } from "../workers/blob-worker-client";

/**
 * options for picking and resizing an image file.
 */
export interface PickImageOptions {
  /** maximum output width in pixels (default: 200) */
  maxWidth?: number;
  /** maximum output height in pixels (default: 200) */
  maxHeight?: number;
  /** WebP quality 0–1 (default: 0.8) */
  quality?: number;
  /** if true, center-crop to a square before resizing (default: false) */
  cropSquare?: boolean;
}

const DEFAULT_MAX_WIDTH = 200;
const DEFAULT_MAX_HEIGHT = 200;
const DEFAULT_QUALITY = 0.8;

/**
 * open a native file picker for images, resize and encode as a WebP data URL.
 * returns null if the user cancels or an error occurs.
 */
export async function pickImageAsDataUrl(options?: PickImageOptions): Promise<string | null> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";

  document.body.appendChild(input);

  try {
    input.click();

    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener("change", () => {
        resolve(input.files?.[0] ?? null);
      });

      // the `cancel` event is the standard way to detect picker dismissal.
      // it is supported in Chrome 113+ and Firefox 113+.
      // older browsers that don't fire `cancel` will leave this promise pending
      // until the page navigates — acceptable because `pickImageAsDataUrl` is
      // always called in a fire-and-forget context and callers re-enable the
      // trigger on each interaction.
      input.addEventListener("cancel", () => resolve(null));

      // the old window.focus-based cancel detection (setTimeout 300ms) is
      // intentionally removed: it races with Playwright's setFiles() CDP call
      // and causes false cancellations in the e2e test environment.
    });

    if (!file) {
      return null;
    }

    return await resizeImageToDataUrl(file, options);
  } catch {
    return null;
  } finally {
    input.remove();
  }
}

/**
 * resize an image File/Blob to a WebP data URL.
 * useful when you already have the file (e.g. from drag-and-drop).
 *
 * delegates to the blob worker — image decode, resize, WebP encode,
 * and base64 conversion all happen off the main thread. returns null
 * on error.
 */
export async function resizeImageToDataUrl(
  file: Blob,
  options?: PickImageOptions
): Promise<string | null> {
  return resizeImageToWebpDataUrl(file, {
    maxWidth: options?.maxWidth ?? DEFAULT_MAX_WIDTH,
    maxHeight: options?.maxHeight ?? DEFAULT_MAX_HEIGHT,
    quality: options?.quality ?? DEFAULT_QUALITY,
    cropSquare: options?.cropSquare ?? false,
  });
}
