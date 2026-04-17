//! reliquary peer service — the minimal phase-1 orchestrator.
//!
//! wires an [`iroh::Endpoint`] into four protocol handlers:
//!
//! - `iroh/automerge-repo/1` — automerge sync via [`IrohRepo`] + [`hub_repo::HubRepo`]
//! - `skein-friendz/1`       — presence/heartbeat/message dispatch via [`FriendzHandler`]
//! - `skein/1`               — blob proxy (ensure-by-blake3) via [`BlobProxyHandler`]
//! - `iroh-blobs/4`          — iroh-blobs [`BlobsProtocol`] for verified transfer
//!
//! phase-1 scope intentionally excludes canvas invite flows, gossip digests,
//! acl changes, and the blob snatcher — those layer back on in phase-2 once the
//! browser+reliquary flow is validated end-to-end.

use std::path::{Path, PathBuf};

use iroh::protocol::Router;
use iroh::Endpoint;
use iroh_blobs::api::downloader::Downloader;
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::BlobsProtocol;
use sqlx::SqlitePool;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use crate::blobz;
use crate::friendz;
use crate::hub_repo::HubRepo;
use crate::protocol::blob_proxy::{BlobProxyHandler, SKEIN_ALPN};
use crate::protocol::handler::{FriendzEvent, FriendzHandler};
use crate::protocol::messages::{FriendzMessage, FRIENDZ_ALPN};
use crate::sync::{IrohRepo, AUTOMERGE_REPO_ALPN};
use crate::userz;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("userz error: {0}")]
    Userz(#[from] userz::UserError),

    #[error("friendz store error: {0}")]
    Friendz(#[from] friendz::FriendError),

    #[error("blobz error: {0}")]
    Blobz(#[from] blobz::BlobError),

    #[error("fs store: {0}")]
    FsStore(String),

    #[error("hub_repo: {0}")]
    HubRepo(String),
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/// configuration for the reliquary peer service.
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    /// base data directory (used for automerge sqlite + iroh-blobs FsStore).
    pub data_dir: PathBuf,
    /// display name advertised in heartbeat/profile messages.
    pub username: String,
    /// short bio served with profile responses (used by the hub variant).
    pub bio: String,
    /// optional path to an avatar image file. processed into a 128px webp
    /// thumbnail and stored in `blobz` on boot. relative paths resolve
    /// against `data_dir`.
    pub avatar_path: Option<String>,
}

// ---------------------------------------------------------------------------
// FsStore singleton
//
// BlobProxyHandler requires `&'static FsStore`. in a long-running reliquary
// process there's only ever one store, so a process-wide OnceCell is fine.
// ---------------------------------------------------------------------------

static FS_STORE: OnceCell<FsStore> = OnceCell::const_new();

async fn fs_store(data_dir: &Path) -> Result<&'static FsStore, ServiceError> {
    FS_STORE
        .get_or_try_init(|| async {
            let path = data_dir.join("iroh-blobs");
            tokio::fs::create_dir_all(&path).await?;
            FsStore::load(&path)
                .await
                .map_err(|e| ServiceError::FsStore(format!("{e}")))
        })
        .await
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/// cheaply-cloneable accessor bundle. hand this out to callers (tauri IPC,
/// embedders, tests) that only need to read from / send messages into the
/// running service — the heavyweight drive loop is owned exclusively by the
/// [`Service`] passed to [`Service::run`].
#[derive(Clone)]
pub struct ServiceHandle {
    endpoint: Endpoint,
    friendz_handler: FriendzHandler,
    iroh_repo: IrohRepo,
    blobz: blobz::Store,
    friendz_store: friendz::Store,
    userz: userz::Directory,
    node_id_str: String,
}

impl ServiceHandle {
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }
    pub fn friendz(&self) -> &FriendzHandler {
        &self.friendz_handler
    }
    pub fn iroh_repo(&self) -> &IrohRepo {
        &self.iroh_repo
    }
    pub fn blobz(&self) -> &blobz::Store {
        &self.blobz
    }
    pub fn friendz_store(&self) -> &friendz::Store {
        &self.friendz_store
    }
    pub fn userz(&self) -> &userz::Directory {
        &self.userz
    }
    pub fn node_id(&self) -> &str {
        &self.node_id_str
    }
}

/// the running peer service. hold on to it for the lifetime of the process;
/// call [`Service::run`] to drive event processing and [`Service::shutdown`]
/// to tear everything down.
pub struct Service {
    endpoint: Endpoint,
    router: Router,
    friendz_handler: FriendzHandler,
    friendz_events: tokio::sync::mpsc::UnboundedReceiver<FriendzEvent>,
    iroh_repo: IrohRepo,
    blobz: blobz::Store,
    friendz_store: friendz::Store,
    userz: userz::Directory,
    #[allow(dead_code)]
    blobs_downloader: Downloader,
    node_id_str: String,
    local_username: String,
}

impl Service {
    /// start the service: load the FsStore + hub_repo, construct all handlers,
    /// and spawn the iroh router.
    pub async fn start(
        endpoint: Endpoint,
        pool: SqlitePool,
        config: ServiceConfig,
    ) -> Result<Self, ServiceError> {
        let node_id = endpoint.id();
        let node_id_str = node_id.to_string();

        // record ourselves in userz
        let userz = userz::Directory::new(pool.clone());
        userz
            .upsert_self(&node_id_str, Some(&config.username), None, None)
            .await?;

        let blobz = blobz::Store::new(pool.clone(), &config.data_dir);
        let friendz_store = friendz::Store::new(pool.clone());

        // automerge sync — hub_repo owns its own sqlite db for now
        let hub_repo = HubRepo::new(node_id_str.clone(), &config.data_dir.join("skein-docs.db"))
            .await
            .map_err(|e| ServiceError::HubRepo(format!("{e}")))?;
        let iroh_repo = IrohRepo::new(endpoint.clone(), hub_repo.clone());

        // friendz presence
        let (friendz_handler, friendz_events) = FriendzHandler::new(
            endpoint.clone(),
            node_id_str.clone(),
            config.username.clone(),
        );

        // iroh-blobs FsStore + blob-proxy
        let store = fs_store(&config.data_dir).await?;
        let blobs_downloader = Downloader::new(store, &endpoint);
        let blobs_protocol = BlobsProtocol::new(store, None);
        let blob_proxy = BlobProxyHandler::new(store, blobz.clone());

        // router
        let router = Router::builder(endpoint.clone())
            .accept(AUTOMERGE_REPO_ALPN, iroh_repo.clone())
            .accept(FRIENDZ_ALPN, friendz_handler.clone())
            .accept(SKEIN_ALPN, blob_proxy)
            .accept(iroh_blobs::ALPN, blobs_protocol)
            .spawn();

        tracing::info!(
            node_id = %node_id,
            "reliquary service running with automerge-repo, skein-friendz, skein, and iroh-blobs"
        );

        Ok(Self {
            endpoint,
            router,
            friendz_handler,
            friendz_events,
            iroh_repo,
            blobz,
            friendz_store,
            userz,
            blobs_downloader,
            node_id_str,
            local_username: config.username,
        })
    }

    /// run until `cancel` is fired.
    ///
    /// drives the friendz heartbeat loop plus incoming-event processing.
    /// on exit, tears down the router *and* closes the endpoint — suitable
    /// for callers (like the CLI) that own the endpoint exclusively.
    ///
    /// use [`Service::run_keep_endpoint`] instead when the endpoint is
    /// shared (e.g. the tauri app's always-on `Endpoint`).
    pub async fn run(self, cancel: CancellationToken) {
        self.run_inner(cancel, true).await
    }

    /// like [`Service::run`], but leaves the endpoint open on exit so an
    /// embedder can keep using it.
    pub async fn run_keep_endpoint(self, cancel: CancellationToken) {
        self.run_inner(cancel, false).await
    }

    async fn run_inner(mut self, cancel: CancellationToken, close_endpoint: bool) {
        tracing::info!(node_id = %self.node_id_str, "service run loop started");

        // heartbeat loop — reads the accepted friend list from our friendz store
        let heartbeat_friendz = self.friendz_handler.clone();
        let heartbeat_store = self.friendz_store.clone();
        let heartbeat_cancel = cancel.clone();
        let heartbeat_handle = tokio::spawn(async move {
            tokio::select! {
                _ = heartbeat_cancel.cancelled() => {}
                _ = heartbeat_friendz.run_heartbeat_loop(move || {
                    let store = heartbeat_store.clone();
                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current().block_on(async move {
                            match store.list(true).await {
                                Ok(friends) => friends
                                    .into_iter()
                                    .map(|f| f.friend_node_id)
                                    .collect::<Vec<_>>(),
                                Err(e) => {
                                    tracing::warn!(error = %e, "failed to load friends for heartbeat");
                                    Vec::new()
                                }
                            }
                        })
                    })
                }) => {}
            }
        });

        // event loop
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => {
                    tracing::info!("shutdown requested");
                    break;
                }
                event = self.friendz_events.recv() => match event {
                    Some(e) => e,
                    None => {
                        tracing::info!("friendz event channel closed");
                        break;
                    }
                },
            };

            if let Err(e) = self.handle_event(event).await {
                tracing::warn!(error = %e, "event handler failed");
            }
        }

        heartbeat_handle.abort();
        if close_endpoint {
            self.shutdown().await;
        } else {
            self.shutdown_keep_endpoint().await;
        }
    }

    async fn handle_event(&self, event: FriendzEvent) -> Result<(), ServiceError> {
        match event {
            FriendzEvent::PeerOnline { node_id, username } => {
                tracing::info!(peer = %node_id, username = %username, "peer online");
                self.userz
                    .upsert_profile(&node_id, Some(&username), None, None)
                    .await?;
            }
            FriendzEvent::PeerOffline { node_id } => {
                tracing::info!(peer = %node_id, "peer offline");
            }
            FriendzEvent::MessageReceived {
                from_node_id,
                message,
            } => {
                self.userz.touch(&from_node_id).await.ok();
                self.handle_friendz_message(&from_node_id, message).await?;
            }
        }
        Ok(())
    }

    async fn handle_friendz_message(
        &self,
        from: &str,
        msg: FriendzMessage,
    ) -> Result<(), ServiceError> {
        match msg {
            FriendzMessage::Heartbeat { .. } => {
                // already touched above
            }
            FriendzMessage::ProfileRequest => {
                let reply = FriendzMessage::ProfileResponse {
                    username: self.local_username.clone(),
                    bio: String::new(),
                    avatar_data_url: String::new(),
                };
                if let Err(e) = self.friendz_handler.send_message(from, &reply).await {
                    tracing::warn!(error = %e, peer = %from, "failed to send profile response");
                }
            }
            FriendzMessage::ProfileResponse {
                username, ..
            } => {
                // phase-1: ignore avatar_data_url; userz.avatar_blake3 takes a
                // blake3 hash, not a data url. avatar transfer comes back later.
                self.userz
                    .upsert_profile(from, Some(&username), None, None)
                    .await?;
            }
            FriendzMessage::FriendRequest { from_username, .. } => {
                tracing::info!(peer = %from, username = %from_username, "friend request received");
                // auto-accept for phase-1 prototype. real ACL flow comes later.
                self.friendz_store
                    .upsert(from, friendz::FriendStatus::Accepted, None)
                    .await?;
                let ack = FriendzMessage::FriendAccept {
                    from_node_id: self.node_id_str.clone(),
                    from_username: self.local_username.clone(),
                };
                if let Err(e) = self.friendz_handler.send_message(from, &ack).await {
                    tracing::warn!(error = %e, peer = %from, "failed to send friend-accept");
                }
            }
            FriendzMessage::FriendAccept { from_username, .. } => {
                tracing::info!(peer = %from, username = %from_username, "friend accept received");
                self.friendz_store
                    .upsert(from, friendz::FriendStatus::Accepted, None)
                    .await?;
            }
            FriendzMessage::FriendReject { .. } => {
                self.friendz_store.delete(from).await?;
            }
            other => {
                tracing::debug!(peer = %from, msg = ?other, "ignoring friendz message in phase-1");
            }
        }
        Ok(())
    }

    /// graceful shutdown of router + endpoint.
    pub async fn shutdown(self) {
        tracing::info!("shutting down reliquary service");
        let timeout = std::time::Duration::from_secs(10);
        match tokio::time::timeout(timeout, self.router.shutdown()).await {
            Ok(Ok(())) => tracing::debug!("router shut down cleanly"),
            Ok(Err(e)) => tracing::warn!(error = ?e, "error shutting down router"),
            Err(_) => tracing::warn!("router shutdown timed out after 10s"),
        }
        self.endpoint.close().await;
        tracing::info!("reliquary service stopped");
    }

    /// graceful shutdown of router only — leaves the `Endpoint` open so an
    /// embedder (e.g. the tauri app) can keep using it. used for the
    /// start/stop hub-toggle flow where the endpoint's lifetime is tied to
    /// the host process, not to any individual `Service` instance.
    pub async fn shutdown_keep_endpoint(self) {
        tracing::info!("shutting down reliquary service (keeping endpoint open)");
        let timeout = std::time::Duration::from_secs(10);
        match tokio::time::timeout(timeout, self.router.shutdown()).await {
            Ok(Ok(())) => tracing::debug!("router shut down cleanly"),
            Ok(Err(e)) => tracing::warn!(error = ?e, "error shutting down router"),
            Err(_) => tracing::warn!("router shutdown timed out after 10s"),
        }
        tracing::info!("reliquary service stopped (endpoint left open)");
    }

    // accessors ---------------------------------------------------------

    /// snapshot a cloneable handle with all of the accessor surfaces.
    /// use this when handing the service to callers that don't drive the
    /// run loop (e.g. tauri IPC commands).
    pub fn handle(&self) -> ServiceHandle {
        ServiceHandle {
            endpoint: self.endpoint.clone(),
            friendz_handler: self.friendz_handler.clone(),
            iroh_repo: self.iroh_repo.clone(),
            blobz: self.blobz.clone(),
            friendz_store: self.friendz_store.clone(),
            userz: self.userz.clone(),
            node_id_str: self.node_id_str.clone(),
        }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    pub fn friendz(&self) -> &FriendzHandler {
        &self.friendz_handler
    }

    pub fn iroh_repo(&self) -> &IrohRepo {
        &self.iroh_repo
    }

    pub fn blobz(&self) -> &blobz::Store {
        &self.blobz
    }

    pub fn userz(&self) -> &userz::Directory {
        &self.userz
    }

    pub fn friendz_store(&self) -> &friendz::Store {
        &self.friendz_store
    }

    pub fn node_id(&self) -> &str {
        &self.node_id_str
    }
}

