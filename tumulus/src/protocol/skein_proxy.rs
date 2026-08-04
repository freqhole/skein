//! `skein/1` protocol handler — hub-side implementation of the
//! `proxy_request`/`proxy_response` wire protocol otherwise implemented
//! only in TypeScript (`loam/src/p2p/skein-handler.ts`, used identically by
//! both tauri and browser peers).
//!
//! the hub is pure rust with no JS runtime, so it can't run that code at
//! all — this module is a from-scratch rust implementation of the same
//! JSON-over-raw-stream wire format (see the framing note below), handling
//! only the routes the hub can usefully answer:
//!
//! - `POST /api/blobs/thumbnail_data` — generate a *real* thumbnail (image
//!   resize, or first-page render for pdf/postscript/plain text) instead of
//!   the browser-peer fallback of serving raw original bytes.
//! - `POST /api/blobs/document_pages` — render every page of a document
//!   (pdf/postscript/plain text) and insert each page as its own blob in
//!   the hub's `blobz`/`FsStore`, returning page metadata only; the actual
//!   page image bytes are then fetched by the caller through the existing
//!   `freqhole/1` ensure + `iroh-blobs/*` verified-transfer pipeline, same
//!   as any other blob — no new byte-transfer path needed.
//!
//! any other `proxy_request` path/method, and any other message `type`
//! (e.g. `compute_blake3_request`, which only makes sense for a browser's
//! own in-memory blob), gets a `404`/is ignored — this handler doesn't try
//! to be a full reimplementation of `skein-handler.ts`.
//!
//! framing: raw JSON, no length prefix. the sender writes the JSON bytes
//! and calls `finish()`; the receiver reads with `read_to_end()`. this
//! matches `freqhole_reliquary::ensure::EnsureBlobHandler`'s framing
//! exactly (see that module for the same pattern used by the `freqhole/1`
//! ALPN), and gates on hub-friend status the same way as `blob_proxy.rs`.

use std::sync::Arc;

