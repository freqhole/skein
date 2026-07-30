//! minimal live terminal dashboard for a running hub.
//!
//! renders a plain-ANSI status screen (no TUI crate, no raw mode, no input
//! handling): a blocky "TUMULUS" banner, this hub's node id and relay
//! connection status, friend/canvas/blob counts and storage usage, and any
//! pending knock requests (friend requests + canvas access requests).
//! redraws in place on a fixed interval rather than scrolling, so a
//! long-running headless hub has something more useful to glance at than a
//! wall of raw log lines.
//!
//! only meant to run when logs are going to a file instead of stdout (see
//! `main.rs`'s `--log-stdout` flag) - the terminal is otherwise free for
//! this, and printing both at once would just interleave garbage.

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::RelayStatus;
use iroh::Watcher;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::friendz::{self, Direction};
use crate::hub_repo::HubRepo;
use crate::protocol::hub_admin::{disk_space, list_pending_knocks};
use crate::snatch::HubSnatchEngine;
use crate::userz;
use freqhole_reliquary::blobz::BlobStore;

const REFRESH_INTERVAL: Duration = Duration::from_millis(1500);

/// blocky "TUMULUS" banner, printed once at the top of every redraw.
const BANNER: &str = "\
█████ █   █ █   █ █   █ █     █   █ █████
  █   █   █ ██ ██ █   █ █     █   █ █    
  █   █   █ █ █ █ █   █ █     █   █ █████
  █   █   █ █   █ █   █ █     █   █     █
  █   █████ █   █ █████ █████ █████ █████";
/// ANSI magenta foreground, reset at the end - wraps the banner only.
const MAGENTA: &str = "\x1b[35m";
const RESET: &str = "\x1b[0m";

/// everything the dashboard needs to read live state - all cheaply
/// cloneable handles already owned by `HubPeerService`.
pub struct DashboardContext {
    pub node_id: String,
    pub endpoint: iroh::Endpoint,
    pub hub_repo: HubRepo,
    pub friendz_store: friendz::Store,
    pub userz: userz::Directory,
    pub blobz: Arc<dyn BlobStore>,
    pub canvas_doc_ids: Arc<Mutex<HashSet<String>>>,
    pub data_dir: PathBuf,
    pub(crate) engine: Arc<HubSnatchEngine>,
}

/// drive the dashboard until `cancel` fires.
pub async fn run(ctx: DashboardContext, cancel: CancellationToken) {
    let mut relay_watcher = ctx.endpoint.home_relay_status();

    loop {
        let frame = render_frame(&ctx, &mut relay_watcher).await;
        // clear screen + home cursor, then draw - redraws in place rather
        // than scrolling.
        print!("\x1b[2J\x1b[H{frame}");
        let _ = std::io::stdout().flush();

        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(REFRESH_INTERVAL) => {}
        }
    }
}

