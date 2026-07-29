//! hub_repo — custom automerge sync handler for JS automerge-repo messages.
//!
//! replaces samod for processing incoming sync messages from the JS
//! automerge-repo v2.x client. the JS side sends CBOR-encoded messages over
//! iroh QUIC streams with 4-byte big-endian length-delimited framing.
//!
//! message shapes (CBOR maps):
//!
//! - `sync`:            `{ type, senderId, targetId, documentId, data }`
//! - `request`:         `{ type, senderId, targetId, documentId, data }`
//! - `ephemeral`:       `{ type, senderId, targetId, documentId, data, count, sessionId }`
//! - `doc-unavailable`: `{ type, senderId, targetId, documentId }`
//!
//! the `data` field contains raw automerge sync message bytes. framing matches
//! `tokio_util::codec::LengthDelimitedCodec` defaults (`[4-byte BE len][payload]`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use automerge::sync::SyncDoc;
use tokio::sync::{broadcast, RwLock};
use tokio_util::sync::CancellationToken;

// ---------------------------------------------------------------------------
// CBOR message types (incoming)
// ---------------------------------------------------------------------------

/// top-level envelope for all messages arriving from JS automerge-repo.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RepoMessage {
    Sync(SyncMessage),
    Request(SyncMessage),
    Ephemeral(EphemeralMessage),
    DocUnavailable(DocUnavailableMessage),
}

/// payload for `sync` and `request` message types.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMessage {
    pub sender_id: String,
    pub target_id: String,
    pub document_id: String,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

/// payload for `ephemeral` messages (currently ignored by the hub).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralMessage {
    pub sender_id: String,
    pub target_id: String,
    pub document_id: String,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    pub count: u64,
    pub session_id: String,
}

/// payload for `doc-unavailable` messages.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocUnavailableMessage {
    pub sender_id: String,
    pub target_id: String,
    pub document_id: String,
}

// ---------------------------------------------------------------------------
// CBOR message types (outgoing)
// ---------------------------------------------------------------------------

/// sync response sent back to the JS peer.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub sender_id: String,
    pub target_id: String,
    pub document_id: String,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/// errors specific to hub_repo operations.
#[derive(Debug, thiserror::Error)]
pub enum HubRepoError {
    #[error("storage error: {0}")]
    Storage(#[from] sqlx::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// DocHandle — lightweight synchronized access to an automerge document
// ---------------------------------------------------------------------------

/// lightweight handle for synchronized access to an automerge document.
#[derive(Clone)]
pub struct DocHandle {
    doc_id: String,
    doc: Arc<RwLock<automerge::Automerge>>,
}

impl DocHandle {
    pub fn document_id(&self) -> &str {
        &self.doc_id
    }

    /// synchronous read access to the document (runs closure while holding
    /// read lock). blocks the current thread — call from `spawn_blocking`.
    pub fn with_document<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&automerge::Automerge) -> R,
    {
        let doc = self.doc.blocking_read();
        f(&doc)
    }

    /// synchronous mutable access for transact operations. blocks the current
    /// thread — call from `spawn_blocking`.
    pub fn with_document_mut<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut automerge::Automerge) -> R,
    {
        let mut doc = self.doc.blocking_write();
        f(&mut doc)
    }
}

// ---------------------------------------------------------------------------
// PeerInfo
// ---------------------------------------------------------------------------

/// metadata about a currently connected peer.
#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub peer_id: String,
    pub connected_at: std::time::Instant,
    /// signals `handle_connection`'s read loop to stop and close the stream.
    /// cancelled by [`HubRepo::cancel_peer`] when something revokes this
    /// peer's access (e.g. a `friendz` row being blocked/deleted) while the
    /// connection is still open. see the `HubRepo::cancel_peer` doc comment
    /// for the full story on who's expected to call it and when.
    pub cancel: CancellationToken,
}

// ---------------------------------------------------------------------------
// HubDocStorage — sqlite persistence for raw automerge doc bytes
// ---------------------------------------------------------------------------

/// sqlite-backed persistence for automerge documents managed by hub_repo.
///
/// uses a `hub_docs` table for document persistence.
#[derive(Clone)]
pub struct HubDocStorage {
    pool: sqlx::SqlitePool,
}

