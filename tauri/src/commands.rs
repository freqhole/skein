//! skein tauri IPC — single `skein_dispatch(action, payload)` entry point.
//!
//! every frontend call routes through here. the action string selects a
//! handler; the payload is decoded into the per-action request type. responses
//! are serialized as `serde_json::Value` so one tauri command covers the
//! entire surface.
//!
//! see [docs/tauri-progress.md](../../../docs/tauri-progress.md) for the
//! current action list and what's stubbed.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use freqhole_reliquary::blobz::{BlobRecord, NewBlobMeta};
use freqhole_reliquary::identity;
use iroh::Endpoint;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tumulus::{friendz, userz};

// ---------------------------------------------------------------------------
// cancel registry for in-flight blob downloads
// ---------------------------------------------------------------------------

/// global map from blake3 hex -> cancel flag for any in-flight `blob_iroh_download`.
/// the flag is set by `blob_iroh_download_cancel`; the download loop checks it
/// each iteration and aborts when set.
static DOWNLOAD_CANCELS: LazyLock<StdMutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// RAII guard that removes the cancel flag for `blake3` from `DOWNLOAD_CANCELS`
/// when dropped, so the registry never accumulates stale entries.
struct DownloadCancelGuard(String);

impl Drop for DownloadCancelGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = DOWNLOAD_CANCELS.lock() {
            map.remove(&self.0);
        }
    }
}

// ---------------------------------------------------------------------------
// cancel registry for in-flight blob uploads (blob_insert_from_path)
// ---------------------------------------------------------------------------

/// global map from upload_id -> cancel flag for any in-flight `blob_insert_from_path`.
/// the flag is set by `blob_insert_cancel`; the hashing loop checks it each
/// iteration and aborts when set.
static UPLOAD_CANCELS: LazyLock<StdMutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// RAII guard that removes the cancel flag for `upload_id` from `UPLOAD_CANCELS`
/// when dropped, so the registry never accumulates stale entries.
struct UploadCancelGuard(String);

impl Drop for UploadCancelGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = UPLOAD_CANCELS.lock() {
            map.remove(&self.0);
        }
    }
}

/// raii guard that removes a hash from the `blobs_in_flight` set when dropped.
/// ensures the gc protect callback never sees a stale in-flight entry if the
/// download completes, errors, or is cancelled. mirrors `DownloadCancelGuard`.
struct BlobsInFlightGuard {
    set: Arc<std::sync::Mutex<std::collections::HashSet<iroh_blobs::Hash>>>,
    hash: iroh_blobs::Hash,
}

impl Drop for BlobsInFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.set.lock() {
            guard.remove(&self.hash);
        }
    }
}

/// runtime state for the one-and-only tauri command.
///
/// the pool and stores are always alive — they exist for the lifetime of
/// the tauri process. the iroh endpoint/streams (`network`) are NOT: they
/// only come up once an identity exists, which only ever happens in
/// response to something the user explicitly asked for (see
/// [`ensure_network`]/[`build_network_state`]) — never merely because the
/// process started.
pub struct AppState {
    pub network: Arc<Mutex<Option<NetworkState>>>,
    pub data_dir: PathBuf,
    pub username: String,

    /// the iroh-blobs `FsStore` + gc-protect + downloader bundle. boots
    /// fully offline via `StorageNode::init_local` (see `lib.rs`'s
    /// `build_state`); a downloader is bound once a live endpoint exists
    /// (see `attach_network_endpoint`) and cleared if the endpoint is ever
    /// torn down, without needing a new `StorageNode`.
    pub storage: Arc<freqhole_reliquary::node::StorageNode>,
    /// mirrors `storage`'s own downloader across every attach/rebind, so
    /// anything holding this cell (a future snatch engine, e.g.) always
    /// agrees with the storage node about the current downloader. kept in
    /// sync exclusively through `attach_network_endpoint`.
    pub downloader_cell: Arc<std::sync::RwLock<Option<iroh_blobs::api::downloader::Downloader>>>,
    pub friendz_store: friendz::Store,
    pub userz: userz::Directory,

    pub process_started_at: Instant,
    pub app_config_path: PathBuf,
}

/// the "network is up" half of `AppState`: the bound iroh endpoint, our own
/// node id, and the stream registry. lives behind `AppState::network`'s
/// mutex — `None` until [`ensure_network`] (or the boot-time restore path
/// in `lib.rs`, for a returning user with an existing keypair) builds one.
pub struct NetworkState {
    pub endpoint: Endpoint,
    pub node_id: String,
    pub streams: Arc<crate::streams::StreamRegistry>,
}

/// persistent app config — written to `<data_dir>/skein-app.toml`. tracks
/// the user's social settings (visibility / who can send friend requests).
/// add fields with `#[serde(default)]` so older toml files still load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_profile_visibility")]
    pub profile_visibility: String,
    #[serde(default = "default_friend_requests_from")]
    pub friend_requests_from: String,
}

fn default_profile_visibility() -> String {
    "friends".to_string()
}

fn default_friend_requests_from() -> String {
    "everyone".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            profile_visibility: default_profile_visibility(),
            friend_requests_from: default_friend_requests_from(),
        }
    }
}

impl AppConfig {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> std::io::Result<()> {
        let toml = toml::to_string_pretty(self).unwrap_or_default();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, toml)
    }
}

// ---------------------------------------------------------------------------
// dispatch entry point
// ---------------------------------------------------------------------------

/// the one and only tauri command. all frontend traffic flows through here.
#[tauri::command]
pub async fn skein_dispatch(
    action: String,
    payload: Option<Value>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let payload = payload.unwrap_or(Value::Null);
    let result = dispatch(&action, payload, &app, state.inner()).await;

    // any successful social mutation triggers a state-changed event so
    // SqliteSocialDoc refetches its snapshot on the frontend.
    if result.is_ok() && is_social_mutation(&action) {
        if let Err(e) = app.emit("social-state-changed", ()) {
            tracing::warn!(error = %e, "failed to emit social-state-changed");
        }
    }

    result.map_err(|e| e.to_string())
}

