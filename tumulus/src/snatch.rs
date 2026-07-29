//! blob replication for the hub: wires skein's canvas/widget automerge doc
//! model onto [`freqhole_reliquary::snatch::SnatchEngine`], the generic
//! engine that scans for blob references and fetches any missing blobs
//! from peers.
//!
//! [`HubBlobRefSource`] scans automerge canvas docs for blob-bearing widgets
//! (file, audio-recording, voice-recording - see `BLOB_WIDGET_TYPES`) and
//! their widget-state docs for blake3/snatchedBy fields - the engine calls
//! it both for a full boot-time sweep and for single-doc rescans driven by
//! `hub_repo`'s doc-change notifications. [`HubPeerProbeTransport`] asks a
//! candidate peer whether it has a blob via `ensure_blob_request` over the
//! `freqhole/1` ALPN, the same handshake `protocol::blob_proxy` uses for the
//! ensure-request gate.
//!
//! this module also hosts the doc-shape helpers (`classify_doc`,
//! `read_canvas_for_file_widgets`, `read_widget_state`) that `blob_acl`'s
//! canvas-membership resolver reuses read-only to gate blobs the hub
//! already has.

use async_trait::async_trait;
use iroh::Endpoint;
use tokio::sync::broadcast;

use crate::hub_repo::HubRepo;
use crate::protocol::blob_proxy::ENSURE_ALPN;
use freqhole_reliquary::ensure::PeerMessage;
use freqhole_reliquary::snatch::{
    BlobDescriptor, BlobRefSource, PeerProbeTransport, ProbeError, SnatchEngine,
};

// ---------------------------------------------------------------------------
// blob reference — extracted from file widget state docs
// ---------------------------------------------------------------------------

/// a reference to a blob discovered in a canvas file widget.
#[derive(Debug, Clone)]
pub struct BlobRef {
    /// the canvas doc ID this widget belongs to.
    pub canvas_doc_id: String,
    /// the automerge doc ID of the file widget state.
    pub widget_doc_id: String,
    /// media blob ID (usually sha256) from the widget state.
    pub blob_id: String,
    /// blake3 content hash for verified download.
    pub blake3: String,
    /// original filename.
    pub filename: String,
    /// MIME type.
    pub mime: String,
    /// file size in bytes.
    pub size: u64,
    /// node IDs that have snatched this blob (from widget state doc).
    pub snatched_by: Vec<String>,
}

// ---------------------------------------------------------------------------
// blob-replication engine wiring
// ---------------------------------------------------------------------------

/// concrete [`SnatchEngine`] instantiation for the hub: scans automerge
/// canvas/widget docs for blob references ([`HubBlobRefSource`]) and probes
/// peers over the `freqhole/1` ALPN ([`HubPeerProbeTransport`]).
pub(crate) type HubSnatchEngine = SnatchEngine<HubBlobRefSource, HubPeerProbeTransport>;

/// where the hub's blob references live: automerge canvas docs (file
/// widgets) and their widget-state docs (the `blake3`/`snatchedBy` fields).
pub(crate) struct HubBlobRefSource {
    repo: HubRepo,
    local_node_id: String,
}

impl HubBlobRefSource {
    pub(crate) fn new(repo: HubRepo, local_node_id: String) -> Self {
        Self {
            repo,
            local_node_id,
        }
    }

