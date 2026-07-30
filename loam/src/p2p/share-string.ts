// ---------------------------------------------------------------------------
// share string encoding/decoding for P2P canvas sharing.
//
// a share string is a base64-encoded JSON object containing:
// - n: the owner's iroh node ID (64-char hex string)
// - d: the automerge document ID of the canvas
// - t: the canvas's display title, truncated to MAX_TITLE_CHARS (optional —
//   omitted entirely when the canvas has no title yet, to keep the link short)
// - o: the owner's username at share time (optional — omitted when the
//   owner has no username set yet). lets a brand-new invitee's narthex
//   card and pending friend-request row show a real name right away,
//   instead of a bare node id, before any profile info has actually been
//   exchanged with the owner.
// - h: node ids of hubs this canvas has been shared with (optional — omitted
//   when there are none, or when the sharer chose to exclude them)
//
// why hub node ids are in here at all: a hub only ever relays canvas/friend
// activity to peers it's already friends with (see friendz-wiring.ts's
// computeAndSendGossipDigest and docs/knock-and-hub-relay-plan.md) — a hub
// is never a stranger-facing dial target for content the recipient hasn't
// been granted. `h` doesn't change that; it solves a narrower problem: a
// brand-new invitee has no way to *discover* a hub's node id at all unless
// it's handed to them. once discovered, the recipient can send the hub a
// friend request themselves (an explicit, user-visible action — see
// share-dialog.ts) — the hub then auto-accepts if (and only if) the
// invitee's node id is already named in that canvas's `acl`/`pendingInvites`
// (see `docs/hub-and-profile-plan.md` and tumulus's
// `HubPeerService::is_vouched_by_any_canvas`), which only happens because
// the canvas owner already explicitly invited them. this is what lets an
// invite + a hub relationship survive the owner going offline right after
// sending it: the recipient befriends the hub instead, and the hub gossips
// the already-recorded invite (and the canvas itself) to them from there.
//
// a stranger's *knock* (an uninvited access request) still only ever
// reaches the canvas owner directly — knocking never uses `h`, and a knock
// sent straight to a hub is dropped (see docs/knock-and-hub-relay-plan.md).
//
// format: base64({ "n": "<nodeId>", "d": "<docId>", "t": "<title>", "h": [...] })
//
// URL format: #share/<base64>
// ---------------------------------------------------------------------------

import { isTauriMode } from "./tauri-transport";

const TAG = "[skein:share]";

// the real, public web origin — needed because a Tauri webview reports
// `window.location.origin` as the internal `tauri://localhost` scheme,
// which is meaningless to anyone the URL gets shared with.
const PRODUCTION_ORIGIN = "https://skein.freqhole.net";

// keeps the encoded link reasonably short — just enough to tell canvases
// apart in a "syncing..." narthex card, not a full description.
const MAX_TITLE_CHARS = 40;

function truncateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= MAX_TITLE_CHARS) return trimmed;
  return trimmed.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + "\u2026";
}

// plain `btoa`/`atob` only handle Latin1 (one byte per char) — a canvas
// title can contain arbitrary unicode (emoji, accents, non-Latin scripts),
// which `btoa` throws on directly. encode/decode via the title's actual
// UTF-8 bytes instead, so any title round-trips correctly.
function toBase64(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface SharePayload {
  nodeId: string;
  docId: string;
  /** the canvas's display title at share time, truncated — undefined if
   *  the canvas had no title, or the share string predates this field. */
  canvasTitle?: string;
  /** the owner's username at share time — undefined if the owner had no
   *  username set yet, or the share string predates this field. */
  ownerUsername?: string;
  /** node ids of hubs this canvas has been shared with, at share time —
   *  undefined if there were none, or the sharer chose to exclude them
   *  (see share-dialog.ts's "include hub(s)" toggle). lets a brand-new
   *  invitee discover a hub to befriend even while the owner is offline —
   *  see this module's top doc comment for the full rationale. */
  hubNodeIds?: string[];
}

/**
 * encode a share string from a node ID and document ID.
 * returns a base64 string suitable for copying or embedding in a URL.
 *
 * `canvasTitle`, when given and non-empty, is truncated and embedded too —
 * lets the recipient's narthex label the resulting "syncing..." card with
 * the real canvas name instead of a bare docId.
 *
 * `hubNodeIds`, when given and non-empty, is embedded as `h` — see this
 * module's top doc comment for why.
 *
 * `ownerUsername`, when given and non-empty, is embedded as `o` — see the
 * `SharePayload.ownerUsername` doc comment for why. trailing param (rather
 * than inserted before `hubNodeIds`) so existing positional call sites
 * don't need to change.
 */
export function encodeShareString(
  nodeId: string,
  docId: string,
  canvasTitle?: string,
  hubNodeIds?: string[],
  ownerUsername?: string
): string {
  const t = canvasTitle ? truncateTitle(canvasTitle) : "";
  const payload = {
    n: nodeId,
    d: docId,
    ...(t ? { t } : {}),
    ...(hubNodeIds && hubNodeIds.length > 0 ? { h: hubNodeIds } : {}),
    ...(ownerUsername ? { o: ownerUsername } : {}),
  };
  return toBase64(JSON.stringify(payload));
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

    const json = fromBase64(raw);
    const parsed = JSON.parse(json);

    if (
      typeof parsed.n !== "string" ||
      typeof parsed.d !== "string" ||
      !parsed.n ||
      !parsed.d
    ) {
      return null;
    }

    const canvasTitle = typeof parsed.t === "string" && parsed.t ? parsed.t : undefined;
    const ownerUsername = typeof parsed.o === "string" && parsed.o ? parsed.o : undefined;
    const hubNodeIds =
      Array.isArray(parsed.h) && parsed.h.every((id: unknown) => typeof id === "string")
        ? (parsed.h as string[]).filter((id) => id.length > 0)
        : undefined;
    return {
      nodeId: parsed.n,
      docId: parsed.d,
      canvasTitle,
      ownerUsername,
      ...(hubNodeIds && hubNodeIds.length > 0 ? { hubNodeIds } : {}),
    };
  } catch {
    console.warn(TAG, "failed to decode share string:", input.slice(0, 32) + "...");
    return null;
  }
}

/**
 * build a shareable URL fragment for a canvas.
 * returns a string like "#share/<base64>" suitable for window.location.hash.
 */
export function shareFragment(
  nodeId: string,
  docId: string,
  canvasTitle?: string,
  hubNodeIds?: string[],
  ownerUsername?: string
): string {
  return `#share/${encodeShareString(nodeId, docId, canvasTitle, hubNodeIds, ownerUsername)}`;
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
export function buildShareUrl(
  nodeId: string,
  docId: string,
  canvasTitle?: string,
  hubNodeIds?: string[],
  ownerUsername?: string
): string {
  const fragment = shareFragment(nodeId, docId, canvasTitle, hubNodeIds, ownerUsername);
  if (isTauriMode()) {
    return PRODUCTION_ORIGIN + "/" + fragment;
  }
  return window.location.origin + window.location.pathname + fragment;
}