/// returns true for actions that mutate persisted social state. used to
/// gate the `social-state-changed` event so reads don't trigger refetches.
fn is_social_mutation(action: &str) -> bool {
    matches!(
        action,
        "social_add_friend"
            | "social_remove_friend"
            | "social_create_request"
            | "social_update_request"
            | "social_delete_request"
            | "social_set_friend_alias"
            | "social_update_friend"
            | "social_mark_friend_as_hub"
            | "social_update_node_profile"
            | "social_update_profile"
            | "social_update_settings"
            | "social_upsert_group"
            | "social_delete_group"
            | "friend_add"
            | "friend_remove"
    )
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum DispatchError {
    #[error("unknown action: {0}")]
    UnknownAction(String),
    #[error("invalid payload for {action}: {source}")]
    InvalidPayload {
        action: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("stream: {0}")]
    Stream(String),
    #[error("blob: {0}")]
    Blob(#[from] freqhole_reliquary::blobz::BlobStoreError),
    #[error("friend: {0}")]
    Friend(#[from] friendz::FriendError),
    #[error("user: {0}")]
    User(#[from] userz::UserError),
    #[error("not found")]
    NotFound,
    #[error("identity: {0}")]
    Identity(String),
    #[error("fetch: {0}")]
    Fetch(String),
}

/// read the current node id without any side effects — never generates a
/// keypair or binds an endpoint. returns an empty string if no identity has
/// been created yet (a real, valid state: the frontend treats an empty
/// `node_id` as "no identity" the same way it does in browser mode, e.g.
/// `social-widget.ts`'s `hasIdentity` check).
async fn current_node_id(state: &AppState) -> String {
    state
        .network
        .lock()
        .await
        .as_ref()
        .map(|n| n.node_id.clone())
        .unwrap_or_default()
}

/// build a fresh [`NetworkState`]: loads the persisted keypair if one
/// already exists on disk, otherwise generates a brand-new one (via
/// `identity::load_or_generate_keypair`), binds the iroh endpoint, records
/// ourselves in `userz`, starts the stream registry, and pre-warms the
/// iroh-blobs FsStore with every blob already in `blobz`.
///
/// this is the only function that can ever cause a NEW keypair to be
/// generated. callers control *when* that's allowed to happen by
/// controlling *when this function is called at all*: `lib.rs`'s boot path
/// only calls it when a keypair file already exists (a returning user, who
/// already consented to P2P in an earlier session); [`ensure_network`]
/// calls it lazily, the first time the frontend actually needs the
/// network (sharing/joining a canvas, fetching a blob from a peer, or the
/// user clicking "generate identity" in the profile widget) — never merely
/// because the process started.
/// bind (or rebind) the storage node's downloader to `endpoint`, and keep
/// `AppState::downloader_cell` in sync with it. every code path that ends up
/// with a live endpoint funnels through `build_network_state` (the boot-time
/// identity restore in `lib.rs` and `ensure_network`'s lazy first-use build
/// both call it), so this is the single place that ever attaches an
/// endpoint to the storage node.
fn attach_network_endpoint(state: &AppState, endpoint: &Endpoint) {
    state.storage.attach_endpoint(endpoint);
    if let Ok(mut cell) = state.downloader_cell.write() {
        *cell = state.storage.downloader();
    }
}

pub async fn build_network_state(state: &AppState) -> anyhow::Result<NetworkState> {
    let secret =
        identity::load_or_generate_keypair(&state.data_dir, identity::DEFAULT_KEYPAIR_FILENAME)?;
    let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
        .secret_key(secret)
        .bind()
        .await?;
    let node_id = endpoint.id().to_string();

    attach_network_endpoint(state, &endpoint);

    state
        .userz
        .upsert_self(&node_id, Some(&state.username), None, None)
        .await?;

    let streams = crate::streams::StreamRegistry::start_with_blobs(
        endpoint.clone(),
        state.storage.fs_store,
        state.friendz_store.clone(),
    )
    .await?;

    // pre-warm the FsStore for every blob already in blobz. without this,
    // the first peer to ask for a pre-existing blob has to wait for
    // `add_path` (BAO tree compute) inside the dispatch handler, and for
    // large files that easily exceeds the browser's snatch timeout.
    // best-effort: errors are logged and ignored — the lazy
    // `blob_iroh_ensure` path still works as a fallback.
    match state.storage.blobz.list(i64::MAX, 0).await {
        Ok((blobs, _total)) => {
            tracing::info!(count = blobs.len(), "pre-warming iroh-blobs FsStore");
            for blob in blobs {
                prewarm_fs_store(state, &blob).await;
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "prewarm: failed to list blobz, skipping FsStore seed");
        }
    }

    tracing::info!(node_id = %node_id, "iroh endpoint bound");
    Ok(NetworkState {
        endpoint,
        node_id,
        streams,
    })
}

/// ensure the iroh endpoint + streams exist, lazily building them (and
/// generating a keypair if this is genuinely the first time) on first
/// call. every dispatch action that actually needs the network calls this
/// instead of reading `AppState` fields directly.
async fn ensure_network(
    state: &AppState,
) -> Result<(Endpoint, String, Arc<crate::streams::StreamRegistry>), DispatchError> {
    let mut guard = state.network.lock().await;
    if let Some(net) = guard.as_ref() {
        return Ok((
            net.endpoint.clone(),
            net.node_id.clone(),
            net.streams.clone(),
        ));
    }
    let net = build_network_state(state)
        .await
        .map_err(|e| DispatchError::Identity(e.to_string()))?;
    let result = (
        net.endpoint.clone(),
        net.node_id.clone(),
        net.streams.clone(),
    );
    *guard = Some(net);
    Ok(result)
}

async fn dispatch(
    action: &str,
    payload: Value,
    app: &AppHandle,
    state: &AppState,
) -> Result<Value, DispatchError> {
    match action {
        // identity / status
        //
        // `identity_status` is read-only — it never generates a keypair or
        // binds an endpoint, so it's safe to call on every boot (e.g. to
        // show/hide identity-gated UI). `get_node_id` is the "ensure"
        // endpoint: it lazily generates a keypair and binds the iroh
        // endpoint the first time it's actually needed (sharing/joining a
        // canvas, the user clicking "generate identity", ...) — never
        // merely because the process started.
        "identity_status" => Ok(json!({ "node_id": current_node_id(state).await })),
        "get_node_id" => {
            let (_, node_id, _) = ensure_network(state).await?;
            Ok(json!({ "node_id": node_id }))
        }
        "status" => status(state).await,

        // friends
        "friend_add" => friend_add(decode("friend_add", payload)?, state).await,
        "friend_list" => friend_list(state).await,
        "friend_remove" => friend_remove(decode("friend_remove", payload)?, state).await,

        // social doc reads + writes (back the SqliteSocialDoc adapter on the
        // frontend). every mutation triggers `social-state-changed` via the
        // dispatch wrapper above.
        "social_get_state" => social_get_state(state).await,
        "social_add_friend" => {
            social_add_friend(decode("social_add_friend", payload)?, state).await
        }
        "social_remove_friend" => {
            social_remove_friend(decode("social_remove_friend", payload)?, state).await
        }
        "social_create_request" => {
            social_create_request(decode("social_create_request", payload)?, state).await
        }
        "social_update_request" => {
            social_update_request(decode("social_update_request", payload)?, state).await
        }
        "social_delete_request" => {
            social_delete_request(decode("social_delete_request", payload)?, state).await
        }
        "social_mark_friend_as_hub" => {
            social_mark_friend_as_hub(decode("social_mark_friend_as_hub", payload)?, state).await
        }
        "social_set_friend_alias" => {
            social_set_friend_alias(decode("social_set_friend_alias", payload)?, state).await
        }
        "social_update_friend" => {
            social_update_friend(decode("social_update_friend", payload)?, state).await
        }
        "social_update_node_profile" => {
            social_update_node_profile(decode("social_update_node_profile", payload)?, state).await
        }
        "social_update_profile" => {
            social_update_profile(decode("social_update_profile", payload)?, state).await
        }
        "social_update_settings" => {
            social_update_settings(decode("social_update_settings", payload)?, state).await
        }
        // groups are derived from `friendz.group_name` rather than persisted
        // separately, so upsert/delete are accept-and-ignore. groups appear
        // automatically once a friend is assigned to one.
        "social_upsert_group" => Ok(Value::Null),
        "social_delete_group" => Ok(Value::Null),

        // blobs
        "blob_list" => blob_list(decode_or_default(payload), state).await,
        "blob_get" => blob_get(decode("blob_get", payload)?, state).await,
        "blob_get_path" => blob_get_path(decode("blob_get_path", payload)?, state).await,
        "blob_insert" => blob_insert(decode("blob_insert", payload)?, state).await,
        "blob_insert_from_path" => {
            blob_insert_from_path(decode("blob_insert_from_path", payload)?, app, state).await
        }
        "blob_insert_cancel" => blob_insert_cancel(decode("blob_insert_cancel", payload)?).await,
        "blob_iroh_ensure" => blob_iroh_ensure(decode("blob_iroh_ensure", payload)?, state).await,
        "blob_iroh_download" => {
            blob_iroh_download(decode("blob_iroh_download", payload)?, app, state).await
        }
        "blob_iroh_download_cancel" => {
            blob_iroh_download_cancel(decode("blob_iroh_download_cancel", payload)?).await
        }
        "blob_iroh_probe" => blob_iroh_probe(decode("blob_iroh_probe", payload)?, state).await,

        // pdf page rendering (peedeeeff widget)
        "pdf_render_pages" => pdf_render_pages(decode("pdf_render_pages", payload)?, state).await,

        // startup capability probe for the peedeeeff widget — the flyout
        // hides the widget type entirely when `magick` isn't available so
        // users aren't offered a widget that can't render anything.
        "pdf_check_available" => {
            Ok(json!({ "available": crate::pdf::pdf_backend_available().await }))
        }

        // generate a thumbnail for a stored blob. supports image/*, application/pdf,
        // and video/* source types. returns { data: <base64>, mime } or { data: null }.
        "blob_thumbnail" => blob_thumbnail(decode("blob_thumbnail", payload)?, state).await,

        // link widget unfurl — fetch a URL server-side (no CORS restriction,
        // unlike the browser-mode fallback in loam/src/widgets/link-unfurl.ts)
        // and extract a small opengraph-ish summary.
        "link_unfurl" => crate::unfurl::link_unfurl(decode("link_unfurl", payload)?).await,

        // bi-stream IPC — all of these need a live endpoint/streams, so
        // they all lazily ensure the network first (see `ensure_network`).
        "open_bi" => {
            let (endpoint, _, streams) = ensure_network(state).await?;
            crate::streams::open_bi(decode("open_bi", payload)?, &endpoint, &streams)
                .await
                .map_err(stream_err)
        }
        "accept_stream" => {
            let (_, _, streams) = ensure_network(state).await?;
            crate::streams::accept_stream(&streams)
                .await
                .map_err(stream_err)
        }
        "write_message" => {
            let (_, _, streams) = ensure_network(state).await?;
            crate::streams::write_message(decode("write_message", payload)?, &streams)
                .await
                .map_err(stream_err)
        }
        "read_message" => {
            let (_, _, streams) = ensure_network(state).await?;
            crate::streams::read_message(decode("read_message", payload)?, &streams)
                .await
                .map_err(stream_err)
        }
        "close_stream" => {
            let (_, _, streams) = ensure_network(state).await?;
            crate::streams::close_stream(decode("close_stream", payload)?, &streams)
                .await
                .map_err(stream_err)
        }
        "write_raw_and_finish" => {
            let (_, _, streams) = ensure_network(state).await?;
            crate::streams::write_raw_and_finish(decode("write_raw_and_finish", payload)?, &streams)
                .await
                .map_err(stream_err)
        }
        "read_to_end" => {
            let (_, _, streams) = ensure_network(state).await?;
            crate::streams::read_to_end(decode("read_to_end", payload)?, &streams)
                .await
                .map_err(stream_err)
        }

        other => Err(DispatchError::UnknownAction(other.to_string())),
    }
}

fn stream_err(e: crate::streams::StreamError) -> DispatchError {
    DispatchError::Stream(e.to_string())
}

fn decode<T: for<'de> Deserialize<'de>>(
    action: &'static str,
    payload: Value,
) -> Result<T, DispatchError> {
    serde_json::from_value(payload)
        .map_err(|source| DispatchError::InvalidPayload { action, source })
}

fn decode_or_default<T: for<'de> Deserialize<'de> + Default>(payload: Value) -> T {
    if payload.is_null() {
        T::default()
    } else {
        serde_json::from_value(payload).unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// shared dtos
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct StatusResponse {
    node_id: String,
    friend_count: usize,
    uptime_s: u64,
}

#[derive(Debug, Serialize)]
struct FriendDto {
    friend_node_id: String,
    status: String,
    narthex_doc_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl From<friendz::Friend> for FriendDto {
    fn from(f: friendz::Friend) -> Self {
        Self {
            friend_node_id: f.friend_node_id,
            status: f.status.as_str().to_string(),
            narthex_doc_id: f.narthex_doc_id,
            created_at: f.created_at,
            updated_at: f.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
struct BlobDto {
    blake3: String,
    iroh_hash: String,
    filename: Option<String>,
    mime: Option<String>,
    size: u64,
    created_at: i64,
}

impl From<BlobRecord> for BlobDto {
    fn from(b: BlobRecord) -> Self {
        Self {
            blake3: b.blake3,
            iroh_hash: b.iroh_hash.unwrap_or_default(),
            filename: b.filename,
            mime: b.mime,
            size: b.size,
            created_at: b.created_at,
        }
    }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async fn status(state: &AppState) -> Result<Value, DispatchError> {
    let friends = state.friendz_store.list(false).await?;
    let resp = StatusResponse {
        node_id: current_node_id(state).await,
        friend_count: friends.len(),
        uptime_s: state.process_started_at.elapsed().as_secs(),
    };
    Ok(serde_json::to_value(resp).expect("status serialize"))
}

// ---------------------------------------------------------------------------
// friends
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct FriendAddArgs {
    node_id: String,
    status: Option<String>,
}

async fn friend_add(args: FriendAddArgs, state: &AppState) -> Result<Value, DispatchError> {
    let status = match args.status.as_deref() {
        Some("pending") => friendz::FriendStatus::Pending,
        Some("blocked") => friendz::FriendStatus::Blocked,
        Some("allowed") => friendz::FriendStatus::Allowed,
        _ => friendz::FriendStatus::Accepted,
    };
    // friendz fk → userz: ensure a user row exists before upserting the edge.
    state.userz.touch(&args.node_id).await?;
    let friend = state
        .friendz_store
        .upsert(&args.node_id, status, None)
        .await?;
    Ok(serde_json::to_value(FriendDto::from(friend)).expect("friend serialize"))
}

async fn friend_list(state: &AppState) -> Result<Value, DispatchError> {
    let friends = state.friendz_store.list(false).await?;
    let dtos: Vec<FriendDto> = friends.into_iter().map(Into::into).collect();
    Ok(serde_json::to_value(dtos).expect("friend list serialize"))
}

#[derive(Debug, Deserialize)]
struct FriendRemoveArgs {
    node_id: String,
}

async fn friend_remove(args: FriendRemoveArgs, state: &AppState) -> Result<Value, DispatchError> {
    state.friendz_store.delete(&args.node_id).await?;
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// social doc — wires SqliteSocialDoc on the frontend to the friendz/userz
// stores. snapshot reads pull from sqlite; mutation handlers write via the
// existing reliquary primitives. groups are derived from friend.group_name
// (no separate table). settings persist in app_config.toml.
// ---------------------------------------------------------------------------

async fn social_get_state(state: &AppState) -> Result<Value, DispatchError> {
    let cfg = AppConfig::load(&state.app_config_path);
    let me = state.userz.get_self().await?;
    let node_id = current_node_id(state).await;

    let profile = json!({
        "user_id": node_id,
        "username": me
            .as_ref()
            .and_then(|u| u.display_name.clone())
            .unwrap_or_else(|| state.username.clone()),
        "alias": me.as_ref().and_then(|u| u.alias.clone()).unwrap_or_default(),
        "bio": me.as_ref().and_then(|u| u.bio.clone()).unwrap_or_default(),
        "avatar_url": me
            .as_ref()
            .and_then(|u| u.avatar_blake3.clone())
            .unwrap_or_default(),
        "accent_color": me.as_ref().map(|u| u.accent_color).unwrap_or(0),
        "node_id": node_id,
    });

    let rows = state.friendz_store.list(false).await?;

    let mut friends = Vec::new();
    let mut pending = Vec::new();
    let mut outbound = Vec::new();
    let mut group_names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    for f in rows {
        let peer = state.userz.get(&f.friend_node_id).await?;
        let username = peer
            .as_ref()
            .and_then(|p| p.display_name.clone())
            .unwrap_or_default();
        let bio = peer
            .as_ref()
            .and_then(|p| p.bio.clone())
            .unwrap_or_default();
        let avatar = peer
            .as_ref()
            .and_then(|p| p.avatar_blake3.clone())
            .unwrap_or_default();
        let accent = peer.as_ref().map(|p| p.accent_color).unwrap_or(0);
        let last_seen = peer.as_ref().map(|p| p.last_seen_at);
        let is_hub = peer.as_ref().map(|p| p.is_hub).unwrap_or(false);
        let alias = f.alias.clone().unwrap_or_default();
        let group_name = f.group_name.clone().unwrap_or_default();
        if !group_name.is_empty() {
            group_names.insert(group_name.clone());
        }

        match (f.status, f.direction) {
            (friendz::FriendStatus::Accepted, _) | (friendz::FriendStatus::Allowed, _) => {
                friends.push(json!({
                    "id": f.friend_node_id,
                    "group_name": group_name,
                    "created_at": f.created_at,
                    "friend_user_id": f.friend_node_id,
                    "username": username,
                    "alias": alias,
                    "bio": bio,
                    "avatar_url": avatar,
                    "accent_color": accent,
                    "is_hub": is_hub,
                    "node_ids": [{
                        "node_id": f.friend_node_id,
                        "display_name": username,
                        "bio": bio,
                        "avatar_url": avatar,
                        "accent_color": accent,
                        "instance_name": Value::Null,
                        "last_seen_at": last_seen,
                        "created_at": f.created_at,
                    }],
                }));
            }
            (friendz::FriendStatus::Pending, dir) => {
                let direction = match dir {
                    Some(friendz::Direction::Outbound) => "outbound",
                    _ => "inbound",
                };
                let req = json!({
                    "id": f.friend_node_id,
                    "user_id": node_id,
                    "remote_user_id": f.friend_node_id,
                    "direction": direction,
                    "status": "pending",
                    "created_at": f.created_at,
                    "updated_at": f.updated_at,
                    "remote_username": username,
                    "remote_alias": alias,
                    "remote_node_id": f.friend_node_id,
                    "remote_display_name": username,
                });
                if direction == "outbound" {
                    outbound.push(req);
                } else {
                    pending.push(req);
                }
            }
            // Blocked rows are intentionally not surfaced in the social doc.
            (friendz::FriendStatus::Blocked, _) => {}
        }
    }

    let groups: Vec<Value> = group_names
        .into_iter()
        .map(|name| {
            json!({
                "id": name.clone(),
                "user_id": node_id,
                "name": name,
                "color": 0,
            })
        })
        .collect();

    Ok(json!({
        "profile": profile,
        "friends": friends,
        "groups": groups,
        "pending_requests": pending,
        "outbound_requests": outbound,
        "settings": {
            "profile_visibility": cfg.profile_visibility,
            "friend_requests_from": cfg.friend_requests_from,
        },
    }))
}

#[derive(Debug, Deserialize)]
struct SocialAddFriendArgs {
    node_id: String,
    alias: Option<String>,
}

async fn social_add_friend(
    args: SocialAddFriendArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    state.userz.touch(&args.node_id).await?;
    state
        .friendz_store
        .upsert_full(
            &args.node_id,
            friendz::FriendStatus::Accepted,
            None,
            args.alias.as_deref(),
            None,
            None,
        )
        .await?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialRemoveFriendArgs {
    id: String,
}

async fn social_remove_friend(
    args: SocialRemoveFriendArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    state.friendz_store.delete(&args.id).await?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialMarkFriendAsHubArgs {
    node_id: String,
}

/// records that a peer identified itself as a hub via the isHub flag on an
/// incoming friendz protocol message (docs/hub-and-profile-plan.md section
/// 3). the tauri build parses that message in JS
/// (`loam/src/p2p/friends-protocol.ts`, same code path the browser build
/// uses) rather than natively in rust, so `userz::mark_as_hub` needs an
/// explicit IPC action here rather than only being reachable from
/// `tumulus::service::Service`'s own native message handling (which only
/// runs while this instance's hub toggle is on).
async fn social_mark_friend_as_hub(
    args: SocialMarkFriendAsHubArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    state.userz.mark_as_hub(&args.node_id).await?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialCreateRequestArgs {
    node_id: String,
    direction: String,
    display_name: Option<String>,
}

async fn social_create_request(
    args: SocialCreateRequestArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let direction = friendz::Direction::parse(&args.direction);

    state.userz.touch(&args.node_id).await?;
    if let Some(name) = args.display_name.as_deref() {
        if !name.is_empty() {
            state
                .userz
                .upsert_profile(&args.node_id, Some(name), None, None)
                .await?;
        }
    }

    // don't downgrade an existing accepted/allowed/blocked row to pending.
    if let Some(existing) = state.friendz_store.get(&args.node_id).await? {
        match existing.status {
            friendz::FriendStatus::Accepted
            | friendz::FriendStatus::Allowed
            | friendz::FriendStatus::Blocked => return Ok(Value::Null),
            friendz::FriendStatus::Pending => {}
        }
    }

    state
        .friendz_store
        .upsert_full(
            &args.node_id,
            friendz::FriendStatus::Pending,
            direction,
            None,
            None,
            None,
        )
        .await?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialUpdateRequestArgs {
    id: String,
    status: String,
}

async fn social_update_request(
    args: SocialUpdateRequestArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    match args.status.as_str() {
        "accepted" | "accepted-pending-ack" => {
            state.userz.touch(&args.id).await?;
            state
                .friendz_store
                .upsert(&args.id, friendz::FriendStatus::Accepted, None)
                .await?;
        }
        "rejected" | "cancelled" => {
            // reliquary has no rejected status — drop the row.
            state.friendz_store.delete(&args.id).await?;
        }
        "pending" => {
            state.userz.touch(&args.id).await?;
            state
                .friendz_store
                .upsert(&args.id, friendz::FriendStatus::Pending, None)
                .await?;
        }
        other => {
            return Err(DispatchError::InvalidPayload {
                action: "social_update_request",
                source: serde::de::Error::custom(format!("unknown status {other}")),
            });
        }
    }
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialDeleteRequestArgs {
    id: String,
}

async fn social_delete_request(
    args: SocialDeleteRequestArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    // only delete if the row is still in a pending/rejected request state —
    // never blow away a real friendship via this code path.
    if let Some(existing) = state.friendz_store.get(&args.id).await? {
        if matches!(existing.status, friendz::FriendStatus::Pending) {
            state.friendz_store.delete(&args.id).await?;
        }
    }
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialSetFriendAliasArgs {
    friend_user_id: String,
    alias: String,
}

async fn social_set_friend_alias(
    args: SocialSetFriendAliasArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let alias = if args.alias.is_empty() {
        None
    } else {
        Some(args.alias.as_str())
    };
    state.userz.touch(&args.friend_user_id).await?;
    state.userz.set_alias(&args.friend_user_id, alias).await?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialUpdateFriendArgs {
    id: String,
    group_name: Option<String>,
}

async fn social_update_friend(
    args: SocialUpdateFriendArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    // upsert_full COALESCE-merges so we need to write the existing status
    // back rather than letting it default. read first.
    let existing = state
        .friendz_store
        .get(&args.id)
        .await?
        .ok_or(DispatchError::NotFound)?;

    state
        .friendz_store
        .upsert_full(
            &args.id,
            existing.status,
            existing.direction,
            existing.alias.as_deref(),
            args.group_name.as_deref(),
            existing.narthex_doc_id.as_deref(),
        )
        .await?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialUpdateNodeProfileArgs {
    node_id: String,
    display_name: Option<String>,
    bio: Option<String>,
    avatar_url: Option<String>,
}

async fn social_update_node_profile(
    args: SocialUpdateNodeProfileArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    state.userz.touch(&args.node_id).await?;
    state
        .userz
        .upsert_profile(
            &args.node_id,
            args.display_name.as_deref(),
            args.bio.as_deref(),
            args.avatar_url.as_deref(),
        )
        .await?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialUpdateProfileArgs {
    alias: Option<String>,
    bio: Option<String>,
    avatar_url: Option<String>,
    accent_color: Option<i64>,
}

async fn social_update_profile(
    args: SocialUpdateProfileArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let node_id = current_node_id(state).await;
    if node_id.is_empty() {
        // editing your own profile only makes sense once an identity
        // exists; the frontend gates this UI behind identity already
        // existing, so reaching here means a genuine caller error rather
        // than something to silently paper over by generating one as a
        // side effect of an unrelated settings write.
        return Err(DispatchError::Identity(
            "no identity yet — generate one before editing your profile".to_string(),
        ));
    }
    state
        .userz
        .upsert_self_full(
            &node_id,
            None,
            args.alias.as_deref(),
            args.bio.as_deref(),
            args.avatar_url.as_deref(),
            args.accent_color,
        )
        .await?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
struct SocialUpdateSettingsArgs {
    profile_visibility: Option<String>,
    friend_requests_from: Option<String>,
}

async fn social_update_settings(
    args: SocialUpdateSettingsArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let mut cfg = AppConfig::load(&state.app_config_path);
    if let Some(v) = args.profile_visibility {
        cfg.profile_visibility = v;
    }
    if let Some(v) = args.friend_requests_from {
        cfg.friend_requests_from = v;
    }
    if let Err(e) = cfg.save(&state.app_config_path) {
        tracing::warn!(error = %e, "failed to persist social settings");
    }
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct BlobListArgs {
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn blob_list(args: BlobListArgs, state: &AppState) -> Result<Value, DispatchError> {
    let (blobs, _total) = state
        .storage
        .blobz
        .list(args.limit.unwrap_or(200), args.offset.unwrap_or(0))
        .await?;
    let dtos: Vec<BlobDto> = blobs.into_iter().map(Into::into).collect();
    Ok(serde_json::to_value(dtos).expect("blob list serialize"))
}

#[derive(Debug, Deserialize)]
struct BlobGetArgs {
    blake3: String,
}

async fn blob_get(args: BlobGetArgs, state: &AppState) -> Result<Value, DispatchError> {
    let Some(meta) = state.storage.blobz.get(&args.blake3).await? else {
        return Err(DispatchError::NotFound);
    };
    let bytes = state
        .storage
        .blobz
        .read_bytes(&args.blake3)
        .await?
        .ok_or(DispatchError::NotFound)?;
    Ok(json!({
        "meta": BlobDto::from(meta),
        "data": B64.encode(&bytes),
    }))
}

/// resolve a blob id (blake3) to its on-disk filesystem path so the frontend
/// can hand it to tauri's asset:// protocol for native streaming. avoids
/// base64-roundtripping the entire file for `<video>` / `<audio>` previews.
async fn blob_get_path(args: BlobGetArgs, state: &AppState) -> Result<Value, DispatchError> {
    let Some(meta) = state.storage.blobz.get(&args.blake3).await? else {
        return Err(DispatchError::NotFound);
    };
    let path = state.storage.blobz.path_for(&meta);
    Ok(json!({
        "path": path.to_string_lossy(),
        "mime": meta.mime,
        "size": meta.size,
    }))
}

/// best-effort: import a freshly-inserted blob into the iroh-blobs FsStore
/// so the `BlobsProtocol` handler can serve it instantly when a browser
/// peer asks. without this, the first `blob_iroh_ensure` call on a large
/// blob has to compute the BAO tree synchronously inside the dispatch
/// handler — easily blowing past the browser's 30 s strategy-1 timeout
/// for video files. errors are logged and swallowed: the lazy
/// `blob_iroh_ensure` path will still work as a fallback.
async fn prewarm_fs_store(state: &AppState, blob: &BlobRecord) {
    let path = state.storage.blobz.path_for(blob);
    if !path.exists() {
        tracing::warn!(blake3 = %blob.blake3, "prewarm: blob file missing on disk");
        return;
    }
    match state.storage.fs_store.blobs().add_path(path).await {
        Ok(_tag) => {
            tracing::debug!(blake3 = %blob.blake3, "prewarm: imported into FsStore");
        }
        Err(e) => {
            tracing::warn!(blake3 = %blob.blake3, error = %e, "prewarm: FsStore add_path failed");
        }
    }
}

/// import a blob from `blobz` into the iroh-blobs FsStore so the
/// `BlobsProtocol` handler (registered on `iroh-blobs/4` by
/// [`crate::streams::StreamRegistry::start_with_blobs`]) can serve it to a
/// peer over verified streaming.
///
/// called from the frontend's `handleEnsureBlob` over `freqhole/1`: when a
/// peer probes us for a blob via `ensure_blob_request`, the JS layer
/// dispatches this action so the underlying bytes are loaded into the
/// FsStore before we reply `available: true`. without this preload, the
/// peer's subsequent `download_verified_*` call would 404 inside iroh-blobs
/// because the FsStore has no record of the hash yet. blobs inserted via
/// `blob_insert` / `blob_insert_from_path` are pre-warmed at insert time
/// (see [`prewarm_fs_store`]); this dispatch is the catch-all for blobs
/// that arrived through other paths (e.g. snatched from another peer).
///
/// returns `{ available: true }` on success or `{ available: false, reason }`
/// when the blob is unknown / missing on disk / fails to import. mirrors the
/// same lookup-and-stage shape as `freqhole_reliquary::ensure::EnsureBlobHandler`'s
/// own request handling.
async fn blob_iroh_ensure(args: BlobGetArgs, state: &AppState) -> Result<Value, DispatchError> {
    if args.blake3.len() != 64 {
        return Ok(json!({
            "available": false,
            "reason": format!("expected 64-char blake3 hex, got {}", args.blake3.len()),
        }));
    }
    let meta = match state.storage.blobz.get(&args.blake3).await? {
        Some(m) => m,
        None => return Ok(json!({ "available": false, "reason": "unknown blake3" })),
    };
    let path = state.storage.blobz.path_for(&meta);
    if !path.exists() {
        return Ok(json!({ "available": false, "reason": "blob file missing on disk" }));
    }
    // import by reference into the iroh-blobs store. iroh-blobs computes
    // blake3 internally and dedupes on hash, so re-imports are cheap (only
    // the outboard metadata is recomputed).
    match state.storage.fs_store.blobs().add_path(path).await {
        Ok(_tag) => Ok(json!({ "available": true })),
        Err(e) => Ok(json!({
            "available": false,
            "reason": format!("FsStore import failed: {e}"),
        })),
    }
}

#[derive(Debug, Deserialize)]
struct BlobInsertArgs {
    filename: Option<String>,
    mime: Option<String>,
    /// base64-encoded bytes.
    data: String,
}

async fn blob_insert(args: BlobInsertArgs, state: &AppState) -> Result<Value, DispatchError> {
    let bytes = B64
        .decode(args.data.as_bytes())
        .map_err(|e| DispatchError::InvalidPayload {
            action: "blob_insert",
            source: serde::de::Error::custom(format!("base64 decode: {e}")),
        })?;
    let blob = state
        .storage
        .blobz
        .insert(
            &bytes,
            NewBlobMeta {
                filename: args.filename,
                mime: args.mime,
                ..Default::default()
            },
        )
        .await?;
    prewarm_fs_store(state, &blob).await;
    Ok(serde_json::to_value(BlobDto::from(blob)).expect("blob insert serialize"))
}

#[derive(Debug, Deserialize)]
struct BlobInsertFromPathArgs {
    /// absolute path on the local filesystem (e.g. from the tauri native
    /// file picker). the file is read into memory, hashed (blake3), and
    /// copied into reliquary's blob-files dir.
    local_path: String,
    filename: Option<String>,
    mime: Option<String>,
    /// caller-generated id echoed back on every `blob-insert-progress` event
    /// so the frontend can correlate progress with the right upload when
    /// more than one is in flight. progress is skipped entirely if omitted.
    upload_id: Option<String>,
}

/// above this size, `blob_insert_from_path`'s response omits the base64
/// `data` mirror entirely — a multi-gigabyte file has no real use for a
/// duplicate copy in browser-managed storage (OPFS/IndexedDB), and paying
/// for a full base64 encode + a second full-size decode on the JS side just
/// to store bytes nothing ever reads back is exactly the "three copies of a
/// multi-gigabyte file in memory at once" pattern that used to crash the
/// app on large files. widgets already handle "blob only reachable via
/// tauri dispatch" gracefully (see `getBlobData()`'s tauri fallback), so a
/// large file simply staying rust-only is fine.
const MIRROR_DATA_MAX_BYTES: u64 = 25 * 1024 * 1024;

/// thin tauri-facing wrapper around [`blob_insert_from_path_impl`]: its only
/// job is turning `app`/`upload_id` into an `on_progress` closure that emits
/// `blob-insert-progress` events. all the actual upload logic (validation,
/// streaming hash, cancel registry, blobz insert, mirror-data decision) lives
/// in the impl function, which knows nothing about tauri and is exercised
/// directly in tests below with a plain closure instead of a real `AppHandle`.
async fn blob_insert_from_path(
    args: BlobInsertFromPathArgs,
    app: &AppHandle,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let upload_id = args.upload_id.clone();
    let progress_cb = upload_id.map(|id| {
        let app = app.clone();
        move |bytes_read: u64, total: u64| {
            let _ = app.emit(
                "blob-insert-progress",
                json!({ "uploadId": id, "bytesRead": bytes_read, "total": total }),
            );
        }
    });
    let on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)> = progress_cb
        .as_ref()
        .map(|f| f as &(dyn Fn(u64, u64) + Send + Sync));

    blob_insert_from_path_impl(args, on_progress, state).await
}

async fn blob_insert_from_path_impl(
    args: BlobInsertFromPathArgs,
    on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let path = std::path::PathBuf::from(&args.local_path);
    if !path.is_absolute() {
        return Err(DispatchError::InvalidPayload {
            action: "blob_insert_from_path",
            source: serde::de::Error::custom(format!(
                "local_path must be absolute, got {}",
                args.local_path
            )),
        });
    }

    // derive a filename from the path tail when caller didn't pass one.
    let filename = args.filename.or_else(|| {
        path.file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    });

    // streams the file through blake3 in fixed-size chunks (see
    // `register_external_path`'s doc comment in `freqhole_reliquary::blobz`)
    // — never loads the whole file into memory, and registers it as an
    // "external" reference (the file stays exactly where the user's native
    // file picker found it, rather than also being copied into reliquary's
    // blob-files dir) so a multi-gigabyte upload costs one streaming read
    // pass, not a read + a full-file copy + a full-file base64 round-trip.
    let upload_id = args.upload_id.clone();

    // register a cancel flag so `blob_insert_cancel` can abort the hashing pass.
    // the guard removes the entry from the registry on ALL exit paths.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let _upload_guard = if let Some(id) = &upload_id {
        if let Ok(mut map) = UPLOAD_CANCELS.lock() {
            map.insert(id.clone(), Arc::clone(&cancel_flag));
        }
        Some(UploadCancelGuard(id.clone()))
    } else {
        None
    };

    let blob = state
        .storage
        .blobz
        .register_external_path(
            &path,
            NewBlobMeta {
                filename,
                mime: args.mime,
                ..Default::default()
            },
            on_progress,
            Some(&cancel_flag),
        )
        .await
        .map_err(|e| {
            if matches!(e, freqhole_reliquary::blobz::BlobStoreError::Cancelled) {
                DispatchError::Stream("upload cancelled".to_string())
            } else {
                DispatchError::Blob(e)
            }
        })?;
    prewarm_fs_store(state, &blob).await;

    // mirror the bytes back to the JS caller only for small files — see
    // `MIRROR_DATA_MAX_BYTES`'s doc comment. `null` (not an empty string)
    // signals "no mirror" explicitly so the JS side can't mistake it for a
    // genuinely-empty (0-byte) file.
    let data = if blob.size <= MIRROR_DATA_MAX_BYTES {
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            DispatchError::Blob(freqhole_reliquary::blobz::BlobStoreError::Io(format!(
                "read {}: {}",
                path.display(),
                e
            )))
        })?;
        Value::String(B64.encode(&bytes))
    } else {
        Value::Null
    };

    Ok(json!({
        "meta": BlobDto::from(blob),
        "data": data,
    }))
}

#[derive(Debug, Deserialize)]
struct BlobInsertCancelArgs {
    upload_id: String,
}

/// signal an in-flight `blob_insert_from_path` to stop after its current chunk.
///
/// sets the cancel flag registered by the upload loop. returns `{ "cancelled": true }`
/// if the flag was found (upload was still in flight), `false` if it had already
/// finished or the upload_id was not registered with a cancel flag.
async fn blob_insert_cancel(args: BlobInsertCancelArgs) -> Result<Value, DispatchError> {
    let cancelled = match UPLOAD_CANCELS.lock() {
        Ok(map) => match map.get(&args.upload_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        },
        Err(_) => false,
    };
    Ok(json!({ "cancelled": cancelled }))
}

#[derive(Debug, Deserialize)]
struct BlobIrohDownloadArgs {
    /// peer's iroh node id (64-char hex). same convention as `open_bi`.
    peer_addr: String,
    /// blake3 hex hash of the blob to fetch.
    blake3: String,
    /// optional original filename to record in `blobz`.
    filename: Option<String>,
    /// optional mime to record in `blobz`.
    mime: Option<String>,
    /// optional expected total size in bytes — used only to compute the
    /// fraction in `blob-download-progress` events (progress still works
    /// without it; events then carry `bytesDone` with `totalSize: 0`).
    size: Option<u64>,
}

/// thin tauri-facing wrapper around [`blob_iroh_download_impl`]: its only job
/// is turning `app` into an `on_progress` closure that emits
/// `blob-download-progress` events (used both for in-flight progress and the
/// final 100% completion event). all the actual download/ingest logic lives
/// in the impl function, which knows nothing about tauri and is exercised
/// directly in tests below with a plain closure instead of a real `AppHandle`.
async fn blob_iroh_download(
    args: BlobIrohDownloadArgs,
    app: &AppHandle,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let blake3 = args.blake3.clone();
    let app = app.clone();
    let on_progress = move |bytes_done: u64, total_size: u64| {
        let _ = app.emit(
            "blob-download-progress",
            json!({ "blake3": blake3, "bytesDone": bytes_done, "totalSize": total_size }),
        );
    };
    blob_iroh_download_impl(args, &on_progress, state).await
}

/// download a blob from a peer over iroh-blobs verified transfer, ingest
/// it into the local `blobz` store (and FsStore via prewarm), and return
/// the blob row + base64 bytes so the JS caller can mirror it into OPFS /
/// IndexedDB the same way `blob_insert_from_path` does.
///
/// mirrors tomb's `reliquary::snatch::BlobSnatcher::download_blob` — the
/// canonical native-rust impl of the iroh-blobs consumer side.
async fn blob_iroh_download_impl(
    args: BlobIrohDownloadArgs,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    state: &AppState,
) -> Result<Value, DispatchError> {
    use iroh_blobs::api::blobs::{ExportMode, ExportOptions};
    use iroh_blobs::api::downloader::DownloadProgressItem;
    use iroh_blobs::{Hash, HashAndFormat};
    use n0_future::StreamExt;

    if args.blake3.len() != 64 {
        return Err(DispatchError::Stream(format!(
            "expected 64-char blake3 hex, got {}",
            args.blake3.len()
        )));
    }

    let hash: Hash = args
        .blake3
        .parse()
        .map_err(|e| DispatchError::Stream(format!("parse blake3: {e}")))?;

    let node_id: iroh::PublicKey = args.peer_addr.parse().map_err(|e: iroh::KeyParsingError| {
        DispatchError::Stream(format!("parse peer_addr (node id): {e}"))
    })?;

    tracing::info!(
        blake3 = %args.blake3,
        peer = %node_id,
        "blob_iroh_download: starting"
    );

    // register a cancel flag so `blob_iroh_download_cancel` can abort this download.
    // the guard removes the entry from the registry on ALL exit paths.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut map = DOWNLOAD_CANCELS
            .lock()
            .map_err(|_| DispatchError::Stream("cancel registry poisoned".to_string()))?;
        map.insert(args.blake3.clone(), Arc::clone(&cancel_flag));
    }
    let _cancel_guard = DownloadCancelGuard(args.blake3.clone());

    // register the hash as in-flight so the gc protect callback keeps it alive
    // until we have finished ingesting it into blobz. guard removes on all exits.
    {
        if let Ok(mut inf) = state.storage.in_flight.lock() {
            inf.insert(hash);
        }
    }
    let _in_flight_guard = BlobsInFlightGuard {
        set: Arc::clone(&state.storage.in_flight),
        hash,
    };

    let (_endpoint, _, _) = ensure_network(state).await?;
    let downloader = state.storage.downloader().ok_or_else(|| {
        DispatchError::Stream("no downloader attached: endpoint not ready".to_string())
    })?;
    let progress = downloader.download(HashAndFormat::raw(hash), [node_id]);
    let mut stream = progress
        .stream()
        .await
        .map_err(|e| DispatchError::Stream(format!("download stream: {e}")))?;

    let mut last_error: Option<String> = None;
    let started = std::time::Instant::now();
    let mut last_log = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();
    let total_size = args.size.unwrap_or(0);
    let mut event_count: u64 = 0;
    while let Some(event) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) {
            tracing::info!(blake3 = %args.blake3, "blob_iroh_download: cancelled");
            return Err(DispatchError::Stream("download cancelled".to_string()));
        }
        event_count += 1;
        match event {
            DownloadProgressItem::Error(e) => {
                last_error = Some(format!("{e:?}"));
                tracing::warn!(blake3 = %args.blake3, error = ?e, "download progress: error");
            }
            DownloadProgressItem::DownloadError => {
                last_error = Some("download error".to_string());
                tracing::warn!(blake3 = %args.blake3, "download progress: DownloadError");
            }
            DownloadProgressItem::Progress(bytes_done) => {
                // real progress to the frontend — throttled to ~4/s. the
                // frontend listens on this event and maps it to the snatch
                // progress callback (same emit/listen pattern as
                // blob_insert_from_path's "blob-insert-progress").
                if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
                    last_emit = std::time::Instant::now();
                    on_progress(bytes_done, total_size);
                }
                if last_log.elapsed() >= std::time::Duration::from_secs(2) {
                    tracing::info!(
                        blake3 = %args.blake3,
                        bytes_done,
                        elapsed_s = started.elapsed().as_secs(),
                        "blob_iroh_download: progress"
                    );
                    last_log = std::time::Instant::now();
                }
            }
            other => {
                // heartbeat at info every ~2s so a hanging/slow relay download
                // is visible without spamming for fast downloads.
                if last_log.elapsed() >= std::time::Duration::from_secs(2) {
                    tracing::info!(
                        blake3 = %args.blake3,
                        events = event_count,
                        elapsed_s = started.elapsed().as_secs(),
                        last = ?other,
                        "blob_iroh_download: progress"
                    );
                    last_log = std::time::Instant::now();
                } else {
                    tracing::debug!(blake3 = %args.blake3, event = ?other, "download progress");
                }
            }
        }
    }
    tracing::info!(
        blake3 = %args.blake3,
        events = event_count,
        elapsed_s = started.elapsed().as_secs(),
        "blob_iroh_download: stream ended"
    );

    if let Some(err) = last_error {
        return Err(DispatchError::Stream(format!("download failed: {err}")));
    }

    // ingest into blobz WITHOUT the bytes ever passing through memory or
    // IPC: stream-export the (verified, complete) blob from the FsStore
    // straight to blobz's canonical content-addressed path, then record
    // metadata trusting the hash the transfer already verified.
    let target = state
        .storage
        .blobz
        .prepare_canonical_path(&args.blake3)
        .await
        .map_err(|e| DispatchError::Stream(format!("prepare blobz path: {e}")))?;
    // TryReference renames the Owned .data file to the blobz canonical path
    // (same filesystem => no copy; EXDEV falls back to copy). the fs store
    // then tracks it as External and keeps serving it for P2P. the .obao4
    // outboard (~0.1% of size) stays in the fs store.
    state
        .storage
        .fs_store
        .blobs()
        .export_with_opts(ExportOptions {
            hash,
            mode: ExportMode::TryReference,
            target: target.clone(),
        })
        .await
        .map_err(|e| DispatchError::Stream(format!("export to blobz path: {e}")))?;
    let blob = state
        .storage
        .blobz
        .register_ingested(
            &args.blake3,
            NewBlobMeta {
                filename: args.filename,
                mime: args.mime,
                ..Default::default()
            },
        )
        .await?;

    tracing::info!(
        blake3 = %args.blake3,
        size = blob.size,
        elapsed_s = started.elapsed().as_secs(),
        "blob_iroh_download: complete (streamed to blobz, no IPC payload)"
    );

    // final 100% progress event so listeners always see completion
    on_progress(blob.size, blob.size);

    // meta only — the bytes live in blobz, reachable via blob_get_path /
    // asset:// for playback. no base64 payload over IPC.
    Ok(json!({
        "meta": BlobDto::from(blob),
    }))
}

#[derive(Debug, Deserialize)]
struct BlobIrohDownloadCancelArgs {
    /// blake3 hex hash of the in-flight download to cancel.
    blake3: String,
}

/// signal an in-flight `blob_iroh_download` to stop after its current event.
///
/// sets the cancel flag registered by the download loop. the partial blob
/// stays in the FsStore — a re-dispatch of `blob_iroh_download` later will
/// resume from where it left off automatically.
async fn blob_iroh_download_cancel(
    args: BlobIrohDownloadCancelArgs,
) -> Result<Value, DispatchError> {
    let cancelled = match DOWNLOAD_CANCELS.lock() {
        Ok(map) => match map.get(&args.blake3) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        },
        Err(_) => false,
    };
    Ok(json!({ "cancelled": cancelled }))
}

#[derive(Debug, Deserialize)]
struct BlobIrohProbeArgs {
    /// peer's iroh node id (hex). same convention as `open_bi`.
    peer_addr: String,
    /// blake3 hex hash of the blob to ask the peer about.
    blake3: String,
}

/// lightweight peer-availability probe over the `freqhole/1` ALPN.
///
/// mirrors tomb's `grimoire::federation::p2p_client::ensure_blob` /
/// `PeerConnection::ensure_blob` — opens a single bi stream, writes one
/// `ensure_blob_request` JSON frame, reads the response, returns whether
/// the peer has the blob ready. doing this in a single rust dispatch
/// avoids the 4-IPC-round-trip race that the JS-side fallback hits when
/// the connection flaps mid-handshake.
async fn blob_iroh_probe(
    args: BlobIrohProbeArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static REQ_ID: AtomicU64 = AtomicU64::new(1);

    if args.blake3.len() != 64 {
        return Err(DispatchError::Stream(format!(
            "expected 64-char blake3 hex, got {}",
            args.blake3.len()
        )));
    }

    let node_id: iroh::PublicKey = args.peer_addr.parse().map_err(|e: iroh::KeyParsingError| {
        DispatchError::Stream(format!("parse peer_addr (node id): {e}"))
    })?;

    let id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    let req = json!({
        "type": "ensure_blob_request",
        "id": id,
        "blake3_hash": args.blake3,
    });
    let req_bytes = serde_json::to_vec(&req)
        .map_err(|e| DispatchError::Stream(format!("serialize ensure_blob_request: {e}")))?;

    tracing::info!(
        peer = %node_id,
        blake3 = %args.blake3,
        id,
        "blob_iroh_probe: connecting"
    );

    let (endpoint, _, _) = ensure_network(state).await?;
    let conn = endpoint
        .connect(iroh::EndpointAddr::from(node_id), b"freqhole/1")
        .await
        .map_err(|e| DispatchError::Stream(format!("connect: {e}")))?;

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| DispatchError::Stream(format!("open_bi: {e}")))?;

    send.write_all(&req_bytes)
        .await
        .map_err(|e| DispatchError::Stream(format!("write: {e}")))?;
    send.finish()
        .map_err(|e| DispatchError::Stream(format!("finish: {e}")))?;
    // wait for the peer to ack our finish before we start reading. without
    // this the peer can observe a "connection lost" mid-`read_to_end` if
    // we drop too early. matches `streams::write_raw_and_finish`.
    let _ = send.stopped().await;

    // 64 KiB cap is plenty for a JSON ensure_blob_response.
    let resp_bytes = recv
        .read_to_end(64 * 1024)
        .await
        .map_err(|e| DispatchError::Stream(format!("read_to_end: {e}")))?;

    let resp: Value = serde_json::from_slice(&resp_bytes)
        .map_err(|e| DispatchError::Stream(format!("parse response: {e}")))?;

    let resp_type = resp.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if resp_type != "ensure_blob_response" {
        return Err(DispatchError::Stream(format!(
            "unexpected response type: {resp_type}"
        )));
    }
    let resp_id = resp.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
    if resp_id != id {
        return Err(DispatchError::Stream(format!(
            "response id mismatch: expected {id}, got {resp_id}"
        )));
    }
    if let Some(err) = resp.get("error").and_then(|v| v.as_str()) {
        tracing::debug!(peer = %node_id, blake3 = %args.blake3, %err, "probe: peer reported error");
        return Ok(json!({ "available": false }));
    }
    let available = resp
        .get("available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    tracing::info!(
        peer = %node_id,
        blake3 = %args.blake3,
        available,
        "blob_iroh_probe: complete"
    );

    Ok(json!({ "available": available }))
}

// ---------------------------------------------------------------------------
// pdf rendering
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PdfRenderPagesArgs {
    /// blake3 hex of the source pdf blob (already inserted via blob_insert).
    blake3: String,
}

// ---------------------------------------------------------------------------
// blob thumbnail
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct BlobThumbnailArgs {
    blake3: String,
    size: Option<u32>,
}

async fn blob_thumbnail(args: BlobThumbnailArgs, state: &AppState) -> Result<Value, DispatchError> {
    let size = args.size.unwrap_or(200);

    let blob = state
        .storage
        .blobz
        .get(&args.blake3)
        .await?
        .ok_or(DispatchError::NotFound)?;

    let path = state.storage.blobz.path_for(&blob);
    let mime = blob.mime.as_deref().unwrap_or("application/octet-stream");

    let result = crate::thumbnail::generate_thumbnail(&path, mime, size)
        .await
        .map_err(|e| {
            DispatchError::Blob(freqhole_reliquary::blobz::BlobStoreError::Io(e.to_string()))
        })?;

    Ok(result)
}

/// render every page of a pdf to per-page png blobs.
///
/// flow:
/// 1. look up the source pdf bytes by blake3 in `blobz`
/// 2. shell out to `magick` to render pages to a temp dir
/// 3. insert each rendered page as its own blob in `blobz`
/// 4. return a list of `{ page_blob_id, page_number, total_pages, blake3,
///    size, mime, filename }` matching the existing `DocumentPageInfo` shape
///
/// renders are deduped at the blob layer: if the same pdf+pages have already
/// been rendered, `blobz.insert` returns the existing rows and we don't
/// re-render. (we do still re-run magick today; future optimization could
/// cache render results keyed by source blake3 to skip the work entirely.)
async fn pdf_render_pages(
    args: PdfRenderPagesArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let source_blob = state
        .storage
        .blobz
        .get(&args.blake3)
        .await?
        .ok_or_else(|| DispatchError::InvalidPayload {
            action: "pdf_render_pages",
            source: serde::de::Error::custom(format!("no blob with blake3 {}", args.blake3)),
        })?;

    let pdf_bytes = tokio::fs::read(state.storage.blobz.path_for(&source_blob))
        .await
        .map_err(|e| {
            DispatchError::Blob(freqhole_reliquary::blobz::BlobStoreError::Io(format!(
                "read pdf bytes: {e}"
            )))
        })?;

    let pages = crate::pdf::render_pdf_pages(&pdf_bytes)
        .await
        .map_err(|e| DispatchError::InvalidPayload {
            action: "pdf_render_pages",
            source: serde::de::Error::custom(format!("pdf render: {e}")),
        })?;

    let total_pages = pages.len() as i64;
    let stem = source_blob
        .filename
        .as_deref()
        .map(|n| {
            n.trim_end_matches(".pdf")
                .trim_end_matches(".PDF")
                .to_string()
        })
        .unwrap_or_else(|| "document".to_string());

    let mut out = Vec::with_capacity(pages.len());
    for (idx, png_bytes) in pages.into_iter().enumerate() {
        let page_number = (idx + 1) as i64;
        let filename = Some(format!("{stem}_page_{page_number:03}.png"));
        let mime = Some("image/png".to_string());
        let blob = state
            .storage
            .blobz
            .insert(
                &png_bytes,
                NewBlobMeta {
                    filename,
                    mime,
                    ..Default::default()
                },
            )
            .await?;
        prewarm_fs_store(state, &blob).await;

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

    Ok(Value::Array(out))
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use freqhole_reliquary::testing::make_local_storage_node;

    /// builds a real, fully offline `AppState` backed by a fresh tempdir —
    /// no iroh endpoint, no tauri runtime. mirrors `lib.rs`'s `build_state()`
    /// construction, minus the network/identity restore step: none of the
    /// blob dispatch handlers under test touch `state.network`.
    async fn make_test_state() -> (AppState, tempfile::TempDir) {
        let (storage, tmp) = make_local_storage_node().await;
        let data_dir = tmp.path().to_path_buf();

        let pool = tumulus::db::open(&data_dir).await.expect("open skein db");
        let haruspex_pool = tumulus::db::open_haruspex(&data_dir)
            .await
            .expect("open haruspex db");
        let friendz_store = friendz::Store::new(haruspex_pool.clone(), pool);
        let userz_dir = userz::Directory::new(haruspex_pool);

        let state = AppState {
            network: Arc::new(Mutex::new(None)),
            data_dir: data_dir.clone(),
            username: "test-user".to_string(),
            storage: Arc::new(storage),
            downloader_cell: Arc::new(std::sync::RwLock::new(None)),
            friendz_store,
            userz: userz_dir,
            process_started_at: Instant::now(),
            app_config_path: data_dir.join("skein-app.toml"),
        };

        (state, tmp)
    }

    #[tokio::test]
    async fn blob_insert_then_get_roundtrips_bytes() {
        let (state, _tmp) = make_test_state().await;
        let original = b"hello from commands.rs test suite";

        let inserted = blob_insert(
            BlobInsertArgs {
                filename: Some("greeting.txt".to_string()),
                mime: Some("text/plain".to_string()),
                data: B64.encode(original),
            },
            &state,
        )
        .await
        .expect("blob_insert");

        let blake3 = inserted["blake3"]
            .as_str()
            .expect("blake3 field")
            .to_string();
        assert_eq!(blake3.len(), 64);
        assert_eq!(inserted["filename"].as_str().unwrap(), "greeting.txt");
        assert_eq!(inserted["size"].as_u64().unwrap(), original.len() as u64);

        let got = blob_get(
            BlobGetArgs {
                blake3: blake3.clone(),
            },
            &state,
        )
        .await
        .expect("blob_get");
        let decoded = B64
            .decode(got["data"].as_str().expect("data field"))
            .expect("base64 decode");
        assert_eq!(decoded, original);
        assert_eq!(got["meta"]["blake3"].as_str().unwrap(), blake3);
    }

    #[tokio::test]
    async fn blob_get_path_points_at_a_real_file_with_matching_bytes() {
        let (state, _tmp) = make_test_state().await;
        let original = b"blob_get_path should return a real on-disk file";

        let inserted = blob_insert(
            BlobInsertArgs {
                filename: Some("video.bin".to_string()),
                mime: Some("application/octet-stream".to_string()),
                data: B64.encode(original),
            },
            &state,
        )
        .await
        .expect("blob_insert");
        let blake3 = inserted["blake3"].as_str().unwrap().to_string();

        let resolved = blob_get_path(BlobGetArgs { blake3 }, &state)
            .await
            .expect("blob_get_path");
        let path = std::path::PathBuf::from(resolved["path"].as_str().expect("path field"));
        assert!(path.exists(), "resolved path should exist on disk");
        let on_disk = tokio::fs::read(&path).await.expect("read resolved path");
        assert_eq!(on_disk, original);
        assert_eq!(
            resolved["mime"].as_str().unwrap(),
            "application/octet-stream"
        );
        assert_eq!(resolved["size"].as_u64().unwrap(), original.len() as u64);
    }

    #[tokio::test]
    async fn blob_list_reflects_inserted_blobs() {
        let (state, _tmp) = make_test_state().await;
        let a = blob_insert(
            BlobInsertArgs {
                filename: Some("a.txt".into()),
                mime: None,
                data: B64.encode(b"aaa"),
            },
            &state,
        )
        .await
        .expect("insert a");
        let b = blob_insert(
            BlobInsertArgs {
                filename: Some("b.txt".into()),
                mime: None,
                data: B64.encode(b"bbb"),
            },
            &state,
        )
        .await
        .expect("insert b");

        let listed = blob_list(BlobListArgs::default(), &state)
            .await
            .expect("blob_list");
        let listed = listed.as_array().expect("list is array");
        let blake3s: Vec<&str> = listed
            .iter()
            .map(|v| v["blake3"].as_str().unwrap())
            .collect();
        assert!(blake3s.contains(&a["blake3"].as_str().unwrap()));
        assert!(blake3s.contains(&b["blake3"].as_str().unwrap()));
    }

    #[tokio::test]
    async fn blob_get_unknown_blake3_returns_not_found() {
        let (state, _tmp) = make_test_state().await;
        let fake_blake3 = "0".repeat(64);
        let err = blob_get(
            BlobGetArgs {
                blake3: fake_blake3,
            },
            &state,
        )
        .await
        .expect_err("unknown blake3 should error");
        assert!(matches!(err, DispatchError::NotFound));
    }

    #[tokio::test]
    async fn blob_iroh_ensure_rejects_wrong_length_blake3() {
        let (state, _tmp) = make_test_state().await;
        let result = blob_iroh_ensure(
            BlobGetArgs {
                blake3: "not-a-real-hash".to_string(),
            },
            &state,
        )
        .await
        .expect("blob_iroh_ensure should not error, only report unavailable");
        assert!(!result["available"].as_bool().unwrap());
        assert!(result["reason"].as_str().unwrap().contains("64-char"));
    }

    #[tokio::test]
    async fn blob_iroh_ensure_reports_unknown_blake3() {
        let (state, _tmp) = make_test_state().await;
        let fake_blake3 = "1".repeat(64);
        let result = blob_iroh_ensure(
            BlobGetArgs {
                blake3: fake_blake3,
            },
            &state,
        )
        .await
        .expect("blob_iroh_ensure");
        assert!(!result["available"].as_bool().unwrap());
        assert_eq!(result["reason"].as_str().unwrap(), "unknown blake3");
    }

    #[tokio::test]
    async fn blob_iroh_ensure_succeeds_after_insert() {
        let (state, _tmp) = make_test_state().await;
        let inserted = blob_insert(
            BlobInsertArgs {
                filename: Some("ensure-me.bin".to_string()),
                mime: None,
                data: B64.encode(b"ensure this blob is importable into the FsStore"),
            },
            &state,
        )
        .await
        .expect("blob_insert");
        let blake3 = inserted["blake3"].as_str().unwrap().to_string();

        let result = blob_iroh_ensure(BlobGetArgs { blake3 }, &state)
            .await
            .expect("blob_iroh_ensure");
        assert!(
            result["available"].as_bool().unwrap(),
            "a freshly inserted blob should be ensurable: {result:?}"
        );
    }

    // -----------------------------------------------------------------
    // blob_insert_from_path_impl / blob_iroh_download_impl
    //
    // both real dispatch handlers only touch `AppHandle` to build an
    // `on_progress` closure that emits a tauri event — the `_impl`
    // functions take that closure directly, so these tests exercise the
    // real upload/download logic with a plain in-memory recorder instead
    // of a tauri runtime.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn blob_insert_from_path_impl_roundtrips_bytes() {
        let (state, tmp) = make_test_state().await;
        let original = b"blob_insert_from_path_impl should stream-hash this file";
        let source_path = tmp.path().join("upload-source.bin");
        tokio::fs::write(&source_path, original)
            .await
            .expect("write source file");

        let progress_calls: Arc<StdMutex<Vec<(u64, u64)>>> = Arc::new(StdMutex::new(Vec::new()));
        let recorder = {
            let calls = Arc::clone(&progress_calls);
            move |bytes_read: u64, total: u64| {
                calls.lock().unwrap().push((bytes_read, total));
            }
        };
        let on_progress: &(dyn Fn(u64, u64) + Send + Sync) = &recorder;

        let result = blob_insert_from_path_impl(
            BlobInsertFromPathArgs {
                local_path: source_path.to_string_lossy().to_string(),
                filename: None,
                mime: Some("application/octet-stream".to_string()),
                upload_id: Some("test-upload-1".to_string()),
            },
            Some(on_progress),
            &state,
        )
        .await
        .expect("blob_insert_from_path_impl");

        // filename derived from the path tail since none was passed.
        assert_eq!(
            result["meta"]["filename"].as_str().unwrap(),
            "upload-source.bin"
        );
        assert_eq!(
            result["meta"]["size"].as_u64().unwrap(),
            original.len() as u64
        );
        let decoded = B64
            .decode(
                result["data"]
                    .as_str()
                    .expect("small file should mirror data"),
            )
            .expect("base64 decode");
        assert_eq!(decoded, original);

        // any progress calls reported should end at the file's real size.
        let calls = progress_calls.lock().unwrap();
        if let Some(&(_, last_total)) = calls.last() {
            assert_eq!(last_total, original.len() as u64);
        }

        // the upload's cancel-flag guard should have cleaned up on completion.
        assert!(UPLOAD_CANCELS
            .lock()
            .unwrap()
            .get("test-upload-1")
            .is_none());
    }

    #[tokio::test]
    async fn blob_insert_from_path_impl_rejects_relative_path() {
        let (state, _tmp) = make_test_state().await;

        let err = blob_insert_from_path_impl(
            BlobInsertFromPathArgs {
                local_path: "relative/path.bin".to_string(),
                filename: None,
                mime: None,
                upload_id: None,
            },
            None,
            &state,
        )
        .await
        .expect_err("relative local_path should be rejected");

        assert!(matches!(err, DispatchError::InvalidPayload { .. }));
        assert!(err.to_string().contains("must be absolute"));
    }

    #[tokio::test]
    async fn blob_iroh_download_impl_rejects_wrong_length_blake3() {
        let (state, _tmp) = make_test_state().await;
        let no_op: &(dyn Fn(u64, u64) + Send + Sync) = &|_, _| {};

        let err = blob_iroh_download_impl(
            BlobIrohDownloadArgs {
                peer_addr: "0".repeat(64),
                blake3: "not-a-real-hash".to_string(),
                filename: None,
                mime: None,
                size: None,
            },
            no_op,
            &state,
        )
        .await
        .expect_err("wrong-length blake3 should be rejected before any network use");

        assert!(err.to_string().contains("64-char"));
    }

    #[tokio::test]
    async fn blob_iroh_download_impl_rejects_unparseable_peer_addr() {
        let (state, _tmp) = make_test_state().await;
        let no_op: &(dyn Fn(u64, u64) + Send + Sync) = &|_, _| {};

        let err = blob_iroh_download_impl(
            BlobIrohDownloadArgs {
                peer_addr: "not-a-valid-node-id".to_string(),
                blake3: "1".repeat(64),
                filename: None,
                mime: None,
                size: None,
            },
            no_op,
            &state,
        )
        .await
        .expect_err("unparseable peer_addr should be rejected before any network use");

        assert!(err.to_string().contains("parse peer_addr"));
    }
}