    /// resolve a canvas doc into descriptors for every file widget it
    /// references, using the canvas's own peer list as the candidate-peer
    /// pool for each widget's `snatchedBy` entries.
    async fn extract_from_canvas(&self, canvas_doc_id: &str) -> Vec<BlobDescriptor> {
        let Some(handle) = self.repo.find(canvas_doc_id).await else {
            return Vec::new();
        };

        let local_node_id = self.local_node_id.clone();
        let canvas_id_owned = canvas_doc_id.to_string();
        let (placeholder_refs, peers) = tokio::task::spawn_blocking(move || {
            read_canvas_for_file_widgets(&handle, &canvas_id_owned, &local_node_id)
        })
        .await
        .unwrap_or_default();

        let mut descriptors = Vec::new();
        for placeholder in &placeholder_refs {
            let Some(whandle) = self.repo.find(&placeholder.widget_doc_id).await else {
                tracing::info!(
                    canvas = canvas_doc_id,
                    widget_doc_id = %placeholder.widget_doc_id,
                    "widget-state doc not yet synced to hub - skipping this widget for now"
                );
                continue;
            };
            let canvas_id = canvas_doc_id.to_string();
            let wdoc_id = placeholder.widget_doc_id.clone();
            let blob_ref = tokio::task::spawn_blocking(move || {
                read_widget_state(&whandle, &canvas_id, &wdoc_id)
            })
            .await
            .ok()
            .flatten();

            match blob_ref {
                None => {
                    tracing::info!(
                        canvas = canvas_doc_id,
                        widget_doc_id = %placeholder.widget_doc_id,
                        "widget-state doc has no blobId/blake3 field at all yet"
                    );
                }
                Some(blob_ref) if blob_ref.blake3.is_empty() => {
                    tracing::info!(
                        canvas = canvas_doc_id,
                        widget_doc_id = %placeholder.widget_doc_id,
                        blob_id = %blob_ref.blob_id,
                        "widget-state doc has a blobId but no blake3 yet - can't snatch without it"
                    );
                }
                Some(blob_ref) => {
                    let descriptor = to_descriptor(blob_ref, &peers, &self.local_node_id);
                    tracing::info!(
                        canvas = canvas_doc_id,
                        widget_doc_id = %placeholder.widget_doc_id,
                        blake3 = trunc(&descriptor.blake3),
                        canvas_peers = ?peers,
                        candidate_peers = ?descriptor.candidate_peers,
                        "resolved blob descriptor from canvas file widget"
                    );
                    descriptors.push(descriptor);
                }
            }
        }
        descriptors
    }

    /// resolve a widget-state doc into a single descriptor, gathering
    /// candidate peers from every canvas that references it (a widget doc
    /// change carries no canvas context of its own).
    async fn extract_from_widget_state(&self, widget_doc_id: &str) -> Vec<BlobDescriptor> {
        let Some(handle) = self.repo.find(widget_doc_id).await else {
            tracing::info!(
                widget_doc_id,
                "extract_from_widget_state: doc not found in hub repo"
            );
            return Vec::new();
        };
        let placeholder_canvas_id = String::new();
        let wid = widget_doc_id.to_string();
        let blob_ref = match tokio::task::spawn_blocking(move || {
            read_widget_state(&handle, &placeholder_canvas_id, &wid)
        })
        .await
        {
            Ok(Some(b)) if !b.blake3.is_empty() => b,
            Ok(Some(_)) => {
                tracing::info!(
                    widget_doc_id,
                    "extract_from_widget_state: doc found but blake3 is empty"
                );
                return Vec::new();
            }
            _ => {
                tracing::info!(
                    widget_doc_id,
                    "extract_from_widget_state: doc has no blobId/blake3 field at all"
                );
                return Vec::new();
            }
        };

        let peers = self.peers_referencing_widget(widget_doc_id).await;
        let descriptor = to_descriptor(blob_ref, &peers, &self.local_node_id);
        tracing::info!(
            widget_doc_id,
            blake3 = trunc(&descriptor.blake3),
            canvas_peers = ?peers,
            candidate_peers = ?descriptor.candidate_peers,
            "resolved blob descriptor from widget-state doc change"
        );
        vec![descriptor]
    }

    /// walk every doc the hub holds to find canvases that reference
    /// `widget_doc_id`, returning the union of their peer lists.
    async fn peers_referencing_widget(&self, widget_doc_id: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for canvas_doc_id in self.repo.all_doc_ids().await {
            let Some(handle) = self.repo.find(&canvas_doc_id).await else {
                continue;
            };
            let local_node_id = self.local_node_id.clone();
            let canvas_id_owned = canvas_doc_id.clone();
            let (placeholder_refs, peers) = tokio::task::spawn_blocking(move || {
                read_canvas_for_file_widgets(&handle, &canvas_id_owned, &local_node_id)
            })
            .await
            .unwrap_or_default();
            if placeholder_refs
                .iter()
                .any(|r| r.widget_doc_id == widget_doc_id)
            {
                for peer in peers {
                    if !out.contains(&peer) {
                        out.push(peer);
                    }
                }
            }
        }
        out
    }