impl HubDocStorage {
    /// create a new storage instance backed by the given sqlite database file.
    ///
    /// creates the database and `hub_docs` table if they don't already exist.
    ///
    /// note: every query in this impl uses the runtime-checked `sqlx::query`/
    /// `sqlx::query_scalar` api rather than the `!` macros. `HubDocStorage`
    /// opens its own separate sqlite file (`db_path`, typically
    /// `<data_dir>/skein-docs.db` - see `service.rs`) and creates its own
    /// `hub_docs`/`hub_canvas_ids` tables here at runtime; these tables are
    /// not part of `reliquary/migrationz/` or the main `skein-hub.db` schema
    /// that our compile-time `DATABASE_URL` (workspace-root
    /// `.cargo/config.toml`) points at, so the macros have no schema to
    /// validate these queries against.
    pub async fn new(db_path: &Path) -> Result<Self, sqlx::Error> {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS hub_docs (\
                doc_id TEXT PRIMARY KEY, \
                data BLOB NOT NULL, \
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))\
            )",
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS hub_canvas_ids (\
                canvas_doc_id TEXT PRIMARY KEY, \
                added_at TEXT NOT NULL DEFAULT (datetime('now'))\
            )",
        )
        .execute(&pool)
        .await?;

        // `removed_at` was added after the table's initial release — check
        // via `PRAGMA table_info` (rather than blindly running `ALTER TABLE
        // ... ADD COLUMN` and swallowing a "duplicate column" error) so a
        // genuinely unexpected migration failure still surfaces instead of
        // being silently discarded. NULL means "actively tracked"; non-NULL
        // means "the hub was removed from this canvas's ACL, but its data
        // is only soft-deleted" — see `soft_remove_canvas_id()`/
        // `restore_canvas_id()`/`purge_canvas_id()` below, and `reliquary
        // maintenance` (main.rs) for the CLI that lists/restores/purges
        // these. not macro-checkable: see `new()`'s doc comment.
        let has_removed_at = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM pragma_table_info('hub_canvas_ids') WHERE name = 'removed_at'",
        )
        .fetch_one(&pool)
        .await?
            > 0;
        if !has_removed_at {
            sqlx::query("ALTER TABLE hub_canvas_ids ADD COLUMN removed_at TEXT")
                .execute(&pool)
                .await?;
        }

        Ok(Self { pool })
    }

    /// load raw automerge bytes for a document.
    ///
    /// not macro-checkable: see `new()`.
    pub async fn load_doc(&self, doc_id: &str) -> Option<Vec<u8>> {
        sqlx::query_scalar::<_, Vec<u8>>("SELECT data FROM hub_docs WHERE doc_id = ?")
            .bind(doc_id)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
    }

    /// persist raw automerge bytes for a document (insert or replace).
    ///
    /// not macro-checkable: see `new()`.
    pub async fn save_doc(&self, doc_id: &str, data: &[u8]) {
        if let Err(e) =
            sqlx::query("INSERT OR REPLACE INTO hub_docs (doc_id, data, updated_at) VALUES (?, ?, datetime('now'))")
                .bind(doc_id)
                .bind(data)
                .execute(&self.pool)
                .await
        {
            tracing::warn!(doc_id, error = %e, "failed to save doc");
        }
    }

    /// permanently delete a document's raw bytes (used by the maintenance
    /// purge path — see `purge_canvas_id()`). not macro-checkable: see `new()`.
    pub async fn delete_doc(&self, doc_id: &str) {
        if let Err(e) = sqlx::query("DELETE FROM hub_docs WHERE doc_id = ?")
            .bind(doc_id)
            .execute(&self.pool)
            .await
        {
            tracing::warn!(doc_id, error = %e, "failed to delete doc");
        }
    }

    /// load all known document IDs (used on startup to reload persisted docs).
    ///
    /// not macro-checkable: see `new()`.
    pub async fn load_all_doc_ids(&self) -> Vec<String> {
        sqlx::query_scalar::<_, String>("SELECT doc_id FROM hub_docs")
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default()
    }

    /// load all persisted, **actively tracked** canvas doc IDs (excludes
    /// soft-deleted ones — see the `removed_at` doc comment on `new()`).
    /// used on startup to decide which canvases to resume gossip
    /// participation for.
    ///
    /// not macro-checkable: see `new()`.
    pub async fn load_canvas_ids(&self) -> Vec<String> {
        sqlx::query_scalar::<_, String>(
            "SELECT canvas_doc_id FROM hub_canvas_ids WHERE removed_at IS NULL",
        )
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default()
    }

    /// persist a canvas doc ID as actively tracked (idempotent). if this
    /// canvas id was previously soft-deleted (`removed_at` set — e.g. the
    /// hub was removed from the canvas and is now being re-invited), this
    /// also clears `removed_at`, reactivating the existing row rather than
    /// leaving it stuck in the "removed" state forever — a real gap
    /// otherwise: `handle_canvas_invite` (hub/canvas.rs) always calls this
    /// unconditionally on every accept, new or repeat, with no separate
    /// "was this previously removed" branch of its own.
    ///
    /// not macro-checkable: see `new()`.
    pub async fn save_canvas_id(&self, canvas_doc_id: &str) {
        if let Err(e) = sqlx::query(
            "INSERT INTO hub_canvas_ids (canvas_doc_id) VALUES (?) \
             ON CONFLICT(canvas_doc_id) DO UPDATE SET removed_at = NULL",
        )
        .bind(canvas_doc_id)
        .execute(&self.pool)
        .await
        {
            tracing::warn!(canvas_doc_id, error = %e, "failed to persist canvas ID");
        }
    }

    /// soft-delete a canvas doc ID — stamps `removed_at`, but keeps the row
    /// (and the canvas's automerge doc in `hub_docs`) intact. used when the
    /// hub is removed from a canvas's ACL (see `hub/messages.rs`'s
    /// `AclChange` handler) instead of the old hard `DELETE`, so the data
    /// survives for a maintenance window (`reliquary maintenance list` /
    /// `restore` / `purge` — see main.rs) rather than vanishing immediately.
    /// no-op (via `INSERT ... ON CONFLICT DO UPDATE`) if the row doesn't
    /// exist yet, which shouldn't normally happen but keeps this safe to
    /// call defensively.
    ///
    /// not macro-checkable: see `new()`.
    pub async fn soft_remove_canvas_id(&self, canvas_doc_id: &str) {
        if let Err(e) = sqlx::query(
            "INSERT INTO hub_canvas_ids (canvas_doc_id, removed_at) VALUES (?, datetime('now')) \
             ON CONFLICT(canvas_doc_id) DO UPDATE SET removed_at = datetime('now')",
        )
        .bind(canvas_doc_id)
        .execute(&self.pool)
        .await
        {
            tracing::warn!(canvas_doc_id, error = %e, "failed to soft-delete canvas ID");
        }
    }

    /// remove a canvas doc ID from persistence (hard delete of the tracking
    /// row only — does NOT touch `hub_docs`). kept for callers that
    /// genuinely want the old hard-delete semantics; `soft_remove_canvas_id`
    /// is what `hub/messages.rs`'s ACL-removed handler uses now.
    ///
    /// not macro-checkable: see `new()`.
    pub async fn remove_canvas_id(&self, canvas_doc_id: &str) {
        if let Err(e) = sqlx::query("DELETE FROM hub_canvas_ids WHERE canvas_doc_id = ?")
            .bind(canvas_doc_id)
            .execute(&self.pool)
            .await
        {
            tracing::warn!(canvas_doc_id, error = %e, "failed to remove canvas ID from storage");
        }
    }

    /// all persisted canvas doc ids, active AND soft-deleted alike — used by
    /// the maintenance purge sweep (`maintenance.rs`) to find every canvas
    /// doc still known to the hub (even ones not yet purged) when checking
    /// whether a blob is still referenced by something other than the
    /// canvas being purged. `load_canvas_ids()` above deliberately excludes
    /// soft-deleted ones (that method is about "what should the hub
    /// actively gossip/sync"); this one is about "what data still exists".
    ///
    /// not macro-checkable: see `new()`.
    pub async fn load_all_tracked_canvas_ids(&self) -> Vec<String> {
        sqlx::query_scalar::<_, String>("SELECT canvas_doc_id FROM hub_canvas_ids")
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default()
    }

    /// number of soft-deleted (`removed_at IS NOT NULL`) canvas ids —
    /// pairs with `load_removed_canvas_ids()` for CLI pagination.
    ///
    /// not macro-checkable: see `new()`.
    pub async fn count_removed_canvas_ids(&self) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM hub_canvas_ids WHERE removed_at IS NOT NULL",
        )
        .fetch_one(&self.pool)
        .await
        .unwrap_or(0)
    }

    /// a page of soft-deleted canvas ids, most-recently-removed first —
    /// used by `reliquary maintenance list` (main.rs) so an admin can page
    /// through a potentially large trash list rather than dumping it all at
    /// once.
    ///
    /// not macro-checkable: see `new()`.
    pub async fn load_removed_canvas_ids(&self, limit: i64, offset: i64) -> Vec<RemovedCanvasRow> {
        sqlx::query_as::<_, RemovedCanvasRow>(
            "SELECT canvas_doc_id, added_at, removed_at FROM hub_canvas_ids \
             WHERE removed_at IS NOT NULL \
             ORDER BY removed_at DESC LIMIT ? OFFSET ?",
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default()
    }

    /// restore (undelete) a soft-deleted canvas id — clears `removed_at` so
    /// it's active again. note: like `reliquary friend remove`/`admin
    /// remove`, this only updates the sqlite row; if a `reliquary serve`
    /// process is currently running against the same data dir, its live
    /// in-memory `canvas_doc_ids` set won't pick this up until it restarts
    /// or the canvas is re-invited through the normal accept flow (which
    /// calls `save_canvas_id`, itself reactivating). returns `true` if a
    /// row was actually updated (i.e. it existed and was removed).
    ///
    /// not macro-checkable: see `new()`.
    pub async fn restore_canvas_id(&self, canvas_doc_id: &str) -> bool {
        match sqlx::query(
            "UPDATE hub_canvas_ids SET removed_at = NULL \
             WHERE canvas_doc_id = ? AND removed_at IS NOT NULL",
        )
        .bind(canvas_doc_id)
        .execute(&self.pool)
        .await
        {
            Ok(result) => result.rows_affected() > 0,
            Err(e) => {
                tracing::warn!(canvas_doc_id, error = %e, "failed to restore canvas ID");
                false
            }
        }
    }

    /// permanently purge a soft-deleted canvas: deletes both the
    /// `hub_canvas_ids` tracking row and the canvas's own automerge bytes
    /// from `hub_docs`. deliberately does NOT purge the canvas's per-widget
    /// docs or any blob files here — see `reliquary maintenance purge`
    /// (main.rs) for the full sweep, which walks the canvas doc's widget
    /// references first (so it can tell which blobs/widget docs are still
    /// referenced by some OTHER still-active canvas before deleting
    /// anything shared). refuses to purge a canvas id that isn't currently
    /// soft-deleted (`removed_at IS NULL` or missing entirely) — purging an
    /// actively-tracked canvas is never the right call from this path,
    /// that's what removing the hub from the canvas's ACL is for. returns
    /// `true` if the row was actually removed.
    ///
    /// not macro-checkable: see `new()`.
    pub async fn purge_canvas_id(&self, canvas_doc_id: &str) -> bool {
        let is_removed = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM hub_canvas_ids WHERE canvas_doc_id = ? AND removed_at IS NOT NULL",
        )
        .bind(canvas_doc_id)
        .fetch_one(&self.pool)
        .await
        .unwrap_or(0)
            > 0;
        if !is_removed {
            return false;
        }

        self.delete_doc(canvas_doc_id).await;

        match sqlx::query("DELETE FROM hub_canvas_ids WHERE canvas_doc_id = ?")
            .bind(canvas_doc_id)
            .execute(&self.pool)
            .await
        {
            Ok(result) => result.rows_affected() > 0,
            Err(e) => {
                tracing::warn!(canvas_doc_id, error = %e, "failed to purge canvas ID");
                false
            }
        }
    }
}

