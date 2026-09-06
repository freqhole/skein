//! blob replication for the hub: wires skein's canvas/widget automerge doc
//! model onto [`freqhole_reliquary::snatch::SnatchEngine`], the generic
//! engine that scans for blob references and fetches any missing blobs
//! from peers.
//!
//! [`HubBlobRefSource`] scans automerge canvas docs for blob-bearing widgets
//! (file, audio-recording, voice-recording, animaniac - see
//! `BLOB_WIDGET_TYPES`) and their widget-state docs for blake3/snatchedBy
//! fields - the engine calls it both for a full boot-time sweep and for
//! single-doc rescans driven by `hub_repo`'s doc-change notifications.
//! [`HubPeerProbeTransport`] asks a candidate peer whether it has a blob via
//! `ensure_blob_request` over the `freqhole/1` ALPN, the same handshake
//! `protocol::blob_proxy` uses for the ensure-request gate.
//!
//! most widget types carry exactly one blob at their state doc's root
//! (`blobId`/`blake3`/`snatchedBy`). `animaniac` is the one exception: its
//! state doc holds a `clips[]` array, each clip potentially carrying its
//! OWN blob (and its own `snatchedBy` list nested inside that clip, not at
//! the doc root) - see `read_widget_state()`'s own doc comment for how a
//! `BlobRef`'s optional `clip_id` and `to_descriptor()`'s composite
//! `"{widget_doc_id}#clip={clip_id}"` `source_ref` encoding thread this
//! through the otherwise blob-per-doc-shaped engine without needing any
//! upstream change to `freqhole_reliquary::snatch` itself (`source_ref` is
//! already a fully opaque, app-defined string as far as the engine cares).
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
    /// the automerge doc ID of the widget state doc holding this blob
    /// reference. for an `animaniac` clip this is the animaniac doc's own
    /// id (NOT a per-clip doc — clips are not separate automerge docs).
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
    /// set only for a blob living inside one of `animaniac`'s `clips[]`
    /// entries — identifies WHICH clip (by its own `id` field) within
    /// `widget_doc_id`'s doc this blob reference came from, since several
    /// clips (each with their own blob + own nested `snatchedBy` list) can
    /// share the same widget doc. `None` for every other blob-bearing
    /// widget type, which carry exactly one blob at their doc's root.
    pub clip_id: Option<String>,
    /// true for an applied gain-adjustment rendition (see loam's
    /// `voice-recording.ts`/`audio-recording.ts`/`file.ts`/animaniac's own
    /// `gainRenditionBlobId` field) — a SEPARATE blob from the widget/clip's
    /// own primary one, tracked in its own `gainRenditionSnatchedBy` list
    /// (never the primary blob's `snatchedBy`, since a peer who only ever
    /// fetched the original shouldn't be reported as having the rendition
    /// too). affects only which doc field(s) `read_widget_state()`/
    /// `mark_snatched()` read from/write to — everything else about a
    /// rendition `BlobRef` looks like any other.
    pub is_gain_rendition: bool,
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
            let blob_refs = tokio::task::spawn_blocking(move || {
                read_widget_state(&whandle, &canvas_id, &wdoc_id)
            })
            .await
            .unwrap_or_default();

            if blob_refs.is_empty() {
                tracing::info!(
                    canvas = canvas_doc_id,
                    widget_doc_id = %placeholder.widget_doc_id,
                    "widget-state doc has no blob reference(s) at all yet"
                );
                continue;
            }

            for blob_ref in blob_refs {
                if blob_ref.blake3.is_empty() {
                    tracing::info!(
                        canvas = canvas_doc_id,
                        widget_doc_id = %placeholder.widget_doc_id,
                        blob_id = %blob_ref.blob_id,
                        clip_id = ?blob_ref.clip_id,
                        "widget-state doc has a blobId but no blake3 yet - can't snatch without it"
                    );
                    continue;
                }
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
        descriptors
    }

    /// resolve a widget-state doc into a single descriptor, gathering
    /// candidate peers from every canvas that references it (a widget doc
    /// change carries no canvas context of its own). may resolve to
    /// several descriptors for one doc (`animaniac`'s `clips[]` shape).
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
        let blob_refs: Vec<BlobRef> = tokio::task::spawn_blocking(move || {
            read_widget_state(&handle, &placeholder_canvas_id, &wid)
        })
        .await
        .unwrap_or_default();

        if blob_refs.is_empty() {
            tracing::info!(
                widget_doc_id,
                "extract_from_widget_state: doc has no blob reference(s) at all"
            );
            return Vec::new();
        }

        let peers = self.peers_referencing_widget(widget_doc_id).await;
        let mut descriptors = Vec::new();
        for blob_ref in blob_refs {
            if blob_ref.blake3.is_empty() {
                tracing::info!(
                    widget_doc_id,
                    clip_id = ?blob_ref.clip_id,
                    "extract_from_widget_state: blob reference found but blake3 is empty"
                );
                continue;
            }
            let descriptor = to_descriptor(blob_ref, &peers, &self.local_node_id);
            tracing::info!(
                widget_doc_id,
                blake3 = trunc(&descriptor.blake3),
                canvas_peers = ?peers,
                candidate_peers = ?descriptor.candidate_peers,
                "resolved blob descriptor from widget-state doc change"
            );
            descriptors.push(descriptor);
        }
        descriptors
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

    /// mark the local node as having snatched a blob, so future scans (by
    /// this node or any peer reading the same doc) see it in the relevant
    /// `snatchedBy`-shaped list without re-probing. `source_ref` is decoded
    /// in two stages: an optional trailing `#gain` (see `to_descriptor()`'s
    /// own doc comment) selects `gainRenditionSnatchedBy` over the default
    /// `snatchedBy` field name, THEN the remainder is checked for the
    /// animaniac composite `"{widget_doc_id}#clip={clip_id}"` shape (writes
    /// to that one clip's own nested list) vs a plain widget doc id (every
    /// other widget type — writes to the doc's own root list).
    async fn mark_snatched(&self, source_ref: &str, local_node_id: &str) {
        let (base_ref, field) = match source_ref.strip_suffix("#gain") {
            Some(base) => (base, "gainRenditionSnatchedBy"),
            None => (source_ref, "snatchedBy"),
        };
        match decode_clip_source_ref(base_ref) {
            Some((widget_doc_id, clip_id)) => {
                self.mark_clip_snatched(widget_doc_id, clip_id, local_node_id, field)
                    .await
            }
            None => {
                self.mark_widget_snatched(base_ref, local_node_id, field)
                    .await
            }
        }
    }

    /// the pre-animaniac behavior: writes to `widget_doc_id`'s own doc-root
    /// `field` list (`snatchedBy`, or `gainRenditionSnatchedBy` for a gain
    /// rendition — see `mark_snatched()`'s own doc comment).
    async fn mark_widget_snatched(
        &self,
        widget_doc_id: &str,
        local_node_id: &str,
        field: &'static str,
    ) {
        let Some(handle) = self.repo.find(widget_doc_id).await else {
            tracing::warn!(widget_doc_id, "cannot mark snatched: widget doc not found");
            return;
        };

        let local_id = local_node_id.to_string();
        let wdoc_id = widget_doc_id.to_string();

        let wrote = tokio::task::spawn_blocking(move || {
            handle.with_document_mut(|doc| -> bool {
                append_to_snatched_by(doc, &automerge::ROOT, &wdoc_id, &local_id, field)
            })
        })
        .await
        .unwrap_or(false);

        if wrote {
            self.repo.notify_doc_changed(widget_doc_id);
        }
    }

    /// the animaniac case: finds the clip with a matching `id` inside
    /// `widget_doc_id`'s own `clips[]` list and writes to THAT clip's own
    /// nested `field` list (`snatchedBy`, or `gainRenditionSnatchedBy` for a
    /// gain rendition), leaving the doc root (which has no blob field of
    /// its own) and every other clip untouched.
    async fn mark_clip_snatched(
        &self,
        widget_doc_id: &str,
        clip_id: &str,
        local_node_id: &str,
        field: &'static str,
    ) {
        let Some(handle) = self.repo.find(widget_doc_id).await else {
            tracing::warn!(
                widget_doc_id,
                "cannot mark clip snatched: widget doc not found"
            );
            return;
        };

        let local_id = local_node_id.to_string();
        let wdoc_id = widget_doc_id.to_string();
        let target_clip_id = clip_id.to_string();

        let wrote = tokio::task::spawn_blocking(move || {
            handle.with_document_mut(|doc| -> bool {
                use automerge::ReadDoc;

                let Ok(Some((automerge::Value::Object(automerge::ObjType::List), clips_id))) = doc.get(automerge::ROOT, "clips") else {
                    tracing::warn!(widget_doc_id = %wdoc_id, "cannot mark clip snatched: doc has no clips list");
                    return false;
                };

                let mut clip_obj_id = None;
                for i in 0..doc.length(&clips_id) {
                    if let Ok(Some((_, item_id))) = doc.get(&clips_id, i) {
                        if read_str(doc, &item_id, "id") == target_clip_id {
                            clip_obj_id = Some(item_id);
                            break;
                        }
                    }
                }
                let Some(clip_obj_id) = clip_obj_id else {
                    tracing::warn!(widget_doc_id = %wdoc_id, clip_id = %target_clip_id, "cannot mark clip snatched: clip id not found");
                    return false;
                };

                append_to_snatched_by(doc, &clip_obj_id, &wdoc_id, &local_id, field)
            })
        })
        .await
        .unwrap_or(false);

        if wrote {
            self.repo.notify_doc_changed(widget_doc_id);
        }
    }
}

