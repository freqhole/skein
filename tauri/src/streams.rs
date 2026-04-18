//! bi-stream IPC bridge.
//!
//! the frontend (`TauriBiStream` / `TauriStreamNode` in
//! [`loam/src/p2p/tauri-transport.ts`](../../../loam/src/p2p/tauri-transport.ts))
//! drives iroh streams through five `skein_dispatch` actions:
//!
//! - `open_bi { peer_addr, alpn }` -> `{ handle, peer_node_id }`
//! - `accept_stream` -> `{ handle, peer_node_id, alpn }` (or `null` handle)
//! - `write_message { handle, data }` (4-byte big-endian length prefix)
//! - `read_message { handle }` -> `{ data: base64 | null }`
//! - `close_stream { handle }`
//!
//! ## ownership / threading
//!
//! a `StreamRegistry` (lives in [`AppState`]) holds a `Mutex<HashMap>` of
//! `Slot { send, recv }` per integer handle. each slot owns an iroh
//! `SendStream` + `RecvStream` plus the peer's `node_id` and the negotiated
//! alpn for diagnostics.
//!
//! ## inbound streams
//!
//! the frontend can opt-in to receiving by calling `accept_stream`. behind
//! the scenes a single tokio `mpsc` channel buffers inbound connections that
//! an always-on iroh [`Router`] accepts on the dedicated frontend ALPN
//! namespace `skein/frontend/0`. the hub uses different ALPNs so there is
//! no conflict whether the hub is on or off.
//!
//! ## framing
//!
//! identical to midden: each `write_message` writes `len_be_u32 || data` and
//! each `read_message` reads the same. partial reads block; eof returns
//! `null`. this matches `BiStreamLike` in `iroh-network-adapter.ts`.

use std::collections::HashMap;
use std::sync::Arc;

use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, PublicKey};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

/// alpns the tauri-hosted frontend handles inbound. these mirror what midden
/// registers in the browser build (see `midden/src/lib.rs::create_with_alpns`)
/// so browser <-> tauri can negotiate the same protocols in either direction.
///
/// when the in-process hub is enabled it would also want some of these alpns
/// (`iroh/automerge-repo/1`, `skein-friendz/1`, `skein/1`, `iroh-bytes/4`).
/// iroh only allows one handler per alpn at a time, so hub start currently
/// loses to the frontend registry. resolving that overlap is tracked in
/// `docs/tauri-progress.md` iteration 3.
pub const FRONTEND_ALPNS: &[&[u8]] = &[
    b"iroh/automerge-repo/1",
    b"skein-friendz/1",
    b"skein/1",
    // dedicated namespace kept around for future frontend-only sub-protocols.
    b"skein/frontend/0",
];

/// max queued inbound connections waiting for `accept_stream` to drain them.
const ACCEPT_BUFFER: usize = 64;

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum StreamError {
    #[error("unknown handle: {0}")]
    UnknownHandle(u64),
    #[error("connect: {0}")]
    Connect(String),
    #[error("open_bi: {0}")]
    OpenBi(String),
    #[error("write: {0}")]
    Write(String),
    #[error("read: {0}")]
    Read(String),
    #[error("base64 decode: {0}")]
    B64(String),
    #[error("accept channel closed")]
    AcceptClosed,
}

struct Slot {
    send: SendStream,
    recv: RecvStream,
    peer_node_id: String,
    #[allow(dead_code)]
    alpn: String,
}

/// shared stream state — slots indexed by monotonic `u64` handles, plus an
/// inbound queue for `accept_stream`.
pub struct StreamRegistry {
    slots: Mutex<HashMap<u64, Slot>>,
    next_handle: Mutex<u64>,
    accept_rx: Mutex<Option<mpsc::Receiver<InboundStream>>>,
    /// kept alive for the lifetime of `AppState`. dropping the router stops
    /// accepting on the frontend alpns and is fine for a clean shutdown.
    _router: Router,
}

struct InboundStream {
    send: SendStream,
    recv: RecvStream,
    peer_node_id: String,
    alpn: String,
}

