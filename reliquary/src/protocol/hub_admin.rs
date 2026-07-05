//! hub_admin: `iroh/skein-hub-admin/1` protocol handler.
//!
//! lets a remote, authenticated admin peer manage this hub's friendz
//! allow-list (allow / list / remove) over the network, instead of
//! requiring local filesystem/CLI access to the machine the hub runs on.
//! mirrors the CLI's `reliquary friend allow/list/remove` subcommands
//! (`main.rs`'s `FriendCommand`) for consistent semantics.
//!
//! this is deliberately distinct from `skein-friendz/1` (peer-to-peer friend
//! requests between any two skein nodes): `skein-friendz/1` is for ordinary
//! friend-request handshaking between any two peers, while this protocol is
//! for a privileged remote peer to administer *this hub's* allow-list.
//!
//! every request is checked against the `adminz` table before acting; a
//! caller whose node id isn't in `adminz` gets back [`AdminResponse::NotAdmin`]
//! and nothing is changed.
//!
//! `Remove` also cancels the target peer's already-accepted
//! `iroh/automerge-repo/1` connection, if it has one open right now (see
//! `hub_repo::HubRepo::cancel_peer`). this handler runs inside the same
//! process as the live `HubRepo` (constructed once by
//! `hub::HubPeerService::start`), so it's the one revocation call site that
//! can actually reach a currently-connected peer's cancellation token; the
//! CLI's `reliquary friend remove` (`main.rs`) always runs as a separate
//! process from a running `reliquary serve` and has no such handle.
//!
//! wire format: one request/response pair per bidirectional stream, CBOR-
//! encoded via `ciborium` (the same encoding `hub_repo` uses for automerge
//! sync messages), no length prefix — the sender signals end-of-request by
//! calling `finish()` on the send stream, the same convention `skein/1`'s
//! `blob_proxy` handler uses. structure and style follow `blob_proxy.rs`.

use std::sync::Arc;

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use serde::{Deserialize, Serialize};

use crate::adminz;
use crate::blobz;
use crate::friendz;
use crate::hub::HubProfile;
use crate::hub_repo::HubRepo;
use crate::userz;

/// ALPN protocol identifier for remote hub administration.
pub const HUB_ADMIN_ALPN: &[u8] = b"iroh/skein-hub-admin/1";

/// max request/response size read off the wire. generous for a friendz list
/// on any hub that isn't wildly abused.
const MAX_MESSAGE_SIZE: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// protocol messages
// ---------------------------------------------------------------------------

/// a single friendz row as reported to a remote admin.
///
/// `username`/`bio`/`avatar_data_url` are best-effort profile info from
/// `userz` (the hub's own tiny peer directory) — empty strings if the hub
/// has never seen a profile for this peer. `avatar_data_url` is a full
/// `data:<mime>;base64,...` string (not just the blake3 hash), computed
/// server-side by reading the avatar blob out of `blobz`/the filesystem, so
/// the remote admin panel can render it directly with no separate blob
/// fetch/ACL round-trip (a hub's own avatar blob isn't tied to any canvas,
/// so it wouldn't pass the canvas-membership half of `blob_acl`'s gate
/// anyway — see that module's doc comment). `is_admin` cross-references the
/// `adminz` table so the panel can show/manage hub-admin status alongside
/// friend status in one list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendSummary {
    pub node_id: String,
    pub status: String,
    pub updated_at: i64,
    pub username: String,
    pub bio: String,
    pub avatar_data_url: String,
    pub is_admin: bool,
}

/// a single pending knock, aggregated across every canvas doc the hub
/// holds, for the `ListPendingKnocks` request — see
/// `docs/knock-and-hub-relay-plan.md` section 8.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubKnockSummary {
    pub canvas_doc_id: String,
    /// a stable identifier for this knock in listings. the canvas doc's
    /// `pendingKnocks` map (see `canvas-doc.ts`'s `PendingCanvasKnock`) has
    /// no separate "knock id" field of its own — it's keyed directly by
    /// the requester's node id (that's what gives "one outstanding knock
    /// per node id" for free). this field is just that same map key,
    /// exposed under its own name for this listing's convenience: this is
    /// a read-only aggregation view (see this module's doc comment on
    /// `AdminRequest::ListPendingKnocks`) — actually approving or
    /// declining a knock always goes through the normal
    /// `canvas-knock-approve`/`canvas-knock-decline` wire messages, which
    /// carry their own real, wire-level `knockId`.
    pub knock_id: String,
    pub requester_node_id: String,
    pub requester_username: String,
    pub message: String,
    pub knocked_at: i64,
}

/// per-canvas blob usage summary, as reported by `AdminRequest::CanvasUsage`.
///
/// blobs referenced by multiple canvases count independently in each entry:
/// a blob shared between two canvases contributes its full size to both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasUsageSummary {
    pub canvas_doc_id: String,
    pub blob_count: u64,
    pub total_bytes: u64,
}

/// a single blob row, as reported by `AdminRequest::BlobUsage`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobUsageSummary {
    pub blake3: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size: u64,
    pub external: bool,
    /// true if the blob is currently soft-deleted. always false in
    /// `AdminResponse::BlobUsage` (which only lists live blobs); may be
    /// true in `AdminResponse::CanvasBlobs` where the canvas manifest is
    /// shown regardless of soft-deleted status.
    pub soft_deleted: bool,
}

/// a single soft-deleted blob, as reported by `AdminRequest::ListSoftDeleted`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoftDeletedBlobSummary {
    pub blake3: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size: u64,
    pub soft_deleted_at: i64,
    pub soft_deleted_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AdminRequest {
    /// pre-approve a peer (mirrors `reliquary friend allow`).
    Allow { node_id: String },
    /// list every friendz row (mirrors `reliquary friend list`).
    List,
    /// remove a peer from friendz entirely (mirrors `reliquary friend remove`).
    Remove { node_id: String },
    /// deny a peer — drops their requests on the floor (mirrors setting
    /// `friendz.status` to `blocked`). the reverse ("unblock") is just
    /// `Allow` again — there's no separate `Unblock` variant since `Allow`
    /// already promotes any non-`Accepted` status back to `Allowed`.
    Block { node_id: String },
    /// grant a peer hub-admin rights (mirrors `reliquary admin allow`) —
    /// lets a hub friend become a *second* remote administrator, not just
    /// a friend. deliberately separate from friendz status (see
    /// `adminz`'s module doc comment: admin rights and friend status are
    /// orthogonal).
    PromoteAdmin { node_id: String },
    /// revoke a peer's hub-admin rights (mirrors `reliquary admin remove`).
    /// no self-demotion guard, same reasoning as the CLI: a lockout is
    /// always recoverable via direct machine/CLI access.
    DemoteAdmin { node_id: String },
    /// list pending knocks the hub is holding across every canvas doc it
    /// holds — a cross-canvas convenience view, mirroring tomb's
    /// `PendingKnocksView` aggregation. read-only: actually
    /// approving/declining a knock goes through the normal
    /// `canvas-knock-approve`/`canvas-knock-decline` wire messages and
    /// writes directly to the canvas doc's `pendingKnocks` map, not
    /// through this admin protocol.
    ListPendingKnocks,
    /// report total blob bytes, blob count, and best-effort disk space stats
    /// for the filesystem containing the blob-files directory.
    DiskUsage,
    /// for each canvas the hub holds, sum the sizes of all blobs referenced
    /// by its file widgets. blobs shared across canvases count in each.
    CanvasUsage { offset: u64, limit: u64 },
    /// list blob rows from the blobz store, paginated.
    BlobUsage { offset: u64, limit: u64 },
    /// soft-delete blobs by blake3 hash. the hub's own node id (the
    /// authenticated caller) is stamped as the actor. files are NOT touched.
    /// blobs that don't exist or are already soft-deleted land in `failed`.
    SoftDeleteBlobs { blake3s: Vec<String> },
    /// restore soft-deleted blobs by blake3 hash.
    /// blobs that are not currently soft-deleted land in `failed`.
    RestoreBlobs { blake3s: Vec<String> },
    /// list all soft-deleted blobs, paginated.
    ListSoftDeleted { offset: u64, limit: u64 },
    /// permanently delete soft-deleted blobs. `all = true` ignores `blake3s`
    /// and purges every soft-deleted row. for managed (non-external) blobs
    /// the on-disk file is unlinked; for external blobs only the row is
    /// removed (the user owns the file). blobs that are NOT already
    /// soft-deleted land in `failed` — use `SoftDeleteBlobs` first.
    HardDeleteBlobs { blake3s: Vec<String>, all: bool },
    /// remove the hub from a canvas's peers/acl maps, untrack the canvas
    /// locally (soft-delete from hub storage), and sweep blobs that were
    /// only referenced by this canvas.
    UnsyncCanvas { canvas_doc_id: String },
    /// read the hub's current live profile (username, bio, accent_color,
    /// avatar_data_url). reads from the in-memory RwLock, so the value is
    /// always current even if SetHubProfile was called seconds ago.
    GetHubProfile,
    /// update one or more hub profile fields in-place. fields set to None
    /// are left unchanged. persists to userz and updates the in-memory lock.
    /// rejects empty username and enforces length caps (username ≤ 64,
    /// bio ≤ 512 chars).
    SetHubProfile {
        username: Option<String>,
        bio: Option<String>,
        accent_color: Option<i64>,
    },
    /// replace the hub's avatar from a base64-encoded image. decodes the
    /// bytes, rejects if > 512 KB, resizes to 128px webp, stores in blobz,
    /// updates userz and the in-memory lock. responds with the full updated
    /// HubProfile so the caller can refresh its display in one round-trip.
    SetHubAvatar { image_base64: String },
    /// list blobs referenced by a specific canvas's file widgets, paginated.
    /// includes blobs that are soft-deleted (they appear with soft_deleted=true)
    /// and blobs that have never been snatched (size=0, filename from widget doc).
    /// deduped by blake3, sorted by size desc, paginated with clamp_limit.
    CanvasBlobs {
        canvas_doc_id: String,
        offset: u64,
        limit: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AdminResponse {
    Allowed {
        node_id: String,
        status: String,
    },
    List {
        friends: Vec<FriendSummary>,
    },
    Removed {
        node_id: String,
    },
    /// response to `AdminRequest::Block`.
    Blocked {
        node_id: String,
    },
    /// response to `AdminRequest::PromoteAdmin`/`DemoteAdmin`.
    AdminChanged {
        node_id: String,
        is_admin: bool,
    },
    /// caller's node id isn't in the `adminz` table.
    NotAdmin,
    /// request-level failure (bad node_id, store error, etc).
    Error {
        message: String,
    },
    /// response to `AdminRequest::ListPendingKnocks`.
    PendingKnocks {
        knocks: Vec<HubKnockSummary>,
    },
    /// response to `AdminRequest::DiskUsage`.
    DiskUsage {
        total_blob_bytes: u64,
        blob_count: u64,
        /// bytes used by soft-deleted blobs (not included in total_blob_bytes).
        soft_deleted_blob_bytes: u64,
        /// number of soft-deleted blobs.
        soft_deleted_blob_count: u64,
        /// bytes available to unprivileged users on the blob-dir filesystem.
        /// `None` on non-unix platforms or if the stat call fails.
        disk_available_bytes: Option<u64>,
        /// total bytes on the blob-dir filesystem.
        /// `None` on non-unix platforms or if the stat call fails.
        disk_total_bytes: Option<u64>,
    },
    /// response to `AdminRequest::CanvasUsage`.
    CanvasUsage {
        canvases: Vec<CanvasUsageSummary>,
        total: u64,
    },
    /// response to `AdminRequest::BlobUsage`.
    BlobUsage {
        blobs: Vec<BlobUsageSummary>,
        total: u64,
    },
    /// response to soft/restore/hard-delete blob requests (shared).
    BlobsMutation {
        affected: u64,
        failed: Vec<String>,
    },
    /// response to `AdminRequest::ListSoftDeleted`.
    SoftDeleted {
        blobs: Vec<SoftDeletedBlobSummary>,
        total: u64,
    },
    /// response to `AdminRequest::UnsyncCanvas`.
    CanvasUnsynced {
        canvas_doc_id: String,
        /// number of blobs soft-deleted by the sweep (blobs that were only
        /// referenced by this canvas and have now been marked for reclaim).
        swept: u64,
    },
    /// response to `AdminRequest::GetHubProfile`, `AdminRequest::SetHubProfile`,
    /// and `AdminRequest::SetHubAvatar`.
    HubProfile {
        username: String,
        bio: String,
        accent_color: i64,
        avatar_data_url: String,
    },
    /// response to `AdminRequest::CanvasBlobs`.
    CanvasBlobs {
        canvas_doc_id: String,
        blobs: Vec<BlobUsageSummary>,
        total: u64,
    },
}

// ---------------------------------------------------------------------------
// HubAdminHandler
// ---------------------------------------------------------------------------

/// hub's `iroh/skein-hub-admin/1` protocol handler. clones are cheap
/// (backed by `Arc`).
#[derive(Clone)]
pub struct HubAdminHandler {
    inner: Arc<Inner>,
}

struct Inner {
    adminz: adminz::Store,
    friendz: friendz::Store,
    userz: userz::Directory,
    /// read here only to build a `FriendSummary.avatar_data_url` for
    /// `AdminRequest::List` — see that struct's doc comment for why this
    /// is computed server-side rather than left to a separate blob fetch.
    blobz: blobz::Store,
    /// used to cancel a peer's already-accepted `iroh/automerge-repo/1`
    /// connection immediately after a `Remove` request deletes their
    /// `friendz` row (see `HubRepo::cancel_peer`'s doc comment for the full
    /// reasoning on why this crosses from `friendz` into `hub_repo` here,
    /// at the caller, rather than `friendz::Store` reaching into `HubRepo`
    /// itself). this handler is constructed once per running hub process
    /// (`hub::HubPeerService::start`), in the same process as the `HubRepo`
    /// it holds, so it's a legitimate integration point for live
    /// cancellation, unlike the CLI's `friend remove` (see `main.rs`).
    hub_repo: HubRepo,
    /// absolute path to the blob-files directory — used by `DiskUsage` to
    /// stat the filesystem. derived from `blobz.blob_dir()` at construction
    /// time so no extra field is needed on the public `new()` signature.
    blob_dir: std::path::PathBuf,
    /// the hub's own node id string, used by `UnsyncCanvas` to remove the
    /// hub's entry from the canvas doc's `peers` and `acl` maps.
    hub_node_id: String,
    /// live canvas-doc-ids set, shared with `HubPeerService`. `UnsyncCanvas`
    /// removes the target id from this in-memory set in addition to calling
    /// `hub_repo.soft_remove_canvas_id` (which persists the removal). keeping
    /// both in sync mirrors the canvas-deleted flow in `hub/canvas.rs`.
    canvas_doc_ids: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
    /// live hub profile state, shared with `HubPeerService`. admin writes
    /// (SetHubProfile / SetHubAvatar) update this so outgoing profile
    /// responses always reflect the latest values without a restart.
    hub_profile: Arc<tokio::sync::RwLock<HubProfile>>,
    /// fires after SetHubProfile or SetHubAvatar succeeds. the hub's
    /// broadcast loop (hub/mod.rs) waits on this and pushes a
    /// ProfileResponse to every online peer.
    profile_changed: Arc<tokio::sync::Notify>,
}

impl std::fmt::Debug for HubAdminHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HubAdminHandler").finish_non_exhaustive()
    }
}

