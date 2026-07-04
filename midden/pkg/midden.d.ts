/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

type ReadableStreamType = "bytes";

/**
 * a bidirectional QUIC stream for length-delimited message exchange.
 *
 * wraps an iroh (SendStream, RecvStream) pair. messages are framed with
 * a 4-byte big-endian u32 length prefix, matching `LengthDelimitedCodec`
 * from tokio-util.
 *
 * the send and recv halves use RefCell<Option<...>> so that async read
 * and write operations can proceed concurrently (safe because WASM is
 * single-threaded).
 */
export class BiStream {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * the ALPN protocol this stream was established on.
     */
    alpn(): string;
    /**
     * close the stream.
     *
     * finishes the send half and drops both halves.
     */
    close(): void;
    /**
     * the remote peer's node ID (iroh public key as hex string).
     */
    peer_node_id(): string;
    /**
     * read a length-delimited message.
     *
     * reads a 4-byte big-endian u32 length prefix, then reads that many
     * bytes of payload. returns the payload as a Uint8Array.
     *
     * returns null (JsValue::NULL) if the stream has been closed cleanly
     * by the remote peer (EOF on the length prefix read).
     */
    read_message(): Promise<any>;
    /**
     * read all remaining bytes from the recv stream (no length prefix).
     *
     * reads until the remote peer finishes the stream or `max_size` bytes
     * are read. this matches grimoire's `read_to_end()` framing where
     * the message is terminated by the sender calling `finish()`.
     */
    read_to_end(max_size: number): Promise<any>;
    /**
     * write a length-delimited message.
     *
     * writes a 4-byte big-endian u32 length prefix followed by the payload.
     * this matches the `LengthDelimitedCodec` framing used by the
     * iroh-automerge-repo example.
     */
    write_message(data: Uint8Array): Promise<void>;
    /**
     * write raw bytes without a length prefix, then finish the send stream.
     *
     * this matches grimoire's `send_response()` framing where the message
     * is terminated by calling `finish()` on the send stream. the receiver
     * uses `read_to_end()` to read all bytes.
     *
     * after `finish()` we await `stopped()` so the peer's ack is observed
     * before this method returns. without this, JS callers that drop /
     * `close()` the stream immediately after `write_raw_and_finish` can
     * race the QUIC flush — the peer's `read_to_end` then errors with
     * "connection lost" mid-payload because the in-flight frames are
     * torn down with the connection. matters most for large payloads
     * (e.g. base64-encoded blob bodies in `proxy_response`).
     */
    write_raw_and_finish(data: Uint8Array): Promise<void>;
}

/**
 * incremental blake3 hasher for streaming uploads — feed fixed-size chunks
 * via update() and read the final hex hash from finalize(). lets JS hash a
 * File while streaming it (file.stream() reader loop) instead of holding
 * the whole payload in memory for a one-shot hash_blake3().
 */
export class Blake3Hasher {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * finish and return the hash as a 64-char hex string. the hasher can
     * keep absorbing after this (blake3 finalize is non-destructive), but
     * callers should treat the session as done.
     */
    finalize(): string;
    constructor();
    /**
     * absorb the next chunk of data.
     */
    update(chunk: Uint8Array): void;
}

/**
 * result from fetching the server hello image from a peer
 */
export class HelloImageResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly content_type: string | undefined;
    readonly data: Uint8Array;
}

/**
 * chunked import session — the streaming counterpart to import_blob.
 *
 * created via MiddenNode::start_import(). JS feeds fixed-size chunks with
 * push() (backpressured: the promise resolves only once the chunk is
 * queued), then finish() completes the import and returns the blake3 hash.
 * the wasm boundary never sees the whole payload at once; the store's
 * ImportByteStream machinery computes the bao tree incrementally.
 *
 * the finished blob is pinned in the node's active_tags (same as
 * import_blob) until release_blob() is called.
 */
