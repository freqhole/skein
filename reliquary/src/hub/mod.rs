//! hub peer service — orchestrates the always-on p2p hub.
//!
//! ties together the iroh endpoint, friendz handler, hub_repo (custom
//! automerge sync), iroh-blobs, canvas invite/gossip, and (eventually) the
//! blob snatcher into a single service.
//!
//! split into submodules:
//! - [`avatar`]: image processing for profile thumbnails
//! - `messages`: friendz message dispatch (friend requests, profile, heartbeat)
//! - `canvas`: canvas invite, update, and gossip digest handling

pub mod avatar;
mod canvas;
mod messages;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::blobz;
use crate::friendz::{self, FriendStatus};
use crate::hub_repo::HubRepo;
use crate::protocol::blob_proxy::{BlobProxyHandler, SKEIN_ALPN};
use crate::protocol::handler::{FriendzEvent, FriendzHandler};
use crate::protocol::messages::{FriendzMessage, FRIENDZ_ALPN};
use crate::sync::{IrohRepo, AUTOMERGE_REPO_ALPN};
use crate::userz;

use iroh_blobs::api::downloader::Downloader;
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::BlobsProtocol;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum HubError {
    #[error("identity error: {0}")]
    Identity(#[from] crate::identity::IdentityError),

    #[error("storage error: {0}")]
    Storage(#[from] sqlx::Error),

    #[error("endpoint error: {0}")]
    Endpoint(String),

    #[error("iroh repo error: {0}")]
    IrohRepo(String),

    #[error("avatar processing error: {0}")]
    Avatar(String),

    #[error("blobz error: {0}")]
    Blobz(#[from] crate::blobz::BlobError),

    #[error("userz error: {0}")]
    Userz(#[from] crate::userz::UserError),

    #[error("friendz error: {0}")]
    Friendz(#[from] crate::friendz::FriendError),
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/// configuration for the hub peer service.
pub struct HubPeerConfig {
    /// path to the data directory (avatars, blob-files, etc.)
    pub data_dir: PathBuf,
    /// local username for the hub peer (used in heartbeats + profile)
    pub username: String,
    /// short bio for the hub peer's profile
    pub bio: String,
    /// optional path to an avatar image file. processed into a webp
    /// thumbnail and stored in `blobz` on boot. relative paths resolve
    /// against `data_dir`.
    pub avatar_path: Option<String>,
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/// the hub peer service — an always-on peer that syncs automerge documents,
/// participates in the friendz protocol, serves and snatches blobs.
///
/// constructed by [`HubPeerService::start`] given an already-bound iroh
/// endpoint and the skein store handles. consumed by [`HubPeerService::run`]
/// which drives the event loop until cancellation.
pub struct HubPeerService {
    pub(crate) endpoint: iroh::Endpoint,
    router: iroh::protocol::Router,
    pub(crate) iroh_repo: IrohRepo,
    /// custom automerge sync handler — processes CBOR messages from JS peers
    pub(crate) hub_repo: HubRepo,
    pub(crate) friendz: FriendzHandler,
    friendz_events: tokio::sync::mpsc::UnboundedReceiver<FriendzEvent>,
    /// the hub peer's iroh node ID as a string
    pub(crate) node_id_str: String,
    /// cached profile: username (from config, persisted in userz on boot)
    pub(crate) profile_username: String,
    /// cached profile: bio (from config, persisted in userz on boot)
    pub(crate) profile_bio: String,
    /// cached profile: avatar webp data URL (generated from `config.avatar_path`).
    /// the underlying webp bytes are also stored in `blobz` and referenced
    /// from `userz.avatar_blake3`.
    pub(crate) profile_avatar_data_url: String,
    /// canvas doc IDs the hub is participating in (for gossip and relay)
    pub(crate) canvas_doc_ids: Arc<Mutex<HashSet<String>>>,
    /// peer blob inventory — maps peer node ID → set of blake3 hashes they have.
    /// populated by BlobOffer responses. cleared when peer goes offline.
    pub(crate) peer_blob_inventory: Arc<Mutex<HashMap<String, HashSet<String>>>>,
    /// the change-driven blob snatcher — subscribes to hub_repo doc changes
    /// and snatches blobs only for the docs that actually changed.
    /// wrapped in [`Arc`] so it can be moved into the spawned run loop while
    /// the hub keeps a handle for accessor / shutdown purposes.
    pub(crate) snatcher: Arc<crate::snatch::BlobSnatcher>,
    /// legacy "wake the snatcher now" trigger. preserved as a no-op so that
    /// canvas/messages handlers from the prototype still compile; the new
    /// change-driven snatcher subscribes to `hub_repo.subscribe_doc_changes`
    /// directly and ignores this notify.
    pub(crate) snatch_trigger: Arc<tokio::sync::Notify>,

    // skein store handles
    pub(crate) userz: userz::Directory,
    pub(crate) friendz_store: friendz::Store,
    pub(crate) blobz: blobz::Store,
}

impl HubPeerService {
    /// start the hub peer service.
    ///
    /// the caller is responsible for constructing the iroh endpoint, the
    /// iroh-blobs `FsStore`, and the skein `userz`/`friendz`/`blobz` stores
    /// — all of these may be shared with the embedding [`crate::service::Service`].
    /// after this returns, the service is ready to accept connections; call
    /// [`HubPeerService::run`] to drive the event loop.
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        endpoint: iroh::Endpoint,
        hub_repo: HubRepo,
        fs_store: &'static FsStore,
        userz: userz::Directory,
        friendz_store: friendz::Store,
        blobz: blobz::Store,
        config: HubPeerConfig,
    ) -> Result<Self, HubError> {
        let node_id_str = endpoint.id().to_string();
        tracing::info!(node_id = %node_id_str, "hub peer service starting");

        // process avatar (if configured) and persist into blobz + userz.
        let (profile_avatar_data_url, avatar_blake3) =
            process_hub_avatar(config.avatar_path.as_deref(), &config.data_dir, &blobz).await?;

        // persist hub's own profile so it survives restarts and is queryable
        // alongside remote-peer rows.
        userz
            .upsert_self(
                &node_id_str,
                Some(&config.username),
                Some(&config.bio),
                avatar_blake3.as_deref(),
            )
            .await?;
        tracing::info!(
            username = %config.username,
            avatar = ?avatar_blake3,
            "hub peer profile persisted"
        );

        // wire automerge sync over iroh
        let iroh_repo = IrohRepo::new(endpoint.clone(), hub_repo.clone());

        // friendz protocol handler (presence + messaging)
        let (friendz, friendz_events) = FriendzHandler::new(
            endpoint.clone(),
            node_id_str.clone(),
            config.username.clone(),
        );

        // iroh-blobs: serve verified blob data + accept blob-proxy requests
        let blobs_protocol = BlobsProtocol::new(fs_store, None);
        let blob_proxy = BlobProxyHandler::new(fs_store, blobz.clone());

        let router = iroh::protocol::Router::builder(endpoint.clone())
            .accept(AUTOMERGE_REPO_ALPN, iroh_repo.clone())
            .accept(FRIENDZ_ALPN, friendz.clone())
            .accept(SKEIN_ALPN, blob_proxy)
            .accept(iroh_blobs::ALPN, blobs_protocol)
            .spawn();
        tracing::info!(
            "iroh router started: automerge-repo + friendz + skein-blob-proxy + iroh-blobs"
        );

        // resume tracking canvases from previous runs
        let canvas_doc_ids = {
            let persisted = hub_repo.load_canvas_ids().await;
            if !persisted.is_empty() {
                tracing::info!(
                    count = persisted.len(),
                    "loaded persisted canvas doc IDs from storage"
                );
            }
            Arc::new(Mutex::new(persisted.into_iter().collect()))
        };

        // construct the change-driven blob snatcher.
        // it subscribes to hub_repo's doc_notify channel internally, so we
        // don't pass an external trigger — the legacy `snatch_trigger` field
        // below is kept only because canvas/messages prototype code still
        // calls notify_one on it.
        let downloader = Downloader::new(fs_store, &endpoint);
        let peer_blob_inventory = Arc::new(Mutex::new(HashMap::new()));
        let snatch_trigger_legacy = Arc::new(tokio::sync::Notify::new());
        let snatcher = Arc::new(crate::snatch::BlobSnatcher::new(
            hub_repo.clone(),
            endpoint.clone(),
            downloader,
            node_id_str.clone(),
            // BlobSnatcher::new still accepts a scan trigger for the older
            // `run_scan_loop` path; the new `run` (change-driven) path ignores
            // it. nothing in this service notifies the snatcher's copy.
            Arc::new(tokio::sync::Notify::new()),
            peer_blob_inventory.clone(),
            fs_store,
            blobz.clone(),
        ));

        Ok(Self {
            endpoint,
            router,
            iroh_repo,
            hub_repo,
            friendz,
            friendz_events,
            node_id_str,
            profile_username: config.username,
            profile_bio: config.bio,
            profile_avatar_data_url,
            canvas_doc_ids,
            peer_blob_inventory,
            snatcher,
            snatch_trigger: snatch_trigger_legacy,
            userz,
            friendz_store,
            blobz,
        })
    }

    /// run the hub peer service until `cancel` is cancelled.
    pub async fn run(mut self, cancel: CancellationToken) {
        tracing::info!(
            node_id = %self.endpoint.id(),
            "hub peer service running"
        );

        // change-driven blob snatcher: does one boot-time catch-up scan,
        // then only acts on doc-change notifications. replaces the prototype's
        // "scan everything every time anything changes" debounce loop.
        let snatcher = self.snatcher.clone();
        let snatcher_cancel = cancel.clone();
        let snatcher_handle = tokio::spawn(async move {
            snatcher.run(snatcher_cancel).await;
        });

        // heartbeat loop — pulls friend node IDs from friendz store on each tick
        let friendz = self.friendz.clone();
        let friendz_store_for_hb = self.friendz_store.clone();
        let local_node_id = self.node_id_str.clone();
        let heartbeat_handle = tokio::spawn(async move {
            friendz
                .run_heartbeat_loop(move || {
                    let store = friendz_store_for_hb.clone();
                    let local = local_node_id.clone();
                    let result = tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current()
                            .block_on(async move { store.list(true).await })
                    });
                    match result {
                        Ok(friends) => {
                            let ids: Vec<String> = friends
                                .into_iter()
                                .map(|f| f.friend_node_id)
                                .filter(|id| id != &local)
                                .collect();
                            tracing::debug!(
                                node_count = ids.len(),
                                "loaded friend node IDs from friendz store"
                            );
                            ids
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "failed to load friends from friendz store");
                            Vec::new()
                        }
                    }
                })
                .await;
        });

        // periodic sync health log (every 30s)
        let sync_health_hub_repo = self.hub_repo.clone();
        let sync_health_canvas_ids = self.canvas_doc_ids.clone();
        let sync_health_cancel = cancel.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.tick().await; // skip first immediate tick
            loop {
                tokio::select! {
                    _ = sync_health_cancel.cancelled() => break,
                    _ = interval.tick() => {
                        let peer_ids = sync_health_hub_repo.connected_peer_ids().await;
                        let peer_count = peer_ids.len();
                        let canvas_count = sync_health_canvas_ids.lock().await.len();
                        let doc_count = sync_health_hub_repo.document_count().await;

                        tracing::info!(
                            connected_peers = ?peer_ids,
                            total_connections = peer_count,
                            synced_documents = doc_count,
                            tracked_canvases = canvas_count,
                            "sync health check"
                        );
                    }
                }
            }
        });

        // main event loop
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => {
                    tracing::info!("shutdown requested");
                    break;
                }
                event = self.friendz_events.recv() => {
                    match event {
                        Some(e) => e,
                        None => {
                            tracing::info!("friendz event channel closed");
                            break;
                        }
                    }
                }
            };

            tokio::select! {
                _ = cancel.cancelled() => {
                    tracing::info!("shutdown requested during event handling, dropping event");
                    break;
                }
                _ = self.handle_friendz_event(event) => {}
            }
        }

        heartbeat_handle.abort();
        snatcher_handle.abort();
        self.shutdown().await;
    }

    /// check whether a node_id belongs to a friend of the hub peer.
    ///
    /// in skein, friendship lives in a single `friendz` row keyed by node_id.
    /// status `Accepted` and `Allowed` both count as friends for runtime
    /// purposes (allowed peers haven't completed the handshake but the
    /// operator has pre-approved them).
    pub(crate) async fn is_friend(&self, node_id: &str) -> bool {
        match self.friendz_store.get(node_id).await {
            Ok(Some(friend)) => matches!(
                friend.status,
                FriendStatus::Accepted | FriendStatus::Allowed
            ),
            Ok(None) => {
                tracing::debug!(peer = %node_id, "is_friend: no friendz row");
                false
            }
            Err(e) => {
                tracing::warn!(peer = %node_id, error = %e, "is_friend: friendz store error");
                false
            }
        }
    }

    /// gracefully shut down the hub peer service.
    pub async fn shutdown(self) {
        tracing::info!("shutting down hub peer service");

        tracing::debug!("shutting down iroh router...");
        let router_shutdown = self.router.shutdown();
        match tokio::time::timeout(Duration::from_secs(10), router_shutdown).await {
            Ok(Ok(())) => tracing::debug!("iroh router shut down cleanly"),
            Ok(Err(e)) => tracing::warn!(error = ?e, "error shutting down router"),
            Err(_) => tracing::warn!("router shutdown timed out after 10s, continuing"),
        }

        tracing::debug!("closing iroh endpoint...");
        self.endpoint.close().await;

        tracing::info!("hub peer service stopped");
    }

    pub fn node_id(&self) -> iroh::PublicKey {
        self.endpoint.id()
    }

    pub fn iroh_repo(&self) -> &IrohRepo {
        &self.iroh_repo
    }

    pub fn friendz(&self) -> &FriendzHandler {
        &self.friendz
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// process the configured avatar image:
/// 1. read the file
/// 2. resize to 128px webp via [`avatar::resize_to_square_webp`]
/// 3. insert into `blobz` (deduped by blake3)
/// 4. return `(data_url, blake3)` so the caller can persist the reference
///    in `userz` and serve the data URL in `ProfileResponse` messages
async fn process_hub_avatar(
    avatar_path: Option<&str>,
    data_dir: &std::path::Path,
    blobz: &blobz::Store,
) -> Result<(String, Option<String>), HubError> {
    let path = match avatar_path {
        Some(p) if !p.is_empty() => p,
        _ => return Ok((String::new(), None)),
    };

    let avatar_file = if std::path::Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        data_dir.join(path)
    };

    let image_data = match std::fs::read(&avatar_file) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(
                path = %avatar_file.display(),
                error = %e,
                "failed to read hub peer avatar file"
            );
            return Ok((String::new(), None));
        }
    };

    let webp = match avatar::resize_to_square_webp(&image_data, 128) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!(
                path = %avatar_file.display(),
                error = %e,
                "failed to process hub peer avatar image"
            );
            return Ok((String::new(), None));
        }
    };

    // build data URL
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&webp);
    let data_url = format!("data:image/webp;base64,{}", b64);

    // persist the bytes in blobz so other code paths can fetch by blake3.
    let blake3_hash = blake3::hash(&webp).to_hex().to_string();

    // skip insert if already present (idempotent boots). otherwise insert
    // computes the blake3 itself from the bytes and returns the ref.
    let blake3_to_persist = match blobz.get(&blake3_hash).await? {
        Some(_) => Some(blake3_hash.clone()),
        None => match blobz
            .insert(
                blake3_hash.clone(), // iroh_hash: same as blake3 for locally-ingested blobs
                Some("hub-avatar.webp".to_string()),
                Some("image/webp".to_string()),
                &webp,
            )
            .await
        {
            Ok(blob_ref) => Some(blob_ref.blake3),
            Err(e) => {
                tracing::warn!(error = %e, "failed to persist hub avatar to blobz");
                None
            }
        },
    };

    tracing::info!(
        path = %avatar_file.display(),
        size_bytes = webp.len(),
        blake3 = ?blake3_to_persist,
        "processed hub peer avatar"
    );

    Ok((data_url, blake3_to_persist))
}

