//! userz: tiny peer directory.
//!
//! tracks peers we've encountered: node id, optional display name + avatar
//! blob, first/last-seen timestamps. also marks the local node as `is_self`.
//! no passwords, no sessions, no roles.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UserError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerRecord {
    pub node_id: String,
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub avatar_blake3: Option<String>,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub is_self: bool,
}

#[derive(Clone)]
pub struct Directory {
    pool: SqlitePool,
}

impl Directory {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// upsert the local node. called once on hub startup.
    ///
    /// `display_name`, `bio`, and `avatar_blake3` are all optional and
    /// merged with COALESCE — passing `None` for a field leaves the
    /// existing value alone, so partial updates work without read-modify-write.
    pub async fn upsert_self(
        &self,
        node_id: &str,
        display_name: Option<&str>,
        bio: Option<&str>,
        avatar_blake3: Option<&str>,
    ) -> Result<(), UserError> {
        let now = now_secs();
        sqlx::query(
            r#"
            INSERT INTO userz (node_id, display_name, bio, avatar_blake3, first_seen_at, last_seen_at, is_self)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)
            ON CONFLICT(node_id) DO UPDATE SET
                display_name  = COALESCE(excluded.display_name,  userz.display_name),
                bio           = COALESCE(excluded.bio,           userz.bio),
                avatar_blake3 = COALESCE(excluded.avatar_blake3, userz.avatar_blake3),
                last_seen_at  = excluded.last_seen_at,
                is_self       = 1
            "#,
        )
        .bind(node_id)
        .bind(display_name)
        .bind(bio)
        .bind(avatar_blake3)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// update `last_seen_at` for a peer (and insert a minimal row if new).
    pub async fn touch(&self, node_id: &str) -> Result<(), UserError> {
        let now = now_secs();
        sqlx::query(
            r#"
            INSERT INTO userz (node_id, first_seen_at, last_seen_at, is_self)
            VALUES (?1, ?2, ?2, 0)
            ON CONFLICT(node_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
            "#,
        )
        .bind(node_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// update a peer's profile (display_name + bio + avatar). any None fields
    /// are left untouched (COALESCE-based merge).
    pub async fn upsert_profile(
        &self,
        node_id: &str,
        display_name: Option<&str>,
        bio: Option<&str>,
        avatar_blake3: Option<&str>,
    ) -> Result<(), UserError> {
        let now = now_secs();
        sqlx::query(
            r#"
            INSERT INTO userz (node_id, display_name, bio, avatar_blake3, first_seen_at, last_seen_at, is_self)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0)
            ON CONFLICT(node_id) DO UPDATE SET
                display_name  = COALESCE(excluded.display_name,  userz.display_name),
                bio           = COALESCE(excluded.bio,           userz.bio),
                avatar_blake3 = COALESCE(excluded.avatar_blake3, userz.avatar_blake3),
                last_seen_at  = excluded.last_seen_at
            "#,
        )
        .bind(node_id)
        .bind(display_name)
        .bind(bio)
        .bind(avatar_blake3)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get(&self, node_id: &str) -> Result<Option<PeerRecord>, UserError> {
        let row = sqlx::query_as::<_, PeerRow>(
            r#"
            SELECT node_id, display_name, bio, avatar_blake3, first_seen_at, last_seen_at, is_self
            FROM userz WHERE node_id = ?1
            "#,
        )
        .bind(node_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(Into::into))
    }
}

#[derive(sqlx::FromRow)]
struct PeerRow {
    node_id: String,
    display_name: Option<String>,
    bio: Option<String>,
    avatar_blake3: Option<String>,
    first_seen_at: i64,
    last_seen_at: i64,
    is_self: i64,
}

impl From<PeerRow> for PeerRecord {
    fn from(r: PeerRow) -> Self {
        Self {
            node_id: r.node_id,
            display_name: r.display_name,
            bio: r.bio,
            avatar_blake3: r.avatar_blake3,
            first_seen_at: r.first_seen_at,
            last_seen_at: r.last_seen_at,
            is_self: r.is_self != 0,
        }
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
    use crate::db;

    async fn make_dir() -> Directory {
        Directory::new(db::open_in_memory().await)
    }

    #[tokio::test]
    async fn upsert_self_creates_row_marked_is_self() {
        let dir = make_dir().await;
        dir.upsert_self("node-self", Some("me"), Some("hi"), Some("bk3"))
            .await
            .unwrap();

        let got = dir.get("node-self").await.unwrap().expect("present");
        assert!(got.is_self);
        assert_eq!(got.display_name.as_deref(), Some("me"));
        assert_eq!(got.bio.as_deref(), Some("hi"));
        assert_eq!(got.avatar_blake3.as_deref(), Some("bk3"));
        assert_eq!(got.first_seen_at, got.last_seen_at);
    }

    #[tokio::test]
    async fn upsert_self_partial_update_preserves_existing_fields() {
        let dir = make_dir().await;
        dir.upsert_self("n", Some("name1"), Some("bio1"), Some("av1"))
            .await
            .unwrap();
        // pass None for everything except node_id; existing values must remain.
        dir.upsert_self("n", None, None, None).await.unwrap();

        let got = dir.get("n").await.unwrap().unwrap();
        assert_eq!(got.display_name.as_deref(), Some("name1"));
        assert_eq!(got.bio.as_deref(), Some("bio1"));
        assert_eq!(got.avatar_blake3.as_deref(), Some("av1"));
        assert!(got.is_self);
    }

    #[tokio::test]
    async fn touch_creates_minimal_peer_row() {
        let dir = make_dir().await;
        dir.touch("peer-1").await.unwrap();
        let got = dir.get("peer-1").await.unwrap().expect("present");
        assert!(!got.is_self);
        assert!(got.display_name.is_none());
        assert!(got.bio.is_none());
        assert!(got.avatar_blake3.is_none());
    }

    #[tokio::test]
    async fn touch_updates_last_seen_only() {
        let dir = make_dir().await;
        dir.touch("p").await.unwrap();
        let first = dir.get("p").await.unwrap().unwrap();
        // sleep past the 1s timestamp resolution so last_seen_at can advance.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        dir.touch("p").await.unwrap();
        let second = dir.get("p").await.unwrap().unwrap();
        assert_eq!(first.first_seen_at, second.first_seen_at);
        assert!(second.last_seen_at >= first.last_seen_at);
    }

    #[tokio::test]
    async fn upsert_profile_writes_then_merges() {
        let dir = make_dir().await;
        dir.upsert_profile("p", Some("alice"), Some("hello"), Some("av-a"))
            .await
            .unwrap();
        let after_first = dir.get("p").await.unwrap().unwrap();
        assert_eq!(after_first.display_name.as_deref(), Some("alice"));

        // overwrite display_name only; bio + avatar must be preserved.
        dir.upsert_profile("p", Some("alice2"), None, None)
            .await
            .unwrap();
        let after_second = dir.get("p").await.unwrap().unwrap();
        assert_eq!(after_second.display_name.as_deref(), Some("alice2"));
        assert_eq!(after_second.bio.as_deref(), Some("hello"));
        assert_eq!(after_second.avatar_blake3.as_deref(), Some("av-a"));
        assert!(!after_second.is_self);
    }

    #[tokio::test]
    async fn get_returns_none_for_unknown_node() {
        let dir = make_dir().await;
        assert!(dir.get("ghost").await.unwrap().is_none());
    }
}
