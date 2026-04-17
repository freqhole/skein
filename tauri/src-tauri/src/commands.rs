//! skein tauri IPC commands.
//!
//! phase-1 surface: node identity, status, friend management, blob listing.
//! canvas invites, gossip, and p2p messaging come later.

use std::time::Instant;

use reliquary::{blobz, friendz, service::ServiceHandle};
use serde::{Deserialize, Serialize};
use tauri::State;

/// shared state injected into tauri::Builder.
pub struct AppState {
    pub service: ServiceHandle,
    pub started_at: Instant,
}

// ---------------------------------------------------------------------------
// return shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub node_id: String,
    pub friend_count: usize,
    pub uptime_s: u64,
}

#[derive(Debug, Serialize)]
pub struct FriendDto {
    pub friend_node_id: String,
    pub status: String,
    pub narthex_doc_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
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
pub struct BlobDto {
    pub blake3: String,
    pub iroh_hash: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size: i64,
    pub created_at: i64,
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

#[derive(Debug, Deserialize)]
pub struct BlobListArgs {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn skein_node_id(state: State<'_, AppState>) -> String {
    state.service.node_id().to_string()
}

#[tauri::command]
pub async fn skein_status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    let friends = state
        .service
        .friendz_store()
        .list(false)
        .await
        .map_err(|e| e.to_string())?;
    Ok(StatusResponse {
        node_id: state.service.node_id().to_string(),
        friend_count: friends.len(),
        uptime_s: state.started_at.elapsed().as_secs(),
    })
}

#[tauri::command]
pub async fn skein_friend_add(
    node_id: String,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let status = match status.as_deref() {
        Some("pending") => friendz::FriendStatus::Pending,
        Some("blocked") => friendz::FriendStatus::Blocked,
        _ => friendz::FriendStatus::Accepted,
    };
    state
        .service
        .friendz_store()
        .upsert(&node_id, status, None)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn skein_friend_list(state: State<'_, AppState>) -> Result<Vec<FriendDto>, String> {
    let friends = state
        .service
        .friendz_store()
        .list(false)
        .await
        .map_err(|e| e.to_string())?;
    Ok(friends.into_iter().map(FriendDto::from).collect())
}

#[tauri::command]
pub async fn blob_list(
    args: BlobListArgs,
    state: State<'_, AppState>,
) -> Result<Vec<BlobDto>, String> {
    let blobs = state
        .service
        .blobz()
        .list(args.limit.unwrap_or(200), args.offset.unwrap_or(0))
        .await
        .map_err(|e| e.to_string())?;
    Ok(blobs.into_iter().map(BlobDto::from).collect())
}
