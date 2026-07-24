// ---------------------------------------------------------------------------
// share string encoding/decoding for P2P canvas sharing.
//
// a share string is a base64-encoded JSON object containing:
// - n: the owner's iroh node ID (64-char hex string)
// - d: the automerge document ID of the canvas
//
// format: base64({ "n": "<nodeId>", "d": "<docId>" })
//
// URL format: #share/<base64>
// ---------------------------------------------------------------------------

import { isTauriMode } from "./tauri-transport";

const TAG = "[skein:share]";

// the real, public web origin — needed because a Tauri webview reports
// `window.location.origin` as the internal `tauri://localhost` scheme,
// which is meaningless to anyone the URL gets shared with.
const PRODUCTION_ORIGIN = "https://skein.freqhole.net";

export interface SharePayload {
  nodeId: string;
  docId: string;
}

/**
 * encode a share string from a node ID and document ID.
 * returns a base64 string suitable for copying or embedding in a URL.
 */
export function encodeShareString(nodeId: string, docId: string): string {
  const payload = JSON.stringify({ n: nodeId, d: docId });
  return btoa(payload);
}

/**
 * decode a share string back to a node ID and document ID.
 * returns null if the string is invalid.
 *
 * accepts either:
 * - a raw base64 string
 * - a URL fragment like "#share/<base64>" (strips the prefix)
 * - a full share URL like "https://skein.freqhole.net/#share/<base64>"
 *   (extracts the hash fragment before stripping the prefix)
 */
export function decodeShareString(input: string): SharePayload | null {
  try {
    let raw = input.trim();

    // a full URL (scheme + host) — pull out just its hash fragment first,
    // so a pasted address-bar link works the same as a bare fragment.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      try {
        raw = new URL(raw).hash;
      } catch {
        // not a parseable URL — fall through and try as-is
      }
    }

    // strip URL fragment prefix if present
    if (raw.startsWith("#share/")) {
      raw = raw.slice(7);
    } else if (raw.startsWith("#")) {
      raw = raw.slice(1);
    }
    if (raw.startsWith("share/")) {
      raw = raw.slice(6);
    }

    const json = atob(raw);
    const parsed = JSON.parse(json);

    if (
      typeof parsed.n !== "string" ||
      typeof parsed.d !== "string" ||
      !parsed.n ||
      !parsed.d
    ) {
      return null;
    }

    return { nodeId: parsed.n, docId: parsed.d };
  } catch {
    console.warn(TAG, "failed to decode share string:", input.slice(0, 32) + "...");
    return null;
  }
}

/**
 * build a shareable URL fragment for a canvas.
 * returns a string like "#share/<base64>" suitable for window.location.hash.
 */
export function shareFragment(nodeId: string, docId: string): string {
  return `#share/${encodeShareString(nodeId, docId)}`;
}

/**
 * build a full shareable URL for a canvas, usable outside the current app
 * instance (e.g. pasted into a chat message or another browser).
 *
 * uses the real production web origin in Tauri builds — Tauri's webview
 * reports `window.location.origin` as `tauri://localhost`, which no other
 * device or browser can resolve — and the actual browser origin otherwise,
 * so it keeps working for local dev servers and any subpath deployment.
 */
export function buildShareUrl(nodeId: string, docId: string): string {
  const fragment = shareFragment(nodeId, docId);
  if (isTauriMode()) {
    return PRODUCTION_ORIGIN + "/" + fragment;
  }
  return window.location.origin + window.location.pathname + fragment;
}