/// a single soft-deleted canvas tracking row, as returned by
/// `HubDocStorage::load_removed_canvas_ids()`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RemovedCanvasRow {
    pub canvas_doc_id: String,
    pub added_at: String,
    pub removed_at: Option<String>,
}

// ---------------------------------------------------------------------------
// HubRepo — the main sync handler
// ---------------------------------------------------------------------------

/// custom automerge sync handler that processes incoming CBOR-encoded messages
/// from JS automerge-repo peers over iroh QUIC streams.
///
/// all fields are wrapped in `Arc` so the struct is cheaply cloneable.
#[derive(Clone)]
pub struct HubRepo {
    /// all automerge documents, keyed by document ID string.
    documents: Arc<RwLock<HashMap<String, Arc<RwLock<automerge::Automerge>>>>>,
    /// per-(peer, document) sync states (ephemeral, not persisted).
    sync_states: Arc<RwLock<HashMap<(String, String), automerge::sync::State>>>,
    /// sqlite storage backend for document persistence.
    storage: Arc<HubDocStorage>,
    /// hub's own peer ID (the iroh node_id hex string).
    peer_id: String,
    /// broadcast channel to notify waiters when a document becomes available
    /// or is updated.
    doc_notify: broadcast::Sender<String>,
    /// currently connected peers.
    connected_peers: Arc<RwLock<HashMap<String, PeerInfo>>>,
}

