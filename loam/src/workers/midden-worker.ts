// midden-worker — hosts the whole MiddenNode (iroh endpoint, protocols,
// blob store) inside a dedicated worker. see docs/midden-worker-design.md.
//
// architecture: comlink-exposed module, mirroring blob-worker.ts (including
// the ready-signal handshake). stateful wasm objects (BiStream,
// ImportSession) never cross the boundary — they live here in id-keyed
// registries and the api is flat functions over those ids. the main-thread
// wrapper classes in midden-worker-client.ts reconstruct the object
// interfaces call sites expect.
//
// this is what makes the OPFS blob store usable at all:
// FileSystemSyncAccessHandle only exists in dedicated workers, and the
// store, endpoint, and protocols must share one wasm instance.

import * as Comlink from "comlink";
import { CancelToken, MiddenNode, MiddenNodeOptions } from "@freqhole/midden";
import { MIDDEN_WORKER_READY_MESSAGE } from "@freqhole/reliquary/worker";

let node: MiddenNode | null = null;

function requireNode(): MiddenNode {
  if (!node) throw new Error("midden-worker: node not initialized");
  return node;
}

// ---- stream registry -------------------------------------------------------

/** minimal structural view of midden's BiStream (kept local, like the
 *  main-thread BiStreamLike, to avoid depending on generated d.ts). */
interface WasmBiStream {
  peer_node_id(): string;
  alpn(): string;
  read_message(): Promise<Uint8Array | null | undefined>;
  write_message(data: Uint8Array): Promise<void>;
  read_to_end(max_size: number): Promise<Uint8Array>;
  write_raw_and_finish(data: Uint8Array): Promise<void>;
  close(): void;
}

interface WasmImportSession {
  push(chunk: Uint8Array): Promise<void>;
  finish(): Promise<string>;
  abort(): void;
}

export interface StreamInfo {
  streamId: number;
  peerNodeId: string;
  alpn: string;
}

const streams = new Map<number, WasmBiStream>();
let nextStreamId = 1;

const sessions = new Map<number, WasmImportSession>();
let nextSessionId = 1;

// ---- download cancel registry ----------------------------------------------

// pause/cancel for in-flight verified downloads. keyed by a caller-supplied
// download id (the client generates one per download call). the wasm call
// consumes a clone of the token; the original stays here so downloadCancel
// can flip it, and is freed when the download settles.
const cancelTokens = new Map<string, CancelToken>();

function registerCancelToken(downloadId: string): CancelToken {
  const token = new CancelToken();
  cancelTokens.set(downloadId, token);
  return token;
}

function releaseCancelToken(downloadId: string, token: CancelToken): void {
  cancelTokens.delete(downloadId);
  token.free();
}

function registerStream(stream: WasmBiStream): StreamInfo {
  const streamId = nextStreamId++;
  streams.set(streamId, stream);
  return { streamId, peerNodeId: stream.peer_node_id(), alpn: stream.alpn() };
}

function requireStream(streamId: number): WasmBiStream {
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`midden-worker: unknown stream ${streamId}`);
  return stream;
}

// ---- node lifecycle --------------------------------------------------------

/** directory name for the persistent OPFS blob store. */
const OPFS_STORE_DIR = "midden-blob-store";

/** web lock name guarding single-tab ownership of the OPFS store. */
const STORE_LOCK_NAME = "skein-midden-blob-store";

/** skein's own protocol ALPNs, registered alongside the package's default
 *  set: blob proxying/small stream requests, and the shared friendz
 *  protocol (`@freqhole/haruspex/protocol`'s `freqhole-friendz/1`, not a
 *  skein-specific one - see `p2p/iroh-network-adapter.ts`'s `FRIENDZ_ALPN`). */
const SKEIN_ALPN = "skein/1";
const FRIENDZ_ALPN = "freqhole-friendz/1";

/** resolves when we know whether this worker owns the store lock. the lock
 *  (when granted) is held for the worker's lifetime via a never-resolving
 *  promise — worker termination releases it automatically. */
async function acquireStoreLock(): Promise<boolean> {
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) return false;
  return new Promise<boolean>((resolve) => {
    void locks
      .request(STORE_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        // hold the lock until the worker dies
        await new Promise<never>(() => {});
      })
      .catch(() => resolve(false));
  });
}

/**
 * create the MiddenNode (restoring from a persisted secret key when given).
 * returns the identity material so the main thread can cache the sync
 * getters (node_id/secret_key) and persist a fresh identity.
 *
 * blob persistence: when this worker wins the store web-lock (single-tab
 * ownership, v1 policy), the node gets the persistent OPFS-backed blob
 * store; otherwise (second tab) it degrades gracefully to the in-memory
 * store. a best-effort `navigator.storage.persist()` asks the browser not
 * to evict the origin's storage under pressure.
 */
