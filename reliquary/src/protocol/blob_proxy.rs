//! blob_proxy: `skein/1` protocol handler.
//!
//! handles `ensure_blob_request` messages from peers who want to download a
//! blob from the hub via iroh-blobs verified transfer. when the request
//! arrives, the hub looks the blob up in its [`blobz::Store`], imports the
//! on-disk file into the iroh-blobs [`FsStore`] by reference (outboard tree
//! only, no data copy), and reports availability back to the caller.
//!
//! wire format: raw JSON, no length prefix. the sender calls `finish()` on
//! the send stream to signal end-of-request. this matches the midden and
//! tauri transport implementations on the client side.

use std::sync::Arc;

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh_blobs::store::fs::FsStore;
use serde::{Deserialize, Serialize};

use crate::blobz;

/// ALPN protocol identifier for skein blob-proxy connections.
pub const SKEIN_ALPN: &[u8] = b"skein/1";

// ---------------------------------------------------------------------------
// protocol messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerMessage {
    /// request that a blob (by blake3 hex) be loaded into the hub's iroh-blobs
    /// store so the caller can then perform a verified download.
    EnsureBlobRequest { id: u64, blake3_hash: String },

    /// response to an `EnsureBlobRequest`.
    EnsureBlobResponse {
        id: u64,
        available: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// BlobProxyHandler
// ---------------------------------------------------------------------------

/// hub's `skein/1` protocol handler. clones are cheap (backed by `Arc`).
#[derive(Clone)]
pub struct BlobProxyHandler {
    inner: Arc<Inner>,
}

struct Inner {
    store: &'static FsStore,
    blobz: blobz::Store,
}

impl std::fmt::Debug for BlobProxyHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BlobProxyHandler").finish_non_exhaustive()
    }
}

impl BlobProxyHandler {
    pub fn new(store: &'static FsStore, blobz: blobz::Store) -> Self {
        Self {
            inner: Arc::new(Inner { store, blobz }),
        }
    }
}

impl ProtocolHandler for BlobProxyHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let peer_id = conn.remote_id();
        let peer_id_str = peer_id.to_string();
        let peer_short = peer_id_str[..16.min(peer_id_str.len())].to_string();
        tracing::info!(peer = %peer_short, "skein/1: accepted connection");

        loop {
            let (send, recv) = match conn.accept_bi().await {
                Ok(bi) => bi,
                Err(e) => {
                    tracing::debug!(peer = %peer_short, error = %e, "skein/1: connection closed");
                    break;
                }
            };

            let handler = self.clone();
            let peer_short = peer_short.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_stream(send, recv, &handler, &peer_short).await {
                    tracing::debug!(peer = %peer_short, error = %e, "skein/1: stream error");
                }
            });
        }

        Ok(())
    }

    async fn shutdown(&self) {
        tracing::debug!("skein/1: shutting down");
    }
}

// ---------------------------------------------------------------------------
// stream handling
// ---------------------------------------------------------------------------

async fn handle_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    handler: &BlobProxyHandler,
    peer_short: &str,
) -> Result<(), String> {
    let msg_bytes = recv
        .read_to_end(64 * 1024)
        .await
        .map_err(|e| format!("failed to read request: {e}"))?;

    let msg: PeerMessage = serde_json::from_slice(&msg_bytes)
        .map_err(|e| format!("failed to parse request: {e}"))?;

    match msg {
        PeerMessage::EnsureBlobRequest { id, blake3_hash } => {
            let (available, error) = ensure(handler, &blake3_hash).await;
            let resp = PeerMessage::EnsureBlobResponse { id, available, error };
            send_response(&mut send, &resp).await
        }
        PeerMessage::EnsureBlobResponse { .. } => {
            tracing::debug!(peer = peer_short, "skein/1: ignoring response on server stream");
            Ok(())
        }
    }
}