impl HubRepo {
    /// create a new hub repo, loading any previously persisted documents from
    /// the sqlite database at `db_path`.
    pub async fn new(
        peer_id: String,
        db_path: &Path,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let storage = Arc::new(HubDocStorage::new(db_path).await?);
        let (doc_notify, _) = broadcast::channel(64);

        // reload previously persisted documents
        let documents: Arc<RwLock<HashMap<String, Arc<RwLock<automerge::Automerge>>>>> =
            Arc::new(RwLock::new(HashMap::new()));

        let doc_ids = storage.load_all_doc_ids().await;
        let total = doc_ids.len();
        let mut loaded: usize = 0;
        let mut failed: usize = 0;
        for doc_id in doc_ids {
            if let Some(bytes) = storage.load_doc(&doc_id).await {
                match automerge::Automerge::load(&bytes) {
                    Ok(doc) => {
                        documents
                            .write()
                            .await
                            .insert(doc_id.clone(), Arc::new(RwLock::new(doc)));
                        tracing::debug!(doc_id, "loaded persisted doc");
                        loaded += 1;
                    }
                    Err(e) => {
                        tracing::warn!(doc_id, error = %e, "failed to load persisted doc, skipping");
                        failed += 1;
                    }
                }
            }
        }
        tracing::info!(total, loaded, failed, "loaded persisted docs from storage");

        Ok(Self {
            documents,
            sync_states: Arc::new(RwLock::new(HashMap::new())),
            storage,
            peer_id,
            doc_notify,
            connected_peers: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// find a document by ID. returns `None` if not available locally.
    pub async fn find(&self, doc_id: &str) -> Option<DocHandle> {
        let docs = self.documents.read().await;
        docs.get(doc_id).map(|doc| DocHandle {
            doc_id: doc_id.to_string(),
            doc: Arc::clone(doc),
        })
    }

    /// wait for a document to appear (either already exists or arrives via
    /// sync). returns `None` on timeout.
    pub async fn wait_for_doc(
        &self,
        doc_id: &str,
        timeout: std::time::Duration,
    ) -> Option<DocHandle> {
        // check if already available
        if let Some(handle) = self.find(doc_id).await {
            return Some(handle);
        }

        // subscribe and wait for the target document to arrive
        let mut rx = self.doc_notify.subscribe();
        let target = doc_id.to_string();
        let this = self.clone();

        tokio::time::timeout(timeout, async move {
            loop {
                match rx.recv().await {
                    Ok(id) if id == target => {
                        return this.find(&target).await;
                    }
                    Ok(_) => continue,
                    Err(_) => return None,
                }
            }
        })
        .await
        .ok()
        .flatten()
    }

    /// get or create a document for a given ID. used when we receive sync
    /// messages for a doc we don't have yet.
    async fn get_or_create_doc(&self, doc_id: &str) -> Arc<RwLock<automerge::Automerge>> {
        // fast path: read lock
        {
            let docs = self.documents.read().await;
            if let Some(doc) = docs.get(doc_id) {
                return Arc::clone(doc);
            }
        }

        // slow path: write lock, double-check, then create
        let mut docs = self.documents.write().await;
        if let Some(doc) = docs.get(doc_id) {
            return Arc::clone(doc);
        }

        let doc = Arc::new(RwLock::new(automerge::Automerge::new()));
        docs.insert(doc_id.to_string(), Arc::clone(&doc));
        tracing::info!(doc_id, "created new doc for incoming sync");

        // notify waiters that a new document appeared
        let _ = self.doc_notify.send(doc_id.to_string());
        doc
    }

    /// read a peer's effective canvas role from `.acl[peer_id].role` on an
    /// automerge document.
    ///
    /// mirrors `loam/src/p2p/acl-filtering-network-adapter.ts`'s
    /// `createRepoRoleResolver()` exactly, so the two enforcement points
    /// stay in sync: any entry that's missing, malformed, or not the
    /// literal string `"viewer"` is treated as `"member"` (full read/write)
    /// — including a doc with no `.acl` field at all (pre-ACL canvases, or
    /// non-canvas docs like narthex/social/messagez, which have no acl
    /// field and must keep working exactly as before this gate existed).
    /// deliberately does NOT special-case `"admin"` or any other value —
    /// only `"viewer"` ever changes behavior, same as the JS resolver.
    fn peer_canvas_role(doc: &automerge::Automerge, peer_id: &str) -> String {
        use automerge::ReadDoc;

        let acl_obj = match doc.get(automerge::ROOT, "acl") {
            Ok(Some((automerge::Value::Object(automerge::ObjType::Map), obj))) => obj,
            _ => return "member".to_string(),
        };
        let entry_obj = match doc.get(&acl_obj, peer_id) {
            Ok(Some((automerge::Value::Object(automerge::ObjType::Map), obj))) => obj,
            _ => return "member".to_string(),
        };
        match doc.get(&entry_obj, "role") {
            Ok(Some((v, _))) => v
                .to_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "member".to_string()),
            _ => "member".to_string(),
        }
    }

    /// handle an incoming sync/request message from a peer.
    ///
    /// applies the incoming automerge sync message, generates a response if the
    /// local document has changes to send back, and persists the document
    /// asynchronously.
    ///
    /// enforces per-canvas viewer read-only access centrally, at the hub's
    /// one and only point of applying inbound changes to its own canonical
    /// copy of a doc: a "viewer" peer's incoming changes are stripped
    /// before `receive_sync_message` ever sees them (heads/have/need are
    /// left untouched so the viewer's own reads keep syncing normally) —
    /// same rule `AclFilteringNetworkAdapter` enforces browser-side, see
    /// `peer_canvas_role`'s doc comment. enforcing it here too (not just in
    /// every browser peer) closes a real gap: without this, a viewer's
    /// forbidden edit that reached the hub would get merged into the hub's
    /// own canonical doc and then legitimately re-relayed onward to every
    /// other connected peer as the hub's own change, laundering straight
    /// past each browser's separate, sender-identity-based filter.
    ///
    /// returns the encoded response sync message bytes, or `None` if there is
    /// nothing to send back.
    pub async fn handle_sync_message(
        &self,
        peer_id: &str,
        doc_id: &str,
        sync_message_bytes: &[u8],
    ) -> Option<Vec<u8>> {
        let doc_arc = self.get_or_create_doc(doc_id).await;
        let mut doc = doc_arc.write().await;

        // get or create the sync state for this (peer, document) pair
        let key = (peer_id.to_string(), doc_id.to_string());
        let mut sync_states = self.sync_states.write().await;
        let sync_state = sync_states
            .entry(key)
            .or_insert_with(automerge::sync::State::new);

        // decode the incoming automerge sync message
        let mut incoming = match automerge::sync::Message::decode(sync_message_bytes) {
            Ok(msg) => msg,
            Err(e) => {
                tracing::warn!(
                    peer_id,
                    doc_id,
                    error = %e,
                    "failed to decode automerge sync message"
                );
                return None;
            }
        };

        if !incoming.changes.is_empty() && Self::peer_canvas_role(&doc, peer_id) == "viewer" {
            tracing::info!(
                peer_id,
                doc_id,
                "hub: stripping changes from viewer-role peer before applying sync message"
            );
            incoming.changes = automerge::sync::ChunkList::empty();
        }

        // apply the message to our document
        if let Err(e) = doc.receive_sync_message(sync_state, incoming) {
            tracing::warn!(
                peer_id,
                doc_id,
                error = %e,
                "failed to apply automerge sync message"
            );
            return None;
        }

        // notify waiters on every successful receive (doc may now have content)
        let _ = self.doc_notify.send(doc_id.to_string());

        // generate a response message if we have changes to send back
        let response = doc.generate_sync_message(sync_state);

        // persist the document asynchronously after receiving sync
        let save_bytes = doc.save();
        let storage = Arc::clone(&self.storage);
        let doc_id_owned = doc_id.to_string();
        tokio::spawn(async move {
            storage.save_doc(&doc_id_owned, &save_bytes).await;
        });

        response.map(|msg: automerge::sync::Message| msg.encode())
    }

    /// process a full connection: read length-delimited frames, decode CBOR,
    /// handle sync, and send responses.
    ///
    /// this is the main entry point called when accepting a new peer
    /// connection over iroh QUIC.
    pub async fn handle_connection<S>(&self, peer_id_str: String, stream: S)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        use futures::SinkExt;
        use futures::StreamExt;
        use tokio_util::codec::{Framed, LengthDelimitedCodec};

        // cancellation token for this specific connection. anything holding
        // a `HubRepo` clone can cancel it via `cancel_peer` (e.g. once a
        // peer's `friendz` row is revoked mid-session) to stop this loop and
        // close the stream promptly, instead of leaving it running until the
        // peer disconnects on its own.
        let cancel = CancellationToken::new();

        // track the peer
        {
            let mut peers = self.connected_peers.write().await;
            peers.insert(
                peer_id_str.clone(),
                PeerInfo {
                    peer_id: peer_id_str.clone(),
                    connected_at: std::time::Instant::now(),
                    cancel: cancel.clone(),
                },
            );
        }
        tracing::info!(peer = %peer_id_str, "hub_repo: peer connected");

        // frame the stream with 4-byte big-endian length-delimited codec
        let codec = LengthDelimitedCodec::builder()
            .big_endian()
            .length_field_length(4)
            .new_codec();
        let mut framed = Framed::new(stream, codec);

        let hub_peer_id = self.peer_id.clone();

        // listens for doc changes that happened outside this connection's
        // own request/response cycle (another peer's sync message, or a
        // local-only mutation like `write_self_to_canvas_doc`) so this peer
        // gets pushed anything new for a doc it's already syncing with us —
        // see `notify_doc_changed`'s doc comment for the bug this closes.
        let mut doc_changes = self.doc_notify.subscribe();

        loop {
            enum LoopEvent {
                Frame(Option<Result<bytes::BytesMut, std::io::Error>>),
                DocChanged(String),
            }

            let event = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    tracing::info!(peer = %peer_id_str, "hub_repo: connection cancelled (access revoked)");
                    break;
                }
                next = framed.next() => LoopEvent::Frame(next),
                changed = doc_changes.recv() => {
                    match changed {
                        Ok(doc_id) => LoopEvent::DocChanged(doc_id),
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::debug!(
                                peer = %peer_id_str,
                                skipped,
                                "hub_repo: doc-change notify lagged, some pushes may have been missed \
                                 (the peer's next real sync round-trip will still reconcile)"
                            );
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            // sender side only lives as long as the HubRepo itself —
                            // shouldn't happen while this connection is still up, but
                            // isn't fatal to this connection either way.
                            continue;
                        }
                    }
                }
            };

