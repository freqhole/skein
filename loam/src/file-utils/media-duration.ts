/**
 * best-effort media duration probe for audio/video blobs — used by
 * `file.ts` right after upload so a generic `file` widget's `duration`
 * field is populated the same way `audio-recording.ts`/`voice-
 * recording.ts`/`tts` already track their own recording length. non-fatal:
 * resolves to 0 on any failure (missing metadata, network error, or a
 * safety timeout for a stalled stream) rather than throwing — a widget
 * with `duration: 0` just isn't capturable as an animaniac segment yet
 * (see `widgets/animaniac/frame-capture.ts`), it doesn't otherwise break.
 */

const PROBE_TIMEOUT_MS = 8000;

/** @param domain only "audio"/"video" are probed — anything else resolves
 *  to 0 immediately (no point creating a media element for a photo/document). */
export function probeMediaDuration(url: string, domain: string): Promise<number> {
  if (domain !== "audio" && domain !== "video") return Promise.resolve(0);

  return new Promise((resolve) => {
    const el = document.createElement(domain === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.muted = true;

    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const finish = (duration: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("error", onError);
      el.src = "";
      resolve(duration);
    };
    const onLoaded = () => finish(Number.isFinite(el.duration) ? el.duration : 0);
    const onError = () => finish(0);

    el.addEventListener("loadedmetadata", onLoaded, { once: true });
    el.addEventListener("error", onError, { once: true });
    el.src = url;
    timeoutHandle = setTimeout(() => finish(0), PROBE_TIMEOUT_MS);
  });
}
