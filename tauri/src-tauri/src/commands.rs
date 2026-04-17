//! skein tauri IPC — single `skein_dispatch(action, payload)` entry point.
//!
//! every frontend call routes through here. the action string selects a
//! handler; the payload is decoded into the per-action request type. responses
//! are serialized as `serde_json::Value` so one tauri command covers the
//! entire surface.
//!
//! see [docs/tauri-progress.md](../../../docs/tauri-progress.md) for the
//! current action list and what's stubbed.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use iroh::Endpoint;
use reliquary::{blobz, friendz, service, userz};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::State;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// runtime state for the one-and-only tauri command.
///
/// the endpoint, pool, and stores are always alive — they exist for the
/// lifetime of the tauri process. `hub` is optional and can be toggled on
/// and off at runtime via `hub_start` / `hub_stop`.
pub struct AppState {
    pub endpoint: Endpoint,
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub username: String,
    pub node_id: String,

    pub blobz: blobz::Store,
    pub friendz_store: friendz::Store,
    pub userz: userz::Directory,

    pub process_started_at: Instant,
    pub app_config_path: PathBuf,

    pub hub: Arc<Mutex<Option<HubState>>>,
}

/// bookkeeping for a running hub. kept in `Option<_>` — `Some` means the
/// hub is up, `None` means it's stopped.
pub struct HubState {
    pub cancel: CancellationToken,
    pub join: tokio::task::JoinHandle<()>,
    pub started_at: Instant,
}