impl StreamRegistry {
    /// start the always-on frontend router on every alpn in `FRONTEND_ALPNS`
    /// and return a fresh registry. failures spawning the router are bubbled
    /// back so boot can fail loudly.
    pub async fn start(endpoint: Endpoint) -> anyhow::Result<Arc<Self>> {
        let (tx, rx) = mpsc::channel(ACCEPT_BUFFER);
        let mut builder = Router::builder(endpoint);
        for alpn in FRONTEND_ALPNS {
            let handler = AcceptHandler {
                tx: tx.clone(),
                alpn: alpn.to_vec(),
            };
            builder = builder.accept(*alpn, handler);
        }
        let router = builder.spawn();
        Ok(Arc::new(Self {
            slots: Mutex::new(HashMap::new()),
            next_handle: Mutex::new(1),
            accept_rx: Mutex::new(Some(rx)),
            _router: router,
        }))
    }

    async fn next_id(&self) -> u64 {
        let mut g = self.next_handle.lock().await;
        let h = *g;
        *g = g.wrapping_add(1).max(1);
        h
    }

    async fn insert(
        &self,
        send: SendStream,
        recv: RecvStream,
        peer_node_id: String,
        alpn: String,
    ) -> u64 {
        let handle = self.next_id().await;
        self.slots.lock().await.insert(
            handle,
            Slot {
                send,
                recv,
                peer_node_id,
                alpn,
            },
        );
        handle
    }
}

#[derive(Clone)]
struct AcceptHandler {
    tx: mpsc::Sender<InboundStream>,
    /// alpn this handler was registered against — stamped onto inbound
    /// streams so the frontend can route them like midden does.
    alpn: Vec<u8>,
}

impl std::fmt::Debug for AcceptHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcceptHandler")
            .field("alpn", &String::from_utf8_lossy(&self.alpn))
            .finish()
    }
}