/// get-or-create `obj`'s own `field`-named list and append `local_id` if
/// it isn't already present. `obj` is either `automerge::ROOT` (every
/// widget type except animaniac) or one specific clip's own object id
/// (animaniac) — shared by `mark_widget_snatched()`/`mark_clip_snatched()`
/// so the two only differ in WHICH object they point this at. `field` is
/// `"snatchedBy"` or `"gainRenditionSnatchedBy"` (see `mark_snatched()`'s
/// own doc comment) — the two are always separate lists, never merged.
fn append_to_snatched_by(
    doc: &mut automerge::Automerge,
    obj: &automerge::ObjId,
    log_widget_doc_id: &str,
    local_id: &str,
    field: &str,
) -> bool {
    use automerge::ReadDoc;

    let list_id = match doc.get(obj, field) {
        Ok(Some((automerge::Value::Object(automerge::ObjType::List), id))) => id,
        _ => match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            tx.put_object(obj, field, automerge::ObjType::List)
        }) {
            Ok(result) => result.result,
            Err(e) => {
                tracing::warn!(error = ?e, field, "failed to create snatched-by list");
                return false;
            }
        },
    };

    let len = doc.length(&list_id);
    for i in 0..len {
        if let Ok(Some((v, _))) = doc.get(&list_id, i) {
            if v.to_str() == Some(local_id) {
                tracing::debug!(widget_doc_id = %log_widget_doc_id, field, "already in snatched-by list");
                return false;
            }
        }
    }

    match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
        use automerge::transaction::Transactable;
        tx.insert(&list_id, len as usize, local_id)?;
        Ok(())
    }) {
        Ok(_) => {
            tracing::info!(widget_doc_id = %log_widget_doc_id, node_id = trunc(local_id), field, "added self to snatched-by list");
            true
        }
        Err(e) => {
            tracing::warn!(error = ?e, field, "failed to add node ID to snatched-by list");
            false
        }
    }
}

