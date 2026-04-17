//! friendz: accepted friend edges + invite state.
//!
//! one row per friend node id. status is a small enum. we keep the narthex
//! doc id (the canvas they share with us) alongside the edge so the hub can
//! resolve which doc to sync when a friend connects.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FriendError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Friend {
    pub friend_node_id: String,
    pub status: FriendStatus,
    pub narthex_doc_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn upsert(
        &self,
        friend_node_id: &str,
        status: FriendStatus,
        narthex_doc_id: Option<&str>,
    ) -> Result<Friend, FriendError> {
        let now = now_secs();
        sqlx::query(
            r#"
            INSERT INTO friendz (friend_node_id, status, narthex_doc_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?4)
            ON CONFLICT(friend_node_id) DO UPDATE SET
                status = excluded.status,
                narthex_doc_id = COALESCE(excluded.narthex_doc_id, friendz.narthex_doc_id),
                updated_at = excluded.updated_at
            "#,
        )
        .bind(friend_node_id)
        .bind(status.as_str())
        .bind(narthex_doc_id)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get(friend_node_id)
            .await?
            .ok_or_else(|| FriendError::UnknownStatus("friend missing after upsert".into()))
    }

    pub async fn get(
        &self,
        friend_node_id: &str,
    ) -> Result<Option<Friend>, FriendError> {
        let row = sqlx::query_as::<_, FriendRow>(
            r#"
            SELECT friend_node_id, status, narthex_doc_id, created_at, updated_at
            FROM friendz WHERE friend_node_id = ?1
            "#,
        )
        .bind(friend_node_id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }

    pub async fn list(&self, only_accepted: bool) -> Result<Vec<Friend>, FriendError> {
        let sql = if only_accepted {
            r#"SELECT friend_node_id, status, narthex_doc_id, created_at, updated_at
               FROM friendz WHERE status = 'accepted' ORDER BY created_at ASC"#
        } else {
            r#"SELECT friend_node_id, status, narthex_doc_id, created_at, updated_at
               FROM friendz ORDER BY created_at ASC"#
        };
        let rows: Vec<FriendRow> = sqlx::query_as(sql).fetch_all(&self.pool).await?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn delete(&self, friend_node_id: &str) -> Result<(), FriendError> {
        sqlx::query("DELETE FROM friendz WHERE friend_node_id = ?1")
            .bind(friend_node_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct FriendRow {
    friend_node_id: String,
    status: String,
    narthex_doc_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl TryFrom<FriendRow> for Friend {
    type Error = FriendError;

    fn try_from(r: FriendRow) -> Result<Self, Self::Error> {
        Ok(Self {
            friend_node_id: r.friend_node_id,
            status: FriendStatus::parse(&r.status)?,
            narthex_doc_id: r.narthex_doc_id,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
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

    /// build a fresh in-memory pool with a peer row already touched, so the
    /// FK from friendz.friend_node_id -> userz.node_id is satisfied.
    async fn make_store_with_peer(node_id: &str) -> Store {
        let pool = db::open_in_memory().await;
        let users = userz::Directory::new(pool.clone());
        users.touch(node_id).await.unwrap();
        Store::new(pool)
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
        let pool = db::open_in_memory().await;
        let store = Store::new(pool);
        assert!(store.get("nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_filters_by_only_accepted() {
        let pool = db::open_in_memory().await;
        let users = userz::Directory::new(pool.clone());
        for n in ["a", "b", "c"] {
            users.touch(n).await.unwrap();
        }
        let store = Store::new(pool);

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
        assert!(accepted
            .iter()
            .all(|f| f.status == FriendStatus::Accepted));
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

    #[tokio::test]
    async fn upsert_without_userz_row_violates_fk() {
        // friendz.friend_node_id REFERENCES userz(node_id) — inserting
        // without a peer row first should fail with a sqlx error.
        let pool = db::open_in_memory().await;
        let store = Store::new(pool);
        let res = store
            .upsert("orphan", FriendStatus::Allowed, None)
            .await;
        assert!(matches!(res, Err(FriendError::Sqlx(_))));
    }
}