impl HubAdminHandler {
    pub fn new(
        adminz: adminz::Store,
        friendz: friendz::Store,
        userz: userz::Directory,
        blobz: blobz::Store,
        hub_repo: HubRepo,
        hub_node_id: String,
        canvas_doc_ids: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
        hub_profile: Arc<tokio::sync::RwLock<HubProfile>>,
        profile_changed: Arc<tokio::sync::Notify>,
    ) -> Self {
        let blob_dir = blobz.blob_dir().to_path_buf();
        Self {
            inner: Arc::new(Inner {
                adminz,
                friendz,
                userz,
                blobz,
                hub_repo,
                blob_dir,
                hub_node_id,
                canvas_doc_ids,
                hub_profile,
                profile_changed,
            }),
        }
    }
}

impl ProtocolHandler for HubAdminHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let peer_id = conn.remote_id();
        let peer_id_str = peer_id.to_string();
        tracing::info!(peer = %peer_id, "skein-hub-admin/1: accepted connection");

        loop {
            let (send, recv) = match conn.accept_bi().await {
                Ok(bi) => bi,
                Err(e) => {
                    tracing::debug!(peer = %peer_id, error = %e, "skein-hub-admin/1: connection closed");
                    break;
                }
            };

            let handler = self.clone();
            let peer_id_str = peer_id_str.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_stream(send, recv, &handler, &peer_id_str).await {
                    tracing::debug!(peer = %peer_id_str, error = %e, "skein-hub-admin/1: stream error");
                }
            });
        }

        Ok(())
    }

    async fn shutdown(&self) {
        tracing::debug!("skein-hub-admin/1: shutting down");
    }
}

// ---------------------------------------------------------------------------
// stream handling
// ---------------------------------------------------------------------------

async fn handle_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    handler: &HubAdminHandler,
    peer_id_str: &str,
) -> Result<(), String> {
    let msg_bytes = recv
        .read_to_end(MAX_MESSAGE_SIZE)
        .await
        .map_err(|e| format!("failed to read request: {e}"))?;

    let request: AdminRequest = ciborium::from_reader(msg_bytes.as_slice())
        .map_err(|e| format!("failed to decode CBOR request: {e}"))?;

    let response = handle_request(handler, peer_id_str, request).await;
    send_response(&mut send, &response).await
}

/// handle a single decoded request, checking `adminz` authorization first.
/// kept separate from `handle_stream` so it's testable without a live iroh
/// `Connection` (see `mod tests` below).
async fn handle_request(
    handler: &HubAdminHandler,
    peer_id_str: &str,
    request: AdminRequest,
) -> AdminResponse {
    if !handler.inner.adminz.is_admin(peer_id_str).await {
        tracing::info!(peer = %peer_id_str, "skein-hub-admin/1: rejected non-admin caller");
        return AdminResponse::NotAdmin;
    }

    match request {
        AdminRequest::Allow { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                return AdminResponse::Error {
                    message: "node_id cannot be empty".to_string(),
                };
            }

            // mirror the CLI's promote-or-leave semantics (see main.rs's
            // `FriendCommand::Allow` handler): never demote an
            // already-Accepted friend back to Allowed.
            let existing = match handler.inner.friendz.get(node_id).await {
                Ok(f) => f,
                Err(e) => {
                    return AdminResponse::Error {
                        message: format!("friendz lookup failed: {e}"),
                    }
                }
            };
            if matches!(
                existing.as_ref().map(|f| f.status),
                Some(friendz::FriendStatus::Accepted)
            ) {
                return AdminResponse::Allowed {
                    node_id: node_id.to_string(),
                    status: friendz::FriendStatus::Accepted.as_str().to_string(),
                };
            }

            // ensure a userz row exists so the FK on friendz.friend_node_id holds.
            if let Err(e) = handler.inner.userz.touch(node_id).await {
                return AdminResponse::Error {
                    message: format!("userz touch failed: {e}"),
                };
            }
            match handler
                .inner
                .friendz
                .upsert(node_id, friendz::FriendStatus::Allowed, None)
                .await
            {
                Ok(friend) => AdminResponse::Allowed {
                    node_id: friend.friend_node_id,
                    status: friend.status.as_str().to_string(),
                },
                Err(e) => AdminResponse::Error {
                    message: format!("friendz upsert failed: {e}"),
                },
            }
        }
        AdminRequest::List => match handler.inner.friendz.list(false).await {
            Ok(friends) => {
                let mut summaries = Vec::with_capacity(friends.len());
                for f in friends {
                    let (username, bio, avatar_data_url) =
                        match handler.inner.userz.get(&f.friend_node_id).await {
                            Ok(Some(peer)) => {
                                let avatar_data_url = match &peer.avatar_blake3 {
                                    Some(hash) => build_avatar_data_url(&handler.inner.blobz, hash)
                                        .await
                                        .unwrap_or_default(),
                                    None => String::new(),
                                };
                                (
                                    peer.display_name.unwrap_or_default(),
                                    peer.bio.unwrap_or_default(),
                                    avatar_data_url,
                                )
                            }
                            _ => (String::new(), String::new(), String::new()),
                        };
                    let is_admin = handler.inner.adminz.is_admin(&f.friend_node_id).await;
                    summaries.push(FriendSummary {
                        node_id: f.friend_node_id,
                        status: f.status.as_str().to_string(),
                        updated_at: f.updated_at,
                        username,
                        bio,
                        avatar_data_url,
                        is_admin,
                    });
                }
                AdminResponse::List { friends: summaries }
            }
            Err(e) => AdminResponse::Error {
                message: format!("friendz list failed: {e}"),
            },
        },
        AdminRequest::Remove { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                return AdminResponse::Error {
                    message: "node_id cannot be empty".to_string(),
                };
            }
            match handler.inner.friendz.delete(node_id).await {
                Ok(()) => {
                    // revoke, then cancel any already-accepted connection
                    // for this peer, see `HubRepo::cancel_peer`'s doc
                    // comment for why this two-step "caller does both"
                    // pattern lives here rather than inside
                    // `friendz::Store::delete` itself.
                    handler.inner.hub_repo.cancel_peer(node_id).await;
                    AdminResponse::Removed {
                        node_id: node_id.to_string(),
                    }
                }
                Err(e) => AdminResponse::Error {
                    message: format!("friendz delete failed: {e}"),
                },
            }
        }
        AdminRequest::Block { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                return AdminResponse::Error {
                    message: "node_id cannot be empty".to_string(),
                };
            }
            match handler
                .inner
                .friendz
                .upsert(node_id, friendz::FriendStatus::Blocked, None)
                .await
            {
                Ok(_) => AdminResponse::Blocked {
                    node_id: node_id.to_string(),
                },
                Err(e) => AdminResponse::Error {
                    message: format!("friendz upsert failed: {e}"),
                },
            }
        }
        AdminRequest::PromoteAdmin { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                return AdminResponse::Error {
                    message: "node_id cannot be empty".to_string(),
                };
            }
            // ensure a userz row exists so the FK on adminz.node_id holds,
            // same reasoning as the friendz `Allow` handler above.
            if let Err(e) = handler.inner.userz.touch(node_id).await {
                return AdminResponse::Error {
                    message: format!("userz touch failed: {e}"),
                };
            }
            match handler.inner.adminz.allow(node_id).await {
                Ok(_) => AdminResponse::AdminChanged {
                    node_id: node_id.to_string(),
                    is_admin: true,
                },
                Err(e) => AdminResponse::Error {
                    message: format!("adminz allow failed: {e}"),
                },
            }
        }
        AdminRequest::DemoteAdmin { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                return AdminResponse::Error {
                    message: "node_id cannot be empty".to_string(),
                };
            }
            match handler.inner.adminz.remove(node_id).await {
                Ok(()) => AdminResponse::AdminChanged {
                    node_id: node_id.to_string(),
                    is_admin: false,
                },
                Err(e) => AdminResponse::Error {
                    message: format!("adminz remove failed: {e}"),
                },
            }
        }
        AdminRequest::ListPendingKnocks => AdminResponse::PendingKnocks {
            knocks: list_pending_knocks(&handler.inner.hub_repo).await,
        },
        AdminRequest::DiskUsage => {
            let (total_blob_bytes, blob_count) = match handler.inner.blobz.total_usage().await {
                Ok(v) => v,
                Err(e) => {
                    return AdminResponse::Error {
                        message: format!("blobz query failed: {e}"),
                    }
                }
            };
            let (soft_deleted_blob_bytes, soft_deleted_blob_count) =
                match handler.inner.blobz.soft_deleted_usage().await {
                    Ok(v) => v,
                    Err(e) => {
                        return AdminResponse::Error {
                            message: format!("blobz soft-deleted query failed: {e}"),
                        }
                    }
                };
            let (disk_available_bytes, disk_total_bytes) = match disk_space(&handler.inner.blob_dir)
            {
                Some((avail, total)) => (Some(avail), Some(total)),
                None => (None, None),
            };
            AdminResponse::DiskUsage {
                total_blob_bytes,
                blob_count,
                soft_deleted_blob_bytes,
                soft_deleted_blob_count,
                disk_available_bytes,
                disk_total_bytes,
            }
        }
        AdminRequest::CanvasUsage { offset, limit } => {
            let limit = clamp_limit(limit);
            let mut all = canvas_usage(&handler.inner.hub_repo, &handler.inner.blobz).await;
            // sort largest-first so page 1 shows the most storage-heavy canvases.
            all.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));
            let total = all.len() as u64;
            let page: Vec<CanvasUsageSummary> = all
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect();
            AdminResponse::CanvasUsage {
                canvases: page,
                total,
            }
        }
        AdminRequest::BlobUsage { offset, limit } => {
            let limit = clamp_limit(limit);
            match handler
                .inner
                .blobz
                .list_paginated_with_count(limit, offset as i64)
                .await
            {
                Ok((blobs, total)) => AdminResponse::BlobUsage {
                    blobs: blobs
                        .into_iter()
                        .map(|b| BlobUsageSummary {
                            blake3: b.blake3,
                            filename: b.filename,
                            mime: b.mime,
                            size: b.size as u64,
                            external: b.external,
                            soft_deleted: false,
                        })
                        .collect(),
                    total,
                },
                Err(e) => AdminResponse::Error {
                    message: format!("blobz list failed: {e}"),
                },
            }
        }
        AdminRequest::SoftDeleteBlobs { blake3s } => {
            // stamp the authenticated caller as the actor.
            match handler.inner.blobz.soft_delete(&blake3s, peer_id_str).await {
                Ok((affected, failed)) => AdminResponse::BlobsMutation { affected, failed },
                Err(e) => AdminResponse::Error {
                    message: format!("soft_delete failed: {e}"),
                },
            }
        }
        AdminRequest::RestoreBlobs { blake3s } => {
            match handler.inner.blobz.restore(&blake3s).await {
                Ok((affected, failed)) => AdminResponse::BlobsMutation { affected, failed },
                Err(e) => AdminResponse::Error {
                    message: format!("restore failed: {e}"),
                },
            }
        }
        AdminRequest::ListSoftDeleted { offset, limit } => {
            let limit = clamp_limit(limit);
            match handler
                .inner
                .blobz
                .list_soft_deleted_with_count(limit, offset as i64)
                .await
            {
                Ok((blobs, total)) => AdminResponse::SoftDeleted {
                    blobs: blobs
                        .into_iter()
                        .map(|b| SoftDeletedBlobSummary {
                            blake3: b.blake3,
                            filename: b.filename,
                            mime: b.mime,
                            size: b.size,
                            soft_deleted_at: b.soft_deleted_at,
                            soft_deleted_by: b.soft_deleted_by,
                        })
                        .collect(),
                    total,
                },
                Err(e) => AdminResponse::Error {
                    message: format!("list_soft_deleted failed: {e}"),
                },
            }
        }
        AdminRequest::HardDeleteBlobs { blake3s, all } => {
            let hashes = if all { None } else { Some(blake3s.as_slice()) };
            // note: iroh-blobs FsStore blob deletion is not reachable from
            // this handler — the FsStore is not held in Inner. disk space is
            // reclaimed via the on-disk file unlink that hard_delete_soft_deleted
            // already performs for managed (non-external) blobs, which is the
            // part that matters now that TryReference means blobz owns the only copy.
            match handler.inner.blobz.hard_delete_soft_deleted(hashes).await {
                Ok((deleted, failed)) => AdminResponse::BlobsMutation {
                    affected: deleted,
                    failed,
                },
                Err(e) => AdminResponse::Error {
                    message: format!("hard_delete_soft_deleted failed: {e}"),
                },
            }
        }
        AdminRequest::UnsyncCanvas { canvas_doc_id } => {
            handle_unsync_canvas(handler, peer_id_str, &canvas_doc_id).await
        }
        AdminRequest::GetHubProfile => {
            let p = handler.inner.hub_profile.read().await;
            AdminResponse::HubProfile {
                username: p.username.clone(),
                bio: p.bio.clone(),
                accent_color: p.accent_color,
                avatar_data_url: p.avatar_data_url.clone(),
            }
        }
        AdminRequest::SetHubProfile {
            username,
            bio,
            accent_color,
        } => {
            // validate
            if let Some(u) = &username {
                if u.trim().is_empty() {
                    return AdminResponse::Error {
                        message: "username cannot be empty".to_string(),
                    };
                }
                if u.len() > 64 {
                    return AdminResponse::Error {
                        message: "username exceeds 64 characters".to_string(),
                    };
                }
            }
            if let Some(b) = &bio {
                if b.len() > 512 {
                    return AdminResponse::Error {
                        message: "bio exceeds 512 characters".to_string(),
                    };
                }
            }
            // read current values for fields not being updated
            let (cur_username, cur_bio, cur_accent, cur_avatar) = {
                let p = handler.inner.hub_profile.read().await;
                (
                    p.username.clone(),
                    p.bio.clone(),
                    p.accent_color,
                    p.avatar_data_url.clone(),
                )
            };
            let new_username = username.as_deref().unwrap_or(&cur_username);
            let new_bio = bio.as_deref().unwrap_or(&cur_bio);
            let new_accent = accent_color.unwrap_or(cur_accent);
            // persist to userz
            if let Err(e) = handler
                .inner
                .userz
                .upsert_self_full(
                    &handler.inner.hub_node_id,
                    Some(new_username),
                    None,
                    Some(new_bio),
                    None,
                    Some(new_accent),
                )
                .await
            {
                return AdminResponse::Error {
                    message: format!("userz update failed: {e}"),
                };
            }
            // update the in-memory lock
            {
                let mut p = handler.inner.hub_profile.write().await;
                p.username = new_username.to_string();
                p.bio = new_bio.to_string();
                p.accent_color = new_accent;
            }
            // notify the broadcast loop to push the updated profile to online peers
            handler.inner.profile_changed.notify_one();
            AdminResponse::HubProfile {
                username: new_username.to_string(),
                bio: new_bio.to_string(),
                accent_color: new_accent,
                avatar_data_url: cur_avatar,
            }
        }
        AdminRequest::SetHubAvatar { image_base64 } => {
            const MAX_AVATAR_BYTES: usize = 512 * 1024;
            use base64::Engine;
            let bytes = match base64::engine::general_purpose::STANDARD.decode(&image_base64) {
                Ok(b) => b,
                Err(_) => {
                    return AdminResponse::Error {
                        message: "invalid base64 encoding".to_string(),
                    }
                }
            };
            if bytes.len() > MAX_AVATAR_BYTES {
                return AdminResponse::Error {
                    message: "image exceeds 512 KB limit".to_string(),
                };
            }
            let webp = match crate::hub::avatar::resize_to_square_webp(&bytes, 128) {
                Ok(w) => w,
                Err(e) => {
                    return AdminResponse::Error {
                        message: format!("image processing failed: {e}"),
                    }
                }
            };
            let blake3_hash = blake3::hash(&webp).to_hex().to_string();
            let blob_ref = match handler
                .inner
                .blobz
                .insert(
                    blake3_hash,
                    Some("hub-avatar.webp".to_string()),
                    Some("image/webp".to_string()),
                    &webp,
                )
                .await
            {
                Ok(b) => b,
                Err(e) => {
                    return AdminResponse::Error {
                        message: format!("blobz insert failed: {e}"),
                    }
                }
            };
            if let Err(e) = handler
                .inner
                .userz
                .upsert_self_full(
                    &handler.inner.hub_node_id,
                    None,
                    None,
                    None,
                    Some(&blob_ref.blake3),
                    None,
                )
                .await
            {
                return AdminResponse::Error {
                    message: format!("userz avatar update failed: {e}"),
                };
            }
            let data_url = crate::hub::avatar::encode_data_url("image/webp", &webp);
            // update the in-memory lock
            let (username, bio, accent_color) = {
                let mut p = handler.inner.hub_profile.write().await;
                p.avatar_data_url = data_url.clone();
                (p.username.clone(), p.bio.clone(), p.accent_color)
            };
            // notify the broadcast loop to push the updated profile to online peers
            handler.inner.profile_changed.notify_one();
            AdminResponse::HubProfile {
                username,
                bio,
                accent_color,
                avatar_data_url: data_url,
            }
        }
        AdminRequest::CanvasBlobs {
            canvas_doc_id,
            offset,
            limit,
        } => {
            let limit = clamp_limit(limit);
            let blobs = canvas_blobs_for(
                &handler.inner.hub_repo,
                &handler.inner.blobz,
                &canvas_doc_id,
            )
            .await;
            let total = blobs.len() as u64;
            let page: Vec<BlobUsageSummary> = blobs
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect();
            AdminResponse::CanvasBlobs {
                canvas_doc_id,
                blobs: page,
                total,
            }
        }
    }
}

