// offscreen-snapshot.ts — shared headless pixi renderer for generating
// static thumbnail images from widget state, for use as bin compact-card
// thumbnails (CompactInfo.thumbnailUrl) without mounting the full widget.

import { autoDetectRenderer, Rectangle, type Container, type Renderer } from "pixi.js";

const renderers = new Map<string, Promise<Renderer>>();

function rendererKey(width: number, height: number): string {
  return `${width}x${height}`;
}

/** get (or lazily create) a shared offscreen renderer for the given pixel
 *  size. renderers are cached and reused across snapshot calls — creating a
 *  new gpu context per snapshot is wasteful and risks hitting the browser's
 *  concurrent-webgl-context limit. */
function getOffscreenRenderer(width: number, height: number): Promise<Renderer> {
  const key = rendererKey(width, height);
  let existing = renderers.get(key);
  if (!existing) {
    existing = autoDetectRenderer({ width, height, backgroundAlpha: 0, antialias: true });
    renderers.set(key, existing);
  }
  return existing;
}

/**
 * render a pixi container to a data url at the given size, using a shared
 * offscreen renderer. returns null if rendering fails (e.g. no gpu context
 * available in the current environment).
 *
 * an explicit frame covering the full width/height is always passed to
 * extract — without it, pixi's extract computes the capture region from the
 * target's own drawn-content bounding box, which silently crops (and
 * effectively zooms into) any content that doesn't fill the entire
 * width/height, ignoring surrounding empty padding entirely.
 */
export async function renderSnapshot(
  container: Container,
  width: number,
  height: number,
  format: "webp" | "png" = "webp"
): Promise<string | null> {
  try {
    const renderer = await getOffscreenRenderer(width, height);
    return await renderer.extract.base64({
      target: container,
      format,
      frame: new Rectangle(0, 0, width, height),
    });
  } catch {
    return null;
  }
}

/** simple, fast (non-cryptographic) string hash — used to build short
 *  snapshot-cache-key strings from potentially long inputs (e.g. a doodle's
 *  full stroke id list) without bloating the doc with a long stored key. */
export function fnv1aHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