use iroh::endpoint::{RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh_blobs::store::fs::FsStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use freqhole_reliquary::blobz::{BlobStore, NewBlobMeta};

use crate::friendz;

/// ALPN protocol identifier — must match `SKEIN_ALPN` in
/// `loam/src/p2p/iroh-network-adapter.ts` / `tauri/src/streams.rs`'s
/// `FRONTEND_ALPNS` exactly.
pub const SKEIN_PROXY_ALPN: &[u8] = b"skein/1";

/// max size of an incoming request message. requests are small (a blake3
/// hash + a couple of fields as JSON) — this is generous headroom, not a
/// tuned limit.
const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
struct ProxyRequest {
    id: u64,
    method: String,
    path: String,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProxyResponse {
    #[serde(rename = "type")]
    kind: &'static str,
    id: u64,
    status: u16,
    body: String,
}

impl ProxyResponse {
    fn new(id: u64, status: u16, body: Value) -> Self {
        Self {
            kind: "proxy_response",
            id,
            status,
            body: body.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct SkeinProxyHandler {
    inner: Arc<Inner>,
}

struct Inner {
    fs_store: &'static FsStore,
    blobz: Arc<dyn BlobStore>,
    friendz: friendz::Store,
}

impl std::fmt::Debug for SkeinProxyHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SkeinProxyHandler").finish_non_exhaustive()
    }
}

/// build the `skein/1` handler, gated on friend status (same coarse gate as
/// `blob_proxy.rs`'s `freqhole/1` handler — no per-canvas context is
/// available at this layer either).
pub fn new_handler(
    fs_store: &'static FsStore,
    blobz: Arc<dyn BlobStore>,
    friendz: friendz::Store,
) -> SkeinProxyHandler {
    SkeinProxyHandler {
        inner: Arc::new(Inner {
            fs_store,
            blobz,
            friendz,
        }),
    }
}

impl ProtocolHandler for SkeinProxyHandler {
    async fn accept(&self, conn: iroh::endpoint::Connection) -> Result<(), AcceptError> {
        let peer_id = conn.remote_id().to_string();
        let peer_short = peer_id[..16.min(peer_id.len())].to_string();

        if !self.inner.friendz.is_friend(&peer_id).await {
            tracing::debug!(peer = %peer_short, "skein/1: rejecting non-friend connection");
            return Ok(());
        }

        tracing::debug!(peer = %peer_short, "skein/1: accepted connection");

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
                if let Err(e) = handle_stream(send, recv, &handler).await {
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
    mut send: SendStream,
    mut recv: RecvStream,
    handler: &SkeinProxyHandler,
) -> Result<(), String> {
    let msg_bytes = recv
        .read_to_end(MAX_REQUEST_BYTES)
        .await
        .map_err(|e| format!("failed to read request: {e}"))?;

    // parse generically first: the wire format carries several message
    // `type`s (proxy_request, proxy_response, compute_blake3_request/
    // response) that this handler doesn't understand — a strict tagged
    // enum would fail to deserialize those instead of letting us ignore
    // them gracefully.
    let raw: Value =
        serde_json::from_slice(&msg_bytes).map_err(|e| format!("failed to parse request: {e}"))?;

    let msg_type = raw.get("type").and_then(Value::as_str).unwrap_or("");
    if msg_type != "proxy_request" {
        tracing::debug!(msg_type, "skein/1: ignoring unhandled message type");
        return Ok(());
    }

    let req: ProxyRequest =
        serde_json::from_value(raw).map_err(|e| format!("failed to parse proxy_request: {e}"))?;

    let parsed_body: Value = req
        .body
        .as_deref()
        .and_then(|b| serde_json::from_str(b).ok())
        .unwrap_or_else(|| json!({}));

    let response = match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/blobs/thumbnail_data") => {
            handle_thumbnail_data(handler, req.id, &parsed_body).await
        }
        ("POST", "/api/blobs/document_pages") => {
            handle_document_pages(handler, req.id, &parsed_body).await
        }
        (method, path) => {
            tracing::debug!(method, path, "skein/1: unhandled proxy route");
            ProxyResponse::new(
                req.id,
                404,
                json!({ "success": false, "message": "not implemented" }),
            )
        }
    };

    let body =
        serde_json::to_vec(&response).map_err(|e| format!("failed to encode response: {e}"))?;
    send.write_all(&body)
        .await
        .map_err(|e| format!("failed to write response: {e}"))?;
    send.finish()
        .map_err(|e| format!("failed to finish stream: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

fn err_response(id: u64, status: u16, message: impl Into<String>) -> ProxyResponse {
    ProxyResponse::new(
        id,
        status,
        json!({ "success": false, "message": message.into() }),
    )
}

async fn handle_thumbnail_data(
    handler: &SkeinProxyHandler,
    id: u64,
    body: &Value,
) -> ProxyResponse {
    let Some(blake3) = body
        .get("blob_id")
        .or_else(|| body.get("id"))
        .and_then(Value::as_str)
    else {
        return err_response(id, 400, "missing blob_id");
    };

    let record = match handler.inner.blobz.get(blake3).await {
        Ok(Some(r)) => r,
        Ok(None) => return err_response(id, 404, "blob not found"),
        Err(e) => return err_response(id, 500, format!("blob lookup failed: {e}")),
    };

    let path = handler.inner.blobz.path_for(&record);
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => return err_response(id, 404, format!("blob data not found on disk: {e}")),
    };

    // a manually-picked domain override wins over the (possibly wrong)
    // stored mime - retrying with the same mime that already failed
    // classification would fail identically.
    let mime_override = body.get("mime_override").and_then(Value::as_str);
    let mime = mime_override
        .unwrap_or_else(|| record.mime.as_deref().unwrap_or("application/octet-stream"));
    let size = 200u32;
    match crate::thumbnail::generate_thumbnail(&bytes, mime, record.filename.as_deref(), size).await
    {
        Ok(data) => ProxyResponse::new(id, 200, json!({ "success": true, "data": data })),
        Err(e) => err_response(id, 500, format!("thumbnail generation failed: {e}")),
    }
}

async fn handle_document_pages(
    handler: &SkeinProxyHandler,
    id: u64,
    body: &Value,
) -> ProxyResponse {
    let Some(blake3) = body
        .get("blake3")
        .or_else(|| body.get("blob_id"))
        .or_else(|| body.get("id"))
        .and_then(Value::as_str)
    else {
        return err_response(id, 400, "missing blake3");
    };

    let source_blob = match handler.inner.blobz.get(blake3).await {
        Ok(Some(r)) => r,
        Ok(None) => return err_response(id, 404, "blob not found"),
        Err(e) => return err_response(id, 500, format!("blob lookup failed: {e}")),
    };

    let format = source_blob
        .filename
        .as_deref()
        .and_then(crate::pdf::DocumentFormat::from_filename)
        .unwrap_or(crate::pdf::DocumentFormat::Pdf);

    let source_bytes = match tokio::fs::read(handler.inner.blobz.path_for(&source_blob)).await {
        Ok(b) => b,
        Err(e) => return err_response(id, 404, format!("blob data not found on disk: {e}")),
    };

    let pages = match crate::pdf::render_document_pages(&source_bytes, format).await {
        Ok(p) => p,
        Err(e) => return err_response(id, 500, format!("document render failed: {e}")),
    };

    let total_pages = pages.len() as i64;
    let stem = source_blob
        .filename
        .as_deref()
        .map(|n| match n.rsplit_once('.') {
            Some((stem, _ext)) => stem.to_string(),
            None => n.to_string(),
        })
        .unwrap_or_else(|| "document".to_string());

    let mut out = Vec::with_capacity(pages.len());
    for (idx, png_bytes) in pages.into_iter().enumerate() {
        let page_number = (idx + 1) as i64;
        let filename = Some(format!("{stem}_page_{page_number:03}.png"));

        let blob = match handler
            .inner
            .blobz
            .insert(
                &png_bytes,
                NewBlobMeta {
                    filename,
                    mime: Some("image/png".to_string()),
                    ..Default::default()
                },
            )
            .await
        {
            Ok(b) => b,
            Err(e) => return err_response(id, 500, format!("page blob insert failed: {e}")),
        };

        prewarm_fs_store(handler, &blob).await;

        out.push(json!({
            "page_blob_id": blob.blake3,
            "page_number": page_number,
            "total_pages": total_pages,
            "blake3": blob.blake3,
            "size": blob.size,
            "mime": blob.mime,
            "filename": blob.filename,
        }));
    }

    ProxyResponse::new(id, 200, json!({ "success": true, "data": out }))
}

/// best-effort: import a freshly-inserted page blob into the iroh-blobs
/// `FsStore` so the hub can serve it over verified transfer immediately —
/// same rationale as tauri's `prewarm_fs_store` in `commands.rs`.
async fn prewarm_fs_store(
    handler: &SkeinProxyHandler,
    blob: &freqhole_reliquary::blobz::BlobRecord,
) {
    let path = handler.inner.blobz.path_for(blob);
    if !path.exists() {
        tracing::warn!(blake3 = %blob.blake3, "skein/1: prewarm: blob file missing on disk");
        return;
    }
    match handler.inner.fs_store.blobs().add_path(path).await {
        Ok(_tag) => {
            tracing::debug!(blake3 = %blob.blake3, "skein/1: prewarm: imported into FsStore");
        }
        Err(e) => {
            tracing::warn!(blake3 = %blob.blake3, error = %e, "skein/1: prewarm: FsStore add_path failed");
        }
    }
}