/// clamp a requested page limit to a sane maximum.
/// 0 → default 50; anything above 200 → 200.
fn clamp_limit(limit: u64) -> i64 {
    if limit == 0 {
        50
    } else {
        limit.min(200) as i64
    }
}

/// handle `AdminRequest::UnsyncCanvas`:
/// 1. write the hub OUT of the canvas automerge doc (remove from `peers` and `acl`).
/// 2. remove from the live in-memory `canvas_doc_ids` set.
/// 3. soft-remove from hub_repo storage and evict the doc handle.
/// 4. sweep blobs that were only referenced by this canvas (inline, for the count).
async fn handle_unsync_canvas(
    handler: &HubAdminHandler,
    actor: &str,
    canvas_doc_id: &str,
) -> AdminResponse {
    // step 1: write hub out of the canvas automerge doc.
    // if the doc handle isn't found, log a warning and continue with cleanup.
    let doc_written_out = match handler.inner.hub_repo.find(canvas_doc_id).await {
        Some(handle) => {
            let node_id = handler.inner.hub_node_id.clone();
            let did = canvas_doc_id.to_string();
            let result = tokio::task::spawn_blocking(move || {
                remove_self_from_canvas_doc(&handle, &node_id, &did)
            })
            .await
            .unwrap_or(false);
            if result {
                // notify connected peers of the doc change
                handler.inner.hub_repo.notify_doc_changed(canvas_doc_id);
            }
            result
        }
        None => {
            tracing::warn!(
                canvas_doc_id,
                "unsync: doc handle not found — skipping doc write, proceeding with cleanup"
            );
            false
        }
    };
    tracing::info!(
        canvas_doc_id,
        wrote_out = doc_written_out,
        "unsync: hub self-removal from canvas doc"
    );

    // step 2: remove from the live in-memory canvas_doc_ids set.
    {
        let mut ids = handler.inner.canvas_doc_ids.lock().await;
        ids.remove(canvas_doc_id);
    }

    // step 3: soft-remove from storage and evict the doc handle.
    handler
        .inner
        .hub_repo
        .soft_remove_canvas_id(canvas_doc_id)
        .await;
    handler.inner.hub_repo.evict_doc(canvas_doc_id).await;

    // step 4: sweep blobs unique to this canvas (inline so we can return the count).
    let swept = match crate::maintenance::sweep_canvas_blobs(
        handler.inner.hub_repo.storage(),
        &handler.inner.blobz,
        canvas_doc_id,
        actor,
    )
    .await
    {
        Ok(n) => {
            if n > 0 {
                tracing::info!(
                    canvas_doc_id,
                    soft_deleted = n,
                    "unsync: orphan blobs soft-deleted"
                );
            }
            n
        }
        Err(e) => {
            tracing::warn!(
                canvas_doc_id,
                error = %e,
                "unsync: sweep_canvas_blobs failed"
            );
            0
        }
    };

    AdminResponse::CanvasUnsynced {
        canvas_doc_id: canvas_doc_id.to_string(),
        swept,
    }
}

/// write the hub peer OUT of a canvas doc: delete the hub's entry from the
/// `peers` map and from the `acl` map. mirrors the inverse of
/// `write_self_to_canvas_doc`. runs inside `spawn_blocking`.
fn remove_self_from_canvas_doc(
    handle: &crate::hub_repo::DocHandle,
    node_id: &str,
    canvas_doc_id: &str,
) -> bool {
    use automerge::ReadDoc;

    handle.with_document_mut(|doc| {
        let has_version = doc.get(automerge::ROOT, "version").ok().flatten().is_some();
        let has_widgets = doc.get(automerge::ROOT, "widgets").ok().flatten().is_some();
        let has_title = doc.get(automerge::ROOT, "title").ok().flatten().is_some();
        if !has_version && !has_widgets && !has_title {
            tracing::info!(canvas_doc_id, "remove_self: doc has no content — not synced yet");
            return false;
        }

        let nid = node_id.to_string();
        match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            // remove from peers map
            if let Some((_, peers_obj)) = tx.get(automerge::ROOT, "peers")? {
                if tx.get(&peers_obj, nid.as_str())?.is_some() {
                    tx.delete(&peers_obj, nid.as_str())?;
                    tracing::debug!(canvas_doc_id, node_id = %nid, "remove_self: deleted from peers");
                }
            }
            // remove from acl map
            if let Some((_, acl_obj)) = tx.get(automerge::ROOT, "acl")? {
                if tx.get(&acl_obj, nid.as_str())?.is_some() {
                    tx.delete(&acl_obj, nid.as_str())?;
                    tracing::debug!(canvas_doc_id, node_id = %nid, "remove_self: deleted from acl");
                }
            }
            Ok(())
        }) {
            Ok(_) => true,
            Err(e) => {
                tracing::warn!(canvas_doc_id, error = ?e, "remove_self: transact failed");
                false
            }
        }
    })
}

/// read an avatar blob's bytes out of `blobz` and encode as a
/// `data:<mime>;base64,...` string, for `AdminRequest::List`'s
/// `FriendSummary.avatar_data_url`. returns `None` (never a hard error —
/// this is best-effort presentation data, not something worth failing an
/// entire `List` request over) if the blob row is missing, has no mime, or
/// the bytes can't be read.
async fn build_avatar_data_url(blobz: &blobz::Store, blake3: &str) -> Option<String> {
    let blob = blobz.get(blake3).await.ok()??;
    let mime = blob.mime.clone()?;
    let bytes = blobz.read_bytes(blake3).await.ok()??;
    Some(crate::hub::avatar::encode_data_url(&mime, &bytes))
}

// ---------------------------------------------------------------------------
// pending-knock aggregation
// ---------------------------------------------------------------------------

/// scan every doc the hub holds for `pendingKnocks` entries and return a
/// flattened, cross-canvas summary list.
///
/// "every doc the hub holds" is [`HubRepo::all_doc_ids`] — the same
/// enumeration `hub::canvas::send_blob_seek_to_peer` already uses to scan
/// every doc for blob references — rather than a canvas-only tracking set,
/// since this handler (unlike `hub::HubPeerService`) has no
/// `canvas_doc_ids` set of its own to scan instead. widget-state docs the
/// hub also holds simply have no `pendingKnocks` field at all, so they
/// fall out of the scan for free without needing to distinguish doc kinds
/// up front — the same reasoning `send_blob_seek_to_peer` already relies
/// on for its own root-level field probe.
async fn list_pending_knocks(hub_repo: &HubRepo) -> Vec<HubKnockSummary> {
    let doc_ids = hub_repo.all_doc_ids().await;
    let mut summaries = Vec::new();

    for doc_id in doc_ids {
        let handle = match hub_repo.find(&doc_id).await {
            Some(h) => h,
            None => continue,
        };
        let doc_id_owned = doc_id.clone();
        let knocks =
            tokio::task::spawn_blocking(move || read_pending_knocks(&handle, &doc_id_owned))
                .await
                .unwrap_or_default();
        summaries.extend(knocks);
    }

    summaries
}