async fn render_frame(
    ctx: &DashboardContext,
    relay_watcher: &mut impl Watcher<Value = Vec<RelayStatus>>,
) -> String {
    let mut out = String::new();
    out.push_str("\n");
    out.push_str(MAGENTA);
    out.push_str(BANNER);
    out.push_str(RESET);
    out.push_str("\n\n");

    let relay_status = relay_watcher.get();
    let endpoint_status = if relay_status.is_empty() {
        "connecting..."
    } else if relay_status.iter().any(RelayStatus::is_connected) {
        "online"
    } else {
        "offline"
    };
    out.push_str(&format!("node id:  {}\n", ctx.node_id));
    out.push_str(&format!("status:   {endpoint_status}\n"));
    out.push_str(&format!("data dir: {}\n\n", ctx.data_dir.display()));

    let friend_count = ctx
        .friendz_store
        .list(true)
        .await
        .map(|f| f.len())
        .unwrap_or(0);
    let canvas_count = ctx.canvas_doc_ids.lock().await.len();
    let (blob_count, blob_bytes) = match ctx.blobz.total_usage().await {
        Ok(usage) => (usage.count, usage.total_bytes),
        Err(_) => (0, 0),
    };
    // stat `data_dir` rather than `blob_dir` - `blob_dir`'s `blob-files`
    // subdirectory is only created lazily on the first blob insert (see
    // `freqhole_reliquary::blobz`), so a fresh hub with zero blobs would
    // otherwise always report "unavailable". `data_dir` is created at
    // startup and lives on the same filesystem.
    let (disk_available, disk_total) = disk_space(&ctx.data_dir).unzip();

    out.push_str(&format!("friends:  {friend_count}\n"));
    out.push_str(&format!("canvases: {canvas_count}\n"));
    out.push_str(&format!(
        "blobs:    {blob_count} ({})\n",
        format_bytes(blob_bytes)
    ));
    match (disk_available, disk_total) {
        (Some(available), Some(total)) => {
            out.push_str(&format!(
                "storage:  {} used / {} available\n",
                format_bytes(total.saturating_sub(available)),
                format_bytes(available)
            ));
        }
        _ => out.push_str("storage:  unavailable\n"),
    }
    out.push('\n');

    // online friends - `connected_peer_ids` includes any live connection
    // (a peer mid-knock/invite flow may connect before being a friend), so
    // filter down to actual friendz relationships before labeling this
    // "friends".
    let mut online_friends = Vec::new();
    for peer_id in ctx.hub_repo.connected_peer_ids().await {
        if ctx.friendz_store.is_friend(&peer_id).await {
            online_friends.push(display_name_for(&ctx.userz, &peer_id).await);
        }
    }
    if online_friends.is_empty() {
        out.push_str("online friends: none\n\n");
    } else {
        out.push_str(&format!(
            "online friends ({}): {}\n\n",
            online_friends.len(),
            online_friends.join(", ")
        ));
    }

    let active_downloads = ctx.engine.active_downloads();
    if active_downloads.is_empty() {
        out.push_str("downloads: none in progress\n\n");
    } else {
        out.push_str(&format!(
            "downloads: {} in progress\n",
            active_downloads.len()
        ));
        for download in &active_downloads {
            let from = display_name_for(&ctx.userz, &download.peer).await;
            let elapsed = download.started_at.elapsed().as_secs();
            out.push_str(&format!(
                "  - {} from {from} ({elapsed}s)\n",
                download.filename
            ));
        }
        out.push('\n');
    }

    let pending_friend_requests = ctx
        .friendz_store
        .list_pending(Some(Direction::Inbound))
        .await
        .unwrap_or_default();
    let pending_knocks = list_pending_knocks(&ctx.hub_repo).await;

    let request_total = pending_friend_requests.len() + pending_knocks.len();
    if request_total == 0 {
        out.push_str("pending requests: none\n");
    } else {
        out.push_str(&format!("pending requests: {request_total}\n"));
        for req in &pending_friend_requests {
            out.push_str(&format!(
                "  - friend request from {}\n",
                display_name_for(&ctx.userz, &req.friend_node_id).await
            ));
        }
        for knock in &pending_knocks {
            let who = if knock.requester_username.is_empty() {
                short_node_id(&knock.requester_node_id)
            } else {
                knock.requester_username.clone()
            };
            let canvas_label = ctx
                .hub_repo
                .canvas_title(&knock.canvas_doc_id)
                .await
                .unwrap_or_else(|| short_node_id(&knock.canvas_doc_id));
            out.push_str(&format!(
                "  - canvas request from {who} (canvas {canvas_label})\n"
            ));
        }
    }

    out
}

/// resolve a peer's display name via `userz`, falling back to a shortened
/// node id when no username is on record.
async fn display_name_for(userz: &userz::Directory, node_id: &str) -> String {
    let record = userz.get(node_id).await;
    // TEMP DEBUG — remove once the "weird username" report is root-caused.
    // {:?} on the whole record shows display_name *and* alias together, so
    // we can tell whether a stale/wrong alias (not display_name) is what's
    // actually surfacing.
    tracing::info!(
        peer = %node_id,
        record = ?record,
        "TEMP display_name_for resolved record"
    );
    match record {
        Ok(Some(record)) => match record.display_name {
            Some(name) if !name.is_empty() => name,
            _ => short_node_id(node_id),
        },
        _ => short_node_id(node_id),
    }
}

/// shorten a node/doc id for compact display: first 8 + last 4 hex chars.
fn short_node_id(id: &str) -> String {
    if id.len() <= 16 {
        return id.to_string();
    }
    format!("{}…{}", &id[..8], &id[id.len() - 4..])
}

/// render a byte count as a human-readable KB/MB/GB string.
fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit_idx = 0;
    while value >= 1024.0 && unit_idx < UNITS.len() - 1 {
        value /= 1024.0;
        unit_idx += 1;
    }
    if unit_idx == 0 {
        format!("{bytes} {}", UNITS[unit_idx])
    } else {
        format!("{value:.1} {}", UNITS[unit_idx])
    }
}
