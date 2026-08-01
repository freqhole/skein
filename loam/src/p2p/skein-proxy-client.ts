// ---------------------------------------------------------------------------
// skein-proxy-client.ts — outbound `skein/1` proxy_request client.
//
// counterpart to skein-handler.ts (which only handles INBOUND streams).
// used by browser peers (who have no native rendering backend) to ask a
// hub or tauri peer to do work on their behalf — currently: render
// document pages and generate real thumbnails.
//
// framing matches skein-handler.ts / tumulus's `protocol::skein_proxy`
// exactly: raw JSON (no length prefix), one request/response pair per
// bidirectional stream, terminated by the sender calling finish() and the
// receiver reading with read_to_end().
// ---------------------------------------------------------------------------

import { log } from "@freqhole/reliquary/utils";

const TAG = "skein.proxy-client";

/** narrow shape of the raw stream methods this client needs — same optional
 *  extension of `BiStreamLike` used by hub-admin-client.ts. */
interface RawBiStream {
  write_raw_and_finish(data: Uint8Array): Promise<void>;
  read_to_end(max_size: number): Promise<Uint8Array>;
  close(): void;
}

/** minimal node shape this client needs — matches `MiddenNodeLike`. */
export interface SkeinProxyNode {
  open_bi(peer_addr: string, alpn: string): Promise<unknown>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let nextRequestId = 1;

export interface ProxyResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * open a fresh `skein/1` stream to `peerNodeId`, send a single
 * `proxy_request`, and return its parsed `proxy_response` body.
 *
 * throws if the stream can't be opened, the peer doesn't respond, or the
 * response can't be parsed as JSON.
 */
export async function sendSkeinProxyRequest(
  node: SkeinProxyNode,
  peerNodeId: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<ProxyResult> {
  const stream = (await node.open_bi(peerNodeId, "skein/1")) as unknown as RawBiStream;

  const id = nextRequestId++;
  const request = {
    type: "proxy_request",
    id,
    method,
    path,
    body: body ? JSON.stringify(body) : null,
  };

  await stream.write_raw_and_finish(encoder.encode(JSON.stringify(request)));
  const responseBytes = await stream.read_to_end(DEFAULT_MAX_RESPONSE_BYTES);
  stream.close();

  const response = JSON.parse(decoder.decode(responseBytes)) as {
    type: string;
    id: number;
    status: number;
    body: string;
  };

  return { status: response.status, body: JSON.parse(response.body) };
}

/**
 * ask a hub/tauri peer to render every page of a document, trying each
 * candidate peer in order (callers should put hub peers first) until one
 * succeeds. returns `null` if no peer could render the document.
 */
export async function requestDocumentPagesFromPeers(
  node: SkeinProxyNode,
  peerNodeIds: string[],
  blake3: string
): Promise<
  | {
      page_blob_id: string;
      page_number: number | null;
      total_pages: number | null;
      blake3: string | null;
      size: number | null;
      mime: string | null;
      filename: string | null;
    }[]
  | null
> {
  for (const peerId of peerNodeIds) {
    try {
      const result = await sendSkeinProxyRequest(node, peerId, "POST", "/api/blobs/document_pages", {
        blake3,
      });
      if (result.status !== 200 || !result.body.success) {
        log.debug(TAG, `document_pages: peer ${peerId.slice(0, 16)}... declined:`, result.body);
        continue;
      }
      const pages = result.body.data;
      if (Array.isArray(pages)) {
        return pages;
      }
    } catch (err) {
      log.debug(TAG, `document_pages: peer ${peerId.slice(0, 16)}... failed:`, err);
    }
  }
  return null;
}