impl ProtocolHandler for AcceptHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let peer_node_id = connection.remote_id().to_string();
        let alpn = String::from_utf8_lossy(&self.alpn).to_string();
        tracing::info!(
            peer = %peer_node_id,
            alpn = %alpn,
            "frontend: inbound connection, awaiting bi-stream"
        );
        // accept exactly one bi-stream per inbound connection — matches
        // midden's `accept()` semantics and what the frontend expects.
        let (send, recv) = connection.accept_bi().await?;
        tracing::info!(
            peer = %peer_node_id,
            alpn = %alpn,
            "frontend: accepted bi-stream, queuing for accept_stream"
        );
        if self
            .tx
            .send(InboundStream {
                send,
                recv,
                peer_node_id,
                alpn,
            })
            .await
            .is_err()
        {
            tracing::warn!("frontend accept channel closed; dropping inbound stream");
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// dispatch entry points
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct OpenBiArgs {
    pub peer_addr: String,
    pub alpn: String,
}

/// open an outbound bi-directional stream to `peer_addr` on `alpn`. the
/// frontend supplies the peer's iroh node id (hex) as `peer_addr`.
pub async fn open_bi(
    args: OpenBiArgs,
    endpoint: &Endpoint,
    registry: &StreamRegistry,
) -> Result<Value, StreamError> {
    let node_id: PublicKey = args
        .peer_addr
        .parse()
        .map_err(|e: iroh::KeyParsingError| StreamError::Connect(format!("parse node id: {e}")))?;
    open_bi_with_addr(EndpointAddr::from(node_id), &args.alpn, endpoint, registry).await
}

/// shared implementation behind [`open_bi`]. exposed within the crate so
/// integration tests can pass a fully-resolved [`EndpointAddr`] (with direct
/// socket addrs) and avoid relying on real address-lookup infrastructure.
pub(crate) async fn open_bi_with_addr(
    addr: EndpointAddr,
    alpn: &str,
    endpoint: &Endpoint,
    registry: &StreamRegistry,
) -> Result<Value, StreamError> {
    tracing::info!(peer = %addr.id, alpn, "frontend: connecting");
    let conn = endpoint
        .connect(addr, alpn.as_bytes())
        .await
        .map_err(|e| StreamError::Connect(e.to_string()))?;
    let (send, recv) = conn
        .open_bi()
        .await
        .map_err(|e| StreamError::OpenBi(e.to_string()))?;
    let peer_node_id = conn.remote_id().to_string();
    let handle = registry
        .insert(send, recv, peer_node_id.clone(), alpn.to_string())
        .await;
    tracing::info!(peer = %peer_node_id, alpn, handle, "frontend: opened bi-stream");
    Ok(json!({ "handle": handle, "peer_node_id": peer_node_id }))
}

/// pull the next inbound stream from the accept queue. returns `null` handle
/// if the channel has been closed (shouldn't happen during normal runtime).
pub async fn accept_stream(registry: &StreamRegistry) -> Result<Value, StreamError> {
    let mut guard = registry.accept_rx.lock().await;
    let rx = guard.as_mut().ok_or(StreamError::AcceptClosed)?;
    match rx.recv().await {
        Some(inbound) => {
            let handle = registry
                .insert(
                    inbound.send,
                    inbound.recv,
                    inbound.peer_node_id.clone(),
                    inbound.alpn.clone(),
                )
                .await;
            Ok(json!({
                "handle": handle,
                "peer_node_id": inbound.peer_node_id,
                "alpn": inbound.alpn,
            }))
        }
        None => {
            // channel closed; expose to caller so it can stop polling.
            *guard = None;
            Ok(json!({ "handle": Value::Null }))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct WriteArgs {
    pub handle: u64,
    pub data: String,
}

/// length-delimited write (4-byte BE prefix). matches midden framing.
pub async fn write_message(
    args: WriteArgs,
    registry: &StreamRegistry,
) -> Result<Value, StreamError> {
    let bytes = B64
        .decode(args.data.as_bytes())
        .map_err(|e| StreamError::B64(e.to_string()))?;
    let mut slots = registry.slots.lock().await;
    let slot = slots
        .get_mut(&args.handle)
        .ok_or(StreamError::UnknownHandle(args.handle))?;
    let len = (bytes.len() as u32).to_be_bytes();
    slot.send
        .write_all(&len)
        .await
        .map_err(|e| StreamError::Write(e.to_string()))?;
    slot.send
        .write_all(&bytes)
        .await
        .map_err(|e| StreamError::Write(e.to_string()))?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
pub struct HandleArgs {
    pub handle: u64,
}

/// length-delimited read. returns `{ data: null }` on clean eof.
pub async fn read_message(
    args: HandleArgs,
    registry: &StreamRegistry,
) -> Result<Value, StreamError> {
    let mut slots = registry.slots.lock().await;
    let slot = slots
        .get_mut(&args.handle)
        .ok_or(StreamError::UnknownHandle(args.handle))?;

    let mut len_buf = [0u8; 4];
    match slot.recv.read_exact(&mut len_buf).await {
        Ok(()) => {}
        Err(e) => {
            // peer closed the stream cleanly or otherwise — surface as eof.
            tracing::debug!(handle = args.handle, peer = %slot.peer_node_id, error = %e, "read eof");
            return Ok(json!({ "data": Value::Null }));
        }
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 {
        return Ok(json!({ "data": B64.encode(&[] as &[u8]) }));
    }
    let mut buf = vec![0u8; len];
    slot.recv
        .read_exact(&mut buf)
        .await
        .map_err(|e| StreamError::Read(e.to_string()))?;
    Ok(json!({ "data": B64.encode(&buf) }))
}

/// gracefully close a stream and forget the handle.
pub async fn close_stream(
    args: HandleArgs,
    registry: &StreamRegistry,
) -> Result<Value, StreamError> {
    let removed = registry.slots.lock().await.remove(&args.handle);
    if let Some(mut slot) = removed {
        let _ = slot.send.finish();
        // drop recv implicitly.
    }
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// integration tests
// ---------------------------------------------------------------------------
//
// these spin up two real iroh endpoints in-process and exercise the same
// dispatch entry points the tauri command layer calls. the goal is to catch
// alpn / framing / handle-lifecycle regressions without needing the full
// tauri runtime or a browser. they use the n0 preset so they will reach the
// public relays for path discovery — the tests are tagged `#[ignore]` so
// `cargo test` stays offline-clean by default. run with:
//
//   cargo test --no-default-features -- --ignored --nocapture
//
// this matches how reliquary handles its network-touching tests.

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::endpoint::presets;
    use iroh::Endpoint;
    use std::time::Duration;

    /// build a fresh endpoint advertising every frontend alpn so it can both
    /// receive (when wrapped in a registry) and respond to alpn negotiation.
    /// waits for the endpoint to come online so `addr()` returns a populated
    /// `EndpointAddr` (with relay url + direct socket addrs).
    async fn make_endpoint() -> anyhow::Result<Endpoint> {
        let ep = Endpoint::builder(presets::N0)
            .alpns(FRONTEND_ALPNS.iter().map(|a| a.to_vec()).collect())
            .bind()
            .await?;
        ep.online().await;
        Ok(ep)
    }

    /// teach `dialer` about `target`'s direct addresses by handing back a
    /// fully-resolved `EndpointAddr` it can pass straight into `connect()`,
    /// bypassing relay-mediated discovery entirely.
    fn target_addr(target: &Endpoint) -> EndpointAddr {
        target.addr()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "binds real iroh endpoints; run with --ignored"]
    async fn open_bi_round_trip_friendz_alpn() {
        let dialer = make_endpoint().await.expect("dialer endpoint");
        let listener = make_endpoint().await.expect("listener endpoint");

        let registry = StreamRegistry::start(listener.clone())
            .await
            .expect("registry");
        let dialer_registry = StreamRegistry::start(dialer.clone())
            .await
            .expect("dialer registry");

        // outbound: dialer opens a friendz stream to listener via direct addr.
        let target_id = listener.id().to_string();
        let open_resp = open_bi_with_addr(
            target_addr(&listener),
            "skein-friendz/1",
            &dialer,
            &dialer_registry,
        )
        .await
        .expect("open_bi");
        let dialer_handle = open_resp["handle"].as_u64().expect("handle");
        assert_eq!(open_resp["peer_node_id"].as_str().unwrap(), target_id);

        // QUIC bi-streams are lazy: the listener's `accept_bi` only resolves
        // once the dialer sends some bytes. send the first message before
        // awaiting `accept_stream` so the test mirrors production usage where
        // `open_bi` is always followed by a `write_message`.
        let payload = b"hello friendz".to_vec();
        write_message(
            WriteArgs {
                handle: dialer_handle,
                data: B64.encode(&payload),
            },
            &dialer_registry,
        )
        .await
        .expect("write");

        // inbound: listener should see the same stream tagged with the alpn.
        let accept_resp = tokio::time::timeout(
            Duration::from_secs(15),
            accept_stream(&registry),
        )
        .await
        .expect("accept_stream timed out")
        .expect("accept_stream");
        let listener_handle = accept_resp["handle"].as_u64().expect("acc handle");
        assert_eq!(accept_resp["alpn"].as_str().unwrap(), "skein-friendz/1");
        assert_eq!(
            accept_resp["peer_node_id"].as_str().unwrap(),
            dialer.id().to_string(),
        );

        // round-trip a payload dialer -> listener.
        let read_resp = read_message(HandleArgs { handle: listener_handle }, &registry)
            .await
            .expect("read");
        let echoed = B64
            .decode(read_resp["data"].as_str().expect("data str"))
            .expect("b64");
        assert_eq!(echoed, payload);

        // and back the other way to prove bidirectionality.
        let reply = b"ack".to_vec();
        write_message(
            WriteArgs {
                handle: listener_handle,
                data: B64.encode(&reply),
            },
            &registry,
        )
        .await
        .expect("reply write");
        let dialer_read =
            read_message(HandleArgs { handle: dialer_handle }, &dialer_registry)
                .await
                .expect("reply read");
        assert_eq!(
            B64.decode(dialer_read["data"].as_str().unwrap()).unwrap(),
            reply
        );

        close_stream(HandleArgs { handle: dialer_handle }, &dialer_registry)
            .await
            .ok();
        close_stream(HandleArgs { handle: listener_handle }, &registry)
            .await
            .ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "binds real iroh endpoints; run with --ignored"]
    async fn registry_accepts_each_advertised_alpn() {
        let dialer = make_endpoint().await.expect("dialer");
        let listener = make_endpoint().await.expect("listener");
        let registry = StreamRegistry::start(listener.clone())
            .await
            .expect("registry");
        let dialer_registry = StreamRegistry::start(dialer.clone())
            .await
            .expect("dialer registry");

        for alpn in FRONTEND_ALPNS {
            let alpn_str = std::str::from_utf8(alpn).unwrap();
            let resp = open_bi_with_addr(
                target_addr(&listener),
                alpn_str,
                &dialer,
                &dialer_registry,
            )
            .await
            .unwrap_or_else(|e| panic!("open_bi {alpn_str}: {e}"));
            let dialer_handle = resp["handle"].as_u64().unwrap();

            // kick the bi-stream so the listener's `accept_bi` resolves.
            write_message(
                WriteArgs {
                    handle: dialer_handle,
                    data: B64.encode(b"ping"),
                },
                &dialer_registry,
            )
            .await
            .unwrap_or_else(|e| panic!("write {alpn_str}: {e}"));

            let accept = tokio::time::timeout(
                Duration::from_secs(15),
                accept_stream(&registry),
            )
            .await
            .unwrap_or_else(|_| panic!("accept timeout on {alpn_str}"))
            .unwrap_or_else(|e| panic!("accept_stream {alpn_str}: {e}"));
            assert_eq!(accept["alpn"].as_str().unwrap(), alpn_str);

            close_stream(HandleArgs { handle: dialer_handle }, &dialer_registry)
                .await
                .ok();
            close_stream(
                HandleArgs {
                    handle: accept["handle"].as_u64().unwrap(),
                },
                &registry,
            )
            .await
            .ok();
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "binds real iroh endpoints; run with --ignored"]
    async fn read_message_returns_null_on_eof() {
        let dialer = make_endpoint().await.expect("dialer");
        let listener = make_endpoint().await.expect("listener");
        let registry = StreamRegistry::start(listener.clone())
            .await
            .expect("registry");
        let dialer_registry = StreamRegistry::start(dialer.clone())
            .await
            .expect("dialer registry");

        let open = open_bi_with_addr(
            target_addr(&listener),
            "skein/frontend/0",
            &dialer,
            &dialer_registry,
        )
        .await
        .expect("open_bi");
        let dialer_handle = open["handle"].as_u64().unwrap();

        // kick the stream so the listener's `accept_bi` resolves.
        write_message(
            WriteArgs {
                handle: dialer_handle,
                data: B64.encode(b"hi"),
            },
            &dialer_registry,
        )
        .await
        .expect("initial write");

        let accept = tokio::time::timeout(Duration::from_secs(15), accept_stream(&registry))
            .await
            .expect("accept timeout")
            .expect("accept");
        let listener_handle = accept["handle"].as_u64().unwrap();

        // drain the kick payload so the next read after close sees true eof.
        let _ = read_message(HandleArgs { handle: listener_handle }, &registry)
            .await
            .expect("drain read");

        // close the dialer side cleanly; listener's read should return null.
        close_stream(HandleArgs { handle: dialer_handle }, &dialer_registry)
            .await
            .ok();

        let resp = tokio::time::timeout(
            Duration::from_secs(5),
            read_message(HandleArgs { handle: listener_handle }, &registry),
        )
        .await
        .expect("read timeout")
        .expect("read");
        assert!(resp["data"].is_null(), "expected null on eof, got {resp}");
    }

    #[tokio::test]
    async fn close_unknown_handle_is_a_noop() {
        // does not need a network — close_stream should silently ignore
        // handles that were never registered.
        let endpoint = make_endpoint().await.expect("endpoint");
        let registry = StreamRegistry::start(endpoint).await.expect("registry");
        let resp = close_stream(HandleArgs { handle: 9999 }, &registry)
            .await
            .expect("close");
        assert!(resp.is_null());
    }

    #[tokio::test]
    async fn write_to_unknown_handle_errors() {
        let endpoint = make_endpoint().await.expect("endpoint");
        let registry = StreamRegistry::start(endpoint).await.expect("registry");
        let err = write_message(
            WriteArgs {
                handle: 42,
                data: B64.encode(b"x"),
            },
            &registry,
        )
        .await
        .expect_err("expected unknown handle");
        assert!(matches!(err, StreamError::UnknownHandle(42)), "got {err:?}");
    }

    #[tokio::test]
    async fn write_rejects_invalid_base64() {
        let endpoint = make_endpoint().await.expect("endpoint");
        let registry = StreamRegistry::start(endpoint).await.expect("registry");
        let err = write_message(
            WriteArgs {
                handle: 1,
                data: "!!!not base64!!!".to_string(),
            },
            &registry,
        )
        .await
        .expect_err("expected b64 error");
        assert!(matches!(err, StreamError::B64(_)), "got {err:?}");
    }
}
