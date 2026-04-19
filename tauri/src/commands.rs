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
use tauri::{AppHandle, Emitter, State};
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
    pub streams: Arc<crate::streams::StreamRegistry>,
    /// iroh-blobs FsStore — leaked at boot so `BlobsProtocol` (registered on
    /// `iroh-blobs/4` by [`crate::streams::StreamRegistry::start_with_blobs`])
    /// can hold a `'static` reference. used by the `blob_iroh_ensure`
    /// dispatch action to import blob bytes from `blobz` on demand.
    pub fs_store: &'static iroh_blobs::store::fs::FsStore,
}

/// bookkeeping for a running hub. kept in `Option<_>` — `Some` means the
/// hub is up, `None` means it's stopped.
pub struct HubState {
    pub cancel: CancellationToken,
    pub join: tokio::task::JoinHandle<()>,
    pub started_at: Instant,
}

/// persistent app config — written to `<data_dir>/skein-app.toml`. tracks
/// hub auto-start plus the user's social settings (visibility / who can send
/// friend requests). add fields with `#[serde(default)]` so older toml files
/// still load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub hub_enabled: bool,
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
            hub_enabled: false,
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
enum DispatchError {
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
    _app: &AppHandle,
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
            blob_insert_from_path(decode("blob_insert_from_path", payload)?, state).await
        }
        "blob_iroh_ensure" => {
            blob_iroh_ensure(decode("blob_iroh_ensure", payload)?, state).await
        }
        "blob_iroh_download" => {
            blob_iroh_download(decode("blob_iroh_download", payload)?, state).await
        }
        "blob_iroh_probe" => {
            blob_iroh_probe(decode("blob_iroh_probe", payload)?, state).await
        }

        // hub control
        "hub_start" => hub_start_inner(state).await,
        "hub_stop" => hub_stop_inner(state).await,
        "hub_status" => hub_status(state).await,

        // bi-stream IPC
        "open_bi" => crate::streams::open_bi(
            decode("open_bi", payload)?,
            &state.endpoint,
            &state.streams,
        )
        .await
        .map_err(stream_err),
        "accept_stream" => crate::streams::accept_stream(&state.streams)
            .await
            .map_err(stream_err),
        "write_message" => {
            crate::streams::write_message(decode("write_message", payload)?, &state.streams)
                .await
                .map_err(stream_err)
        }
        "read_message" => {
            crate::streams::read_message(decode("read_message", payload)?, &state.streams)
                .await
                .map_err(stream_err)
        }
        "close_stream" => {
            crate::streams::close_stream(decode("close_stream", payload)?, &state.streams)
                .await
                .map_err(stream_err)
        }
        "write_raw_and_finish" => {
            crate::streams::write_raw_and_finish(
                decode("write_raw_and_finish", payload)?,
                &state.streams,
            )
            .await
            .map_err(stream_err)
        }
        "read_to_end" => {
            crate::streams::read_to_end(decode("read_to_end", payload)?, &state.streams)
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
// social doc — wires SqliteSocialDoc on the frontend to the friendz/userz
// stores. snapshot reads pull from sqlite; mutation handlers write via the
// existing reliquary primitives. groups are derived from friend.group_name
// (no separate table). settings persist in app_config.toml.
// ---------------------------------------------------------------------------

async fn social_get_state(state: &AppState) -> Result<Value, DispatchError> {
    let cfg = AppConfig::load(&state.app_config_path);
    let me = state.userz.get_self().await?;

    let profile = json!({
        "user_id": state.node_id,
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
        "node_id": state.node_id,
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
                    "user_id": state.node_id,
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
                "user_id": state.node_id,
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
    state
        .userz
        .upsert_self_full(
            &state.node_id,
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

/// resolve a blob id (blake3) to its on-disk filesystem path so the frontend
/// can hand it to tauri's asset:// protocol for native streaming. avoids
/// base64-roundtripping the entire file for `<video>` / `<audio>` previews.
async fn blob_get_path(args: BlobGetArgs, state: &AppState) -> Result<Value, DispatchError> {
    let Some(meta) = state.blobz.get(&args.blake3).await? else {
        return Err(DispatchError::NotFound);
    };
    let path = state.blobz.path_for(&meta);
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
async fn prewarm_fs_store(state: &AppState, blob: &blobz::BlobRef) {
    let path = state.blobz.path_for(blob);
    if !path.exists() {
        tracing::warn!(blake3 = %blob.blake3, "prewarm: blob file missing on disk");
        return;
    }
    match state.fs_store.blobs().add_path(path).await {
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
/// called from the frontend's `handleEnsureBlob` over `skein/1`: when a
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
/// when the blob is unknown / missing on disk / fails to import. mirrors
/// reliquary's [`reliquary::protocol::blob_proxy::BlobProxyHandler::ensure`]
/// shape.
async fn blob_iroh_ensure(
    args: BlobGetArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    if args.blake3.len() != 64 {
        return Ok(json!({
            "available": false,
            "reason": format!("expected 64-char blake3 hex, got {}", args.blake3.len()),
        }));
    }
    let meta = match state.blobz.get(&args.blake3).await? {
        Some(m) => m,
        None => return Ok(json!({ "available": false, "reason": "unknown blake3" })),
    };
    let path = state.blobz.path_for(&meta);
    if !path.exists() {
        return Ok(json!({ "available": false, "reason": "blob file missing on disk" }));
    }
    // import by reference into the iroh-blobs store. iroh-blobs computes
    // blake3 internally and dedupes on hash, so re-imports are cheap (only
    // the outboard metadata is recomputed).
    match state.fs_store.blobs().add_path(path).await {
        Ok(_tag) => Ok(json!({ "available": true })),
        Err(e) => Ok(json!({
            "available": false,
            "reason": format!("FsStore import failed: {e}"),
        })),
    }
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
    /// optional iroh hash override. defaults to mirroring the blake3.
    iroh_hash: Option<String>,
}

async fn blob_insert_from_path(
    args: BlobInsertFromPathArgs,
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

    let bytes = tokio::fs::read(&path).await.map_err(|e| {
        DispatchError::Blob(blobz::BlobError::Io(std::io::Error::new(
            e.kind(),
            format!("read {}: {}", path.display(), e),
        )))
    })?;

    // derive a filename from the path tail when caller didn't pass one.
    let filename = args.filename.or_else(|| {
        path.file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    });

    let blake3_hex = blake3::hash(&bytes).to_hex().to_string();
    let iroh_hash = args.iroh_hash.unwrap_or_else(|| blake3_hex.clone());
    let blob = state
        .blobz
        .insert(iroh_hash, filename, args.mime, &bytes)
        .await?;
    prewarm_fs_store(state, &blob).await;

    // return both the row metadata and the raw bytes so the JS caller can
    // mirror the file into IndexedDB / OPFS for its existing display paths
    // without a second filesystem read.
    Ok(json!({
        "meta": BlobDto::from(blob),
        "data": B64.encode(&bytes),
    }))
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
}

/// download a blob from a peer over iroh-blobs verified transfer, ingest
/// it into the local `blobz` store (and FsStore via prewarm), and return
/// the blob row + base64 bytes so the JS caller can mirror it into OPFS /
/// IndexedDB the same way `blob_insert_from_path` does.
///
/// mirrors tomb's `reliquary::snatch::BlobSnatcher::download_blob` — the
/// canonical native-rust impl of the iroh-blobs consumer side.
async fn blob_iroh_download(
    args: BlobIrohDownloadArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    use iroh_blobs::api::downloader::{DownloadProgressItem, Downloader};
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

    let node_id: iroh::PublicKey = args
        .peer_addr
        .parse()
        .map_err(|e: iroh::KeyParsingError| {
            DispatchError::Stream(format!("parse peer_addr (node id): {e}"))
        })?;

    tracing::info!(
        blake3 = %args.blake3,
        peer = %node_id,
        "blob_iroh_download: starting"
    );

    let downloader = Downloader::new(state.fs_store, &state.endpoint);
    let progress = downloader.download(HashAndFormat::raw(hash), [node_id]);
    let mut stream = progress
        .stream()
        .await
        .map_err(|e| DispatchError::Stream(format!("download stream: {e}")))?;

    let mut last_error: Option<String> = None;
    let started = std::time::Instant::now();
    let mut last_log = std::time::Instant::now();
    let mut event_count: u64 = 0;
    while let Some(event) = stream.next().await {
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

    let bytes = state
        .fs_store
        .get_bytes(hash)
        .await
        .map_err(|e| DispatchError::Stream(format!("FsStore.get_bytes: {e}")))?;

    tracing::info!(
        blake3 = %args.blake3,
        size = bytes.len(),
        "blob_iroh_download: download complete, ingesting into blobz"
    );

    // ingest into blobz so subsequent `blob_get` / `blob_get_path` succeed
    // and asset:// playback works without a re-download. iroh_hash mirrors
    // blake3 (same as blob_insert when no override given).
    let blob = state
        .blobz
        .insert(
            args.blake3.clone(),
            args.filename,
            args.mime,
            bytes.as_ref(),
        )
        .await?;
    // FsStore is already populated (the download itself wrote it) — no
    // need to re-prewarm.

    Ok(json!({
        "meta": BlobDto::from(blob),
        "data": B64.encode(&bytes),
    }))
}

#[derive(Debug, Deserialize)]
struct BlobIrohProbeArgs {
    /// peer's iroh node id (hex). same convention as `open_bi`.
    peer_addr: String,
    /// blake3 hex hash of the blob to ask the peer about.
    blake3: String,
}

/// lightweight peer-availability probe over the `skein/1` ALPN.
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

    let node_id: iroh::PublicKey = args.peer_addr.parse().map_err(
        |e: iroh::KeyParsingError| {
            DispatchError::Stream(format!("parse peer_addr (node id): {e}"))
        },
    )?;

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

    let conn = state
        .endpoint
        .connect(iroh::EndpointAddr::from(node_id), b"skein/1")
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
/// but not surfaced — persistence is best-effort. preserves the rest of
/// AppConfig (e.g. social settings) by load-modify-save.
fn persist_hub_state(state: &AppState, hub_enabled: bool) {
    let mut cfg = AppConfig::load(&state.app_config_path);
    cfg.hub_enabled = hub_enabled;
    if let Err(e) = cfg.save(&state.app_config_path) {
        tracing::warn!(error = %e, path = ?state.app_config_path, "failed to persist hub state");
    }
}