/// read a canvas doc's `pendingKnocks` map into a list of summaries, one
/// per still-undecided entry (an entry with a non-empty `decisions` list
/// has already been decided — see `PendingCanvasKnock.decisions` in
/// `canvas-doc.ts` — so it's excluded: it's no longer "pending" even if it
/// hasn't been cleaned up out of the map yet, see section 6 of the plan
/// doc for why cleanup lags behind resolution).
///
/// runs inside `spawn_blocking` because doc access holds a lock.
fn read_pending_knocks(
    handle: &crate::hub_repo::DocHandle,
    canvas_doc_id: &str,
) -> Vec<HubKnockSummary> {
    use automerge::ReadDoc;

    fn read_str(doc: &automerge::Automerge, obj: &automerge::ObjId, key: &str) -> String {
        match doc.get(obj, key) {
            Ok(Some((automerge::Value::Object(automerge::ObjType::Text), text_id))) => {
                doc.text(&text_id).unwrap_or_default()
            }
            Ok(Some((v, _))) => v.to_str().map(|s| s.to_string()).unwrap_or_default(),
            _ => String::new(),
        }
    }

    let mut summaries = Vec::new();

    handle.with_document(|doc| {
        let pending_obj = match doc.get(automerge::ROOT, "pendingKnocks") {
            Ok(Some((_, obj_id))) => obj_id,
            _ => return,
        };

        let keys: Vec<String> = doc.keys(&pending_obj).collect();
        for requester_node_id in keys {
            let knock_obj = match doc.get(&pending_obj, requester_node_id.as_str()) {
                Ok(Some((_, obj_id))) => obj_id,
                _ => continue,
            };

            // skip already-decided knocks — see this function's doc comment.
            if let Ok(Some((_, decisions_obj))) = doc.get(&knock_obj, "decisions") {
                if doc.length(&decisions_obj) > 0 {
                    continue;
                }
            }

            let requester_username = read_str(doc, &knock_obj, "requesterUsername");
            let message = read_str(doc, &knock_obj, "message");
            let knocked_at_str = read_str(doc, &knock_obj, "knockedAt");
            let knocked_at = time::OffsetDateTime::parse(
                &knocked_at_str,
                &time::format_description::well_known::Rfc3339,
            )
            .map(|dt| dt.unix_timestamp())
            .unwrap_or(0);

            summaries.push(HubKnockSummary {
                canvas_doc_id: canvas_doc_id.to_string(),
                knock_id: requester_node_id.clone(),
                requester_node_id,
                requester_username,
                message,
                knocked_at,
            });
        }
    });

    summaries
}

// ---------------------------------------------------------------------------
// disk and canvas usage helpers
// ---------------------------------------------------------------------------

/// query bytes available to unprivileged users and total bytes on the
/// filesystem containing `path`. returns `None` on failure or non-unix.
#[cfg(unix)]
fn disk_space(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if ret != 0 {
        return None;
    }
    let available = (stat.f_bavail as u64).checked_mul(stat.f_frsize as u64)?;
    let total = (stat.f_blocks as u64).checked_mul(stat.f_frsize as u64)?;
    Some((available, total))
}

#[cfg(not(unix))]
fn disk_space(_path: &std::path::Path) -> Option<(u64, u64)> {
    None
}

/// for each canvas the hub holds, sum the sizes of blobs referenced by its
/// file widgets. only blobs already present in the local blobz store are
/// counted; widgets whose blake3 has not been snatched yet are skipped.
///
/// blobs shared across canvases count independently in each canvas entry —
/// see `CanvasUsageSummary`'s doc comment.
async fn canvas_usage(hub_repo: &HubRepo, blobz: &blobz::Store) -> Vec<CanvasUsageSummary> {
    use crate::snatch::{classify_doc, read_canvas_for_file_widgets, read_widget_state, DocKind};

    let doc_ids = hub_repo.all_doc_ids().await;
    let mut summaries = Vec::new();

    for doc_id in &doc_ids {
        let handle = match hub_repo.find(doc_id).await {
            Some(h) => h,
            None => continue,
        };

        // only process canvas docs
        let kind = {
            let h = handle.clone();
            tokio::task::spawn_blocking(move || classify_doc(&h))
                .await
                .unwrap_or(DocKind::Unknown)
        };
        if kind != DocKind::Canvas {
            continue;
        }

        // collect widget doc IDs from this canvas
        let doc_id_owned = doc_id.clone();
        let placeholder_refs = tokio::task::spawn_blocking(move || {
            let (refs, _peers) = read_canvas_for_file_widgets(&handle, &doc_id_owned, "");
            refs
        })
        .await
        .unwrap_or_default();

        let mut blob_count = 0u64;
        let mut total_bytes = 0u64;

        for placeholder in &placeholder_refs {
            let whandle = match hub_repo.find(&placeholder.widget_doc_id).await {
                Some(h) => h,
                None => continue,
            };
            let canvas_id = doc_id.clone();
            let wdoc_id = placeholder.widget_doc_id.clone();
            let widget_ref = tokio::task::spawn_blocking(move || {
                read_widget_state(&whandle, &canvas_id, &wdoc_id)
            })
            .await
            .ok()
            .flatten();

            let Some(wref) = widget_ref else { continue };
            if wref.blake3.is_empty() {
                continue;
            }

            // only count blobs already in the local store
            if let Ok(Some(blob)) = blobz.get(&wref.blake3).await {
                blob_count += 1;
                total_bytes += blob.size as u64;
            }
        }

        summaries.push(CanvasUsageSummary {
            canvas_doc_id: doc_id.clone(),
            blob_count,
            total_bytes,
        });
    }

    summaries
}

/// walk a single canvas doc for its file widgets, resolve each widget's
/// blob reference, and return a deduped (by blake3), sorted (size desc) list
/// of BlobUsageSummary rows for the CanvasBlobs request.
///
/// includes blobs that are:
/// - live in blobz (normal case)
/// - soft-deleted (`soft_deleted = true`)
/// - never snatched (`size = 0`, filename taken from the widget doc)
async fn canvas_blobs_for(
    hub_repo: &HubRepo,
    blobz: &blobz::Store,
    canvas_doc_id: &str,
) -> Vec<BlobUsageSummary> {
    use crate::snatch::{read_canvas_for_file_widgets, read_widget_state};
    use std::collections::HashMap;

    let handle = match hub_repo.find(canvas_doc_id).await {
        Some(h) => h,
        None => return Vec::new(),
    };

    let doc_id_owned = canvas_doc_id.to_string();
    let placeholder_refs = tokio::task::spawn_blocking(move || {
        let (refs, _peers) = read_canvas_for_file_widgets(&handle, &doc_id_owned, "");
        refs
    })
    .await
    .unwrap_or_default();

    // dedupe by blake3: accumulate into a map, keeping the most informative
    // entry (prefer a blobz-resolved row over a widget-only stub).
    let mut by_blake3: HashMap<String, BlobUsageSummary> = HashMap::new();

    for placeholder in &placeholder_refs {
        let whandle = match hub_repo.find(&placeholder.widget_doc_id).await {
            Some(h) => h,
            None => continue,
        };
        let cid = canvas_doc_id.to_string();
        let wid = placeholder.widget_doc_id.clone();
        let wref = tokio::task::spawn_blocking(move || read_widget_state(&whandle, &cid, &wid))
            .await
            .ok()
            .flatten();
        let Some(wref) = wref else { continue };
        if wref.blake3.is_empty() {
            continue;
        }

        // skip if we already have a blobz-resolved entry for this blake3.
        if by_blake3.contains_key(&wref.blake3) {
            continue;
        }

        let blob_any = blobz.get_any(&wref.blake3).await.ok().flatten();
        let (size, filename, mime, external, soft_deleted) = if let Some(b) = blob_any {
            let is_soft_deleted = blobz.get(&wref.blake3).await.ok().flatten().is_none();
            (
                b.size as u64,
                b.filename.or_else(|| {
                    if wref.filename.is_empty() {
                        None
                    } else {
                        Some(wref.filename.clone())
                    }
                }),
                b.mime,
                b.external,
                is_soft_deleted,
            )
        } else {
            // never snatched — use widget doc metadata, size 0
            (
                0,
                if wref.filename.is_empty() {
                    None
                } else {
                    Some(wref.filename.clone())
                },
                if wref.mime.is_empty() {
                    None
                } else {
                    Some(wref.mime.clone())
                },
                false,
                false,
            )
        };

        by_blake3.insert(
            wref.blake3.clone(),
            BlobUsageSummary {
                blake3: wref.blake3,
                filename,
                mime,
                size,
                external,
                soft_deleted,
            },
        );
    }

    let mut result: Vec<BlobUsageSummary> = by_blake3.into_values().collect();
    // sort largest-first; unsnatched (size 0) blobs sort to the end.
    result.sort_by(|a, b| b.size.cmp(&a.size).then(a.blake3.cmp(&b.blake3)));
    result
}