/// ensure a blob with the given blake3 hex is importable from the hub's
/// iroh-blobs store. looks the blob up in `blobz`, finds its on-disk file,
/// and adds it by reference into `FsStore` if not already present.
async fn ensure(handler: &BlobProxyHandler, blake3_hex: &str) -> (bool, Option<String>) {
    if blake3_hex.len() != 64 {
        return (
            false,
            Some(format!("expected 64-char blake3 hex, got {}", blake3_hex.len())),
        );
    }

    let blob = match handler.inner.blobz.get(blake3_hex).await {
        Ok(Some(b)) => b,
        Ok(None) => return (false, Some("unknown blake3".into())),
        Err(e) => return (false, Some(format!("blobz lookup failed: {e}"))),
    };

    let path = handler.inner.blobz.path_for(&blob);
    if !path.exists() {
        return (false, Some("blob file missing on disk".into()));
    }

    // import the file into the iroh-blobs store by reference. iroh-blobs
    // computes blake3 internally and dedupes on hash, so re-imports are
    // cheap (outboard metadata only).
    match handler.inner.store.blobs().add_path(path).await {
        Ok(_tag) => (true, None),
        Err(e) => (false, Some(format!("FsStore import failed: {e}"))),
    }
}

async fn send_response(
    send: &mut iroh::endpoint::SendStream,
    msg: &PeerMessage,
) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(msg).map_err(|e| format!("failed to serialize response: {e}"))?;
    send.write_all(&bytes)
        .await
        .map_err(|e| format!("failed to write response: {e}"))?;
    send.finish()
        .map_err(|e| format!("failed to finish stream: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// client-side helper (used by snatch)
// ---------------------------------------------------------------------------

/// send an `EnsureBlobRequest` to `peer_node_id` and return whether the peer
/// reports the blob as available.
pub async fn send_ensure_blob_request(
    endpoint: &iroh::Endpoint,
    peer_node_id: iroh::PublicKey,
    blake3_hash: &str,
) -> Result<bool, String> {
    let addr = iroh::EndpointAddr::from(peer_node_id);
    let conn = endpoint
        .connect(addr, SKEIN_ALPN)
        .await
        .map_err(|e| format!("failed to connect to peer: {e}"))?;

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("failed to open bi stream: {e}"))?;

    let request = PeerMessage::EnsureBlobRequest {
        id: 1,
        blake3_hash: blake3_hash.to_string(),
    };
    let bytes =
        serde_json::to_vec(&request).map_err(|e| format!("failed to serialize request: {e}"))?;
    send.write_all(&bytes)
        .await
        .map_err(|e| format!("failed to write request: {e}"))?;
    send.finish()
        .map_err(|e| format!("failed to finish request stream: {e}"))?;

    let response_bytes = recv
        .read_to_end(64 * 1024)
        .await
        .map_err(|e| format!("failed to read response: {e}"))?;

    let response: PeerMessage = serde_json::from_slice(&response_bytes)
        .map_err(|e| format!("failed to parse response: {e}"))?;

    match response {
        PeerMessage::EnsureBlobResponse { available, .. } => Ok(available),
        _ => Err("unexpected response type".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_blob_request_roundtrip() {
        let msg = PeerMessage::EnsureBlobRequest {
            id: 42,
            blake3_hash: "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
                .into(),
        };
        let j = serde_json::to_string(&msg).unwrap();
        assert!(j.contains("ensure_blob_request"));
        let back: PeerMessage = serde_json::from_str(&j).unwrap();
        assert!(matches!(back, PeerMessage::EnsureBlobRequest { id: 42, .. }));
    }

    #[test]
    fn ensure_blob_response_roundtrip() {
        let msg = PeerMessage::EnsureBlobResponse {
            id: 7,
            available: true,
            error: None,
        };
        let j = serde_json::to_string(&msg).unwrap();
        let back: PeerMessage = serde_json::from_str(&j).unwrap();
        assert!(matches!(
            back,
            PeerMessage::EnsureBlobResponse { available: true, .. }
        ));
    }
}
