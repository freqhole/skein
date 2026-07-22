//! hub peer service — orchestrates the always-on p2p hub.
//!
//! ties together the iroh endpoint, friendz handler, hub_repo (custom
//! automerge sync), iroh-blobs, canvas invite/gossip, and (eventually) the
//! blob snatcher into a single service.
//!
//! split into submodules:
//! - `messages`: friendz message dispatch (friend requests, profile, heartbeat)
//! - `canvas`: canvas invite, update, and gossip digest handling
//! - `wire`: skein-specific wire shapes layered on haruspex's core protocol
//!   (`skein:`-namespaced app extensions, gossip digest's app payload)

mod canvas;
mod messages;
mod wire;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::friendz;
use crate::hub_repo::HubRepo;
use crate::protocol::blob_proxy::ENSURE_ALPN;
use crate::sync::{IrohRepo, AUTOMERGE_REPO_ALPN};
use crate::userz;
use freqhole_reliquary::blobz::{BlobStore, NewBlobMeta};
use freqhole_reliquary::node::StorageNode;
use haruspex::protocol::{
    CoreMessage, FriendzEvent, FriendzMessage, FriendzProtocolHandler, FriendzService,
    FriendzTransportError, LocalProfile, FRIENDZ_ALPN,
};

use iroh_blobs::BlobsProtocol;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum HubError {
    #[error("identity error: {0}")]
    Identity(#[from] freqhole_reliquary::identity::IdentityError),

    #[error("storage error: {0}")]
    Storage(#[from] sqlx::Error),

    #[error("endpoint error: {0}")]
    Endpoint(String),

    #[error("iroh repo error: {0}")]
    IrohRepo(String),

    #[error("avatar processing error: {0}")]
    Avatar(String),

    #[error("blobz error: {0}")]
    Blobz(#[from] freqhole_reliquary::blobz::BlobStoreError),

    #[error("userz error: {0}")]
    Userz(#[from] crate::userz::UserError),

    #[error("friendz error: {0}")]
    Friendz(#[from] crate::friendz::FriendError),
}

// ---------------------------------------------------------------------------
// live profile state
// ---------------------------------------------------------------------------

/// the hub's own profile — username, bio, accent colour, and pre-built avatar
/// data URL. wrapped in `Arc<RwLock<_>>` so both the friendz message handler
/// (frequent reads: one read per incoming ProfileRequest) and the admin
/// protocol (rare writes: SetHubProfile / SetHubAvatar) can access it without
/// copying the three large strings for every message send.
#[derive(Debug, Clone)]
pub struct HubProfile {
    pub username: String,
    pub bio: String,
    pub accent_color: i64,
    pub avatar_data_url: String,
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
    pub(crate) friendz: FriendzProtocolHandler,
    friendz_events: tokio::sync::mpsc::UnboundedReceiver<FriendzEvent>,
    /// the hub's own node ID as a string
    pub(crate) node_id_str: String,
    /// live profile (username, bio, accent_color, avatar_data_url). shared
    /// with HubAdminHandler via Arc<RwLock<_>> so admin writes are immediately
    /// visible to outgoing ProfileResponse messages without a restart.
    pub(crate) hub_profile: Arc<RwLock<HubProfile>>,
    /// notified by HubAdminHandler whenever SetHubProfile or SetHubAvatar
    /// succeeds. the broadcast task in `run()` waits here and pushes a
    /// ProfileResponse to every currently-online peer.
    pub(crate) profile_changed: Arc<tokio::sync::Notify>,
    /// canvas doc IDs the hub is participating in (for gossip and relay)
    pub(crate) canvas_doc_ids: Arc<Mutex<HashSet<String>>>,
    /// blob replication engine: scans automerge canvas/widget docs for
    /// blob references the hub doesn't have locally and fetches them from
    /// peers over the `freqhole/1` ALPN. wrapped in [`Arc`] so it can be moved
    /// into the spawned run loop while the hub keeps a handle - e.g. to
    /// feed it peer-offered blob inventory via `offer_peer_blobs` once a
    /// `BlobOffer` message arrives.
    pub(crate) engine: Arc<crate::snatch::HubSnatchEngine>,
    /// legacy "wake the snatcher now" trigger. preserved as a no-op so that
    /// canvas/messages handlers from the prototype still compile; the
    /// change-driven engine subscribes to `hub_repo.subscribe_doc_changes`
    /// directly and ignores this notify.
    pub(crate) snatch_trigger: Arc<tokio::sync::Notify>,

    // skein store handles
    pub(crate) userz: userz::Directory,
    pub(crate) friendz_store: friendz::Store,
    pub(crate) blobz: Arc<dyn BlobStore>,
    /// kept on the service for future accessor use (e.g. a `ServiceHandle`-
    /// style admin surface); the running `iroh/skein-hub-admin/1` handler
    /// already holds its own clone, constructed in `start` below.
    #[allow(dead_code)]
    pub(crate) adminz_store: crate::adminz::Store,
}

impl HubPeerService {
    /// start the hub peer service.
    ///
    /// the caller is responsible for constructing the iroh endpoint, the
    /// iroh-blobs storage node, and the skein `userz`/`friendz`/`blobz` stores
    /// — all of these may be shared with the embedding [`crate::service::Service`].
    /// after this returns, the service is ready to accept connections; call
    /// [`HubPeerService::run`] to drive the event loop.
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        endpoint: iroh::Endpoint,
        hub_repo: HubRepo,
        storage: &'static StorageNode,
        userz: userz::Directory,
        friendz_store: friendz::Store,
        adminz_store: crate::adminz::Store,
        config: HubPeerConfig,
    ) -> Result<Self, HubError> {
        let node_id_str = endpoint.id().to_string();
        tracing::info!(node_id = %node_id_str, "hub peer service starting");

        let fs_store = storage.fs_store;
        let blobz = storage.blobz.clone();

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

        // shared live profile state — admin writes update this directly
        // so outgoing profile responses always use the current values.
        let hub_profile = Arc::new(RwLock::new(HubProfile {
            username: config.username.clone(),
            bio: config.bio.clone(),
            accent_color: 0,
            avatar_data_url: profile_avatar_data_url.clone(),
        }));

        // notified when admin changes the hub's own profile so the broadcast
        // task in run() can push a fresh ProfileResponse to online peers.
        let profile_changed = Arc::new(tokio::sync::Notify::new());

        // wire automerge sync over iroh
        let iroh_repo = IrohRepo::new(endpoint.clone(), hub_repo.clone(), friendz_store.clone());

        // friendz protocol service (presence + messaging) - `dispatch`
        // auto-answers profile-request/hello/heartbeat directly on the
        // inbound stream from the local profile configured below; every
        // other message surfaces as `FriendzEvent::MessageReceived` for
        // `handle_friendz_event`/`handle_message` (hub/messages.rs) to act on.
        let (friendz_service, friendz_events) =
            FriendzService::new(node_id_str.clone(), config.username.clone());
        friendz_service
            .set_local_profile(LocalProfile {
                username: config.username.clone(),
                bio: config.bio.clone(),
                avatar_data_url: profile_avatar_data_url.clone(),
                accent_color: Some(0),
                profile_doc_id: None,
                profile_updated_at: None,
                // this router is a hub's friendz handler — always flag
                // ourselves as a hub node (see docs/hub-and-profile-plan.md
                // section 3.2).
                is_hub: Some(true),
            })
            .await;
        let friendz = FriendzProtocolHandler::new(Arc::new(friendz_service));

        // iroh-blobs: serve verified blob data + accept blob-proxy requests.
        //
        // gated by `blob_acl`: a peer must be a hub friend *and* have a
        // `.acl` entry on at least one canvas that references the requested
        // blob (see `blob_acl`'s module doc comment for the full design and
        // what this replaces — previously `events: None` here meant any
        // peer who could open a connection and knew a blake3 hash could
        // fetch it, with zero access control of any kind).
        let blob_acl_gate =
            crate::blob_acl::BlobAclGate::for_hub(friendz_store.clone(), hub_repo.clone());
        let blobs_protocol = BlobsProtocol::new(
            fs_store,
            Some(crate::blob_acl::build_gated_blobs_events(blob_acl_gate)),
        );
        let blob_proxy = crate::protocol::blob_proxy::new_handler(
            fs_store,
            blobz.clone(),
            friendz_store.clone(),
        );

        // resume tracking canvases from previous runs (moved before hub_admin
        // so the admin handler can receive a clone of the live set).
        let canvas_doc_ids = {
            let persisted = hub_repo.load_canvas_ids().await;
            if !persisted.is_empty() {
                tracing::info!(
                    count = persisted.len(),
                    "loaded persisted canvas doc IDs from storage"
                );
            }
            Arc::new(Mutex::new(
                persisted.into_iter().collect::<HashSet<String>>(),
            ))
        };

        // remote hub administration: lets a privileged remote peer manage
        // this hub's friendz allow-list over the network (see
        // `protocol::hub_admin`), instead of requiring local CLI access.
        // also hands over a `hub_repo` clone so a `Remove` request can
        // cancel an already-accepted connection for the revoked peer, not
        // just delete their `friendz` row.
        let hub_admin = crate::protocol::hub_admin::HubAdminHandler::new(
            adminz_store.clone(),
            friendz_store.clone(),
            userz.clone(),
            blobz.clone(),
            // absolute path to the blob-files directory, used only for
            // filesystem disk-usage stats (not part of the BlobStore trait
            // — see freqhole_reliquary::blobz's module doc comment).
            config.data_dir.join("blob-files"),
            hub_repo.clone(),
            node_id_str.clone(),
            Arc::clone(&canvas_doc_ids),
            Arc::clone(&hub_profile),
            Arc::clone(&profile_changed),
        );

        let router = iroh::protocol::Router::builder(endpoint.clone())
            .accept(AUTOMERGE_REPO_ALPN, iroh_repo.clone())
            .accept(FRIENDZ_ALPN, friendz.clone())
            .accept(ENSURE_ALPN, blob_proxy)
            .accept(iroh_blobs::ALPN, blobs_protocol)
            .accept(crate::protocol::hub_admin::HUB_ADMIN_ALPN, hub_admin)
            .spawn();
        tracing::info!(
            "iroh router started: automerge-repo + friendz + skein-blob-proxy + iroh-blobs + skein-hub-admin"
        );

        // construct the change-driven blob snatcher.
        // it subscribes to hub_repo's doc_notify channel internally, so we
        // don't pass an external trigger — the legacy `snatch_trigger` field
        // below is kept only because canvas/messages prototype code still
        // calls notify_one on it. the engine shares the storage node's own
        // downloader cell (not a point-in-time clone) so it keeps observing
        // the same live downloader across any future attach/detach cycle,
        // and shares the in-flight set with the node's own gc-protect
        // callback, so a blob mid-download is never swept before it's
        // ingested into blobz.
        let snatch_trigger_legacy = Arc::new(tokio::sync::Notify::new());
        let engine = Arc::new(freqhole_reliquary::snatch::SnatchEngine::new(
            blobz.clone(),
            storage.downloader_cell(),
            fs_store,
            storage.in_flight.clone(),
            node_id_str.clone(),
            crate::snatch::HubBlobRefSource::new(hub_repo.clone(), node_id_str.clone()),
            crate::snatch::HubPeerProbeTransport::new(endpoint.clone()),
            freqhole_reliquary::snatch::SnatchEngineOptions::default(),
        ));

        Ok(Self {
            endpoint,
            router,
            iroh_repo,
            hub_repo,
            friendz,
            friendz_events,
            node_id_str,
            hub_profile,
            profile_changed,
            canvas_doc_ids,
            engine,
            snatch_trigger: snatch_trigger_legacy,
            userz,
            friendz_store,
            blobz,
            adminz_store,
        })
    }

    /// run the hub peer service until `cancel` is cancelled.
    pub async fn run(mut self, cancel: CancellationToken) {
        tracing::info!(
            node_id = %self.endpoint.id(),
            "hub peer service running"
        );

        // resume any in-flight "write ourselves into this canvas's peers
        // map" work that a previous run was interrupted mid-retry (e.g. the
        // process was restarted while `schedule_write_self_to_canvas`'s
        // background retry loop — spawned once, at invite-receipt time —
        // was still waiting for the canvas doc to sync). that loop lives
        // entirely in-memory; restarting the process kills it with no
        // record left anywhere that it needs to resume, so a canvas the hub
        // was invited to but hadn't yet finished writing itself into before
        // the restart would otherwise NEVER complete that write — a real,
        // confirmed bug, 2026-07-03 (found immediately after fixing the
        // related "change never gets pushed" bug: restarting the hub to
        // pick up that fix is exactly what surfaced this one, since the
        // restart happened mid-retry). `schedule_write_self_to_canvas`
        // itself is idempotent (see `write_self_to_canvas_doc`'s
        // `already_in_peers` check — an already-completed canvas just gets
        // its `lastSeenAt` stamped again, harmless), so it's safe to kick
        // off for every persisted/tracked canvas id unconditionally rather
        // than trying to first figure out which ones actually still need it.
        {
            let tracked: Vec<String> = self.canvas_doc_ids.lock().await.iter().cloned().collect();
            if !tracked.is_empty() {
                tracing::info!(
                    count = tracked.len(),
                    "resuming peer-write for all tracked canvases after startup"
                );
            }
            for canvas_doc_id in tracked {
                self.schedule_write_self_to_canvas(&canvas_doc_id);
            }
        }

        // change-driven blob snatcher: does one boot-time catch-up scan,
        // then only acts on doc-change notifications. replaces the prototype's
        // "scan everything every time anything changes" debounce loop.
        let engine = self.engine.clone();
        let snatcher_cancel = cancel.clone();
        let snatcher_handle = tokio::spawn(async move {
            engine.run(snatcher_cancel).await;
        });

        // heartbeat loop — pulls friend node IDs from friendz store on each tick
        let friendz = self.friendz.clone();
        let friendz_store_for_hb = self.friendz_store.clone();
        let local_node_id = self.node_id_str.clone();
        let endpoint_for_heartbeat = self.endpoint.clone();
        let heartbeat_handle = tokio::spawn(async move {
            friendz
                .run_heartbeat_loop(endpoint_for_heartbeat, move || {
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

        // push a fresh ProfileResponse to every online peer after an admin
        // SetHubProfile or SetHubAvatar call. debounces 500ms so a burst of
        // username + bio + avatar changes sends one message, not three.
        let profile_changed = Arc::clone(&self.profile_changed);
        let friendz_for_profile = self.friendz.clone();
        let endpoint_for_profile = self.endpoint.clone();
        let hub_profile_for_broadcast = Arc::clone(&self.hub_profile);
        let broadcast_cancel = cancel.clone();
        tokio::spawn(async move {
            loop {
                // wait for a profile change notification or cancellation
                tokio::select! {
                    _ = broadcast_cancel.cancelled() => break,
                    _ = profile_changed.notified() => {}
                }
                // debounce: absorb rapid successive changes
                tokio::select! {
                    _ = broadcast_cancel.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                }
                let (msg, local_profile) = {
                    let p = hub_profile_for_broadcast.read().await;
                    let msg = FriendzMessage::Core(CoreMessage::ProfileResponse {
                        v: 1,
                        username: p.username.clone(),
                        bio: p.bio.clone(),
                        avatar_data_url: p.avatar_data_url.clone(),
                        accent_color: Some(p.accent_color),
                        profile_doc_id: None,
                        profile_updated_at: None,
                        is_hub: Some(true),
                    });
                    let local_profile = LocalProfile {
                        username: p.username.clone(),
                        bio: p.bio.clone(),
                        avatar_data_url: p.avatar_data_url.clone(),
                        accent_color: Some(p.accent_color),
                        profile_doc_id: None,
                        profile_updated_at: None,
                        is_hub: Some(true),
                    };
                    (msg, local_profile)
                };
                // keep the service's own auto-answer profile in sync too, so a
                // fresh profile-request (not just this proactive broadcast)
                // also sees the update.
                friendz_for_profile
                    .service()
                    .set_local_profile(local_profile)
                    .await;
                let peers = friendz_for_profile.service().online_peers().await;
                tracing::debug!(
                    peer_count = peers.len(),
                    "broadcasting updated hub profile to online peers"
                );
                for peer_id in peers {
                    if let Err(e) = send_friendz_message_via(
                        &endpoint_for_profile,
                        &friendz_for_profile,
                        &peer_id,
                        &msg,
                    )
                    .await
                    {
                        tracing::debug!(
                            peer = %peer_id,
                            error = %e,
                            "profile broadcast: send failed"
                        );
                    }
                }
            }
        });
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
    /// operator has pre-approved them). delegates to `friendz::Store::is_friend`,
    /// the same check `sync::IrohRepo::accept` uses to gate the automerge
    /// sync ALPN.
    pub(crate) async fn is_friend(&self, node_id: &str) -> bool {
        self.friendz_store.is_friend(node_id).await
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

    pub fn friendz(&self) -> &FriendzProtocolHandler {
        &self.friendz
    }

    /// send a friendz protocol message to a peer by node id. resolves the
    /// node id into an `EndpointAddr` (relying on the endpoint's configured
    /// discovery/relay - the same addressing haruspex's own heartbeat loop
    /// uses for peers it only has a bare node id for) and opens a fresh
    /// outbound stream; see [`FriendzProtocolHandler::send_message`]'s doc
    /// comment for why this is fire-and-forget rather than request/reply.
    pub(crate) async fn send_friendz_message(
        &self,
        peer_node_id: &str,
        msg: &FriendzMessage,
    ) -> Result<(), FriendzTransportError> {
        send_friendz_message_via(&self.endpoint, &self.friendz, peer_node_id, msg).await
    }
}

/// standalone helper behind [`HubPeerService::send_friendz_message`] - also
/// used by the profile-broadcast task in `run()`, which only has clones of
/// `endpoint`/`friendz`, not a `&HubPeerService`.
async fn send_friendz_message_via(
    endpoint: &iroh::Endpoint,
    friendz: &FriendzProtocolHandler,
    peer_node_id: &str,
    msg: &FriendzMessage,
) -> Result<(), FriendzTransportError> {
    let public_key: iroh::PublicKey = peer_node_id
        .parse()
        .map_err(|e| FriendzTransportError::InvalidNodeId(format!("{e}")))?;
    friendz
        .send_message(endpoint, iroh::EndpointAddr::from(public_key), msg)
        .await
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// process the configured avatar image:
/// 1. read the file
/// 2. resize to 128px webp via [`freqhole_reliquary::media::resize_to_square_webp`]
/// 3. insert into `blobz` (deduped by blake3)
/// 4. return `(data_url, blake3)` so the caller can persist the reference
///    in `userz` and serve the data URL in `ProfileResponse` messages
async fn process_hub_avatar(
    avatar_path: Option<&str>,
    data_dir: &std::path::Path,
    blobz: &Arc<dyn BlobStore>,
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

    let webp = match freqhole_reliquary::media::resize_to_square_webp(&image_data, 128) {
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
                &webp,
                NewBlobMeta {
                    filename: Some("hub-avatar.webp".to_string()),
                    mime: Some("image/webp".to_string()),
                    ..Default::default()
                },
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