            let frame = match event {
                LoopEvent::DocChanged(doc_id) => {
                    if let Some(data) = self
                        .generate_outbound_sync_message(&peer_id_str, &doc_id)
                        .await
                    {
                        let response = SyncResponse {
                            msg_type: "sync".to_string(),
                            sender_id: hub_peer_id.clone(),
                            target_id: peer_id_str.clone(),
                            document_id: doc_id.clone(),
                            data,
                        };
                        let mut buf = Vec::new();
                        if let Err(e) = ciborium::into_writer(&response, &mut buf) {
                            tracing::warn!(
                                peer = %peer_id_str,
                                error = %e,
                                "hub_repo: failed to encode CBOR push message"
                            );
                            continue;
                        }
                        if let Err(e) = framed.send(bytes::Bytes::from(buf)).await {
                            tracing::warn!(
                                peer = %peer_id_str,
                                error = %e,
                                "hub_repo: failed to send proactive sync push"
                            );
                            break;
                        }
                        tracing::debug!(
                            peer = %peer_id_str,
                            doc_id = %doc_id,
                            "hub_repo: pushed proactive sync message (doc changed outside request/response cycle)"
                        );
                    }
                    continue;
                }
                LoopEvent::Frame(next) => match next {
                    Some(Ok(frame)) => frame,
                    Some(Err(e)) => {
                        tracing::warn!(peer = %peer_id_str, error = %e, "hub_repo: frame read error");
                        break;
                    }
                    None => {
                        tracing::info!(peer = %peer_id_str, "hub_repo: stream closed");
                        break;
                    }
                },
            };

            // decode CBOR envelope
            let message: RepoMessage = match ciborium::from_reader(frame.as_ref()) {
                Ok(msg) => msg,
                Err(e) => {
                    tracing::warn!(
                        peer = %peer_id_str,
                        error = %e,
                        bytes = frame.len(),
                        "hub_repo: failed to decode CBOR message"
                    );
                    continue;
                }
            };