/// decodes a `to_descriptor()`-produced `source_ref` back into
/// `(widget_doc_id, clip_id)` if it's the animaniac-clip composite shape,
/// or `None` for a plain widget doc id (every other widget type). callers
/// strip any trailing `#gain` suffix first — see `mark_snatched()`'s own
/// doc comment.
fn decode_clip_source_ref(source_ref: &str) -> Option<(&str, &str)> {
    source_ref.split_once("#clip=")
}

/// combine a raw widget-doc [`BlobRef`] with its canvas peer list into a
/// generic [`BlobDescriptor`]: candidate peers are whichever `snatchedBy`
/// entries are also members of the canvas peer list (excluding ourselves) -
/// peers who confirmed they have the blob and are actually reachable
/// through this canvas. an empty result here is not a dead end: the engine
/// falls back to its own peer-blob-inventory (fed by `offer_peer_blobs`)
/// when a descriptor arrives with no candidate peers of its own.
///
/// `source_ref` is a fully opaque handle as far as [`SnatchEngine`] is
/// concerned (it's only ever handed back verbatim to
/// [`BlobRefSource::on_snatched`]) — for an animaniac clip (`blob_ref.
/// clip_id.is_some()`) it's encoded as `"{widget_doc_id}#clip={clip_id}"`;
/// every other widget type keeps the plain `widget_doc_id` it always used.
/// either shape then gets a trailing `#gain` appended for a gain-rendition
/// `BlobRef` (`blob_ref.is_gain_rendition`), so `mark_snatched()` can tell
/// it apart from the SAME widget/clip's primary blob and write to the
/// right (separate) snatched-by list.
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
    let base_ref = match &blob_ref.clip_id {
        Some(clip_id) => format!("{}#clip={}", blob_ref.widget_doc_id, clip_id),
        None => blob_ref.widget_doc_id.clone(),
    };
    let source_ref = if blob_ref.is_gain_rendition {
        format!("{}#gain", base_ref)
    } else {
        base_ref
    };
    BlobDescriptor {
        blake3: blob_ref.blake3,
        filename: blob_ref.filename,
        mime: blob_ref.mime,
        size: blob_ref.size,
        candidate_peers,
        source_ref,
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
            return;
        }
        // an `animaniac` widget state doc has no root-level blob field at
        // all — its blobs live inside `clips[]` entries instead (see
        // `read_widget_state()`'s own doc comment) — detect it by the
        // presence of that list so `HubBlobRefSource::extract_from_doc()`'s
        // dispatch on a live doc-change notification still routes an
        // already-known animaniac doc's OWN edits (e.g. a new clip added)
        // through `extract_from_widget_state()` instead of silently
        // falling into `DocKind::Unknown` and never rescanning.
        if matches!(
            doc.get(automerge::ROOT, "clips"),
            Ok(Some((
                automerge::Value::Object(automerge::ObjType::List),
                _
            )))
        ) {
            kind = DocKind::WidgetState;
        }
    });
    kind
}