async function init(
  secretKey: Uint8Array | null
): Promise<{ nodeId: string; secretKey: Uint8Array }> {
  if (node) throw new Error("midden-worker: already initialized");

  const ownsStore = await acquireStoreLock();
  if (ownsStore) {
    // best-effort durability request; result is advisory
    void navigator.storage?.persist?.().catch(() => {});
  } else {
    console.warn(
      "[midden-worker] store lock unavailable (another tab owns it) — using in-memory blob store"
    );
  }
  const storeDir = ownsStore ? OPFS_STORE_DIR : undefined;

  const options = new MiddenNodeOptions();
  options.secret_key = secretKey ?? undefined;
  options.opfs_store_dir = storeDir;
  options.extra_alpns = [SKEIN_ALPN, FRIENDZ_ALPN];

  node = await MiddenNode.create_with_options(options);
  const sk = node.secret_key();
  return { nodeId: node.node_id(), secretKey: Comlink.transfer(sk, [sk.buffer as ArrayBuffer]) };
}

// ---- streams ---------------------------------------------------------------

async function openBi(peerAddr: string, alpn: string): Promise<StreamInfo> {
  const stream = (await requireNode().open_bi(peerAddr, alpn)) as unknown as WasmBiStream;
  return registerStream(stream);
}

/** long-poll: resolves with the next accepted stream, or null when the
 *  endpoint closes. */
async function accept(): Promise<StreamInfo | null> {
  const stream = (await requireNode().accept()) as unknown as WasmBiStream | null;
  if (!stream) return null;
  return registerStream(stream);
}

async function streamReadMessage(streamId: number): Promise<Uint8Array | null> {
  const result = await requireStream(streamId).read_message();
  if (result === null || result === undefined) return null;
  return Comlink.transfer(result, [result.buffer as ArrayBuffer]);
}

async function streamWriteMessage(streamId: number, bytes: Uint8Array): Promise<void> {
  await requireStream(streamId).write_message(bytes);
}

async function streamReadToEnd(streamId: number, maxSize: number): Promise<Uint8Array> {
  const result = await requireStream(streamId).read_to_end(maxSize);
  return Comlink.transfer(result, [result.buffer as ArrayBuffer]);
}

async function streamWriteRawAndFinish(streamId: number, bytes: Uint8Array): Promise<void> {
  await requireStream(streamId).write_raw_and_finish(bytes);
}

function streamClose(streamId: number): void {
  const stream = streams.get(streamId);
  if (!stream) return; // already closed/dead — close is idempotent
  streams.delete(streamId);
  try {
    stream.close();
  } catch {
    // stream already dead
  }
}

// ---- blob store ------------------------------------------------------------

async function importBlob(data: Uint8Array): Promise<string> {
  return requireNode().import_blob(data);
}

async function importBlobAndExportBao(
  data: Uint8Array
): Promise<{ hash: string; bao: Uint8Array }> {
  const result = await requireNode().import_blob_and_export_bao(data);
  const bao = result.bao as Uint8Array;
  return Comlink.transfer({ hash: result.hash as string, bao }, [bao.buffer as ArrayBuffer]);
}

async function importBao(blake3Hash: string, baoData: Uint8Array): Promise<string> {
  return requireNode().import_bao(blake3Hash, baoData);
}

function hasActiveBlob(blake3Hash: string): boolean {
  return requireNode().has_active_blob(blake3Hash);
}

async function hasCompleteBlob(blake3Hash: string): Promise<boolean> {
  return (requireNode() as unknown as { has_complete_blob(h: string): Promise<boolean> })
    .has_complete_blob(blake3Hash);
}

function releaseBlob(blake3Hash: string): void {
  requireNode().release_blob(blake3Hash);
}

function restrictBlobToPeers(blake3Hash: string, peerNodeIds: string[]): void {
  requireNode().restrict_blob_to_peers(blake3Hash, peerNodeIds);
}

function clearBlobRestriction(blake3Hash: string): void {
  requireNode().clear_blob_restriction(blake3Hash);
}

// ---- chunked import sessions -----------------------------------------------

function startImport(): number {
  const session = requireNode().start_import() as unknown as WasmImportSession;
  const sessionId = nextSessionId++;
  sessions.set(sessionId, session);
  return sessionId;
}

async function importPush(sessionId: number, chunk: Uint8Array): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`midden-worker: unknown import session ${sessionId}`);
  await session.push(chunk);
}

async function importFinish(sessionId: number): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`midden-worker: unknown import session ${sessionId}`);
  sessions.delete(sessionId);
  return session.finish();
}

function importAbort(sessionId: number): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    session.abort();
  } catch {
    // already finished
  }
}

// ---- downloads -------------------------------------------------------------
// callback args arrive as comlink proxies (async functions). the wasm side
// calls them fire-and-forget, which is exactly the semantic proxies give.

async function ensureBlob(peerAddr: string, blake3Hash: string): Promise<boolean> {
  return requireNode().ensure_blob(peerAddr, blake3Hash);
}