/// persistent app config — written to `<data_dir>/skein-app.toml`. currently
/// just tracks whether the user wants the hub to start automatically.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub hub_enabled: bool,
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
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let payload = payload.unwrap_or(Value::Null);
    dispatch(&action, payload, state.inner())
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, thiserror::Error)]
enum DispatchError {
    #[error("unknown action: {0}")]
    UnknownAction(String),
    #[error("invalid payload for {action}: {source}")]
    InvalidPayload {
        action: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),
    #[error("hub: {0}")]
    Hub(String),
    #[error("blob: {0}")]
    Blob(#[from] blobz::BlobError),
    #[error("friend: {0}")]
    Friend(#[from] friendz::FriendError),
    #[error("user: {0}")]
    User(#[from] userz::UserError),
    #[error("not found")]
    NotFound,
}

async fn dispatch(
    action: &str,
    payload: Value,
    state: &AppState,
) -> Result<Value, DispatchError> {
    match action {
        // identity / status
        "get_node_id" => Ok(json!({ "node_id": state.node_id })),
        "status" => status(state).await,

        // friends
        "friend_add" => friend_add(decode("friend_add", payload)?, state).await,
        "friend_list" => friend_list(state).await,
        "friend_remove" => friend_remove(decode("friend_remove", payload)?, state).await,

        // blobs
        "blob_list" => blob_list(decode_or_default(payload), state).await,
        "blob_get" => blob_get(decode("blob_get", payload)?, state).await,
        "blob_insert" => blob_insert(decode("blob_insert", payload)?, state).await,

        // hub control
        "hub_start" => hub_start_inner(state).await,
        "hub_stop" => hub_stop_inner(state).await,
        "hub_status" => hub_status(state).await,

        // bi-stream IPC — stubbed pending iteration 2
        "open_bi" | "accept_stream" | "write_message" | "read_message"
        | "close_stream" => Err(DispatchError::NotImplemented(
            "bi-stream IPC ships in iteration 2",
        )),

        other => Err(DispatchError::UnknownAction(other.to_string())),
    }
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
    hub_running: bool,
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
    size: i64,
    created_at: i64,
}

impl From<blobz::BlobRef> for BlobDto {
    fn from(b: blobz::BlobRef) -> Self {
        Self {
            blake3: b.blake3,
            iroh_hash: b.iroh_hash,
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
    let hub_running = state.hub.lock().await.is_some();
    let resp = StatusResponse {
        node_id: state.node_id.clone(),
        friend_count: friends.len(),
        uptime_s: state.process_started_at.elapsed().as_secs(),
        hub_running,
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

async fn friend_remove(
    args: FriendRemoveArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    state.friendz_store.delete(&args.node_id).await?;
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
    let blobs = state
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
    let Some(meta) = state.blobz.get(&args.blake3).await? else {
        return Err(DispatchError::NotFound);
    };
    let bytes = state
        .blobz
        .read_bytes(&args.blake3)
        .await?
        .ok_or(DispatchError::NotFound)?;
    Ok(json!({
        "meta": BlobDto::from(meta),
        "data": B64.encode(&bytes),
    }))
}

#[derive(Debug, Deserialize)]
struct BlobInsertArgs {
    /// optional iroh hash (if the blob is also being shared via iroh-blobs).
    /// for purely local blobs, callers can omit and the rust side mirrors
    /// the blake3.
    iroh_hash: Option<String>,
    filename: Option<String>,
    mime: Option<String>,
    /// base64-encoded bytes.
    data: String,
}

async fn blob_insert(
    args: BlobInsertArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    let bytes = B64.decode(args.data.as_bytes()).map_err(|e| {
        DispatchError::InvalidPayload {
            action: "blob_insert",
            source: serde::de::Error::custom(format!("base64 decode: {e}")),
        }
    })?;
    let blake3_hex = blake3::hash(&bytes).to_hex().to_string();
    let iroh_hash = args.iroh_hash.unwrap_or_else(|| blake3_hex.clone());
    let blob = state
        .blobz
        .insert(iroh_hash, args.filename, args.mime, &bytes)
        .await?;
    Ok(serde_json::to_value(BlobDto::from(blob)).expect("blob insert serialize"))
}

// ---------------------------------------------------------------------------
// hub control
// ---------------------------------------------------------------------------

/// start the hub. noop (with ok response) if already running. used both
/// from the dispatch action and from boot.
pub async fn hub_start(state: &AppState) -> Result<Value, String> {
    hub_start_inner(state).await.map_err(|e| e.to_string())
}

async fn hub_start_inner(state: &AppState) -> Result<Value, DispatchError> {
    let mut slot = state.hub.lock().await;
    if slot.is_some() {
        return Ok(json!({ "running": true, "already_running": true }));
    }

    let svc = service::Service::start(
        state.endpoint.clone(),
        state.pool.clone(),
        service::ServiceConfig {
            data_dir: state.data_dir.clone(),
            username: state.username.clone(),
            bio: String::new(),
            avatar_path: None,
        },
    )
    .await
    .map_err(|e| DispatchError::Hub(format!("service start: {e}")))?;

    let cancel = CancellationToken::new();
    let run_cancel = cancel.clone();
    let join = tokio::spawn(async move {
        svc.run_keep_endpoint(run_cancel).await;
    });
    let started_at = Instant::now();
    *slot = Some(HubState {
        cancel,
        join,
        started_at,
    });
    drop(slot);

    persist_hub_state(state, true);
    Ok(json!({ "running": true, "already_running": false }))
}

/// stop the hub. noop if already stopped.
async fn hub_stop_inner(state: &AppState) -> Result<Value, DispatchError> {
    let taken = state.hub.lock().await.take();
    let Some(hub) = taken else {
        return Ok(json!({ "running": false, "already_stopped": true }));
    };
    hub.cancel.cancel();
    // run_keep_endpoint shuts down the router internally; await the spawn.
    if let Err(e) = hub.join.await {
        tracing::warn!(error = ?e, "hub run task join error");
    }
    persist_hub_state(state, false);
    Ok(json!({ "running": false, "already_stopped": false }))
}

async fn hub_status(state: &AppState) -> Result<Value, DispatchError> {
    let slot = state.hub.lock().await;
    match &*slot {
        Some(hub) => Ok(json!({
            "running": true,
            "node_id": state.node_id,
            "uptime_s": hub.started_at.elapsed().as_secs(),
        })),
        None => Ok(json!({ "running": false, "node_id": state.node_id })),
    }
}

/// write `hub_enabled` into `<data_dir>/skein-app.toml`. errors are logged
/// but not surfaced — persistence is best-effort.
fn persist_hub_state(state: &AppState, hub_enabled: bool) {
    let cfg = AppConfig { hub_enabled };
    if let Err(e) = cfg.save(&state.app_config_path) {
        tracing::warn!(error = %e, path = ?state.app_config_path, "failed to persist hub state");
    }
}