/// widget types whose state doc may carry a blob reference (`blobId`/
/// `blake3` at the root, or — for `animaniac` — inside its `clips[]` array)
/// that the hub should discover, snatch/replicate, and gate via `blob_acl`.
/// keep this in sync with the client-side widget schemas (loam's
/// `widgets/file.ts`, `widgets/audio-recording.ts`, `widgets/voice-
/// recording.ts`, `widgets/animaniac/types.ts`) — a future blob-backed
/// widget type needs to be added here too, or its widget-state docs are
/// silently skipped by the scan below and the hub never proxies/mirrors
/// its blobs.
const BLOB_WIDGET_TYPES: &[&str] = &["file", "audio-recording", "voice-recording", "animaniac"];

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
    // the caller resolves each widget doc into full BlobRef(s) — possibly
    // more than one per widget doc for `animaniac` (see `read_widget_state`).
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
            clip_id: None,
            is_gain_rendition: false,
        })
        .collect();

    (placeholder_refs, peers)
}

/// read a blob-bearing widget state doc to extract every blob reference it
/// carries.
///
/// almost every widget type carries exactly one blob at the doc's own root
/// (`blobId`/`blake3`/`snatchedBy`) and this returns a single-element vec
/// for those. `animaniac` is the exception: its doc has no root-level blob
/// field at all — instead it holds a `clips[]` list, where each clip MAY
/// carry its own blob (`imageUrl` for doodle-frame/image, `audioBlobId`/
/// `audioBlake3` for voice-recording/tts/audio-segment, `videoBlobId`/
/// `videoBlake3` for video-segment; `label` clips have no blob at all) plus
/// its own `snatchedBy` list NESTED inside that clip (not at the doc root,
/// since several clips sharing one doc each need their own independent
/// snatched-tracking). those entries come back with `clip_id: Some(..)`
/// set to the clip's own `id` field — see `to_descriptor()`'s composite
/// `source_ref` encoding and `HubBlobRefSource::mark_snatched()`'s
/// corresponding decode for how the rest of the (otherwise one-blob-per-doc
/// shaped) engine handles this without any change to it.
///
/// `pub(crate)`: also used by `blob_acl`'s canvas-membership resolver to
/// read a widget doc's blake3 field(s) when checking whether a given blob
/// is referenced by a given canvas.
pub(crate) fn read_widget_state(
    handle: &crate::hub_repo::DocHandle,
    canvas_doc_id: &str,
    widget_doc_id: &str,
) -> Vec<BlobRef> {
    let mut results: Vec<BlobRef> = Vec::new();

    /// pushes a gain-rendition `BlobRef` (see `BlobRef::is_gain_rendition`'s
    /// own doc comment) if `obj` carries a non-empty `gainRenditionBlobId`
    /// — shared by the root-level and per-clip cases below, a rendition is
    /// a SEPARATE blob living alongside (never instead of) the primary one
    /// on the SAME automerge object, so this is always an ADDITIONAL push,
    /// never a replacement for the primary `BlobRef` already pushed.
    fn push_gain_rendition(
        doc: &automerge::Automerge,
        obj: &automerge::ObjId,
        results: &mut Vec<BlobRef>,
        canvas_doc_id: &str,
        widget_doc_id: &str,
        clip_id: Option<String>,
        filename: String,
    ) {
        let blob_id = read_str(doc, obj, "gainRenditionBlobId");
        if blob_id.is_empty() {
            return;
        }
        results.push(BlobRef {
            canvas_doc_id: canvas_doc_id.to_string(),
            widget_doc_id: widget_doc_id.to_string(),
            blob_id,
            blake3: read_str(doc, obj, "gainRenditionBlake3"),
            filename,
            mime: read_str(doc, obj, "gainRenditionMime"),
            size: read_u64(doc, obj, "gainRenditionSize"),
            snatched_by: read_string_list(doc, obj, "gainRenditionSnatchedBy"),
            clip_id,
            is_gain_rendition: true,
        });
    }

    handle.with_document(|doc| {
        use automerge::ReadDoc;

        let blob_id = read_str(doc, &automerge::ROOT, "blobId");
        let blake3 = read_str(doc, &automerge::ROOT, "blake3");

        if !blob_id.is_empty() || !blake3.is_empty() {
            let filename = read_str(doc, &automerge::ROOT, "filename");
            results.push(BlobRef {
                canvas_doc_id: canvas_doc_id.to_string(),
                widget_doc_id: widget_doc_id.to_string(),
                blob_id,
                blake3,
                filename: filename.clone(),
                mime: read_str(doc, &automerge::ROOT, "mime"),
                size: read_u64(doc, &automerge::ROOT, "size"),
                snatched_by: read_string_list(doc, &automerge::ROOT, "snatchedBy"),
                clip_id: None,
                is_gain_rendition: false,
            });
            // voice-recording.ts/audio-recording.ts/file.ts all carry an
            // OPTIONAL gain-rendition blob at this SAME doc root (see
            // types.ts's own gainFields) — check for it regardless of the
            // primary blob above.
            push_gain_rendition(
                doc,
                &automerge::ROOT,
                &mut results,
                canvas_doc_id,
                widget_doc_id,
                None,
                filename,
            );
            return;
        }

        // no root-level blob field — check for animaniac's `clips[]` shape.
        let Ok(Some((automerge::Value::Object(automerge::ObjType::List), clips_id))) =
            doc.get(automerge::ROOT, "clips")
        else {
            return;
        };

        for i in 0..doc.length(&clips_id) {
            let Ok(Some((_, clip_id_obj))) = doc.get(&clips_id, i) else {
                continue;
            };
            let clip_id = read_str(doc, &clip_id_obj, "id");
            if clip_id.is_empty() {
                continue;
            }
            let kind = read_str(doc, &clip_id_obj, "kind");
            // mirrors loam's `clip-track-adapter`-adjacent `clipBlobInfo()`
            // (widgets/animaniac/snatch-controller.ts) field-per-kind
            // mapping exactly — keep the two in sync.
            let (blob_id, blake3, mime) = match kind.as_str() {
                "doodle-frame" | "image" => {
                    let image_url = read_str(doc, &clip_id_obj, "imageUrl");
                    // blob-store ids ARE blake3 hashes for these clip kinds
                    // (no separate blake3 field exists to carry) — same
                    // `blob:<id>` stripping the TS side does.
                    let Some(id) = image_url.strip_prefix("blob:") else {
                        continue;
                    };
                    if id.is_empty() {
                        continue;
                    }
                    (id.to_string(), id.to_string(), "image/png".to_string())
                }
                "voice-recording" | "tts" | "audio-segment" => {
                    let blob_id = read_str(doc, &clip_id_obj, "audioBlobId");
                    if blob_id.is_empty() {
                        continue;
                    }
                    let blake3 = read_str(doc, &clip_id_obj, "audioBlake3");
                    let mime = read_str(doc, &clip_id_obj, "audioMime");
                    // only these 3 clip kinds ever carry a gain rendition
                    // (see types.ts's own gainFields) — video-segment/
                    // image/doodle-frame/label never do.
                    push_gain_rendition(
                        doc,
                        &clip_id_obj,
                        &mut results,
                        canvas_doc_id,
                        widget_doc_id,
                        Some(clip_id.clone()),
                        clip_id.clone(),
                    );
                    (blob_id, blake3, mime)
                }
                "video-segment" => {
                    let blob_id = read_str(doc, &clip_id_obj, "videoBlobId");
                    if blob_id.is_empty() {
                        continue;
                    }
                    let blake3 = read_str(doc, &clip_id_obj, "videoBlake3");
                    let mime = read_str(doc, &clip_id_obj, "videoMime");
                    (blob_id, blake3, mime)
                }
                // "label" and anything unrecognized has no blob to snatch.
                _ => continue,
            };

            results.push(BlobRef {
                canvas_doc_id: canvas_doc_id.to_string(),
                widget_doc_id: widget_doc_id.to_string(),
                blob_id,
                blake3,
                filename: clip_id.clone(),
                mime,
                size: 0,
                snatched_by: read_string_list(doc, &clip_id_obj, "snatchedBy"),
                clip_id: Some(clip_id),
                is_gain_rendition: false,
            });
        }
    });

    results
}