export class ImportSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * abort the import. any partially-imported data is left to GC.
     */
    abort(): void;
    /**
     * signal end-of-stream, wait for the import to complete, pin the
     * resulting blob, and return its blake3 hash as a hex string.
     */
    finish(): Promise<string>;
    /**
     * queue the next chunk. resolves once the chunk has been accepted by
     * the import stream (bounded channel — this is the backpressure point).
     */
    push(chunk: Uint8Array): Promise<void>;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * browser P2P node for the skein canvas ecosystem.
 *
 * supports two protocols:
 * - skein/1: API proxying and small blob streaming
 * - iroh-blobs: verified streaming for file blobs
 */
export class MiddenNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * accept the next incoming connection and bidirectional stream.
     *
     * blocks until an incoming connection arrives on any registered ALPN.
     * returns a BiStream with the peer's node ID and the negotiated ALPN.
     *
     * returns null (JsValue::NULL) if the endpoint has been closed.
     *
     * the caller should check `stream.alpn()` to route the connection
     * to the appropriate handler.
     */
    accept(): Promise<any>;
    /**
     * return the number of blobs currently held in the store via active TempTags.
     */
    active_blob_count(): number;
    /**
     * PROTOTYPE: remove a hash's restriction, returning it to the default
     * (served to anyone) state.
     */
    clear_blob_restriction(blake3_hash: string): void;
    /**
     * compute blake3 hash for a blob on demand
     *
     * use this when the client doesn't have the blake3 hash yet (not in API response).
     * the server will compute the hash, save it to the database, and add the file
     * to FsStore for verified streaming.
     *
     * returns the blake3 hash (64 hex chars) if successful, null if blob not found.
     */
    compute_blake3(peer_addr: string, blob_id: string): Promise<string | undefined>;
    /**
     * create a new node with random identity
     * waits for relay connection before returning.
     * `opfs_store_dir`: when given, blobs persist in an OPFS-backed store
     * under this directory (worker context required); otherwise (or when
     * OPFS is unavailable) an in-memory store is used.
     */
    static create(opfs_store_dir?: string | null): Promise<MiddenNode>;
    /**
     * create a node from existing secret key bytes (for persistence)
     * key_bytes must be exactly 32 bytes
     */
    static create_from_key(key_bytes: Uint8Array, opfs_store_dir?: string | null): Promise<MiddenNode>;
    /**
     * create a node from existing secret key with additional ALPN protocols.
     *
     * `extra_alpns` is a JS array of strings (e.g. ["iroh/automerge-repo/1"]).
     * the node always registers "skein/1" plus whatever extra ALPNs are given.
     */
    static create_with_alpns(key_bytes: Uint8Array, extra_alpns: Array<any>): Promise<MiddenNode>;
    /**
     * download a blob using iroh-blobs verified streaming
     *
     * this is the preferred method for audio files - provides:
     * - verified streaming (each chunk is cryptographically verified)
     * - resume support (can restart interrupted transfers)
     * - efficient parallel chunk fetching
     *
     * peer_addr: plain node_id or full endpoint JSON
     * blake3_hash: the blake3 hash of the blob (64 hex chars)
     */
    download_verified(peer_addr: string, blake3_hash: string): Promise<Uint8Array>;
    /**
     * download a blob by blob_id using verified streaming with on-demand blake3
     *
     * use this when the client doesn't have the blake3 hash yet (not in API response).
     * computes blake3 on the server, then uses iroh-blobs verified streaming.
     *
     * returns (blob_data, blake3_hash) for caching the hash for future requests.
     */
    download_verified_by_id(peer_addr: string, blob_id: string): Promise<Array<any>>;
    /**
     * full pipeline from blob_id with progress reporting
     *
     * computes blake3 on demand, then uses verified download with progress.
     * returns [data: Uint8Array, blake3: string].
     */
    download_verified_by_id_progress(peer_addr: string, blob_id: string, total_size: number, on_progress: Function): Promise<Array<any>>;
    /**
     * download a verified blob and stream chunks to JS via callback
     * (ported from tomb's midden).
     *
     * this is the preferred path for large blobs. instead of materializing
     * the full blob in wasm linear memory (which fails around 32MB+ due to
     * allocator pressure on a single contiguous Bytes), this:
     *
     * 1. downloads the blob into MemStore using the verified iroh-blobs path
     * 2. opens a streaming reader and pulls chunks
     * 3. delivers each chunk to the JS callback as a Uint8Array
     *
     * JS can write each chunk straight to a writable stream (disk) or
     * accumulate into a Blob, releasing chunks as it goes. wasm peak memory
     * stays bounded by chunk_size + the MemStore copy.
     *
     * callback signature: `on_chunk(chunk: Uint8Array, offset: number) -> void`
     * progress callback: `on_progress(fraction: number) -> void`
     *
     * returns total bytes streamed.
     */
    download_verified_streaming(peer_addr: string, blake3_hash: string, total_size: number, on_chunk: Function, on_progress: Function): Promise<number>;
    /**
     * streaming download with auto ensure+retry. first attempts the
     * streaming download; if the verified download fails (blob not in
     * peer's store), calls ensure_blob to load it, then retries.
     */
    download_verified_streaming_with_ensure(peer_addr: string, blake3_hash: string, total_size: number, on_chunk: Function, on_progress: Function): Promise<number>;
    /**
     * download a blob using iroh-blobs with automatic ensure + retry
     *
     * tries download_verified first. if blob not in peer's FsStore,
     * calls ensure_blob to load it, then retries.
     */
    download_verified_with_ensure(peer_addr: string, blake3_hash: string): Promise<Uint8Array>;
    /**
     * download with ensure + retry and progress reporting
     *
     * tries download first; if blob not in peer's FsStore, calls ensure_blob
     * then retries. progress callback receives fraction (0.0 to 1.0).
     *
     * NOTE: any failure on the first attempt triggers this same
     * ensure-then-retry fallback, not just the "blob not in FsStore yet"
     * case the fallback was designed for. for a large blob, the first
     * attempt can stream a substantial fraction of the bytes (driving
     * `on_progress` most/all of the way to 1.0) before failing late (e.g.
     * the peer's FsStore didn't have every chunk materialized yet even
     * though iroh-blobs offered to serve it), so the caller-visible symptom
     * is a full 0->100% progress cycle that silently restarts from 0 for a
     * second full cycle. logging the first attempt's error (previously
     * discarded) and explicitly resetting progress to 0 here makes this
     * restart visible/diagnosable instead of looking like a silent glitch.
     */
    download_verified_with_ensure_progress(peer_addr: string, blake3_hash: string, total_size: number, on_progress: Function): Promise<Uint8Array>;
    /**
     * download a blob with progress reporting via JS callback
     *
     * same as download_verified but calls on_progress(fraction) where
     * fraction is bytes_received / total_size (0.0 to 1.0).
     * total_size should come from the automerge doc's size field.
     */
    download_verified_with_progress(peer_addr: string, blake3_hash: string, total_size: number, on_progress: Function): Promise<Uint8Array>;
    /**
     * ensure a blob is loaded into the peer's FsStore by blake3 hash
     *
     * call this before retrying download_verified if the first attempt fails.
     * the server will look up the file by blake3 hash and add it to FsStore.
     *
     * returns true if blob is now available, false if not found.
     */
    ensure_blob(peer_addr: string, blake3_hash: string): Promise<boolean>;
    /**
     * fetch server image from a peer (public, no auth required)
     * used during "add remote" flow before user is authenticated
     * peer_addr can be plain node_id or full endpoint JSON with relay/IP hints
     */
    fetch_hello_image(peer_addr: string): Promise<HelloImageResult>;
    /**
     * check whether a blob with the given blake3 hash is currently held in the store
     * via an active TempTag. avoids expensive OPFS read + bao recomputation when the
     * blob is already loaded.
     */
    has_active_blob(blake3_hash: string): boolean;
    /**
     * check whether a COMPLETE blob with this hash exists in the blob
     * store itself — with the persistent opfs store this is true across
     * reloads, even when no TempTag pins it. lets serving paths skip
     * re-imports entirely.
     */
    has_complete_blob(blake3_hash: string): Promise<boolean>;
    /**
     * import a blob from its pre-computed bao-encoded bytes, skipping the
     * expensive bao tree computation. `blake3_hash` is the 64-char hex hash,
     * `bao_data` is the bao-encoded bytes previously returned by
     * `import_blob_and_export_bao`.
     *
     * uses `import_bao_bytes` (iroh-blobs internal API) to feed the pre-computed
     * bao stream directly into the store, then creates a global TempTag via
     * `Tags::temp_tag` to prevent GC.
     */
    import_bao(blake3_hash: string, bao_data: Uint8Array): Promise<string>;
    /**
     * import raw bytes into the iroh-blobs store, returning the blake3 hash.
     * this makes the blob available for verified download by peers.
     * the blob stays in the store as long as its TempTag is held in active_tags.
     * call release_blob() to allow GC.
     */
    import_blob(data: Uint8Array): Promise<string>;
    /**
     * import raw bytes into the iroh-blobs store, returning both the blake3 hash
     * AND the bao-encoded bytes. the bao bytes can be cached in OPFS and later
     * fed to `import_bao` to skip the expensive bao tree recomputation on re-import.
     *
     * returns a JS object: `{ hash: string, bao: Uint8Array }`
     */
    import_blob_and_export_bao(data: Uint8Array): Promise<any>;
    /**
     * get our node_id (iroh public key)
     */
    node_id(): string;
    /**
     * open a bidirectional stream to a peer on a specific ALPN.
     *
     * `peer_addr` can be a plain node_id hex string or a full endpoint
     * address JSON (same format as proxy_request). `alpn` is the protocol
     * to negotiate (e.g. "iroh/automerge-repo/1").
     *
     * returns a BiStream for length-delimited message exchange.
     */
    open_bi(peer_addr: string, alpn: string): Promise<BiStream>;
    /**
     * send an API request to a peer
     * peer_addr can be plain node_id or full endpoint JSON with relay/IP hints
     */
    proxy_request(peer_addr: string, method: string, path: string, body?: string | null): Promise<any>;
    /**
     * release a blob's TempTag, allowing the store to garbage-collect it.
     * blake3_hash should be the 64-char hex string returned by import_blob.
     */
    release_blob(blake3_hash: string): void;
    /**
     * PROTOTYPE: restrict a blob (by blake3 hex hash) so only the given
     * peer node ids may fetch it over the `iroh-blobs/*` ALPN. a hash with
     * no restriction registered is served to anyone (today's default
     * behavior, unchanged) — calling this is what opts a specific hash
     * into gating.
     *
     * this is a stopgap/demo hook, not the real canvas-ACL integration: it
     * has to be called explicitly, from JS, with an already-resolved list
     * of allowed peer node ids for this one hash. see the accompanying
     * design report for what real integration would need instead.
     */
    restrict_blob_to_peers(blake3_hash: string, peer_node_ids: Array<any>): void;
    /**
     * get the secret key bytes for persistence (32 bytes)
     * store this in IndexedDB to maintain the same identity across sessions
     */
    secret_key(): Uint8Array;
    /**
     * begin a chunked import — the streaming counterpart to import_blob for
     * payloads that shouldn't be materialized as one contiguous &[u8] across
     * the wasm boundary. see ImportSession for the push/finish protocol.
     */
    start_import(): ImportSession;
}

/**
 * compute the blake3 hash of the given bytes and return as a hex string.
 * this runs entirely in the browser — no network call needed.
 */
export function hash_blake3(data: Uint8Array): string;

/**
 * stage-0 opfs store spike selftest — runs the full import/export round
 * trip against real OPFS through the real iroh-blobs api. worker context
 * required (sync access handles). see src/opfs_store/.
 */
export function opfs_store_selftest(): Promise<string>;

/**
 * persistence selftest: blobs + tags survive a store shutdown/reopen over
 * the same OPFS directory. worker context required.
 */
export function opfs_store_selftest_persistence(): Promise<string>;

export function start(): void;