    /// mark the local node as having snatched a widget's blob, so future
    /// scans (by this node or any peer reading the same doc) see it in
    /// `snatchedBy` without re-probing. notifies `hub_repo`'s doc-change
    /// channel on a real write so any sync-push logic subscribed to it
    /// picks up the change immediately, the same way any other mutation
    /// made outside `handle_sync_message` must.
    async fn mark_snatched(&self, widget_doc_id: &str, local_node_id: &str) {
        let Some(handle) = self.repo.find(widget_doc_id).await else {
            tracing::warn!(widget_doc_id, "cannot mark snatched: widget doc not found");
            return;
        };

        let local_id = local_node_id.to_string();
        let wdoc_id = widget_doc_id.to_string();

        let wrote = tokio::task::spawn_blocking(move || {
            handle.with_document_mut(|doc| -> bool {
                use automerge::ReadDoc;

                // get or create snatchedBy list
                let list_id = match doc.get(automerge::ROOT, "snatchedBy") {
                    Ok(Some((automerge::Value::Object(automerge::ObjType::List), id))) => id,
                    _ => {
                        // create the list via transact
                        match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
                            use automerge::transaction::Transactable;
                            tx.put_object(automerge::ROOT, "snatchedBy", automerge::ObjType::List)
                        }) {
                            Ok(result) => result.result,
                            Err(e) => {
                                tracing::warn!(error = ?e, "failed to create snatchedBy list");
                                return false;
                            }
                        }
                    }
                };

                // check if already in the list
                let len = doc.length(&list_id);
                for i in 0..len {
                    if let Ok(Some((v, _))) = doc.get(&list_id, i) {
                        if v.to_str() == Some(&local_id) {
                            tracing::debug!(widget_doc_id = %wdoc_id, "already in snatchedBy");
                            return false;
                        }
                    }
                }

                // append our node ID via transact
                match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
                    use automerge::transaction::Transactable;
                    tx.insert(&list_id, len as usize, local_id.as_str())?;
                    Ok(())
                }) {
                    Ok(_) => {
                        tracing::info!(
                            widget_doc_id = %wdoc_id,
                            node_id = trunc(&local_id),
                            "added self to snatchedBy"
                        );
                        true
                    }
                    Err(e) => {
                        tracing::warn!(error = ?e, "failed to add node ID to snatchedBy");
                        false
                    }
                }
            })
        })
        .await
        .unwrap_or(false);

        if wrote {
            self.repo.notify_doc_changed(widget_doc_id);
        }
    }
}

/// combine a raw widget-doc [`BlobRef`] with its canvas peer list into a
/// generic [`BlobDescriptor`]: candidate peers are whichever `snatchedBy`
/// entries are also members of the canvas peer list (excluding ourselves) -
/// peers who confirmed they have the blob and are actually reachable
/// through this canvas. an empty result here is not a dead end: the engine
/// falls back to its own peer-blob-inventory (fed by `offer_peer_blobs`)
/// when a descriptor arrives with no candidate peers of its own.
fn to_descriptor(
    blob_ref: BlobRef,
    canvas_peers: &[String],
    local_node_id: &str,
) -> BlobDescriptor {
    let candidate_peers = blob_ref
        .snatched_by
        .iter()
        .filter(|node_id| canvas_peers.contains(node_id) && node_id.as_str() != local_node_id)
        .cloned()
        .collect();
    BlobDescriptor {
        blake3: blob_ref.blake3,
        filename: blob_ref.filename,
        mime: blob_ref.mime,
        size: blob_ref.size,
        candidate_peers,
        source_ref: blob_ref.widget_doc_id,
    }
}

#[async_trait]
impl BlobRefSource for HubBlobRefSource {
    async fn all_doc_ids(&self) -> Vec<String> {
        self.repo.all_doc_ids().await
    }

    fn subscribe_changes(&self) -> broadcast::Receiver<String> {
        self.repo.subscribe_doc_changes()
    }

    async fn extract_from_doc(&self, doc_id: &str) -> Vec<BlobDescriptor> {
        let Some(handle) = self.repo.find(doc_id).await else {
            return Vec::new();
        };
        let kind = {
            let h = handle.clone();
            tokio::task::spawn_blocking(move || classify_doc(&h))
                .await
                .unwrap_or(DocKind::Unknown)
        };
        match kind {
            DocKind::Canvas => self.extract_from_canvas(doc_id).await,
            DocKind::WidgetState => self.extract_from_widget_state(doc_id).await,
            DocKind::Unknown => Vec::new(),
        }
    }

    async fn on_snatched(&self, descriptor: &BlobDescriptor, local_node_id: &str) {
        self.mark_snatched(&descriptor.source_ref, local_node_id)
            .await;
    }
}