// ---------------------------------------------------------------------------
// hub variant
//
// `start_hub` is the phase-2 entry point used by `reliquary serve`. it
// constructs the same set of stores/handlers as `Service::start`, then hands
// them to [`crate::hub::HubPeerService`] which adds canvas invite/gossip/
// blob-snatch logic and runs the full event loop.
// ---------------------------------------------------------------------------

/// bootstrap a [`crate::hub::HubPeerService`] sharing the same data_dir +
/// sqlite pool as the minimal `Service`.
///
/// returns a ready-to-run hub. spawn `service.run(cancel)` to drive it.
pub async fn start_hub(
    endpoint: Endpoint,
    pool: SqlitePool,
    config: ServiceConfig,
) -> Result<crate::hub::HubPeerService, ServiceError> {
    use crate::hub::{HubPeerConfig, HubPeerService};

    let node_id_str = endpoint.id().to_string();

    let userz = userz::Directory::new(pool.clone());
    let blobz = blobz::Store::new(pool.clone(), &config.data_dir);
    let friendz_store = friendz::Store::new(pool.clone());

    // automerge sync — hub_repo owns its own sqlite db for the doc graph
    let hub_repo = HubRepo::new(node_id_str.clone(), &config.data_dir.join("skein-docs.db"))
        .await
        .map_err(|e| ServiceError::HubRepo(format!("{e}")))?;

    // shared iroh-blobs FsStore (process-wide singleton)
    let store = fs_store(&config.data_dir).await?;

    let hub_config = HubPeerConfig {
        data_dir: config.data_dir.clone(),
        username: config.username,
        bio: config.bio,
        avatar_path: config.avatar_path,
    };

    HubPeerService::start(
        endpoint,
        hub_repo,
        store,
        userz,
        friendz_store,
        blobz,
        hub_config,
    )
    .await
    .map_err(|e| ServiceError::HubRepo(format!("hub start: {e}")))
}