            match message {
                RepoMessage::Sync(msg) | RepoMessage::Request(msg) => {
                    tracing::debug!(
                        peer = %peer_id_str,
                        doc_id = %msg.document_id,
                        data_len = msg.data.len(),
                        "hub_repo: received sync message"
                    );

                    if let Some(response_bytes) = self
                        .handle_sync_message(&peer_id_str, &msg.document_id, &msg.data)
                        .await
                    {
                        let response = SyncResponse {
                            msg_type: "sync".to_string(),
                            sender_id: hub_peer_id.clone(),
                            target_id: msg.sender_id.clone(),
                            document_id: msg.document_id.clone(),
                            data: response_bytes,
                        };

                        let mut buf = Vec::new();
                        if let Err(e) = ciborium::into_writer(&response, &mut buf) {
                            tracing::warn!(
                                peer = %peer_id_str,
                                error = %e,
                                "hub_repo: failed to encode CBOR response"
                            );
                            continue;
                        }

                        if let Err(e) = framed.send(bytes::Bytes::from(buf)).await {
                            tracing::warn!(
                                peer = %peer_id_str,
                                error = %e,
                                "hub_repo: failed to send sync response"
                            );
                            break;
                        }

                        tracing::debug!(
                            peer = %peer_id_str,
                            doc_id = %msg.document_id,
                            "hub_repo: sent sync response"
                        );
                    }
                }

                RepoMessage::Ephemeral(msg) => {
                    tracing::trace!(
                        peer = %peer_id_str,
                        doc_id = %msg.document_id,
                        count = msg.count,
                        "hub_repo: received ephemeral message (ignored)"
                    );
                }

                RepoMessage::DocUnavailable(msg) => {
                    tracing::info!(
                        peer = %peer_id_str,
                        doc_id = %msg.document_id,
                        "hub_repo: peer says doc unavailable"
                    );
                }
            }
        }

        // untrack the peer and clean up per-peer sync states
        {
            let mut peers = self.connected_peers.write().await;
            peers.remove(&peer_id_str);
        }
        {
            let mut states = self.sync_states.write().await;
            states.retain(|(p, _), _| p != &peer_id_str);
        }
        tracing::info!(peer = %peer_id_str, "hub_repo: peer disconnected, cleaned up sync states");
    }

    /// number of currently connected peers.
    pub async fn connected_peer_count(&self) -> usize {
        self.connected_peers.read().await.len()
    }

    /// list of currently connected peer IDs.
    pub async fn connected_peer_ids(&self) -> Vec<String> {
        self.connected_peers.read().await.keys().cloned().collect()
    }

    /// cancel a connected peer's active connection, if it has one.
    ///
    /// call this immediately after revoking a peer's access (e.g. deleting
    /// or blocking their `friendz` row) so an already-accepted connection
    /// doesn't keep syncing until the peer disconnects on its own.
    /// `friendz::Store` deliberately has no knowledge of `HubRepo` (a lower-
    /// level store shouldn't depend on networking/session state, and it
    /// would create a circular dependency with `sync`/`hub_repo`, which
    /// already depend on `friendz`), so it's the caller of the revoking
    /// operation that's expected to do both steps: revoke in `friendz::Store`,
    /// then call this. today the only caller that runs in the same process
    /// as a live `HubRepo` is `protocol::hub_admin`'s remote `Remove` handler.
    /// the CLI's `reliquary friend remove` always runs as a separate process
    /// from a running `reliquary serve` (they only share the sqlite database,
    /// not in-memory state), so it has no `HubRepo` handle to call this on,
    /// see the comment on `main.rs`'s `FriendCommand::Remove` arm for that
    /// limitation.
    ///
    /// returns `true` if a live connection was found and cancelled, `false`
    /// if the peer has no active connection (a no-op, not an error, the
    /// common case is revoking a peer that was never connected, or already
    /// disconnected).
    pub async fn cancel_peer(&self, peer_id: &str) -> bool {
        let peers = self.connected_peers.read().await;
        match peers.get(peer_id) {
            Some(info) => {
                info.cancel.cancel();
                tracing::info!(peer = %peer_id, "hub_repo: cancelled active connection");
                true
            }
            None => {
                tracing::debug!(peer = %peer_id, "hub_repo: cancel_peer called, no active connection");
                false
            }
        }
    }

    /// number of documents currently held by the hub repo.
    pub async fn document_count(&self) -> usize {
        self.documents.read().await.len()
    }

    /// the hub's own peer ID (iroh node_id hex string).
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// list all document IDs currently held in memory.
    pub async fn all_doc_ids(&self) -> Vec<String> {
        self.documents.read().await.keys().cloned().collect()
    }

    /// load all persisted canvas doc IDs from storage.
    pub async fn load_canvas_ids(&self) -> Vec<String> {
        self.storage.load_canvas_ids().await
    }

    /// access the underlying doc storage — used by maintenance helpers that
    /// operate on raw doc bytes (e.g. sweep_canvas_blobs, purge).
    pub fn storage(&self) -> &HubDocStorage {
        &self.storage
    }

    /// persist a canvas doc ID to storage (idempotent).
    pub async fn save_canvas_id(&self, canvas_doc_id: &str) {
        self.storage.save_canvas_id(canvas_doc_id).await;
    }

    /// remove a canvas doc ID from storage.
    pub async fn remove_canvas_id(&self, canvas_doc_id: &str) {
        self.storage.remove_canvas_id(canvas_doc_id).await;
    }

    /// soft-delete a canvas doc ID (see `HubDocStorage::soft_remove_canvas_id`)
    /// — used by `hub/messages.rs`'s ACL-removed handler instead of the
    /// hard-delete `remove_canvas_id` above.
    pub async fn soft_remove_canvas_id(&self, canvas_doc_id: &str) {
        self.storage.soft_remove_canvas_id(canvas_doc_id).await;
    }

    /// evict a document from the in-memory `documents` map, without
    /// touching its persisted `hub_docs` row — the doc is reloaded from
    /// storage next time something calls `find()`/`wait_for_doc()` and it
    /// isn't already resident (there's currently no lazy-reload path for a
    /// evicted-but-still-persisted doc; this is meant to pair with a
    /// soft-delete, where the canvas is expected to stay untracked rather
    /// than looked up again soon). frees the doc's memory for a canvas the
    /// hub was just removed from, closing the gap noted on `documents`'
    /// own doc comment (previously nothing ever evicted from this map).
    pub async fn evict_doc(&self, doc_id: &str) -> bool {
        self.documents.write().await.remove(doc_id).is_some()
    }

    /// number of soft-deleted canvas ids (see `HubDocStorage::count_removed_canvas_ids`).
    pub async fn count_removed_canvas_ids(&self) -> i64 {
        self.storage.count_removed_canvas_ids().await
    }

    /// all persisted canvas doc ids, active and soft-deleted alike (see
    /// `HubDocStorage::load_all_tracked_canvas_ids`).
    pub async fn load_all_tracked_canvas_ids(&self) -> Vec<String> {
        self.storage.load_all_tracked_canvas_ids().await
    }

    /// a page of soft-deleted canvas ids (see `HubDocStorage::load_removed_canvas_ids`).
    pub async fn load_removed_canvas_ids(&self, limit: i64, offset: i64) -> Vec<RemovedCanvasRow> {
        self.storage.load_removed_canvas_ids(limit, offset).await
    }

    /// restore (undelete) a soft-deleted canvas id (see `HubDocStorage::restore_canvas_id`).
    pub async fn restore_canvas_id(&self, canvas_doc_id: &str) -> bool {
        self.storage.restore_canvas_id(canvas_doc_id).await
    }

    /// permanently purge a soft-deleted canvas's tracking row + persisted
    /// automerge bytes (see `HubDocStorage::purge_canvas_id`), and evict it
    /// from the in-memory map too if a live process happens to still hold
    /// it (normally it wouldn't, since it was untracked when soft-deleted,
    /// but this keeps `purge` a true "this canvas is completely gone from
    /// this process" operation regardless).
    pub async fn purge_canvas_id(&self, canvas_doc_id: &str) -> bool {
        let purged = self.storage.purge_canvas_id(canvas_doc_id).await;
        if purged {
            self.evict_doc(canvas_doc_id).await;
        }
        purged
    }

    /// subscribe to document change notifications.
    ///
    /// fires whenever a document is created or updated via sync.
    /// the payload is the doc_id string.
    pub fn subscribe_doc_changes(&self) -> broadcast::Receiver<String> {
        self.doc_notify.subscribe()
    }

    /// broadcast that `doc_id` changed, for callers that mutate a doc
    /// through a path other than `handle_sync_message` (which already fires
    /// this itself on every successful incoming apply) — e.g.
    /// `hub/canvas.rs`'s `write_self_to_canvas_doc`, which mutates a
    /// [`DocHandle`] directly and has no `HubRepo` reference of its own to
    /// call this through except via its caller. every connection's
    /// `handle_connection` loop listens for this (see the `doc_notify`
    /// branch there) and proactively pushes a fresh sync message to that
    /// peer if it has anything new for them — without this, a change made
    /// outside the request/response cycle (like the hub writing itself
    /// into a canvas's `.peers` map) would sit in the hub's own local doc
    /// forever, with no already-connected peer ever finding out about it. a
    /// real, confirmed bug, 2026-07-02: this is why an invited hub wrote
    /// itself into `.peers` successfully (per its own logs) but never
    /// actually showed up in the inviting peer's share dialog — the write
    /// happened, it just never got pushed anywhere.
    pub fn notify_doc_changed(&self, doc_id: &str) {
        let _ = self.doc_notify.send(doc_id.to_string());
    }

    /// generate an outbound sync message to push `doc_id`'s latest state to
    /// `peer_id`, but ONLY if we already have a sync state for that
    /// (peer, doc) pair — i.e. this peer has synced this doc with us
    /// before (via an inbound sync/request message reaching
    /// `handle_sync_message`, which always creates one). deliberately does
    /// NOT create a new sync state (unlike `handle_sync_message`): a peer
    /// who has never touched this doc shouldn't suddenly have it pushed at
    /// them just because it changed. returns `None` if there's no existing
    /// sync state, the doc doesn't exist, or automerge has nothing new to
    /// send this peer (already caught up).
    pub async fn generate_outbound_sync_message(
        &self,
        peer_id: &str,
        doc_id: &str,
    ) -> Option<Vec<u8>> {
        let doc_arc = {
            let docs = self.documents.read().await;
            docs.get(doc_id)?.clone()
        };
        let doc = doc_arc.read().await;

        let key = (peer_id.to_string(), doc_id.to_string());
        let mut sync_states = self.sync_states.write().await;
        let sync_state = sync_states.get_mut(&key)?;

        doc.generate_sync_message(sync_state)
            .map(|msg: automerge::sync::Message| msg.encode())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// build a `HubRepo` backed by a fresh temp-dir sqlite file. the
    /// returned `TempDir` must be kept alive for as long as the `HubRepo` is
    /// used (dropping it deletes the backing file).
    async fn make_hub_repo() -> (HubRepo, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");
        (hub_repo, tmp)
    }

    #[tokio::test]
    async fn cancel_peer_with_no_active_connection_is_a_no_op() {
        let (hub_repo, _tmp) = make_hub_repo().await;

        // nobody has ever connected, so this must not panic and must report
        // "nothing to cancel" rather than pretending it found something.
        assert!(!hub_repo.cancel_peer("never-connected").await);
        assert_eq!(hub_repo.connected_peer_count().await, 0);
    }
    /// this is the core regression test for the fix described on
    /// `HubRepo::cancel_peer`'s doc comment: a peer with an active
    /// connection (an in-flight `handle_connection` loop, here driven by an
    /// in-memory `tokio::io::duplex` pair rather than a real iroh stream,
    /// matching this crate's existing precedent for testing `hub_repo`/
    /// `sync` logic without a live network - see `sync::tests`'s doc
    /// comments) can be cancelled from outside its
    /// own loop, and the loop actually stops promptly rather than running
    /// until the peer disconnects on its own.
    #[tokio::test]
    async fn cancel_peer_terminates_an_active_connection_promptly() {
        let (hub_repo, _tmp) = make_hub_repo().await;
        let peer_id = "revoked-peer".to_string();

        let (client_side, server_side) = tokio::io::duplex(8192);

        let repo_for_task = hub_repo.clone();
        let peer_id_for_task = peer_id.clone();
        let handle = tokio::spawn(async move {
            repo_for_task
                .handle_connection(peer_id_for_task, server_side)
                .await;
        });

        // wait for the connection to register itself before cancelling it,
        // otherwise we'd race the insert into `connected_peers`.
        for _ in 0..100 {
            if hub_repo.connected_peer_count().await == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            hub_repo.connected_peer_count().await,
            1,
            "connection should have registered itself in connected_peers"
        );

        // simulates what `protocol::hub_admin`'s `Remove` handler does after
        // `friendz::Store::delete()`: look up the peer's active connection
        // and cancel it.
        assert!(
            hub_repo.cancel_peer(&peer_id).await,
            "cancel_peer should find and cancel the active connection"
        );

        // the spawned handle_connection task must actually return promptly
        // (not hang until the client side is dropped/closed).
        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("handle_connection should return promptly once cancelled")
            .expect("handle_connection task should not panic");

        assert_eq!(
            hub_repo.connected_peer_count().await,
            0,
            "cancelled connection should have cleaned itself out of connected_peers"
        );

        drop(client_side);
    }

    // -----------------------------------------------------------------
    // per-canvas viewer-role enforcement (peer_canvas_role /
    // handle_sync_message)
    // -----------------------------------------------------------------

    /// build an automerge doc with the shape `read_str`/`peer_canvas_role`
    /// expect: `version`/`widgets`/`title` (so it counts as "synced" for
    /// other helpers elsewhere in this crate that check for that), plus an
    /// `.acl` map with one entry per `(peer_id, role)` pair given.
    fn build_seed_doc(title: &str, acl_entries: &[(&str, &str)]) -> automerge::Automerge {
        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            tx.put(automerge::ROOT, "version", 1_i64)?;
            tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;
            tx.put(automerge::ROOT, "title", title)?;

            if !acl_entries.is_empty() {
                let acl = tx.put_object(automerge::ROOT, "acl", automerge::ObjType::Map)?;
                for (peer_id, role) in acl_entries {
                    let entry = tx.put_object(&acl, *peer_id, automerge::ObjType::Map)?;
                    tx.put(&entry, "role", *role)?;
                }
            }
            Ok(())
        })
        .expect("seed doc transact should succeed");
        doc
    }

    #[test]
    fn peer_canvas_role_reads_the_recorded_role() {
        let doc = build_seed_doc("t", &[("viewer-peer", "viewer"), ("member-peer", "member")]);
        assert_eq!(HubRepo::peer_canvas_role(&doc, "viewer-peer"), "viewer");
        assert_eq!(HubRepo::peer_canvas_role(&doc, "member-peer"), "member");
    }

    #[test]
    fn peer_canvas_role_defaults_to_member_when_acl_or_entry_is_missing() {
        // no `.acl` map at all — e.g. a pre-ACL canvas, or a non-canvas doc
        // (narthex/social/messagez) that has no acl field.
        let doc_no_acl = build_seed_doc("t", &[]);
        assert_eq!(HubRepo::peer_canvas_role(&doc_no_acl, "anyone"), "member");

        // `.acl` exists, but this peer has no entry in it.
        let doc_with_acl = build_seed_doc("t", &[("someone-else", "viewer")]);
        assert_eq!(
            HubRepo::peer_canvas_role(&doc_with_acl, "stranger"),
            "member"
        );
    }

    /// drive a real 3-message automerge sync handshake between an
    /// independent peer-side doc/state and `hub_repo.handle_sync_message`,
    /// returning the peer's final synced doc (so callers can also assert
    /// on it if useful) after the exchange settles. panics if the exchange
    /// doesn't settle within a small fixed number of rounds.
    async fn sync_peer_with_hub(
        hub_repo: &HubRepo,
        peer_id: &str,
        doc_id: &str,
        peer_doc: &mut automerge::Automerge,
    ) {
        use automerge::sync::SyncDoc;

        let mut peer_state = automerge::sync::State::new();
        for _ in 0..5 {
            let Some(msg) = peer_doc.generate_sync_message(&mut peer_state) else {
                break;
            };
            let Some(resp_bytes) = hub_repo
                .handle_sync_message(peer_id, doc_id, &msg.encode())
                .await
            else {
                continue;
            };
            let resp = automerge::sync::Message::decode(&resp_bytes).expect("decode hub response");
            peer_doc
                .receive_sync_message(&mut peer_state, resp)
                .expect("peer should apply hub's response");
        }
    }

    #[tokio::test]
    async fn viewer_role_peers_changes_are_stripped_before_reaching_the_hubs_canonical_doc() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");

        let seed_doc = build_seed_doc("original title", &[("viewer-peer", "viewer")]);
        let seed_bytes = seed_doc.save();

        let storage = HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");
        storage.save_doc("canvas-1", &seed_bytes).await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new (reload) should succeed");

        // "viewer-peer"'s own local replica, forked from the same initial
        // state, with a forbidden edit applied only on their side.
        let mut peer_doc = automerge::Automerge::load(&seed_bytes).expect("load peer doc");
        peer_doc
            .transact::<_, _, automerge::AutomergeError>(|tx| {
                use automerge::transaction::Transactable;
                tx.put(automerge::ROOT, "title", "HACKED BY VIEWER")?;
                Ok(())
            })
            .expect("peer transact should succeed");

        sync_peer_with_hub(&hub_repo, "viewer-peer", "canvas-1", &mut peer_doc).await;

        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");
        let hub_title = tokio::task::spawn_blocking(move || {
            use automerge::ReadDoc;
            handle.with_document(|doc| {
                doc.get(automerge::ROOT, "title")
                    .ok()
                    .flatten()
                    .and_then(|(v, _)| v.to_str().map(|s| s.to_string()))
            })
        })
        .await
        .expect("spawn_blocking should not panic");

        assert_eq!(
            hub_title,
            Some("original title".to_string()),
            "a viewer-role peer's change must never be applied to the hub's canonical doc"
        );
    }

    #[tokio::test]
    async fn member_role_peers_changes_are_applied_normally() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");

        let seed_doc = build_seed_doc("original title", &[("member-peer", "member")]);
        let seed_bytes = seed_doc.save();

        let storage = HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");
        storage.save_doc("canvas-1", &seed_bytes).await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new (reload) should succeed");

        let mut peer_doc = automerge::Automerge::load(&seed_bytes).expect("load peer doc");
        peer_doc
            .transact::<_, _, automerge::AutomergeError>(|tx| {
                use automerge::transaction::Transactable;
                tx.put(automerge::ROOT, "title", "edited by member")?;
                Ok(())
            })
            .expect("peer transact should succeed");

        sync_peer_with_hub(&hub_repo, "member-peer", "canvas-1", &mut peer_doc).await;

        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");
        let hub_title = tokio::task::spawn_blocking(move || {
            use automerge::ReadDoc;
            handle.with_document(|doc| {
                doc.get(automerge::ROOT, "title")
                    .ok()
                    .flatten()
                    .and_then(|(v, _)| v.to_str().map(|s| s.to_string()))
            })
        })
        .await
        .expect("spawn_blocking should not panic");

        assert_eq!(
            hub_title,
            Some("edited by member".to_string()),
            "a member-role peer's change must be applied normally — this gate must not be overly restrictive"
        );
    }

    #[tokio::test]
    async fn a_doc_with_no_acl_at_all_still_applies_changes_normally() {
        // e.g. narthex/social/messagez docs, or a pre-ACL canvas — must
        // behave exactly as before this gate existed (fully read/write for
        // everyone) since `peer_canvas_role` defaults to "member" here.
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");

        let seed_doc = build_seed_doc("original title", &[]);
        let seed_bytes = seed_doc.save();

        let storage = HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");
        storage.save_doc("doc-1", &seed_bytes).await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new (reload) should succeed");

        let mut peer_doc = automerge::Automerge::load(&seed_bytes).expect("load peer doc");
        peer_doc
            .transact::<_, _, automerge::AutomergeError>(|tx| {
                use automerge::transaction::Transactable;
                tx.put(automerge::ROOT, "title", "edited, no acl at all")?;
                Ok(())
            })
            .expect("peer transact should succeed");

        sync_peer_with_hub(&hub_repo, "anyone", "doc-1", &mut peer_doc).await;

        let handle = hub_repo.find("doc-1").await.expect("doc should be found");
        let hub_title = tokio::task::spawn_blocking(move || {
            use automerge::ReadDoc;
            handle.with_document(|doc| {
                doc.get(automerge::ROOT, "title")
                    .ok()
                    .flatten()
                    .and_then(|(v, _)| v.to_str().map(|s| s.to_string()))
            })
        })
        .await
        .expect("spawn_blocking should not panic");

        assert_eq!(hub_title, Some("edited, no acl at all".to_string()));
    }
}
