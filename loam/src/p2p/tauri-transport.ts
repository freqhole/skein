/**
 * tauri transport bridge for skein P2P.
 *
 * replaces midden WASM in Tauri builds — routes all P2P operations through
 * the single `skein_dispatch` Tauri command. the Rust side manages iroh
 * streams via handle IDs, using the same 4-byte length-delimited framing
 * as midden.
 *
 * usage:
 *   const node = await TauriStreamNode.create();
 *   const stream = await node.open_bi(peerId, "freqhole-friendz/1");
 *   await stream.write_message(data);
 *   const msg = await stream.read_message();
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BiStreamLike, MiddenStreamNode } from "@freqhole/reliquary/automerge";
import { log } from "@freqhole/reliquary/utils";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (...args: unknown[]) => Promise<unknown> };
  }
}

const TAG = "tauri-transport";

// ---------------------------------------------------------------------------
// tauri bridge helpers
// ---------------------------------------------------------------------------

/** detect if we're running inside a Tauri webview */
export function isTauriMode(): boolean {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";
}

/**
 * invoke the skein_dispatch command on the Rust side.
 */
export async function dispatch(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<any> {
  return invoke("skein_dispatch", { action, payload });
}

/**
 * read the current node id without any side effects — never generates a
 * keypair or binds the iroh endpoint on the Rust side. returns `""` if no
 * identity has been created yet.
 *
 * safe to call on every boot (e.g. to gate identity-dependent UI) — unlike
 * `TauriStreamNode.create()`/`get_node_id`, which is the "ensure" call that
 * lazily generates an identity the first time it's invoked.
 */
export async function checkTauriIdentityStatus(): Promise<string> {
  const result = await dispatch("identity_status");
  return typeof result?.node_id === "string" ? result.node_id : "";
}

// ---------------------------------------------------------------------------
// base64 helpers (browser-native, no dependencies)
// ---------------------------------------------------------------------------

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// TauriBiStream — replaces midden BiStream
// ---------------------------------------------------------------------------

/**
 * a bidirectional QUIC stream backed by a Rust-side handle.
 * all read/write operations are dispatched through the Tauri IPC bridge.
 */
export class TauriBiStream implements BiStreamLike {
  private handle: number;
  private _peerNodeId: string;
  private _alpn: string;
  private closed = false;

  constructor(handle: number, peerNodeId: string, alpn: string) {
    this.handle = handle;
    this._peerNodeId = peerNodeId;
    this._alpn = alpn;
  }

  peer_node_id(): string {
    return this._peerNodeId;
  }

  alpn(): string {
    return this._alpn;
  }

  async write_message(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("stream closed");
    await dispatch("write_message", {
      handle: this.handle,
      data: toBase64(data),
    });
  }

  async read_message(): Promise<Uint8Array | null> {
    if (this.closed) return null;
    const result = await dispatch("read_message", { handle: this.handle });
    if (result.data === null || result.data === undefined) {
      return null;
    }
    return fromBase64(result.data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // fire-and-forget — don't block the caller
    dispatch("close_stream", { handle: this.handle }).catch((err) => {
      log.warn(TAG, "close_stream error (handle", this.handle, "):", err);
    });
  }

  /**
   * raw framing: write all bytes and finish the send side. matches midden's
   * `BiStream::write_raw_and_finish`. used by skein/1 protocol exchanges
   * where the receiver reads to eof rather than length-delimited frames.
   */
  async write_raw_and_finish(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("stream closed");
    await dispatch("write_raw_and_finish", {
      handle: this.handle,
      data: toBase64(data),
    });
  }

  /**
   * raw framing: read until the peer finishes the send side. matches
   * midden's `BiStream::read_to_end`. up to `max_size` bytes will be
   * accepted; the iroh recv stream errors if the peer sends more.
   */
  async read_to_end(max_size: number): Promise<Uint8Array> {
    if (this.closed) return new Uint8Array(0);
    const result = await dispatch("read_to_end", {
      handle: this.handle,
      max_size,
    });
    if (result?.data === null || result?.data === undefined) {
      return new Uint8Array(0);
    }
    return fromBase64(result.data);
  }
}

// ---------------------------------------------------------------------------
// TauriStreamNode — replaces midden MiddenNode
// ---------------------------------------------------------------------------

/**
 * stream node backed by the Tauri app's iroh endpoint.
 * uses the existing federation endpoint managed by grimoire —
 * no separate keypair or endpoint creation needed.
 */
export class TauriStreamNode implements MiddenStreamNode {
  private _nodeId: string;

  private constructor(nodeId: string) {
    this._nodeId = nodeId;
  }

  /**
   * create a TauriStreamNode using the running iroh endpoint's identity.
   *
   * this is the "ensure" call — the Rust side (`commands::ensure_network`)
   * will lazily bind the iroh endpoint (generating a keypair, if this is
   * genuinely the first time) the moment this is invoked. only call this
   * in response to something the user actually asked for (sharing/joining
   * a canvas, starting the hub, clicking "generate identity"), never just
   * to check whether an identity already exists — use
   * `checkTauriIdentityStatus()` for that instead.
   */
  static async create(): Promise<TauriStreamNode> {
    const result = await dispatch("get_node_id");
    log.debug(TAG, "node ID:", result.node_id.slice(0, 16) + "...");
    return new TauriStreamNode(result.node_id);
  }

  node_id(): string {
    return this._nodeId;
  }

  async open_bi(peer_addr: string, alpn: string): Promise<TauriBiStream> {
    const result = await dispatch("open_bi", { peer_addr, alpn });
    log.debug(
      TAG,
      "opened stream to",
      result.peer_node_id.slice(0, 16) + "...",
      "on",
      alpn,
      "(handle:",
      result.handle,
      ")"
    );
    return new TauriBiStream(result.handle, result.peer_node_id, alpn);
  }

  async accept(): Promise<BiStreamLike | null> {
    try {
      log.debug(TAG, "accept(): polling backend for next inbound stream");
      const result = await dispatch("accept_stream");
      if (result.handle === null || result.handle === undefined) {
        // channel closed or not configured — no more incoming streams
        log.debug(TAG, "accept(): backend signalled channel closed");
        return null;
      }
      log.debug(
        TAG,
        "accepted incoming stream from",
        (result.peer_node_id as string).slice(0, 16) + "...",
        "on",
        result.alpn,
        "(handle:",
        result.handle,
        ")"
      );
      return new TauriBiStream(result.handle, result.peer_node_id, result.alpn);
    } catch (err) {
      log.error(TAG, "accept_stream failed:", err);
      return null;
    }
  }

  /**
   * skein/1 ensure_blob exchange: probe a peer to check if they have a blob.
   * dispatches to rust-side `blob_iroh_probe` which performs the whole
   * open_bi + write + finish + read_to_end in a single native call. doing the
   * exchange atomically in rust avoids a multi-IPC-round-trip race when the
   * connection flaps mid-handshake.
   */
  async ensure_blob(peer_addr: string, blake3_hash: string): Promise<boolean> {
    const resp = (await dispatch("blob_iroh_probe", {
      peer_addr,
      blake3: blake3_hash,
    })) as { available?: boolean };
    return resp?.available === true;
  }

  /**
   * iroh-blobs verified download INTO THE NATIVE STORE — dispatches the
   * rust-side `blob_iroh_download`, which streams the blob into the local
   * FsStore and exports it straight to blobz's content-addressed layout.
   * the bytes never cross the IPC boundary (all streaming happens native).
   * playback/serving read the file natively via blob_get_path / asset://.
   *
   * progress reporting: the rust side emits throttled `blob-download-progress`
   * events ({ blake3, bytesDone, totalSize }) which map onto the
   * `on_progress(fraction)` callback here.
   *
   * returns the recorded blob metadata.
   */
  async download_to_native_store(
    peer_addr: string,
    blake3_hash: string,
    total_size: number,
    on_progress?: (fraction: number) => void,
    filename?: string,
    mime?: string
  ): Promise<{ size: number; mime: string | null; filename: string | null }> {
    // listen before dispatching so no early events are missed. events are
    // filtered by blake3 — concurrent downloads of different blobs don't
    // cross-talk (same-blob concurrent downloads share progress, which is
    // fine: they share the underlying transfer too).
    let unlisten: (() => void) | null = null;
    if (on_progress) {
      unlisten = await listen<{ blake3: string; bytesDone: number; totalSize: number }>(
        "blob-download-progress",
        (event) => {
          const p = event.payload;
          if (p?.blake3 !== blake3_hash) return;
          const total = p.totalSize > 0 ? p.totalSize : total_size;
          if (total > 0) {
            on_progress(Math.min(p.bytesDone / total, 1));
          }
        }
      );
    }
    try {
      const resp = (await dispatch("blob_iroh_download", {
        peer_addr,
        blake3: blake3_hash,
        size: total_size > 0 ? total_size : undefined,
        filename: filename || undefined,
        mime: mime || undefined,
      })) as { meta?: { size?: number; mime?: string | null; filename?: string | null } };
      const meta = resp?.meta ?? {};
      return {
        size: typeof meta.size === "number" ? meta.size : 0,
        mime: meta.mime ?? null,
        filename: meta.filename ?? null,
      };
    } catch (err) {
      // rethrow all errors unchanged — deliberate cancellations ("download cancelled")
      // propagate as-is so the caller can string-match without extra wrapping.
      throw err;
    } finally {
      unlisten?.();
    }
  }

  /**
   * signal an in-flight `download_to_native_store` call to stop.
   *
   * sets the cancel flag on the rust side; the download loop exits after
   * its next progress event and returns an error containing "download cancelled".
   * the partial blob remains in the FsStore — re-dispatching `download_to_native_store`
   * later will resume automatically.
   *
   * returns `true` if a download for this hash was in-flight, `false` otherwise.
   */
  async cancel_native_download(blake3: string): Promise<boolean> {
    const resp = (await dispatch("blob_iroh_download_cancel", { blake3 })) as {
      cancelled?: boolean;
    };
    return resp?.cancelled === true;
  }

  /**
   * skein/1 proxy_request exchange: forward an HTTP-style request to a peer
   * and return the `{status, body}` envelope where `body` is the raw response
   * string the peer's handler produced (typically JSON).
   */
  async proxy_request(
    peer_addr: string,
    method: string,
    path: string,
    body: string | null
  ): Promise<{ status: number; body: string }> {
    const stream = await this.open_bi(peer_addr, "skein/1");
    try {
      const req = JSON.stringify({
        type: "proxy_request",
        id: 1,
        method,
        path,
        body,
      });
      await stream.write_raw_and_finish(new TextEncoder().encode(req));
      // blob payloads can be large — allow up to 64MiB for now. the rust
      // side caps reads at this exact size.
      const respBytes = await stream.read_to_end(64 * 1024 * 1024);
      const resp = JSON.parse(new TextDecoder().decode(respBytes)) as {
        type?: string;
        status?: number;
        body?: string;
      };
      return {
        status: typeof resp?.status === "number" ? resp.status : 0,
        body: typeof resp?.body === "string" ? resp.body : "",
      };
    } finally {
      stream.close();
    }
  }
}