/// probes a peer for blob availability over the `freqhole/1` ALPN
/// (`ensure_blob_request`/`ensure_blob_response`), the same handshake
/// `protocol::blob_proxy` uses for the ensure-request gate.
pub(crate) struct HubPeerProbeTransport {
    endpoint: Endpoint,
}

impl HubPeerProbeTransport {
    pub(crate) fn new(endpoint: Endpoint) -> Self {
        Self { endpoint }
    }
}

#[async_trait]
impl PeerProbeTransport for HubPeerProbeTransport {
    async fn probe(&self, peer_node_id: &str, blake3: &str) -> Result<bool, ProbeError> {
        probe_single_peer(&self.endpoint, peer_node_id, blake3)
            .await
            .map_err(|e| match e {
                SnatchError::Connection(msg) => ProbeError::Connection(msg),
                other => ProbeError::Protocol(other.to_string()),
            })
    }
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/// errors that can occur during blob snatching.
#[derive(Debug, thiserror::Error)]
pub enum SnatchError {
    #[error("blob has no blake3 hash")]
    NoBlake3,

    #[error("no canvas peers to probe")]
    NoPeers,

    #[error("no peer has the requested blob")]
    NoPeerHasBlob,

    #[error("probe timed out")]
    ProbeTimeout,

    #[error("invalid blake3 hash: {0}")]
    InvalidHash(String),

    #[error("invalid node ID: {0}")]
    InvalidNodeId(String),

    #[error("download failed: {0}")]
    DownloadFailed(String),

    #[error("download timed out")]
    DownloadTimeout,

    #[error("failed to read blob from store: {0}")]
    StoreRead(String),

    #[error("failed to ingest blob: {0}")]
    Ingest(String),

    #[error("connection failed: {0}")]
    Connection(String),

    #[error("protocol error: {0}")]
    Protocol(String),
}

// ---------------------------------------------------------------------------
// free functions
// ---------------------------------------------------------------------------

/// truncate a string for logging (first 16 chars).
fn trunc(s: &str) -> &str {
    if s.len() > 16 {
        &s[..16]
    } else {
        s
    }
}

/// send `ensure_blob_request` to a single peer over the `freqhole/1` ALPN.
///
/// returns `true` if the peer has the blob and it's now available for download.
async fn probe_single_peer(
    endpoint: &Endpoint,
    peer_node_id: &str,
    blake3_hash: &str,
) -> Result<bool, SnatchError> {
    let node_id: iroh::PublicKey = peer_node_id
        .parse()
        .map_err(|e| SnatchError::InvalidNodeId(format!("{e}")))?;

    let addr = iroh::EndpointAddr::from(node_id);

    let conn = endpoint
        .connect(addr, ENSURE_ALPN)
        .await
        .map_err(|e| SnatchError::Connection(format!("{e}")))?;

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| SnatchError::Connection(format!("open_bi: {e}")))?;

    // send ensure request
    let request = PeerMessage::EnsureBlobRequest {
        id: 1,
        blake3_hash: blake3_hash.to_string(),
    };
    let bytes = serde_json::to_vec(&request)
        .map_err(|e| SnatchError::Protocol(format!("serialize: {e}")))?;
    send.write_all(&bytes)
        .await
        .map_err(|e| SnatchError::Protocol(format!("write: {e}")))?;
    send.finish()
        .map_err(|e| SnatchError::Protocol(format!("finish: {e}")))?;

    // read response
    let response_bytes = recv
        .read_to_end(64 * 1024)
        .await
        .map_err(|e| SnatchError::Protocol(format!("read: {e}")))?;

    let response: PeerMessage = serde_json::from_slice(&response_bytes)
        .map_err(|e| SnatchError::Protocol(format!("deserialize: {e}")))?;