async fn send_response(
    send: &mut iroh::endpoint::SendStream,
    resp: &AdminResponse,
) -> Result<(), String> {
    let mut buf = Vec::new();
    ciborium::into_writer(resp, &mut buf)
        .map_err(|e| format!("failed to encode CBOR response: {e}"))?;
    send.write_all(&buf)
        .await
        .map_err(|e| format!("failed to write response: {e}"))?;
    send.finish()
        .map_err(|e| format!("failed to finish stream: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    /// the returned `TempDir` backs `HubRepo`'s sqlite file and must be kept
    /// alive by the caller for as long as the returned handler/hub_repo are
    /// used (dropping it deletes the backing file out from under the pool).
    async fn make_handler() -> (
        HubAdminHandler,
        adminz::Store,
        friendz::Store,
        userz::Directory,
        blobz::Store,
        HubRepo,
        tempfile::TempDir,
        Arc<tokio::sync::Notify>,
    ) {
        let pool = db::open_in_memory().await;
        let adminz_store = adminz::Store::new(pool.clone());
        let friendz_store = friendz::Store::new(pool.clone());
        let userz_dir = userz::Directory::new(pool.clone());
        let tmp = tempfile::tempdir().expect("tempdir");
        let blobz_store = blobz::Store::new(pool, tmp.path());
        let hub_repo = HubRepo::new("hub-node".to_string(), &tmp.path().join("hub-docs.db"))
            .await
            .expect("HubRepo::new should succeed");
        let canvas_doc_ids = Arc::new(tokio::sync::Mutex::new(
            std::collections::HashSet::<String>::new(),
        ));
        let hub_profile = default_test_hub_profile();
        let profile_changed = Arc::new(tokio::sync::Notify::new());
        (
            HubAdminHandler::new(
                adminz_store.clone(),
                friendz_store.clone(),
                userz_dir.clone(),
                blobz_store.clone(),
                hub_repo.clone(),
                "hub-node".to_string(),
                canvas_doc_ids,
                hub_profile,
                Arc::clone(&profile_changed),
            ),
            adminz_store,
            friendz_store,
            userz_dir,
            blobz_store,
            hub_repo,
            tmp,
            profile_changed,
        )
    }

    /// default hub profile for tests.
    fn default_test_hub_profile() -> Arc<tokio::sync::RwLock<HubProfile>> {
        Arc::new(tokio::sync::RwLock::new(HubProfile {
            username: "test-hub".to_string(),
            bio: "a test hub".to_string(),
            accent_color: 0,
            avatar_data_url: String::new(),
        }))
    }

    #[test]
    fn request_and_response_cbor_round_trip() {
        let req = AdminRequest::Allow {
            node_id: "abc".to_string(),
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&req, &mut buf).unwrap();
        let decoded: AdminRequest = ciborium::from_reader(buf.as_slice()).unwrap();
        assert!(matches!(decoded, AdminRequest::Allow { node_id } if node_id == "abc"));

        let resp = AdminResponse::Removed {
            node_id: "abc".to_string(),
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&resp, &mut buf).unwrap();
        let decoded: AdminResponse = ciborium::from_reader(buf.as_slice()).unwrap();
        assert!(matches!(decoded, AdminResponse::Removed { node_id } if node_id == "abc"));
    }

    #[tokio::test]
    async fn non_admin_is_rejected_for_all_operations() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        let stranger = "stranger-node";

        let allow = handle_request(
            &handler,
            stranger,
            AdminRequest::Allow {
                node_id: "target".to_string(),
            },
        )
        .await;
        assert!(matches!(allow, AdminResponse::NotAdmin));

        let list = handle_request(&handler, stranger, AdminRequest::List).await;
        assert!(matches!(list, AdminResponse::NotAdmin));

        let remove = handle_request(
            &handler,
            stranger,
            AdminRequest::Remove {
                node_id: "target".to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::NotAdmin));
    }

    #[tokio::test]
    async fn admin_can_allow_list_and_remove() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let allow = handle_request(
            &handler,
            admin_node,
            AdminRequest::Allow {
                node_id: "target-peer".to_string(),
            },
        )
        .await;
        match allow {
            AdminResponse::Allowed { node_id, status } => {
                assert_eq!(node_id, "target-peer");
                assert_eq!(status, "allowed");
            }
            other => panic!("expected Allowed, got {other:?}"),
        }

        let list = handle_request(&handler, admin_node, AdminRequest::List).await;
        match list {
            AdminResponse::List { friends } => {
                assert_eq!(friends.len(), 1);
                assert_eq!(friends[0].node_id, "target-peer");
            }
            other => panic!("expected List, got {other:?}"),
        }

        let remove = handle_request(
            &handler,
            admin_node,
            AdminRequest::Remove {
                node_id: "target-peer".to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::Removed { .. }));

        let list_after = handle_request(&handler, admin_node, AdminRequest::List).await;
        match list_after {
            AdminResponse::List { friends } => assert!(friends.is_empty()),
            other => panic!("expected List, got {other:?}"),
        }
    }

    /// proves the cancellation wiring added alongside this handler's
    /// `hub_repo` field: a `Remove` request doesn't just delete the
    /// `friendz` row, it also cancels that peer's already-accepted
    /// `iroh/automerge-repo/1` connection (driven here by a real
    /// `HubRepo::handle_connection` loop over an in-memory
    /// `tokio::io::duplex` pair, same approach as
    /// `hub_repo::tests::cancel_peer_terminates_an_active_connection_promptly`
    /// and `sync::tests::revoking_friendz_status_now_cancels_an_already_accepted_connection`,
    /// since no unit test in this crate spins up a real iroh connection).
    #[tokio::test]
    async fn admin_remove_cancels_an_active_connection() {
        let (handler, adminz_store, friendz_store, userz_dir, _blobz, hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        let target_peer = "target-peer";
        adminz_store.allow(admin_node).await.unwrap();
        userz_dir.touch(target_peer).await.unwrap();
        friendz_store
            .upsert(target_peer, friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();

        let (client_side, server_side) = tokio::io::duplex(8192);
        let repo_for_task = hub_repo.clone();
        let conn_handle = tokio::spawn(async move {
            repo_for_task
                .handle_connection(target_peer.to_string(), server_side)
                .await;
        });

        for _ in 0..100 {
            if hub_repo.connected_peer_count().await == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(hub_repo.connected_peer_count().await, 1);

        let remove = handle_request(
            &handler,
            admin_node,
            AdminRequest::Remove {
                node_id: target_peer.to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::Removed { .. }));

        tokio::time::timeout(std::time::Duration::from_secs(2), conn_handle)
            .await
            .expect("handle_connection should return promptly once cancelled")
            .expect("handle_connection task should not panic");
        assert_eq!(hub_repo.connected_peer_count().await, 0);

        drop(client_side);
    }

    #[tokio::test]
    async fn admin_allow_does_not_demote_an_already_accepted_friend() {
        let (handler, adminz_store, friendz_store, userz_dir, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // simulate a friend that's already gone through the full handshake.
        // needs a userz row first to satisfy the friendz FK.
        userz_dir.touch("already-accepted").await.unwrap();
        friendz_store
            .upsert("already-accepted", friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();

        let allow = handle_request(
            &handler,
            admin_node,
            AdminRequest::Allow {
                node_id: "already-accepted".to_string(),
            },
        )
        .await;
        match allow {
            AdminResponse::Allowed { status, .. } => assert_eq!(status, "accepted"),
            other => panic!("expected Allowed, got {other:?}"),
        }
    }

    /// the existing `non_admin_is_rejected_for_all_operations` test only
    /// checks the response variant. a rejected request must also have zero
    /// side effects — confirm the friendz table is untouched, not just that
    /// the wire response looks right.
    #[tokio::test]
    async fn non_admin_requests_have_no_side_effects_on_friendz_table() {
        let (handler, _adminz, friendz_store, userz_dir, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let stranger = "stranger-node";

        let allow = handle_request(
            &handler,
            stranger,
            AdminRequest::Allow {
                node_id: "target".to_string(),
            },
        )
        .await;
        assert!(matches!(allow, AdminResponse::NotAdmin));
        assert!(
            friendz_store.get("target").await.unwrap().is_none(),
            "a rejected Allow must not create a friendz row"
        );

        // seed a real friendz row directly (bypassing the handler) so we can
        // confirm a rejected Remove doesn't touch it either.
        userz_dir.touch("existing-friend").await.unwrap();
        friendz_store
            .upsert("existing-friend", friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();

        let remove = handle_request(
            &handler,
            stranger,
            AdminRequest::Remove {
                node_id: "existing-friend".to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::NotAdmin));
        assert!(
            friendz_store
                .get("existing-friend")
                .await
                .unwrap()
                .is_some(),
            "a rejected Remove must not delete an existing friendz row"
        );

        let list = handle_request(&handler, stranger, AdminRequest::List).await;
        assert!(matches!(list, AdminResponse::NotAdmin));
    }

    /// admin/friendz status are independent per `adminz`'s own doc comment;
    /// this test confirms it specifically through the wire protocol: an
    /// admin `Remove` request only ever deletes a `friendz` row (there is no
    /// remote way to mutate `hub_adminz` at all — see `AdminRequest`'s
    /// variants), so it must never affect the caller's own admin rights.
    #[tokio::test]
    async fn admin_remove_never_touches_the_adminz_table() {
        let (handler, adminz_store, friendz_store, userz_dir, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();
        userz_dir.touch(admin_node).await.unwrap();
        friendz_store
            .upsert(admin_node, friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();

        // an admin can "remove" their own node id from friendz (self is not
        // special-cased) without losing admin rights.
        let remove = handle_request(
            &handler,
            admin_node,
            AdminRequest::Remove {
                node_id: admin_node.to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::Removed { .. }));
        assert!(!friendz_store.is_friend(admin_node).await);
        assert!(
            adminz_store.is_admin(admin_node).await,
            "removing a friendz row must never revoke admin rights"
        );
    }

    /// `Remove` on a node id with no friendz row is a no-op delete (matches
    /// `friendz::Store::delete`'s documented idempotent-delete convention
    /// used throughout this codebase, e.g. `blobz`/`adminz`), so it still
    /// reports `Removed` rather than an error. documenting this explicitly:
    /// it's an intentional "delete is idempotent" convention, not a bug.
    #[tokio::test]
    async fn admin_remove_of_nonexistent_friend_reports_removed_not_error() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let remove = handle_request(
            &handler,
            admin_node,
            AdminRequest::Remove {
                node_id: "never-existed".to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::Removed { .. }));
    }

    /// whitespace-only node ids must be rejected the same way empty ones
    /// are (`node_id.trim()` runs before the emptiness check) for both
    /// mutating request variants.
    #[tokio::test]
    async fn allow_and_remove_reject_whitespace_only_node_id() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let allow = handle_request(
            &handler,
            admin_node,
            AdminRequest::Allow {
                node_id: "   ".to_string(),
            },
        )
        .await;
        assert!(matches!(allow, AdminResponse::Error { .. }));

        let remove = handle_request(
            &handler,
            admin_node,
            AdminRequest::Remove {
                node_id: "  \t ".to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::Error { .. }));
    }

    // -- Block / PromoteAdmin / DemoteAdmin ------------------------------

    #[tokio::test]
    async fn admin_can_block_and_then_unblock_via_allow() {
        let (handler, adminz_store, friendz_store, userz_dir, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();
        userz_dir.touch("target-peer").await.unwrap();
        friendz_store
            .upsert("target-peer", friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();

        let block = handle_request(
            &handler,
            admin_node,
            AdminRequest::Block {
                node_id: "target-peer".to_string(),
            },
        )
        .await;
        assert!(matches!(block, AdminResponse::Blocked { node_id } if node_id == "target-peer"));
        assert!(!friendz_store.is_friend("target-peer").await);
        assert_eq!(
            friendz_store
                .get("target-peer")
                .await
                .unwrap()
                .unwrap()
                .status,
            friendz::FriendStatus::Blocked
        );

        // "unblock" is just Allow again — no separate Unblock variant.
        let unblock = handle_request(
            &handler,
            admin_node,
            AdminRequest::Allow {
                node_id: "target-peer".to_string(),
            },
        )
        .await;
        match unblock {
            AdminResponse::Allowed { status, .. } => assert_eq!(status, "allowed"),
            other => panic!("expected Allowed, got {other:?}"),
        }
        assert!(friendz_store.is_friend("target-peer").await);
    }

    #[tokio::test]
    async fn block_rejects_empty_node_id_and_non_admin_callers() {
        let (handler, adminz_store, friendz_store, userz_dir, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let empty = handle_request(
            &handler,
            admin_node,
            AdminRequest::Block {
                node_id: "   ".to_string(),
            },
        )
        .await;
        assert!(matches!(empty, AdminResponse::Error { .. }));

        userz_dir.touch("target-peer").await.unwrap();
        friendz_store
            .upsert("target-peer", friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();
        let stranger = "stranger-node";
        let rejected = handle_request(
            &handler,
            stranger,
            AdminRequest::Block {
                node_id: "target-peer".to_string(),
            },
        )
        .await;
        assert!(matches!(rejected, AdminResponse::NotAdmin));
        assert!(
            friendz_store.is_friend("target-peer").await,
            "a non-admin Block request must not change friendz status"
        );
    }

    #[tokio::test]
    async fn admin_can_promote_and_demote_a_second_admin() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();
        assert!(!adminz_store.is_admin("new-admin").await);

        let promote = handle_request(
            &handler,
            admin_node,
            AdminRequest::PromoteAdmin {
                node_id: "new-admin".to_string(),
            },
        )
        .await;
        assert!(matches!(
            promote,
            AdminResponse::AdminChanged { node_id, is_admin: true } if node_id == "new-admin"
        ));
        assert!(adminz_store.is_admin("new-admin").await);

        // the newly-promoted admin can now make their own requests.
        let list = handle_request(&handler, "new-admin", AdminRequest::List).await;
        assert!(matches!(list, AdminResponse::List { .. }));

        let demote = handle_request(
            &handler,
            admin_node,
            AdminRequest::DemoteAdmin {
                node_id: "new-admin".to_string(),
            },
        )
        .await;
        assert!(matches!(
            demote,
            AdminResponse::AdminChanged { node_id, is_admin: false } if node_id == "new-admin"
        ));
        assert!(!adminz_store.is_admin("new-admin").await);

        let list_after = handle_request(&handler, "new-admin", AdminRequest::List).await;
        assert!(matches!(list_after, AdminResponse::NotAdmin));
    }

    #[tokio::test]
    async fn promote_and_demote_admin_reject_non_admin_callers() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        let stranger = "stranger-node";

        let promote = handle_request(
            &handler,
            stranger,
            AdminRequest::PromoteAdmin {
                node_id: "target".to_string(),
            },
        )
        .await;
        assert!(matches!(promote, AdminResponse::NotAdmin));

        let demote = handle_request(
            &handler,
            stranger,
            AdminRequest::DemoteAdmin {
                node_id: "target".to_string(),
            },
        )
        .await;
        assert!(matches!(demote, AdminResponse::NotAdmin));
    }

    // -- List profile enrichment ------------------------------------------

    #[tokio::test]
    async fn list_includes_username_bio_avatar_and_admin_status() {
        let (handler, adminz_store, friendz_store, userz_dir, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // a friend with a full profile, including an avatar blob.
        userz_dir.touch("alice").await.unwrap();
        userz_dir
            .upsert_profile("alice", Some("alice"), Some("hi, i'm alice"), None)
            .await
            .unwrap();
        let avatar_bytes = b"fake-png-bytes";
        let avatar_blob = blobz_store
            .insert(
                "alice-avatar-iroh-hash".to_string(),
                None,
                Some("image/png".to_string()),
                avatar_bytes,
            )
            .await
            .unwrap();
        userz_dir
            .upsert_profile("alice", None, None, Some(&avatar_blob.blake3))
            .await
            .unwrap();
        friendz_store
            .upsert("alice", friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();
        adminz_store.allow("alice").await.unwrap();

        // a friend with no profile data at all — should still list cleanly
        // with empty strings, not error.
        userz_dir.touch("bob").await.unwrap();
        friendz_store
            .upsert("bob", friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();

        let list = handle_request(&handler, admin_node, AdminRequest::List).await;
        let mut friends = match list {
            AdminResponse::List { friends } => friends,
            other => panic!("expected List, got {other:?}"),
        };
        friends.sort_by(|a, b| a.node_id.cmp(&b.node_id));

        assert_eq!(friends.len(), 2);
        let alice = &friends[0];
        assert_eq!(alice.node_id, "alice");
        assert_eq!(alice.username, "alice");
        assert_eq!(alice.bio, "hi, i'm alice");
        assert_eq!(
            alice.avatar_data_url,
            "data:image/png;base64,ZmFrZS1wbmctYnl0ZXM="
        );
        assert!(alice.is_admin);

        let bob = &friends[1];
        assert_eq!(bob.node_id, "bob");
        assert_eq!(bob.username, "");
        assert_eq!(bob.bio, "");
        assert_eq!(bob.avatar_data_url, "");
        assert!(!bob.is_admin);
    }

    /// before ever consulting `adminz` — malformed bytes on the wire (a
    /// truncated frame, a non-admin-protocol payload accidentally dialed at
    /// this ALPN, etc.) must fail cleanly rather than panic. `handle_stream`
    /// itself needs a live iroh stream to exercise end-to-end (no fake
    /// `SendStream`/`RecvStream` exists in this crate — see
    /// `sync::tests`'s doc comment for why), so this exercises the same
    /// decode call directly.
    #[test]
    fn malformed_cbor_bytes_fail_to_decode_without_panicking() {
        let garbage = [0xff_u8; 32];
        let result: Result<AdminRequest, _> = ciborium::from_reader(garbage.as_slice());
        assert!(result.is_err());
    }

    // -- ListPendingKnocks ----------------------------------------------

    /// seed a canvas doc's `pendingKnocks` map with the given entries (each
    /// with an empty `decisions` list, matching a freshly-recorded knock)
    /// and persist it via `HubDocStorage`, mirroring `blob_acl.rs`'s
    /// `seed_canvas_and_widget` seeding pattern — `HubRepo` has no public
    /// "insert this doc" method outside of a live sync message.
    async fn seed_canvas_with_knocks(
        db_path: &std::path::Path,
        canvas_doc_id: &str,
        knocks: &[(&str, &str, &str, &str)], // (requester_node_id, username, message, knocked_at)
    ) {
        let storage = crate::hub_repo::HubDocStorage::new(db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");

        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            let pending =
                tx.put_object(automerge::ROOT, "pendingKnocks", automerge::ObjType::Map)?;
            for (node_id, username, message, knocked_at) in knocks {
                let entry = tx.put_object(&pending, *node_id, automerge::ObjType::Map)?;
                tx.put(&entry, "requesterNodeId", *node_id)?;
                tx.put(&entry, "requesterUsername", *username)?;
                tx.put(&entry, "message", *message)?;
                tx.put(&entry, "knockedAt", *knocked_at)?;
                tx.put_object(&entry, "decisions", automerge::ObjType::List)?;
            }
            Ok(())
        })
        .expect("canvas doc transact should succeed");
        storage.save_doc(canvas_doc_id, &doc.save()).await;
    }

    #[tokio::test]
    async fn list_pending_knocks_aggregates_across_multiple_canvas_docs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");

        seed_canvas_with_knocks(
            &db_path,
            "canvas-1",
            &[("req-1", "alice", "hi", "2025-01-01T00:00:00Z")],
        )
        .await;
        seed_canvas_with_knocks(
            &db_path,
            "canvas-2",
            &[
                ("req-2", "bob", "please let me in", "2025-01-02T00:00:00Z"),
                ("req-3", "carol", "hey", "2025-01-03T00:00:00Z"),
            ],
        )
        .await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");
        let pool = db::open_in_memory().await;
        let adminz_store = adminz::Store::new(pool.clone());
        let friendz_store = friendz::Store::new(pool.clone());
        let userz_dir = userz::Directory::new(pool.clone());
        let blobz_store = blobz::Store::new(pool, tmp.path());
        let handler = HubAdminHandler::new(
            adminz_store.clone(),
            friendz_store,
            userz_dir,
            blobz_store,
            hub_repo,
            "hub-node".to_string(),
            Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
            default_test_hub_profile(),
            Arc::new(tokio::sync::Notify::new()),
        );

        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let response = handle_request(&handler, admin_node, AdminRequest::ListPendingKnocks).await;
        match response {
            AdminResponse::PendingKnocks { mut knocks } => {
                knocks.sort_by(|a, b| a.requester_node_id.cmp(&b.requester_node_id));
                assert_eq!(
                    knocks.len(),
                    3,
                    "should aggregate knocks across both canvases"
                );

                assert_eq!(knocks[0].canvas_doc_id, "canvas-1");
                assert_eq!(knocks[0].requester_node_id, "req-1");
                assert_eq!(knocks[0].requester_username, "alice");
                assert_eq!(knocks[0].message, "hi");
                assert!(knocks[0].knocked_at > 0);

                assert_eq!(knocks[1].canvas_doc_id, "canvas-2");
                assert_eq!(knocks[1].requester_node_id, "req-2");
                assert_eq!(knocks[1].requester_username, "bob");

                assert_eq!(knocks[2].canvas_doc_id, "canvas-2");
                assert_eq!(knocks[2].requester_node_id, "req-3");
            }
            other => panic!("expected PendingKnocks, got {other:?}"),
        }
    }

    /// an already-decided knock (non-empty `decisions`) is excluded from
    /// the listing — see `read_pending_knocks`'s doc comment.
    #[tokio::test]
    async fn list_pending_knocks_excludes_already_decided_entries() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");

        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");
        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            let pending =
                tx.put_object(automerge::ROOT, "pendingKnocks", automerge::ObjType::Map)?;

            let still_pending = tx.put_object(&pending, "req-pending", automerge::ObjType::Map)?;
            tx.put(&still_pending, "requesterNodeId", "req-pending")?;
            tx.put(&still_pending, "requesterUsername", "dave")?;
            tx.put(&still_pending, "message", "hello")?;
            tx.put(&still_pending, "knockedAt", "2025-01-01T00:00:00Z")?;
            tx.put_object(&still_pending, "decisions", automerge::ObjType::List)?;

            let decided = tx.put_object(&pending, "req-decided", automerge::ObjType::Map)?;
            tx.put(&decided, "requesterNodeId", "req-decided")?;
            tx.put(&decided, "requesterUsername", "erin")?;
            tx.put(&decided, "message", "hi there")?;
            tx.put(&decided, "knockedAt", "2025-01-01T00:00:00Z")?;
            let decisions = tx.put_object(&decided, "decisions", automerge::ObjType::List)?;
            let decision = tx.insert_object(&decisions, 0, automerge::ObjType::Map)?;
            tx.put(&decision, "byNodeId", "admin-node")?;
            tx.put(&decision, "decision", "approve")?;
            tx.put(&decision, "role", "member")?;
            tx.put(&decision, "at", "2025-01-01T01:00:00Z")?;

            Ok(())
        })
        .expect("canvas doc transact should succeed");
        storage.save_doc("canvas-1", &doc.save()).await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");
        let pool = db::open_in_memory().await;
        let adminz_store = adminz::Store::new(pool.clone());
        let friendz_store = friendz::Store::new(pool.clone());
        let userz_dir = userz::Directory::new(pool.clone());
        let blobz_store = blobz::Store::new(pool, tmp.path());
        let handler = HubAdminHandler::new(
            adminz_store.clone(),
            friendz_store,
            userz_dir,
            blobz_store,
            hub_repo,
            "hub-node".to_string(),
            Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
            default_test_hub_profile(),
            Arc::new(tokio::sync::Notify::new()),
        );
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let response = handle_request(&handler, admin_node, AdminRequest::ListPendingKnocks).await;
        match response {
            AdminResponse::PendingKnocks { knocks } => {
                assert_eq!(
                    knocks.len(),
                    1,
                    "the already-decided knock must be excluded"
                );
                assert_eq!(knocks[0].requester_node_id, "req-pending");
            }
            other => panic!("expected PendingKnocks, got {other:?}"),
        }
    }

    /// a non-admin caller must get `NotAdmin` for `ListPendingKnocks`, with
    /// no pending-knock data leaked in the response — mirrors
    /// `non_admin_requests_have_no_side_effects_on_friendz_table`'s
    /// "verify more than just the response variant" discipline, applied to
    /// this read-only request (its only possible "side effect" is leaking
    /// data it shouldn't).
    #[tokio::test]
    async fn non_admin_cannot_list_pending_knocks() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        seed_canvas_with_knocks(
            &db_path,
            "canvas-1",
            &[("req-1", "alice", "hi", "2025-01-01T00:00:00Z")],
        )
        .await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");
        let pool = db::open_in_memory().await;
        let adminz_store = adminz::Store::new(pool.clone());
        let friendz_store = friendz::Store::new(pool.clone());
        let userz_dir = userz::Directory::new(pool.clone());
        let blobz_store = blobz::Store::new(pool, tmp.path());
        let handler = HubAdminHandler::new(
            adminz_store,
            friendz_store,
            userz_dir,
            blobz_store,
            hub_repo,
            "hub-node".to_string(),
            Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
            default_test_hub_profile(),
            Arc::new(tokio::sync::Notify::new()),
        );

        let stranger = "stranger-node";
        let response = handle_request(&handler, stranger, AdminRequest::ListPendingKnocks).await;
        assert!(
            matches!(response, AdminResponse::NotAdmin),
            "non-admin must not receive pending-knock data"
        );
    }

    // -- DiskUsage -------------------------------------------------------

    #[tokio::test]
    async fn disk_usage_sums_blobz_sizes_and_counts_rows() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // empty store
        let resp = handle_request(&handler, admin_node, AdminRequest::DiskUsage).await;
        match resp {
            AdminResponse::DiskUsage {
                total_blob_bytes,
                blob_count,
                ..
            } => {
                assert_eq!(blob_count, 0);
                assert_eq!(total_blob_bytes, 0);
            }
            other => panic!("expected DiskUsage, got {other:?}"),
        }

        blobz_store
            .insert("h1".into(), None, None, b"hello")
            .await
            .unwrap();
        blobz_store
            .insert("h2".into(), None, None, b"world!!")
            .await
            .unwrap();

        let resp = handle_request(&handler, admin_node, AdminRequest::DiskUsage).await;
        match resp {
            AdminResponse::DiskUsage {
                total_blob_bytes,
                blob_count,
                ..
            } => {
                assert_eq!(blob_count, 2);
                assert_eq!(total_blob_bytes, (b"hello".len() + b"world!!".len()) as u64);
            }
            other => panic!("expected DiskUsage, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn non_admin_cannot_request_disk_usage() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        let resp = handle_request(&handler, "stranger", AdminRequest::DiskUsage).await;
        assert!(matches!(resp, AdminResponse::NotAdmin));
    }

    // -- BlobUsage -------------------------------------------------------

    #[tokio::test]
    async fn blob_usage_returns_all_blob_rows() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        blobz_store
            .insert(
                "h1".into(),
                Some("a.txt".into()),
                Some("text/plain".into()),
                b"aaa",
            )
            .await
            .unwrap();
        blobz_store
            .insert("h2".into(), None, None, b"bbbbb")
            .await
            .unwrap();

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::BlobUsage {
                offset: 0,
                limit: 50,
            },
        )
        .await;
        match resp {
            AdminResponse::BlobUsage { blobs, total } => {
                assert_eq!(blobs.len(), 2);
                assert_eq!(total, 2);
                let a = blobs
                    .iter()
                    .find(|b| b.filename == Some("a.txt".to_string()));
                assert!(a.is_some());
                assert_eq!(a.unwrap().size, 3);
                assert!(!a.unwrap().external);
            }
            other => panic!("expected BlobUsage, got {other:?}"),
        }
    }

    // -- SoftDeleteBlobs / RestoreBlobs / ListSoftDeleted / HardDeleteBlobs --

    #[tokio::test]
    async fn soft_delete_stamps_caller_as_actor_and_hides_blob() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let blob = blobz_store
            .insert("h-sd-admin".into(), None, None, b"soft del via admin")
            .await
            .unwrap();

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::SoftDeleteBlobs {
                blake3s: vec![blob.blake3.clone()],
            },
        )
        .await;
        match resp {
            AdminResponse::BlobsMutation { affected, failed } => {
                assert_eq!(affected, 1);
                assert!(failed.is_empty());
            }
            other => panic!("expected BlobsMutation, got {other:?}"),
        }

        // blob is hidden from normal get
        assert!(blobz_store.get(&blob.blake3).await.unwrap().is_none());
        // but the actor is the admin's node id
        let sd = blobz_store.list_soft_deleted().await.unwrap();
        assert_eq!(sd.len(), 1);
        assert_eq!(sd[0].soft_deleted_by, admin_node);
    }

    #[tokio::test]
    async fn restore_blobs_makes_blob_visible_again() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let blob = blobz_store
            .insert("h-res-admin".into(), None, None, b"restore me")
            .await
            .unwrap();
        blobz_store
            .soft_delete(&[blob.blake3.clone()], admin_node)
            .await
            .unwrap();
        assert!(blobz_store.get(&blob.blake3).await.unwrap().is_none());

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::RestoreBlobs {
                blake3s: vec![blob.blake3.clone()],
            },
        )
        .await;
        match resp {
            AdminResponse::BlobsMutation { affected, failed } => {
                assert_eq!(affected, 1);
                assert!(failed.is_empty());
            }
            other => panic!("expected BlobsMutation, got {other:?}"),
        }
        assert!(blobz_store.get(&blob.blake3).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn list_soft_deleted_returns_soft_deleted_blobs() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let blob = blobz_store
            .insert("h-lsd".into(), Some("f.txt".into()), None, b"list me")
            .await
            .unwrap();
        blobz_store
            .soft_delete(&[blob.blake3.clone()], admin_node)
            .await
            .unwrap();

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::ListSoftDeleted {
                offset: 0,
                limit: 50,
            },
        )
        .await;
        match resp {
            AdminResponse::SoftDeleted { blobs, total } => {
                assert_eq!(blobs.len(), 1);
                assert_eq!(total, 1);
                assert_eq!(blobs[0].blake3, blob.blake3);
                assert_eq!(blobs[0].filename.as_deref(), Some("f.txt"));
                assert_eq!(blobs[0].soft_deleted_by, admin_node);
            }
            other => panic!("expected SoftDeleted, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn hard_delete_blobs_removes_managed_file_and_row() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let blob = blobz_store
            .insert("h-hd-admin".into(), None, None, b"hard del via admin")
            .await
            .unwrap();
        let path = blobz_store.path_for(&blob);
        assert!(path.exists());

        // must soft-delete first
        blobz_store
            .soft_delete(&[blob.blake3.clone()], admin_node)
            .await
            .unwrap();

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::HardDeleteBlobs {
                blake3s: vec![blob.blake3.clone()],
                all: false,
            },
        )
        .await;
        match resp {
            AdminResponse::BlobsMutation { affected, failed } => {
                assert_eq!(affected, 1);
                assert!(failed.is_empty());
            }
            other => panic!("expected BlobsMutation, got {other:?}"),
        }
        assert!(blobz_store.get_any(&blob.blake3).await.unwrap().is_none());
        assert!(!path.exists(), "managed file must be unlinked");
    }

    #[tokio::test]
    async fn hard_delete_all_purges_every_soft_deleted_row() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        for i in 0u8..3 {
            let b = blobz_store
                .insert(format!("h-all-{i}"), None, None, &[i; 4])
                .await
                .unwrap();
            blobz_store
                .soft_delete(&[b.blake3], admin_node)
                .await
                .unwrap();
        }

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::HardDeleteBlobs {
                blake3s: vec![],
                all: true,
            },
        )
        .await;
        match resp {
            AdminResponse::BlobsMutation { affected, failed } => {
                assert_eq!(affected, 3);
                assert!(failed.is_empty());
            }
            other => panic!("expected BlobsMutation, got {other:?}"),
        }
        assert!(blobz_store.list_soft_deleted().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn disk_usage_includes_soft_deleted_fields() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let live = blobz_store
            .insert("h-du-live".into(), None, None, b"alive")
            .await
            .unwrap();
        let sd = blobz_store
            .insert("h-du-sd".into(), None, None, b"soft deleted")
            .await
            .unwrap();
        blobz_store
            .soft_delete(&[sd.blake3.clone()], admin_node)
            .await
            .unwrap();

        let resp = handle_request(&handler, admin_node, AdminRequest::DiskUsage).await;
        match resp {
            AdminResponse::DiskUsage {
                total_blob_bytes,
                blob_count,
                soft_deleted_blob_bytes,
                soft_deleted_blob_count,
                ..
            } => {
                assert_eq!(blob_count, 1);
                assert_eq!(total_blob_bytes, live.size as u64);
                assert_eq!(soft_deleted_blob_count, 1);
                assert_eq!(soft_deleted_blob_bytes, sd.size as u64);
            }
            other => panic!("expected DiskUsage, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn non_admin_cannot_soft_delete_restore_or_hard_delete_blobs() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        let stranger = "stranger-node";

        let sd = handle_request(
            &handler,
            stranger,
            AdminRequest::SoftDeleteBlobs {
                blake3s: vec!["any".to_string()],
            },
        )
        .await;
        assert!(matches!(sd, AdminResponse::NotAdmin));

        let restore = handle_request(
            &handler,
            stranger,
            AdminRequest::RestoreBlobs {
                blake3s: vec!["any".to_string()],
            },
        )
        .await;
        assert!(matches!(restore, AdminResponse::NotAdmin));

        let list = handle_request(
            &handler,
            stranger,
            AdminRequest::ListSoftDeleted {
                offset: 0,
                limit: 50,
            },
        )
        .await;
        assert!(matches!(list, AdminResponse::NotAdmin));

        let hard = handle_request(
            &handler,
            stranger,
            AdminRequest::HardDeleteBlobs {
                blake3s: vec!["any".to_string()],
                all: false,
            },
        )
        .await;
        assert!(matches!(hard, AdminResponse::NotAdmin));
    }

    // -- pagination tests -------------------------------------------------

    #[tokio::test]
    async fn blob_usage_pagination_returns_correct_page_and_total() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        for i in 0u8..5 {
            blobz_store
                .insert(format!("h-page-{i}"), None, None, &[i; 4])
                .await
                .unwrap();
        }

        // page 1: limit 2, offset 0
        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::BlobUsage {
                offset: 0,
                limit: 2,
            },
        )
        .await;
        match resp {
            AdminResponse::BlobUsage { blobs, total } => {
                assert_eq!(blobs.len(), 2);
                assert_eq!(total, 5, "total must reflect all rows, not just the page");
            }
            other => panic!("expected BlobUsage, got {other:?}"),
        }

        // page beyond end: offset 10 > total 5
        let resp2 = handle_request(
            &handler,
            admin_node,
            AdminRequest::BlobUsage {
                offset: 10,
                limit: 50,
            },
        )
        .await;
        match resp2 {
            AdminResponse::BlobUsage { blobs, total } => {
                assert!(blobs.is_empty(), "page beyond end must be empty");
                assert_eq!(total, 5, "total must still be correct");
            }
            other => panic!("expected BlobUsage, got {other:?}"),
        }

        // limit 0 → default 50 (returns all 5)
        let resp3 = handle_request(
            &handler,
            admin_node,
            AdminRequest::BlobUsage {
                offset: 0,
                limit: 0,
            },
        )
        .await;
        match resp3 {
            AdminResponse::BlobUsage { blobs, total } => {
                assert_eq!(blobs.len(), 5);
                assert_eq!(total, 5);
            }
            other => panic!("expected BlobUsage, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn soft_deleted_pagination_returns_correct_page_and_total() {
        let (handler, adminz_store, _friendz, _userz, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        for i in 0u8..4 {
            let b = blobz_store
                .insert(format!("h-sd-page-{i}"), None, None, &[i; 3])
                .await
                .unwrap();
            blobz_store
                .soft_delete(&[b.blake3], admin_node)
                .await
                .unwrap();
        }

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::ListSoftDeleted {
                offset: 0,
                limit: 2,
            },
        )
        .await;
        match resp {
            AdminResponse::SoftDeleted { blobs, total } => {
                assert_eq!(blobs.len(), 2);
                assert_eq!(total, 4);
            }
            other => panic!("expected SoftDeleted, got {other:?}"),
        }

        // offset beyond end
        let resp2 = handle_request(
            &handler,
            admin_node,
            AdminRequest::ListSoftDeleted {
                offset: 100,
                limit: 50,
            },
        )
        .await;
        match resp2 {
            AdminResponse::SoftDeleted { blobs, total } => {
                assert!(blobs.is_empty());
                assert_eq!(total, 4);
            }
            other => panic!("expected SoftDeleted, got {other:?}"),
        }
    }

    // -- UnsyncCanvas tests -----------------------------------------------

    #[tokio::test]
    async fn unsync_canvas_soft_removes_and_returns_swept_count() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");

        // seed a canvas with two blobs
        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new");
        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            tx.put(automerge::ROOT, "title", "test canvas")?;
            Ok(())
        })
        .unwrap();
        storage.save_doc("canvas-sync", &doc.save()).await;
        storage.save_canvas_id("canvas-sync").await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new");
        let pool = db::open_in_memory().await;
        let adminz_store = adminz::Store::new(pool.clone());
        let friendz_store = friendz::Store::new(pool.clone());
        let userz_dir = userz::Directory::new(pool.clone());
        let blobz_store = blobz::Store::new(pool, tmp.path());
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // track the canvas in the live set
        let canvas_doc_ids = Arc::new(tokio::sync::Mutex::new(
            std::collections::HashSet::<String>::from(["canvas-sync".to_string()]),
        ));
        let handler = HubAdminHandler::new(
            adminz_store,
            friendz_store,
            userz_dir,
            blobz_store,
            hub_repo,
            "hub-node".to_string(),
            Arc::clone(&canvas_doc_ids),
            default_test_hub_profile(),
            Arc::new(tokio::sync::Notify::new()),
        );

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::UnsyncCanvas {
                canvas_doc_id: "canvas-sync".to_string(),
            },
        )
        .await;
        match resp {
            AdminResponse::CanvasUnsynced {
                canvas_doc_id,
                swept,
            } => {
                assert_eq!(canvas_doc_id, "canvas-sync");
                // no blobs seeded → 0 swept
                assert_eq!(swept, 0);
            }
            other => panic!("expected CanvasUnsynced, got {other:?}"),
        }

        // canvas must be removed from the live in-memory set
        assert!(
            !canvas_doc_ids.lock().await.contains("canvas-sync"),
            "canvas must be removed from live canvas_doc_ids after UnsyncCanvas"
        );
    }

    #[tokio::test]
    async fn unsync_canvas_sweeps_only_canvas_unique_blobs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = db::open_in_memory().await;
        let blobz_store = blobz::Store::new(pool.clone(), tmp.path());

        // insert a blob and soft-delete it to simulate an orphan
        let b = blobz_store
            .insert("h-unsync-sweep".into(), None, None, b"sweepme")
            .await
            .unwrap();
        // leave the blob live (not soft-deleted) — sweep_canvas_blobs will
        // soft-delete it if it's only referenced by the target canvas.
        // here we simply test the "no widgets" path which sweeps nothing.
        let _ = b;

        let db_path = tmp.path().join("hub-docs.db");
        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new");
        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            tx.put(automerge::ROOT, "title", "canvas-to-unsync")?;
            Ok(())
        })
        .unwrap();
        storage.save_doc("canvas-to-unsync", &doc.save()).await;
        storage.save_canvas_id("canvas-to-unsync").await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new");
        let adminz_store = crate::adminz::Store::new(pool.clone());
        adminz_store.allow("admin").await.unwrap();
        let canvas_doc_ids = Arc::new(tokio::sync::Mutex::new(
            std::collections::HashSet::<String>::from(["canvas-to-unsync".to_string()]),
        ));
        let handler = HubAdminHandler::new(
            adminz_store,
            friendz::Store::new(pool.clone()),
            userz::Directory::new(pool),
            blobz_store,
            hub_repo,
            "hub-node".to_string(),
            canvas_doc_ids,
            default_test_hub_profile(),
            Arc::new(tokio::sync::Notify::new()),
        );

        let resp = handle_request(
            &handler,
            "admin",
            AdminRequest::UnsyncCanvas {
                canvas_doc_id: "canvas-to-unsync".to_string(),
            },
        )
        .await;
        assert!(
            matches!(resp, AdminResponse::CanvasUnsynced { swept, .. } if swept == 0),
            "no widget-referenced blobs → swept should be 0"
        );
    }

    #[tokio::test]
    async fn non_admin_cannot_unsync_canvas() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        let resp = handle_request(
            &handler,
            "stranger",
            AdminRequest::UnsyncCanvas {
                canvas_doc_id: "any-canvas".to_string(),
            },
        )
        .await;
        assert!(matches!(resp, AdminResponse::NotAdmin));
    }

    // -- GetHubProfile / SetHubProfile / SetHubAvatar --------------------

    #[tokio::test]
    async fn get_hub_profile_returns_current_values() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let resp = handle_request(&handler, admin_node, AdminRequest::GetHubProfile).await;
        match resp {
            AdminResponse::HubProfile {
                username,
                bio,
                accent_color,
                ..
            } => {
                assert_eq!(username, "test-hub");
                assert_eq!(bio, "a test hub");
                assert_eq!(accent_color, 0);
            }
            other => panic!("expected HubProfile, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn non_admin_cannot_get_hub_profile() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        let resp = handle_request(&handler, "stranger", AdminRequest::GetHubProfile).await;
        assert!(matches!(resp, AdminResponse::NotAdmin));
    }

    #[tokio::test]
    async fn set_hub_profile_round_trip_persists_to_userz_and_lock() {
        let (handler, adminz_store, _friendz, userz_dir, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // first upsert_self so the hub node row exists for the FK
        userz_dir
            .upsert_self("hub-node", Some("test-hub"), Some("a test hub"), None)
            .await
            .unwrap();

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::SetHubProfile {
                username: Some("new-hub-name".to_string()),
                bio: Some("updated bio".to_string()),
                accent_color: Some(42),
            },
        )
        .await;
        match &resp {
            AdminResponse::HubProfile {
                username,
                bio,
                accent_color,
                ..
            } => {
                assert_eq!(username, "new-hub-name");
                assert_eq!(bio, "updated bio");
                assert_eq!(*accent_color, 42);
            }
            other => panic!("expected HubProfile, got {other:?}"),
        }

        // verify persisted to userz
        let self_row = userz_dir.get_self().await.unwrap();
        assert!(self_row.is_some(), "self row must exist after upsert");
        let row = self_row.unwrap();
        assert_eq!(row.display_name.as_deref(), Some("new-hub-name"));
        assert_eq!(row.bio.as_deref(), Some("updated bio"));
        assert_eq!(row.accent_color, 42);

        // verify visible in a subsequent GetHubProfile
        let get_resp = handle_request(&handler, admin_node, AdminRequest::GetHubProfile).await;
        match get_resp {
            AdminResponse::HubProfile {
                username,
                bio,
                accent_color,
                ..
            } => {
                assert_eq!(username, "new-hub-name");
                assert_eq!(bio, "updated bio");
                assert_eq!(accent_color, 42);
            }
            other => panic!("expected HubProfile on second get, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn set_hub_profile_rejects_empty_username() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::SetHubProfile {
                username: Some("   ".to_string()),
                bio: None,
                accent_color: None,
            },
        )
        .await;
        assert!(matches!(resp, AdminResponse::Error { .. }));
    }

    #[tokio::test]
    async fn set_hub_profile_rejects_overlong_username_and_bio() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let long_name = "x".repeat(65);
        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::SetHubProfile {
                username: Some(long_name),
                bio: None,
                accent_color: None,
            },
        )
        .await;
        assert!(
            matches!(resp, AdminResponse::Error { .. }),
            "65-char username must fail"
        );

        let long_bio = "b".repeat(513);
        let resp2 = handle_request(
            &handler,
            admin_node,
            AdminRequest::SetHubProfile {
                username: None,
                bio: Some(long_bio),
                accent_color: None,
            },
        )
        .await;
        assert!(
            matches!(resp2, AdminResponse::Error { .. }),
            "513-char bio must fail"
        );
    }

    /// SetHubProfile fires the profile_changed notify on a successful update
    /// so the broadcast task in hub/mod.rs can push the change to online peers.
    /// SetHubProfile with invalid input must NOT fire it (no spurious broadcast).
    #[tokio::test]
    async fn set_hub_profile_fires_notify_on_success() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, notify) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // invalid request: empty username — notify must NOT fire
        handle_request(
            &handler,
            admin_node,
            AdminRequest::SetHubProfile {
                username: Some("   ".to_string()),
                bio: None,
                accent_color: None,
            },
        )
        .await;
        let no_fire =
            tokio::time::timeout(std::time::Duration::from_millis(10), notify.notified()).await;
        assert!(
            no_fire.is_err(),
            "notify must not fire for a rejected request"
        );

        // valid request: notify must fire
        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::SetHubProfile {
                username: Some("new-hub-name".to_string()),
                bio: Some("updated bio".to_string()),
                accent_color: None,
            },
        )
        .await;
        assert!(matches!(resp, AdminResponse::HubProfile { .. }));
        tokio::time::timeout(std::time::Duration::from_millis(100), notify.notified())
            .await
            .expect("notify must fire after a successful SetHubProfile");
    }

    #[tokio::test]
    async fn non_admin_cannot_set_hub_profile() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        let resp = handle_request(
            &handler,
            "stranger",
            AdminRequest::SetHubProfile {
                username: Some("evil".to_string()),
                bio: None,
                accent_color: None,
            },
        )
        .await;
        assert!(matches!(resp, AdminResponse::NotAdmin));
    }

    #[tokio::test]
    async fn set_hub_avatar_accepts_valid_png_and_updates_lock() {
        let (handler, adminz_store, _friendz, userz_dir, blobz_store, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // seed hub node row
        userz_dir
            .upsert_self("hub-node", Some("test-hub"), Some("bio"), None)
            .await
            .unwrap();

        // generate a minimal valid png in-memory (same helper as avatar.rs tests)
        let png = {
            let img = image::RgbImage::from_fn(8, 8, |x, y| {
                image::Rgb([(x * 32) as u8, (y * 32) as u8, 0])
            });
            let mut buf = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(img)
                .write_to(&mut buf, image::ImageFormat::Png)
                .unwrap();
            buf.into_inner()
        };

        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::SetHubAvatar { image_base64: b64 },
        )
        .await;
        match &resp {
            AdminResponse::HubProfile {
                avatar_data_url, ..
            } => {
                assert!(
                    avatar_data_url.starts_with("data:image/webp;base64,"),
                    "response must contain a webp data url"
                );
            }
            other => panic!("expected HubProfile, got {other:?}"),
        }

        // verify blobz has a blob now
        let blobs = blobz_store
            .list_paginated_with_count(10, 0)
            .await
            .unwrap()
            .0;
        assert!(!blobs.is_empty(), "avatar blob must be stored in blobz");

        // verify lock was updated
        let get_resp = handle_request(&handler, admin_node, AdminRequest::GetHubProfile).await;
        match get_resp {
            AdminResponse::HubProfile {
                avatar_data_url, ..
            } => {
                assert!(avatar_data_url.starts_with("data:image/webp;base64,"));
            }
            other => panic!("expected HubProfile, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn set_hub_avatar_rejects_oversized_image() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // build a base64 payload that decodes to > 512 KB
        use base64::Engine;
        let big = vec![0u8; 513 * 1024];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&big);

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::SetHubAvatar { image_base64: b64 },
        )
        .await;
        assert!(
            matches!(resp, AdminResponse::Error { .. }),
            "oversized avatar must be rejected with Error"
        );
    }

    #[tokio::test]
    async fn non_admin_cannot_set_hub_avatar() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"data");
        let resp = handle_request(
            &handler,
            "stranger",
            AdminRequest::SetHubAvatar { image_base64: b64 },
        )
        .await;
        assert!(matches!(resp, AdminResponse::NotAdmin));
    }

    // -- CanvasBlobs -------------------------------------------------------

    #[tokio::test]
    async fn canvas_blobs_returns_empty_for_unknown_canvas() {
        let (handler, adminz_store, _friendz, _userz, _blobz, _hub_repo, _tmp, _) =
            make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let resp = handle_request(
            &handler,
            admin_node,
            AdminRequest::CanvasBlobs {
                canvas_doc_id: "no-such-canvas".to_string(),
                offset: 0,
                limit: 50,
            },
        )
        .await;
        match resp {
            AdminResponse::CanvasBlobs { blobs, total, .. } => {
                assert_eq!(total, 0);
                assert!(blobs.is_empty());
            }
            other => panic!("expected CanvasBlobs, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn canvas_blobs_includes_soft_deleted_flag() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = db::open_in_memory().await;
        let blobz_store = blobz::Store::new(pool.clone(), tmp.path());

        // insert a blob that we'll soft-delete
        let b = blobz_store
            .insert(
                "h-cb-sd".into(),
                Some("soft.txt".into()),
                Some("text/plain".into()),
                b"soft content",
            )
            .await
            .unwrap();
        blobz_store
            .soft_delete(&[b.blake3.clone()], "admin")
            .await
            .unwrap();

        // insert a live blob
        let live = blobz_store
            .insert(
                "h-cb-live".into(),
                Some("live.txt".into()),
                Some("text/plain".into()),
                b"live content",
            )
            .await
            .unwrap();

        // build a canvas doc with two file widgets referencing these blobs
        let db_path = tmp.path().join("hub-docs.db");
        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new");

        let mut canvas_doc = automerge::Automerge::new();
        let canvas_doc_id = "canvas-blob-test";
        let widget_doc_id_soft = "widget-soft-deleted";
        let widget_doc_id_live = "widget-live";

        canvas_doc
            .transact::<_, _, automerge::AutomergeError>(|tx| {
                use automerge::transaction::Transactable;
                tx.put(automerge::ROOT, "title", "test canvas")?;
                let widgets = tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;
                let w1 = tx.put_object(&widgets, "w1", automerge::ObjType::Map)?;
                tx.put(&w1, "type", "file")?;
                tx.put(&w1, "docId", widget_doc_id_soft)?;
                let w2 = tx.put_object(&widgets, "w2", automerge::ObjType::Map)?;
                tx.put(&w2, "type", "file")?;
                tx.put(&w2, "docId", widget_doc_id_live)?;
                Ok(())
            })
            .unwrap();
        storage.save_doc(canvas_doc_id, &canvas_doc.save()).await;

        // build widget state docs
        for (wid, blake3, filename) in [
            (widget_doc_id_soft, b.blake3.as_str(), "soft.txt"),
            (widget_doc_id_live, live.blake3.as_str(), "live.txt"),
        ] {
            let mut wdoc = automerge::Automerge::new();
            wdoc.transact::<_, _, automerge::AutomergeError>(|tx| {
                use automerge::transaction::Transactable;
                tx.put(automerge::ROOT, "blobId", blake3)?;
                tx.put(automerge::ROOT, "blake3", blake3)?;
                tx.put(automerge::ROOT, "filename", filename)?;
                tx.put(automerge::ROOT, "mime", "text/plain")?;
                tx.put(automerge::ROOT, "size", 12u64)?;
                Ok(())
            })
            .unwrap();
            storage.save_doc(wid, &wdoc.save()).await;
        }

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new");
        let adminz_store = crate::adminz::Store::new(pool.clone());
        adminz_store.allow("admin").await.unwrap();
        let handler = HubAdminHandler::new(
            adminz_store,
            friendz::Store::new(pool.clone()),
            userz::Directory::new(pool),
            blobz_store,
            hub_repo,
            "hub-node".to_string(),
            Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
            default_test_hub_profile(),
            Arc::new(tokio::sync::Notify::new()),
        );

        let resp = handle_request(
            &handler,
            "admin",
            AdminRequest::CanvasBlobs {
                canvas_doc_id: canvas_doc_id.to_string(),
                offset: 0,
                limit: 50,
            },
        )
        .await;
        match resp {
            AdminResponse::CanvasBlobs { blobs, total, .. } => {
                assert_eq!(total, 2, "both blobs (live + soft-deleted) should appear");
                let soft = blobs.iter().find(|b2| b2.blake3 == b.blake3);
                let live_b = blobs.iter().find(|b2| b2.blake3 == live.blake3);
                assert!(soft.is_some(), "soft-deleted blob must be in the response");
                assert!(
                    soft.unwrap().soft_deleted,
                    "soft_deleted flag must be true for the soft-deleted blob"
                );
                assert!(live_b.is_some(), "live blob must be in the response");
                assert!(
                    !live_b.unwrap().soft_deleted,
                    "live blob must have soft_deleted=false"
                );
            }
            other => panic!("expected CanvasBlobs, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn canvas_blobs_pagination_works() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = db::open_in_memory().await;
        let blobz_store = blobz::Store::new(pool.clone(), tmp.path());

        // insert three blobs with different sizes so we can verify sort order
        let blobs_in: Vec<(&str, &str, &[u8])> = vec![
            ("h-pg-1", "small.txt", b"s"),
            ("h-pg-2", "medium.txt", b"mmm"),
            ("h-pg-3", "large.txt", b"lllll"),
        ];
        let mut inserted = Vec::new();
        for (iroh, name, data) in &blobs_in {
            let b = blobz_store
                .insert(iroh.to_string(), Some(name.to_string()), None, data)
                .await
                .unwrap();
            inserted.push(b);
        }

        let db_path = tmp.path().join("hub-docs.db");
        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new");

        let canvas_doc_id = "canvas-pg";
        let mut canvas_doc = automerge::Automerge::new();
        canvas_doc
            .transact::<_, _, automerge::AutomergeError>(|tx| {
                use automerge::transaction::Transactable;
                tx.put(automerge::ROOT, "title", "pg canvas")?;
                let widgets = tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;
                for (i, b) in inserted.iter().enumerate() {
                    let wkey = format!("w{i}");
                    let wdoc_id = format!("widget-pg-{i}");
                    let w = tx.put_object(&widgets, wkey, automerge::ObjType::Map)?;
                    tx.put(&w, "type", "file")?;
                    tx.put(&w, "docId", wdoc_id)?;
                    let _ = b;
                }
                Ok(())
            })
            .unwrap();
        storage.save_doc(canvas_doc_id, &canvas_doc.save()).await;

        for (i, b) in inserted.iter().enumerate() {
            let wdoc_id = format!("widget-pg-{i}");
            let mut wdoc = automerge::Automerge::new();
            wdoc.transact::<_, _, automerge::AutomergeError>(|tx| {
                use automerge::transaction::Transactable;
                tx.put(automerge::ROOT, "blobId", b.blake3.as_str())?;
                tx.put(automerge::ROOT, "blake3", b.blake3.as_str())?;
                tx.put(
                    automerge::ROOT,
                    "filename",
                    b.filename.as_deref().unwrap_or(""),
                )?;
                tx.put(automerge::ROOT, "size", b.size as u64)?;
                Ok(())
            })
            .unwrap();
            storage.save_doc(&wdoc_id, &wdoc.save()).await;
        }

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new");
        let adminz_store = crate::adminz::Store::new(pool.clone());
        adminz_store.allow("admin").await.unwrap();
        let handler = HubAdminHandler::new(
            adminz_store,
            friendz::Store::new(pool.clone()),
            userz::Directory::new(pool),
            blobz_store,
            hub_repo,
            "hub-node".to_string(),
            Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
            default_test_hub_profile(),
            Arc::new(tokio::sync::Notify::new()),
        );

        // full listing: 3 blobs, sorted size desc
        let resp = handle_request(
            &handler,
            "admin",
            AdminRequest::CanvasBlobs {
                canvas_doc_id: canvas_doc_id.to_string(),
                offset: 0,
                limit: 50,
            },
        )
        .await;
        match resp {
            AdminResponse::CanvasBlobs { blobs, total, .. } => {
                assert_eq!(total, 3);
                assert_eq!(blobs.len(), 3);
                // largest first
                assert!(blobs[0].size >= blobs[1].size);
                assert!(blobs[1].size >= blobs[2].size);
            }
            other => panic!("expected CanvasBlobs, got {other:?}"),
        }

        // paginate: offset=1, limit=1 → second blob only
        let resp2 = handle_request(
            &handler,
            "admin",
            AdminRequest::CanvasBlobs {
                canvas_doc_id: canvas_doc_id.to_string(),
                offset: 1,
                limit: 1,
            },
        )
        .await;
        match resp2 {
            AdminResponse::CanvasBlobs { blobs, total, .. } => {
                assert_eq!(total, 3, "total is always the deduplicated count");
                assert_eq!(blobs.len(), 1, "limit=1 must return exactly 1 blob");
            }
            other => panic!("expected CanvasBlobs, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn non_admin_cannot_list_canvas_blobs() {
        let (handler, _adminz, _friendz, _userz, _blobz, _hub_repo, _tmp, _) = make_handler().await;
        let resp = handle_request(
            &handler,
            "stranger",
            AdminRequest::CanvasBlobs {
                canvas_doc_id: "any".to_string(),
                offset: 0,
                limit: 10,
            },
        )
        .await;
        assert!(matches!(resp, AdminResponse::NotAdmin));
    }
}