/// human-readable name for a friendz message type (for logging).
pub(crate) fn friendz_msg_type_name(msg: &FriendzMessage) -> &'static str {
    match msg {
        FriendzMessage::ProfileRequest => "profile-request",
        FriendzMessage::ProfileResponse { .. } => "profile-response",
        FriendzMessage::FriendRequest { .. } => "friend-request",
        FriendzMessage::FriendAccept { .. } => "friend-accept",
        FriendzMessage::FriendAcceptAck { .. } => "friend-accept-ack",
        FriendzMessage::FriendReject { .. } => "friend-reject",
        FriendzMessage::Heartbeat { .. } => "heartbeat",
        FriendzMessage::CanvasInvite { .. } => "canvas-invite",
        FriendzMessage::CanvasInviteAck { .. } => "canvas-invite-ack",
        FriendzMessage::CanvasInviteAccept { .. } => "canvas-invite-accept",
        FriendzMessage::CanvasInviteDecline { .. } => "canvas-invite-decline",
        FriendzMessage::AclChange { .. } => "acl-change",
        FriendzMessage::CanvasUpdate { .. } => "canvas-update",
        FriendzMessage::CanvasDeleted { .. } => "canvas-deleted",
        FriendzMessage::OfflineAnnouncement { .. } => "offline-announcement",
        FriendzMessage::GossipDigest { .. } => "gossip-digest",
        FriendzMessage::BlobSeek { .. } => "blob-seek",
        FriendzMessage::BlobOffer { .. } => "blob-offer",
    }
}