/// helper: read a string field from an automerge object.
/// handles both scalar strings and Text objects (JS automerge stores strings as Text).
pub(crate) fn read_str(doc: &automerge::Automerge, obj: &automerge::ObjId, key: &str) -> String {
    use automerge::ReadDoc;
    match doc.get(obj, key) {
        Ok(Some((automerge::Value::Object(automerge::ObjType::Text), text_id))) => {
            doc.text(&text_id).unwrap_or_default()
        }
        Ok(Some((v, _))) => v.to_str().map(|s| s.to_string()).unwrap_or_default(),
        _ => String::new(),
    }
}

/// helper: read a list-of-strings field (e.g. `snatchedBy`) from an
/// automerge object, given directly (not necessarily `automerge::ROOT` —
/// `read_widget_state()`'s animaniac path calls this on a specific clip's
/// own object id, since each clip nests its own independent list).
///
/// list elements may be stored either as plain scalar strings or as
/// automerge Text objects (the JS automerge proxy stores array-of-string
/// assignments like `doc.snatchedBy = [nodeId]` as Text elements, not
/// scalars) — handle both, mirroring `read_str()`'s own scalar-vs-Text
/// handling.
pub(crate) fn read_string_list(
    doc: &automerge::Automerge,
    obj: &automerge::ObjId,
    key: &str,
) -> Vec<String> {
    use automerge::ReadDoc;
    let mut items = Vec::new();
    if let Ok(Some((automerge::Value::Object(automerge::ObjType::List), list_id))) =
        doc.get(obj, key)
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
}

