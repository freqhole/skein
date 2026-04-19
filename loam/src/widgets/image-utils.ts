/**
 * shared utilities for picking image files from the user's device
 * and converting them to small WebP data URLs.
 */

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
export async function pickImageAsDataUrl(
  options?: PickImageOptions,
): Promise<string | null> {
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

      // detect cancellation — the input element fires no event on cancel,
      // but a focus event on the window fires shortly after the picker closes.
      const onFocus = () => {
        window.removeEventListener("focus", onFocus);
        // small delay so "change" fires first if a file was picked
        setTimeout(() => resolve(null), 300);
      };
      window.addEventListener("focus", onFocus);
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
  options?: PickImageOptions,
): Promise<string | null> {
  const { resizeImageToWebpDataUrl } = await import("../workers/blob-worker-client");
  return resizeImageToWebpDataUrl(file, {
    maxWidth: options?.maxWidth ?? DEFAULT_MAX_WIDTH,
    maxHeight: options?.maxHeight ?? DEFAULT_MAX_HEIGHT,
    quality: options?.quality ?? DEFAULT_QUALITY,
    cropSquare: options?.cropSquare ?? false,
  });
}