    match response {
        PeerMessage::EnsureBlobResponse {
            available, error, ..
        } => {
            if let Some(err) = error {
                tracing::debug!(
                    peer = trunc(peer_node_id),
                    error = %err,
                    "ensure_blob error"
                );
                return Ok(false);
            }
            Ok(available)
        }
        _ => Err(SnatchError::Protocol(
            "unexpected response type".to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// automerge doc reading (sync — runs in spawn_blocking)
// ---------------------------------------------------------------------------

/// classify a hub-repo doc by inspecting its top-level shape.
///
/// canvases have a `widgets` map and usually a `peers` map. file widget
/// state docs have a `blake3` field at the root. anything else is unknown.
///
/// `pub(crate)`: also used by `blob_acl`'s canvas-membership resolver, which
/// needs to tell canvas docs apart from widget-state docs the same way this
/// module does, without duplicating the classification logic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DocKind {
    Canvas,
    WidgetState,
    Unknown,
}

pub(crate) fn classify_doc(handle: &crate::hub_repo::DocHandle) -> DocKind {
    use automerge::ReadDoc;
    let mut kind = DocKind::Unknown;
    handle.with_document(|doc| {
        // skip deleted canvases — treat as unknown so we don't try to scan them
        if let Ok(Some((automerge::Value::Scalar(s), _))) = doc.get(automerge::ROOT, "deleted") {
            if s.as_ref() == &automerge::ScalarValue::Boolean(true) {
                return;
            }
        }
        if matches!(
            doc.get(automerge::ROOT, "widgets"),
            Ok(Some((automerge::Value::Object(automerge::ObjType::Map), _)))
        ) {
            kind = DocKind::Canvas;
            return;
        }
        // a widget state doc has blake3 (or at minimum blobId) at the root
        let blake3 = read_str(doc, &automerge::ROOT, "blake3");
        let blob_id = read_str(doc, &automerge::ROOT, "blobId");
        if !blake3.is_empty() || !blob_id.is_empty() {
            kind = DocKind::WidgetState;
        }
    });
    kind
}

/// widget types whose state doc may carry a blob reference (`blobId`/
/// `blake3`) that the hub should discover, snatch/replicate, and gate via
/// `blob_acl`. keep this in sync with the client-side widget schemas (loam's
/// `widgets/file.ts`, `widgets/audio-recording.ts`, `widgets/voice-recording.ts`)
/// — a future blob-backed widget type needs to be added here too, or its
/// widget-state docs are silently skipped by the scan below and the hub
/// never proxies/mirrors its blobs.
const BLOB_WIDGET_TYPES: &[&str] = &["file", "audio-recording", "voice-recording"];

/// read a canvas automerge doc to find blob-bearing widget docIds (file,
/// audio-recording, voice-recording — see `BLOB_WIDGET_TYPES`) and peer node
/// IDs.
///
/// returns placeholder BlobRefs (only canvas_doc_id + widget_doc_id populated)
/// plus the list of peer node IDs from the canvas peers map.
///
/// `pub(crate)`: also used by `blob_acl`'s canvas-membership resolver to
/// find which widget docs a canvas references, read-only (it never snatches
/// anything) — reusing this instead of a second, drifting copy of the same
/// widgets-map walk.
pub(crate) fn read_canvas_for_file_widgets(
    handle: &crate::hub_repo::DocHandle,
    canvas_doc_id: &str,
    local_node_id: &str,
) -> (Vec<BlobRef>, Vec<String>) {
    use automerge::ReadDoc;

    let mut widget_doc_ids: Vec<String> = Vec::new();
    let mut peers: Vec<String> = Vec::new();

    handle.with_document(|doc| {
        // skip deleted canvases
        if let Ok(Some((automerge::Value::Scalar(s), _))) = doc.get(automerge::ROOT, "deleted") {
            if s.as_ref() == &automerge::ScalarValue::Boolean(true) {
                return;
            }
        }

        // extract peer node IDs from the "peers" map
        if let Ok(Some((_, peers_obj))) = doc.get(automerge::ROOT, "peers") {
            for key in doc.keys(&peers_obj) {
                let node_id = key.to_string();
                if node_id != local_node_id && !node_id.is_empty() {
                    peers.push(node_id);
                }
            }
        }

        // find blob-bearing widgets in the "widgets" map
        if let Ok(Some((_, widgets_obj))) = doc.get(automerge::ROOT, "widgets") {
            for key in doc.keys(&widgets_obj) {
                let key_str: &str = &key;
                if let Ok(Some((_, widget_obj))) = doc.get(&widgets_obj, key_str) {
                    // check widget type
                    let widget_type = read_str(doc, &widget_obj, "type");
                    if !BLOB_WIDGET_TYPES.contains(&widget_type.as_str()) {
                        continue;
                    }

                    // get the docId pointing to the widget state doc
                    let doc_id = read_str(doc, &widget_obj, "docId");
                    if !doc_id.is_empty() {
                        widget_doc_ids.push(doc_id);
                    }
                }
            }
        }
    });

    if widget_doc_ids.is_empty() {
        tracing::trace!(
            canvas = canvas_doc_id,
            blob_widgets = 0,
            peers = peers.len(),
            "scanned canvas for blob widgets"
        );
    } else {
        tracing::info!(
            canvas = canvas_doc_id,
            blob_widgets = widget_doc_ids.len(),
            peers = peers.len(),
            "scanned canvas for blob widgets"
        );
    }

    // return placeholder BlobRefs — only widget_doc_id is filled in.
    // the caller resolves each widget doc into a full BlobRef.
    let placeholder_refs: Vec<BlobRef> = widget_doc_ids
        .into_iter()
        .map(|wid| BlobRef {
            canvas_doc_id: canvas_doc_id.to_string(),
            widget_doc_id: wid,
            blob_id: String::new(),
            blake3: String::new(),
            filename: String::new(),
            mime: String::new(),
            size: 0,
            snatched_by: Vec::new(),
        })
        .collect();

    (placeholder_refs, peers)
}

/// read a blob-bearing widget state doc to extract blob reference fields.
///
/// `pub(crate)`: also used by `blob_acl`'s canvas-membership resolver to
/// read a widget doc's `blake3` field when checking whether a given blob is
/// referenced by a given canvas.
pub(crate) fn read_widget_state(
    handle: &crate::hub_repo::DocHandle,
    canvas_doc_id: &str,
    widget_doc_id: &str,
) -> Option<BlobRef> {
    let mut result: Option<BlobRef> = None;

    handle.with_document(|doc| {
        use automerge::ReadDoc;

        let blob_id = read_str(doc, &automerge::ROOT, "blobId");
        let blake3 = read_str(doc, &automerge::ROOT, "blake3");

        // skip widgets with no blob reference
        if blob_id.is_empty() && blake3.is_empty() {
            return;
        }

        // read snatchedBy — an automerge list of string node IDs.
        //
        // list elements may be stored either as plain scalar strings or as
        // automerge Text objects (the JS automerge proxy stores array-of-string
        // assignments like `doc.snatchedBy = [nodeId]` as Text elements, not
        // scalars) — handle both, mirroring read_str()'s scalar-vs-Text
        // handling for top-level fields.
        let snatched_by = {
            let mut items = Vec::new();
            if let Ok(Some((automerge::Value::Object(automerge::ObjType::List), list_id))) =
                doc.get(automerge::ROOT, "snatchedBy")
            {
                for i in 0..doc.length(&list_id) {
                    if let Ok(Some((v, item_id))) = doc.get(&list_id, i) {
                        match v {
                            automerge::Value::Object(automerge::ObjType::Text) => {
                                if let Ok(s) = doc.text(&item_id) {
                                    items.push(s);
                                }
                            }
                            _ => {
                                if let Some(s) = v.to_str() {
                                    items.push(s.to_string());
                                }
                            }
                        }
                    }
                }
            }
            items
        };

        result = Some(BlobRef {
            canvas_doc_id: canvas_doc_id.to_string(),
            widget_doc_id: widget_doc_id.to_string(),
            blob_id,
            blake3,
            filename: read_str(doc, &automerge::ROOT, "filename"),
            mime: read_str(doc, &automerge::ROOT, "mime"),
            size: read_u64(doc, &automerge::ROOT, "size"),
            snatched_by,
        });
    });

    result
}

/// helper: read a string field from an automerge object.
/// handles both scalar strings and Text objects (JS automerge stores strings as Text).
fn read_str(doc: &automerge::Automerge, obj: &automerge::ObjId, key: &str) -> String {
    use automerge::ReadDoc;
    match doc.get(obj, key) {
        Ok(Some((automerge::Value::Object(automerge::ObjType::Text), text_id))) => {
            doc.text(&text_id).unwrap_or_default()
        }
        Ok(Some((v, _))) => v.to_str().map(|s| s.to_string()).unwrap_or_default(),
        _ => String::new(),
    }
}

/// helper: read a u64 field from an automerge object.
fn read_u64(doc: &automerge::Automerge, obj: &automerge::ObjId, key: &str) -> u64 {
    use automerge::ReadDoc;
    doc.get(obj, key)
        .ok()
        .flatten()
        .and_then(|(v, _)| v.to_u64())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blob_ref_defaults() {
        let br = BlobRef {
            canvas_doc_id: "abc".to_string(),
            widget_doc_id: "def".to_string(),
            blob_id: String::new(),
            blake3: String::new(),
            filename: "test.txt".to_string(),
            mime: "text/plain".to_string(),
            size: 42,
            snatched_by: Vec::new(),
        };
        assert_eq!(br.size, 42);
        assert!(br.blake3.is_empty());
    }

    #[test]
    fn test_snatch_error_display() {
        let e = SnatchError::NoBlake3;
        assert_eq!(e.to_string(), "blob has no blake3 hash");

        let e = SnatchError::NoPeers;
        assert_eq!(e.to_string(), "no canvas peers to probe");

        let e = SnatchError::DownloadFailed("timeout".to_string());
        assert_eq!(e.to_string(), "download failed: timeout");
    }

    #[test]
    fn test_trunc() {
        assert_eq!(trunc("abcdefghijklmnopqrstuvwxyz"), "abcdefghijklmnop");
        assert_eq!(trunc("short"), "short");
        assert_eq!(trunc(""), "");
    }

    #[test]
    fn test_check_empty_blob_ref() {
        // blob ref with no identifiers should not crash trunc
        let br = BlobRef {
            canvas_doc_id: String::new(),
            widget_doc_id: String::new(),
            blob_id: String::new(),
            blake3: String::new(),
            filename: String::new(),
            mime: String::new(),
            size: 0,
            snatched_by: Vec::new(),
        };
        assert_eq!(trunc(&br.blake3), "");
        assert_eq!(trunc(&br.blob_id), "");
    }

    /// a canvas with file/audio-recording/voice-recording widgets should have
    /// all three discovered for blob replication; a non-blob widget type
    /// (canvas-card) should be skipped. regression test for the hub silently
    /// never proxying/snatching audio and voice recording blobs because the
    /// scan used to hardcode `widget_type != "file"`.
    #[tokio::test]
    async fn read_canvas_for_file_widgets_includes_audio_and_voice_widgets() {
        use automerge::transaction::Transactable;

        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub.db");

        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");

        let mut canvas_doc = automerge::Automerge::new();
        canvas_doc
            .transact::<_, _, automerge::AutomergeError>(|tx| {
                let widgets = tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;

                let file_widget = tx.put_object(&widgets, "w1", automerge::ObjType::Map)?;
                tx.put(&file_widget, "type", "file")?;
                tx.put(&file_widget, "docId", "file-widget-doc")?;

                let audio_widget = tx.put_object(&widgets, "w2", automerge::ObjType::Map)?;
                tx.put(&audio_widget, "type", "audio-recording")?;
                tx.put(&audio_widget, "docId", "audio-widget-doc")?;

                let voice_widget = tx.put_object(&widgets, "w3", automerge::ObjType::Map)?;
                tx.put(&voice_widget, "type", "voice-recording")?;
                tx.put(&voice_widget, "docId", "voice-widget-doc")?;

                // non-blob widget type — should be skipped by the scan.
                let card_widget = tx.put_object(&widgets, "w4", automerge::ObjType::Map)?;
                tx.put(&card_widget, "type", "canvas-card")?;
                tx.put(&card_widget, "docId", "card-widget-doc")?;

                Ok(())
            })
            .expect("canvas doc transact should succeed");
        storage.save_doc("canvas-1", &canvas_doc.save()).await;

        let repo = HubRepo::new("local-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");
        let handle = repo
            .find("canvas-1")
            .await
            .expect("canvas doc should be findable");

        // `read_canvas_for_file_widgets` uses `DocHandle::with_document`'s
        // `blocking_read()` internally, which panics if called directly on
        // a tokio runtime thread — run it via `spawn_blocking`, same as the
        // real callers (`extract_from_canvas`, `blob_acl`'s resolver) do.
        let (refs, _peers) = tokio::task::spawn_blocking(move || {
            read_canvas_for_file_widgets(&handle, "canvas-1", "local-node")
        })
        .await
        .expect("spawn_blocking should not panic");
        let widget_doc_ids: Vec<&str> = refs.iter().map(|r| r.widget_doc_id.as_str()).collect();

        assert!(widget_doc_ids.contains(&"file-widget-doc"));
        assert!(widget_doc_ids.contains(&"audio-widget-doc"));
        assert!(widget_doc_ids.contains(&"voice-widget-doc"));
        assert!(!widget_doc_ids.contains(&"card-widget-doc"));
        assert_eq!(widget_doc_ids.len(), 3);
    }
}