/// helper: read a u64 field from an automerge object.
pub(crate) fn read_u64(doc: &automerge::Automerge, obj: &automerge::ObjId, key: &str) -> u64 {
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
            clip_id: None,
            is_gain_rendition: false,
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
            clip_id: None,
            is_gain_rendition: false,
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

    /// builds an animaniac widget-state doc's automerge shape: a `clips[]`
    /// list with one blob-bearing clip of each extractable kind, plus a
    /// `label` clip (no blob) to confirm it's correctly skipped.
    fn build_animaniac_doc() -> automerge::Automerge {
        use automerge::transaction::Transactable;

        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            let clips = tx.put_object(automerge::ROOT, "clips", automerge::ObjType::List)?;

            let video = tx.insert_object(&clips, 0, automerge::ObjType::Map)?;
            tx.put(&video, "id", "clip-video")?;
            tx.put(&video, "kind", "video-segment")?;
            tx.put(&video, "videoBlobId", "vblob1")?;
            tx.put(&video, "videoBlake3", "vblake3-1")?;
            tx.put(&video, "videoMime", "video/mp4")?;

            let image = tx.insert_object(&clips, 1, automerge::ObjType::Map)?;
            tx.put(&image, "id", "clip-image")?;
            tx.put(&image, "kind", "image")?;
            tx.put(&image, "imageUrl", "blob:iblake3-1")?;

            let voice = tx.insert_object(&clips, 2, automerge::ObjType::Map)?;
            tx.put(&voice, "id", "clip-voice")?;
            tx.put(&voice, "kind", "voice-recording")?;
            tx.put(&voice, "audioBlobId", "ablob1")?;
            tx.put(&voice, "audioBlake3", "ablake3-1")?;
            tx.put(&voice, "audioMime", "audio/wav")?;
            let voice_snatched = tx.put_object(&voice, "snatchedBy", automerge::ObjType::List)?;
            tx.insert(&voice_snatched, 0, "peer-already-has-it")?;

            let label = tx.insert_object(&clips, 3, automerge::ObjType::Map)?;
            tx.put(&label, "id", "clip-label")?;
            tx.put(&label, "kind", "label")?;
            tx.put(&label, "text", "hello")?;

            // a tts clip with no audioBlobId yet (not generated) — must be
            // skipped, same as the "widget has a blobId but no blake3"
            // case for other widget types.
            let tts = tx.insert_object(&clips, 4, automerge::ObjType::Map)?;
            tx.put(&tts, "id", "clip-tts")?;
            tx.put(&tts, "kind", "tts")?;
            tx.put(&tts, "audioBlobId", "")?;

            Ok(())
        })
        .expect("animaniac doc transact should succeed");
        doc
    }

    #[test]
    fn classify_doc_recognizes_animaniac_clips_shape() {
        let doc = build_animaniac_doc();
        let saved = doc.save();
        let reopened = automerge::Automerge::load(&saved).expect("reload saved doc");
        // classify_doc takes a `hub_repo::DocHandle`, which wraps a real
        // synced doc — exercise the same root-shape check directly against
        // a plain `Automerge` instead of standing up a whole HubRepo, since
        // the check itself (`doc.get(ROOT, "clips")`) doesn't need one.
        use automerge::ReadDoc;
        assert!(matches!(
            reopened.get(automerge::ROOT, "clips"),
            Ok(Some((
                automerge::Value::Object(automerge::ObjType::List),
                _
            )))
        ));
    }

    #[tokio::test]
    async fn read_widget_state_extracts_one_blob_ref_per_animaniac_clip() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub.db");
        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");
        storage
            .save_doc("animaniac-1", &build_animaniac_doc().save())
            .await;

        let repo = HubRepo::new("local-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");
        let handle = repo
            .find("animaniac-1")
            .await
            .expect("animaniac doc should be findable");

        let refs = tokio::task::spawn_blocking(move || {
            read_widget_state(&handle, "canvas-1", "animaniac-1")
        })
        .await
        .expect("spawn_blocking should not panic");

        // video-segment, image, voice-recording resolved; label (no blob)
        // and tts (empty audioBlobId, not generated yet) skipped.
        assert_eq!(refs.len(), 3);

        let video = refs
            .iter()
            .find(|r| r.clip_id.as_deref() == Some("clip-video"))
            .expect("video clip ref");
        assert_eq!(video.blake3, "vblake3-1");
        assert_eq!(video.blob_id, "vblob1");
        assert_eq!(video.mime, "video/mp4");
        assert!(video.snatched_by.is_empty());

        let image = refs
            .iter()
            .find(|r| r.clip_id.as_deref() == Some("clip-image"))
            .expect("image clip ref");
        // doodle-frame/image clips have no separate blake3 field — the
        // blob-store id IS the blake3 hash.
        assert_eq!(image.blake3, "iblake3-1");
        assert_eq!(image.blob_id, "iblake3-1");

        let voice = refs
            .iter()
            .find(|r| r.clip_id.as_deref() == Some("clip-voice"))
            .expect("voice clip ref");
        assert_eq!(voice.blake3, "ablake3-1");
        assert_eq!(voice.snatched_by, vec!["peer-already-has-it".to_string()]);

        assert!(refs
            .iter()
            .all(|r| r.clip_id.as_deref() != Some("clip-label")));
        assert!(refs
            .iter()
            .all(|r| r.clip_id.as_deref() != Some("clip-tts")));
    }

    /// regression test for the per-clip `mark_snatched` write: marking one
    /// clip's blob snatched must not touch any OTHER clip's own
    /// `snatchedBy` list on the same animaniac doc.
    #[tokio::test]
    async fn mark_snatched_writes_only_to_the_targeted_clip() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub.db");
        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");
        storage
            .save_doc("animaniac-1", &build_animaniac_doc().save())
            .await;

        let repo = HubRepo::new("local-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");
        let source = HubBlobRefSource::new(repo.clone(), "hub-node".to_string());

        source
            .mark_snatched("animaniac-1#clip=clip-video", "hub-node")
            .await;

        let handle = repo.find("animaniac-1").await.expect("doc still findable");
        let (video_snatched, image_snatched, voice_snatched) =
            tokio::task::spawn_blocking(move || {
                handle.with_document(|doc| {
                    use automerge::ReadDoc;
                    let Ok(Some((_, clips_id))) = doc.get(automerge::ROOT, "clips") else {
                        panic!("clips list missing");
                    };
                    let mut by_id: std::collections::HashMap<String, Vec<String>> =
                        std::collections::HashMap::new();
                    for i in 0..doc.length(&clips_id) {
                        let (_, item_id) = doc.get(&clips_id, i).unwrap().unwrap();
                        let id = read_str(doc, &item_id, "id");
                        by_id.insert(id, read_string_list(doc, &item_id, "snatchedBy"));
                    }
                    (
                        by_id.get("clip-video").cloned().unwrap_or_default(),
                        by_id.get("clip-image").cloned().unwrap_or_default(),
                        by_id.get("clip-voice").cloned().unwrap_or_default(),
                    )
                })
            })
            .await
            .expect("spawn_blocking should not panic");

        assert_eq!(video_snatched, vec!["hub-node".to_string()]);
        assert!(image_snatched.is_empty());
        // the voice clip's pre-existing snatchedBy entry must be untouched.
        assert_eq!(voice_snatched, vec!["peer-already-has-it".to_string()]);

        // calling it again must be idempotent (no duplicate entry).
        source
            .mark_snatched("animaniac-1#clip=clip-video", "hub-node")
            .await;
        let handle = repo.find("animaniac-1").await.expect("doc still findable");
        let video_snatched_again = tokio::task::spawn_blocking(move || {
            handle.with_document(|doc| {
                use automerge::ReadDoc;
                let Ok(Some((_, clips_id))) = doc.get(automerge::ROOT, "clips") else {
                    panic!("clips list missing");
                };
                for i in 0..doc.length(&clips_id) {
                    let (_, item_id) = doc.get(&clips_id, i).unwrap().unwrap();
                    if read_str(doc, &item_id, "id") == "clip-video" {
                        return read_string_list(doc, &item_id, "snatchedBy");
                    }
                }
                Vec::new()
            })
        })
        .await
        .expect("spawn_blocking should not panic");
        assert_eq!(video_snatched_again, vec!["hub-node".to_string()]);
    }
}
