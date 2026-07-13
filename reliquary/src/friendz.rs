//! friendz: accepted friend edges + invite state.
//!
//! one row per friend node id. status is a small enum. we keep the narthex
//! doc id (the canvas they share with us) alongside the edge so the hub can
//! resolve which doc to sync when a friend connects.
//!
//! storage for the shared fields (status/direction/alias/group_name/
//! timestamps) is haruspex's own `FriendStore`/`SqliteFriendStore` - the
//! narthex doc id has no equivalent field on haruspex's `FriendEdge` (an
//! app-specific concept, not part of the core friend-relationship shape),
//! so it lives in a small side table (`friend_docz`) this module manages
//! directly.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;

use haruspex::sqlite::SqliteFriendStore;
use haruspex::stores::friend_store::{
    FriendDirection as HxDirection, FriendEdge as HxFriendEdge, FriendStatus as HxFriendStatus,
};
use haruspex::stores::FriendStore as _;

#[derive(Debug, Error)]
pub enum FriendError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("haruspex store error: {0}")]
    Store(#[from] haruspex::error::StoreError),

    #[error("unknown status value: {0}")]
    UnknownStatus(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FriendStatus {
    /// peer is pre-approved by the operator (e.g. via `reliquary friend allow`).
    /// inbound `FriendRequest` from an `Allowed` peer auto-promotes to
    /// `Accepted` and triggers a `FriendAccept` reply.
    Allowed,
    /// inbound `FriendRequest` recorded but not yet acted on. operator must
    /// promote with `reliquary friend allow` (or its equivalent ipc) for the
    /// hub to send `FriendAccept`.
    Pending,
    /// mutual friendship established.
    Accepted,
    /// peer is denied — drop their requests on the floor.
    Blocked,
}

impl FriendStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Blocked => "blocked",
        }
    }

    pub fn parse(s: &str) -> Result<Self, FriendError> {
        match s {
            "allowed" => Ok(Self::Allowed),
            "pending" => Ok(Self::Pending),
            "accepted" => Ok(Self::Accepted),
            "blocked" => Ok(Self::Blocked),
            other => Err(FriendError::UnknownStatus(other.to_string())),
        }
    }

    fn to_haruspex(self) -> HxFriendStatus {
        match self {
            Self::Allowed => HxFriendStatus::Allowed,
            Self::Pending => HxFriendStatus::Pending,
            Self::Accepted => HxFriendStatus::Accepted,
            Self::Blocked => HxFriendStatus::Blocked,
        }
    }

    fn from_haruspex(status: HxFriendStatus) -> Self {
        match status {
            HxFriendStatus::Allowed => Self::Allowed,
            HxFriendStatus::Pending => Self::Pending,
            HxFriendStatus::Accepted => Self::Accepted,
            HxFriendStatus::Blocked => Self::Blocked,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Inbound,
    Outbound,
}

impl Direction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Inbound => "inbound",
            Self::Outbound => "outbound",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "inbound" => Some(Self::Inbound),
            "outbound" => Some(Self::Outbound),
            _ => None,
        }
    }

    fn to_haruspex(self) -> HxDirection {
        match self {
            Self::Inbound => HxDirection::Inbound,
            Self::Outbound => HxDirection::Outbound,
        }
    }

    fn from_haruspex(direction: HxDirection) -> Self {
        match direction {
            HxDirection::Inbound => Self::Inbound,
            HxDirection::Outbound => Self::Outbound,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Friend {
    pub friend_node_id: String,
    pub status: FriendStatus,
    pub direction: Option<Direction>,
    pub alias: Option<String>,
    pub group_name: Option<String>,
    pub narthex_doc_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Friend {
    fn from_edge(edge: HxFriendEdge, narthex_doc_id: Option<String>) -> Self {
        Self {
            friend_node_id: edge.node_id,
            status: FriendStatus::from_haruspex(edge.status),
            direction: Some(Direction::from_haruspex(edge.direction)),
            alias: edge.alias,
            group_name: edge.group_name,
            narthex_doc_id,
            created_at: edge.created_at,
            updated_at: edge.updated_at,
        }
    }
}

#[derive(Clone)]
pub struct Store {
    /// haruspex's own sqlite db (a sibling file to this crate's own,
    /// opened via `haruspex_bridge::open`) - every method below except the
    /// narthex-doc-id side table goes through this pool.
    haruspex_pool: SqlitePool,
    /// this crate's own sqlite db, used only for `friend_docz`.
    skein_pool: SqlitePool,
}

impl Store {
    pub fn new(haruspex_pool: SqlitePool, skein_pool: SqlitePool) -> Self {
        Self {
            haruspex_pool,
            skein_pool,
        }
    }

    fn edges(&self) -> SqliteFriendStore {
        SqliteFriendStore::new(self.haruspex_pool.clone())
    }

    pub async fn upsert(
        &self,
        friend_node_id: &str,
        status: FriendStatus,
        narthex_doc_id: Option<&str>,
    ) -> Result<Friend, FriendError> {
        self.upsert_full(friend_node_id, status, None, None, None, narthex_doc_id)
            .await
    }

    /// upsert with all optional fields. None values use COALESCE-style merge:
    /// existing row values are preserved when the parameter is None.
    /// haruspex's `upsert_edge` overwrites unconditionally, so the coalesce
    /// is done here by reading the existing edge first - the same pattern
    /// haruspex's own `hub_admin::friend_allow`/`friend_block` use.
    pub async fn upsert_full(
        &self,
        friend_node_id: &str,
        status: FriendStatus,
        direction: Option<Direction>,
        alias: Option<&str>,
        group_name: Option<&str>,
        narthex_doc_id: Option<&str>,
    ) -> Result<Friend, FriendError> {
        let now = now_secs();
        let existing = self.edges().get_edge(friend_node_id).await?;

        let edge = HxFriendEdge {
            node_id: friend_node_id.to_string(),
            status: status.to_haruspex(),
            direction: direction
                .map(Direction::to_haruspex)
                .or_else(|| existing.as_ref().map(|e| e.direction))
                .unwrap_or(HxDirection::Inbound),
            alias: alias
                .map(str::to_string)
                .or_else(|| existing.as_ref().and_then(|e| e.alias.clone())),
            group_name: group_name
                .map(str::to_string)
                .or_else(|| existing.as_ref().and_then(|e| e.group_name.clone())),
            created_at: existing.as_ref().map(|e| e.created_at).unwrap_or(now),
            updated_at: now,
        };
        self.edges().upsert_edge(edge).await?;

        if let Some(doc_id) = narthex_doc_id {
            self.set_narthex_doc_id(friend_node_id, doc_id).await?;
        }

        self.get(friend_node_id)
            .await?
            .ok_or_else(|| FriendError::UnknownStatus("friend missing after upsert".into()))
    }

    pub async fn get(&self, friend_node_id: &str) -> Result<Option<Friend>, FriendError> {
        let Some(edge) = self.edges().get_edge(friend_node_id).await? else {
            return Ok(None);
        };
        let narthex_doc_id = self.narthex_doc_id(friend_node_id).await?;
        Ok(Some(Friend::from_edge(edge, narthex_doc_id)))
    }

    pub async fn list(&self, only_accepted: bool) -> Result<Vec<Friend>, FriendError> {
        let status = only_accepted.then_some(HxFriendStatus::Accepted);
        let edges = self.edges().list_edges(status).await?;
        let mut friends = self.attach_doc_ids(edges).await?;
        friends.sort_by_key(|f| f.created_at);
        Ok(friends)
    }

    /// list all friendz rows where status='pending' filtered by direction.
    /// pass None to get pending rows of either direction.
    pub async fn list_pending(
        &self,
        direction: Option<Direction>,
    ) -> Result<Vec<Friend>, FriendError> {
        let edges = self
            .edges()
            .list_edges(Some(HxFriendStatus::Pending))
            .await?;
        let mut friends = self.attach_doc_ids(edges).await?;
        if let Some(direction) = direction {
            friends.retain(|f| f.direction == Some(direction));
        }
        friends.sort_by_key(|f| f.created_at);
        Ok(friends)
    }

    pub async fn delete(&self, friend_node_id: &str) -> Result<(), FriendError> {
        self.edges().remove_edge(friend_node_id).await?;
        Ok(())
    }

    /// check whether `friend_node_id` counts as a friend for connection-
    /// authorization purposes: status `Accepted` or `Allowed` (allowed peers
    /// haven't completed the handshake but the operator has pre-approved
    /// them). used to gate both the `iroh/automerge-repo/1` sync ALPN
    /// (`sync::IrohRepo::accept`) and `freqhole-friendz/1`'s canvas invite
    /// handling (`hub::HubPeerService::is_friend`).
    ///
    /// returns `false` (and logs) on a missing row or store error rather
    /// than propagating, since callers use this as a yes/no gate on a hot
    /// connection path.
    pub async fn is_friend(&self, friend_node_id: &str) -> bool {
        match self.get(friend_node_id).await {
            Ok(Some(friend)) => matches!(
                friend.status,
                FriendStatus::Accepted | FriendStatus::Allowed
            ),
            Ok(None) => {
                tracing::debug!(peer = %friend_node_id, "is_friend: no friendz row");
                false
            }
            Err(e) => {
                tracing::warn!(peer = %friend_node_id, error = %e, "is_friend: friendz store error");
                false
            }
        }
    }

    /// haruspex's `FriendEdge` has no equivalent field for the narthex doc
    /// id (an app-specific concept), so it's tracked in its own side table.
    async fn narthex_doc_id(&self, node_id: &str) -> Result<Option<String>, FriendError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT narthex_doc_id FROM friend_docz WHERE node_id = ?1")
                .bind(node_id)
                .fetch_optional(&self.skein_pool)
                .await?;
        Ok(row.map(|(doc_id,)| doc_id))
    }

    async fn set_narthex_doc_id(&self, node_id: &str, doc_id: &str) -> Result<(), FriendError> {
        sqlx::query(
            r#"
            INSERT INTO friend_docz (node_id, narthex_doc_id)
            VALUES (?1, ?2)
            ON CONFLICT(node_id) DO UPDATE SET narthex_doc_id = excluded.narthex_doc_id
            "#,
        )
        .bind(node_id)
        .bind(doc_id)
        .execute(&self.skein_pool)
        .await?;
        Ok(())
    }

    async fn attach_doc_ids(&self, edges: Vec<HxFriendEdge>) -> Result<Vec<Friend>, FriendError> {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT node_id, narthex_doc_id FROM friend_docz")
                .fetch_all(&self.skein_pool)
                .await?;
        let mut doc_ids: HashMap<String, String> = rows.into_iter().collect();
        Ok(edges
            .into_iter()
            .map(|edge| {
                let doc_id = doc_ids.remove(&edge.node_id);
                Friend::from_edge(edge, doc_id)
            })
            .collect())
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, userz};

    /// build a fresh pair of in-memory pools (skein's own + haruspex's own)
    /// with a peer row already touched. no longer required for an FK
    /// (haruspex's friendz schema has none), kept so friend rows in tests
    /// have a matching peer row like real usage.
    async fn make_store_with_peer(node_id: &str) -> Store {
        let skein_pool = db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let users = userz::Directory::new(haruspex_pool.clone());
        users.touch(node_id).await.unwrap();
        Store::new(haruspex_pool, skein_pool)
    }

    #[test]
    fn status_round_trips_through_string() {
        for s in [
            FriendStatus::Allowed,
            FriendStatus::Pending,
            FriendStatus::Accepted,
            FriendStatus::Blocked,
        ] {
            assert_eq!(FriendStatus::parse(s.as_str()).unwrap(), s);
        }
        assert!(matches!(
            FriendStatus::parse("garbage"),
            Err(FriendError::UnknownStatus(_))
        ));
    }

    #[tokio::test]
    async fn upsert_inserts_then_updates_status() {
        let store = make_store_with_peer("peer-a").await;
        let inserted = store
            .upsert("peer-a", FriendStatus::Allowed, None)
            .await
            .unwrap();
        assert_eq!(inserted.status, FriendStatus::Allowed);
        assert!(inserted.narthex_doc_id.is_none());
        assert_eq!(inserted.created_at, inserted.updated_at);

        // promotion to Accepted should preserve created_at, advance updated_at.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let promoted = store
            .upsert("peer-a", FriendStatus::Accepted, Some("doc-1"))
            .await
            .unwrap();
        assert_eq!(promoted.status, FriendStatus::Accepted);
        assert_eq!(promoted.narthex_doc_id.as_deref(), Some("doc-1"));
        assert_eq!(promoted.created_at, inserted.created_at);
        assert!(promoted.updated_at >= inserted.updated_at);
    }

    #[tokio::test]
    async fn upsert_preserves_existing_doc_id_when_none_passed() {
        let store = make_store_with_peer("peer-b").await;
        store
            .upsert("peer-b", FriendStatus::Allowed, Some("doc-original"))
            .await
            .unwrap();
        // pass None — COALESCE should keep the original doc id.
        let after = store
            .upsert("peer-b", FriendStatus::Accepted, None)
            .await
            .unwrap();
        assert_eq!(after.narthex_doc_id.as_deref(), Some("doc-original"));
    }

    #[tokio::test]
    async fn get_returns_none_for_unknown_friend() {
        let store = Store::new(
            haruspex::testing::open_in_memory().await,
            db::open_in_memory().await,
        );
        assert!(store.get("nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_filters_by_only_accepted() {
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let users = userz::Directory::new(haruspex_pool.clone());
        for n in ["a", "b", "c"] {
            users.touch(n).await.unwrap();
        }
        let store = Store::new(haruspex_pool, db::open_in_memory().await);

        store
            .upsert("a", FriendStatus::Accepted, None)
            .await
            .unwrap();
        store
            .upsert("b", FriendStatus::Pending, None)
            .await
            .unwrap();
        store
            .upsert("c", FriendStatus::Accepted, None)
            .await
            .unwrap();

        let all = store.list(false).await.unwrap();
        assert_eq!(all.len(), 3);

        let accepted = store.list(true).await.unwrap();
        assert_eq!(accepted.len(), 2);
        assert!(accepted.iter().all(|f| f.status == FriendStatus::Accepted));
    }

    #[tokio::test]
    async fn delete_removes_friend_row() {
        let store = make_store_with_peer("peer-d").await;
        store
            .upsert("peer-d", FriendStatus::Allowed, None)
            .await
            .unwrap();
        assert!(store.get("peer-d").await.unwrap().is_some());

        store.delete("peer-d").await.unwrap();
        assert!(store.get("peer-d").await.unwrap().is_none());

        // delete on missing row is a no-op.
        store.delete("never-existed").await.unwrap();
    }

    /// haruspex's friendz schema carries no FK to peerz (unlike skein's
    /// original schema's FK to userz) - a friend edge can be recorded before
    /// any profile/presence data has arrived for the peer. a deliberate,
    /// documented behavior change (see CUTOVER_BACKLOG.md).
    #[tokio::test]
    async fn upsert_without_a_peer_row_no_longer_requires_one() {
        let store = Store::new(
            haruspex::testing::open_in_memory().await,
            db::open_in_memory().await,
        );
        let res = store.upsert("orphan", FriendStatus::Allowed, None).await;
        assert!(res.is_ok());
    }

    /// a `Blocked` peer that gets re-`Allowed` (e.g. an operator changes
    /// their mind) must actually unblock — `is_friend()` should flip back to
    /// true and no stale "blocked" state should linger anywhere. `upsert`
    /// writes `status` unconditionally (`status = excluded.status`, not a
    /// COALESCE), so there's no separate "unblock" path to forget to wire up,
    /// but this is worth a real assertion rather than trusting the SQL by
    /// inspection.
    #[tokio::test]
    async fn blocked_peer_can_be_reallowed_and_becomes_a_friend_again() {
        let store = make_store_with_peer("peer-e").await;
        store
            .upsert("peer-e", FriendStatus::Blocked, None)
            .await
            .unwrap();
        assert!(!store.is_friend("peer-e").await);

        let unblocked = store
            .upsert("peer-e", FriendStatus::Allowed, None)
            .await
            .unwrap();
        assert_eq!(unblocked.status, FriendStatus::Allowed);
        assert!(store.is_friend("peer-e").await);

        // and the reverse direction: Accepted -> Blocked must also take
        // effect immediately.
        store
            .upsert("peer-e", FriendStatus::Accepted, None)
            .await
            .unwrap();
        assert!(store.is_friend("peer-e").await);
        store
            .upsert("peer-e", FriendStatus::Blocked, None)
            .await
            .unwrap();
        assert!(!store.is_friend("peer-e").await);
    }

    /// `upsert_full`'s `INSERT ... ON CONFLICT DO UPDATE` is a single atomic
    /// statement (unlike blobz.rs's old check-then-insert pattern), so
    /// concurrent upserts for the *same* node id from different tasks (e.g.
    /// two racing `FriendRequest`/hub_admin `Allow` calls for the same peer)
    /// should never surface a sqlite-level error, and must always converge
    /// on exactly one row. uses a real file-backed pool (multiple
    /// connections) + a multi-thread runtime so the race is actually
    /// exercised, unlike `open_in_memory()`'s single-connection pool.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent_upsert_same_node_id_resolves_to_single_row() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let skein_pool = crate::db::open(tmp.path()).await.expect("open db");
        // a real file-backed pool (multiple connections) for haruspex's own
        // db too, since this test needs the same race actually exercised
        // against it, not against a single-connection in-memory pool.
        let haruspex_pool = haruspex::sqlite::open(tmp.path())
            .await
            .expect("open haruspex db");
        let users = userz::Directory::new(haruspex_pool.clone());
        users.touch("racing-peer").await.unwrap();
        let store = Store::new(haruspex_pool, skein_pool);

        let mut handles = Vec::new();
        for _ in 0..8 {
            let store = store.clone();
            handles.push(tokio::spawn(async move {
                store
                    .upsert("racing-peer", FriendStatus::Allowed, None)
                    .await
            }));
        }
        for h in handles {
            h.await
                .expect("task panicked")
                .expect("upsert must not error on a race");
        }

        let all = store.list(false).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].friend_node_id, "racing-peer");
    }
}