async function downloadVerifiedWithEnsure(
  peerAddr: string,
  blake3Hash: string
): Promise<Uint8Array> {
  const result = await requireNode().download_verified_with_ensure(peerAddr, blake3Hash);
  return Comlink.transfer(result, [result.buffer as ArrayBuffer]);
}

async function downloadVerifiedWithEnsureProgress(
  peerAddr: string,
  blake3Hash: string,
  totalSize: number,
  onProgress: (fraction: number) => void,
  downloadId?: string
): Promise<Uint8Array> {
  const token = downloadId ? registerCancelToken(downloadId) : null;
  try {
    const result = await requireNode().download_verified_with_ensure_progress(
      peerAddr,
      blake3Hash,
      totalSize,
      onProgress,
      token ? token.clone_token() : undefined
    );
    return Comlink.transfer(result, [result.buffer as ArrayBuffer]);
  } finally {
    if (downloadId && token) releaseCancelToken(downloadId, token);
  }
}

async function downloadVerifiedById(
  peerAddr: string,
  blobId: string
): Promise<[Uint8Array, string]> {
  const result = await requireNode().download_verified_by_id(peerAddr, blobId);
  const bytes = result[0] as Uint8Array;
  return Comlink.transfer([bytes, result[1] as string], [bytes.buffer as ArrayBuffer]);
}

async function downloadVerifiedByIdProgress(
  peerAddr: string,
  blobId: string,
  totalSize: number,
  onProgress: (fraction: number) => void
): Promise<[Uint8Array, string]> {
  const result = await requireNode().download_verified_by_id_progress(
    peerAddr,
    blobId,
    totalSize,
    onProgress
  );
  const bytes = result[0] as Uint8Array;
  return Comlink.transfer([bytes, result[1] as string], [bytes.buffer as ArrayBuffer]);
}

async function downloadVerifiedStreamingWithEnsure(
  peerAddr: string,
  blake3Hash: string,
  totalSize: number,
  onChunk: (chunk: Uint8Array, offset: number) => void,
  onProgress: (fraction: number) => void,
  downloadId?: string
): Promise<number> {
  const token = downloadId ? registerCancelToken(downloadId) : null;
  try {
    return await requireNode().download_verified_streaming_with_ensure(
      peerAddr,
      blake3Hash,
      totalSize,
      onChunk,
      onProgress,
      token ? token.clone_token() : undefined
    );
  } finally {
    if (downloadId && token) releaseCancelToken(downloadId, token);
  }
}

/** flip the cancel token for an in-flight download (pause). no-op when the
 *  download already settled. the partial stays in the (persistent) store and
 *  the wasm side pins the hash against gc until resumed or unprotected. */
function downloadCancel(downloadId: string): boolean {
  const token = cancelTokens.get(downloadId);
  if (!token) return false;
  token.cancel();
  return true;
}

/** pin a hash against gc (e.g. keep a paused partial alive). */
function protectBlob(blake3Hash: string): void {
  requireNode().protect_blob(blake3Hash);
}

/** remove a gc pin (paused partial resumed to completion or discarded). */
function unprotectBlob(blake3Hash: string): void {
  requireNode().unprotect_blob(blake3Hash);
}

// ---- api requests -----------------------------------------------------------
// exposed as `proxyRequest` to match @freqhole/reliquary/worker's
// MiddenWorkerApi contract, which this worker implements the receiving end
// of.

async function proxyRequest(
  peerAddr: string,
  method: string,
  path: string,
  body: string | null
): Promise<{ status: number; body: string }> {
  return (await requireNode().api_request(peerAddr, method, path, body)) as {
    status: number;
    body: string;
  };
}

const api = {
  init,
  openBi,
  accept,
  streamReadMessage,
  streamWriteMessage,
  streamReadToEnd,
  streamWriteRawAndFinish,
  streamClose,
  importBlob,
  importBlobAndExportBao,
  importBao,
  hasActiveBlob,
  hasCompleteBlob,
  releaseBlob,
  restrictBlobToPeers,
  clearBlobRestriction,
  startImport,
  importPush,
  importFinish,
  importAbort,
  ensureBlob,
  downloadVerifiedWithEnsure,
  downloadVerifiedWithEnsureProgress,
  downloadVerifiedById,
  downloadVerifiedByIdProgress,
  downloadVerifiedStreamingWithEnsure,
  downloadCancel,
  protectBlob,
  unprotectBlob,
  proxyRequest,
};

export type MiddenWorkerApi = typeof api;

Comlink.expose(api);

// ready signal AFTER Comlink registered its message listener — same race
// (and same fix) as blob-worker.ts: an RPC posted before the listener
// exists is dropped forever. the exact literal matters: it must match
// what @freqhole/reliquary/worker's WorkerMiddenNode client waits for.
postMessage(MIDDEN_WORKER_READY_MESSAGE);
