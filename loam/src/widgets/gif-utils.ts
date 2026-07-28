/**
 * helpers for handling animated gif files without flattening them to a
 * single static frame.
 *
 * `pickImageAsDataUrl`/`resizeImageToDataUrl` (from `@freqhole/reliquary/utils`)
 * always redraw the picked image through an `OffscreenCanvas`, which only
 * ever captures one frame — perfect for avatars/thumbnails, but it silently
 * strips animation from any gif a user picks. these helpers read a gif's raw
 * bytes into a data url instead, so the browser's native gif decoder (not a
 * canvas snapshot) keeps every frame.
 */

import { resizeImageToDataUrl, type PickImageOptions } from "@freqhole/reliquary/utils";

/** true if a File/Blob is a gif, by its reported mime type. */
export function isGifFile(file: File | Blob): boolean {
  return file.type === "image/gif";
}

/** true if a data: URL encodes gif image data. */
export function isGifDataUrl(url: string): boolean {
  return url.startsWith("data:image/gif");
}

/** read a File/Blob's raw bytes as a data url, verbatim (no resize/re-encode). */
export function readFileAsDataUrl(file: File | Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * pick an image file via a native file input, same as `pickImageAsDataUrl`,
 * except a gif is returned as-is (raw bytes, every frame intact) instead of
 * being resized/flattened through a canvas. non-gif files behave exactly
 * like `pickImageAsDataUrl` (resized + re-encoded per `options`).
 */
export async function pickImageOrGifAsDataUrl(
  options?: PickImageOptions
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
      input.addEventListener("cancel", () => resolve(null));
    });

    if (!file) return null;

    if (isGifFile(file)) {
      return await readFileAsDataUrl(file);
    }

    return await resizeImageToDataUrl(file, options);
  } catch {
    return null;
  } finally {
    input.remove();
  }
}
