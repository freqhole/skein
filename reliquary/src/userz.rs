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
    pub async fn upsert_self(
        &self,
        node_id: &str,
        display_name: Option<&str>,
    ) -> Result<(), UserError> {
        let now = now_secs();
        sqlx::query(
            r#"
            INSERT INTO userz (node_id, display_name, first_seen_at, last_seen_at, is_self)
            VALUES (?1, ?2, ?3, ?3, 1)
            ON CONFLICT(node_id) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, userz.display_name),
                last_seen_at = excluded.last_seen_at,
                is_self = 1
            "#,
        )
        .bind(node_id)
        .bind(display_name)
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

    /// update a peer's profile (display_name + avatar). any None fields are
    /// left untouched.
    pub async fn upsert_profile(
        &self,
        node_id: &str,
        display_name: Option<&str>,
        avatar_blake3: Option<&str>,
    ) -> Result<(), UserError> {
        let now = now_secs();
        sqlx::query(
            r#"
            INSERT INTO userz (node_id, display_name, avatar_blake3, first_seen_at, last_seen_at, is_self)
            VALUES (?1, ?2, ?3, ?4, ?4, 0)
            ON CONFLICT(node_id) DO UPDATE SET
                display_name  = COALESCE(excluded.display_name,  userz.display_name),
                avatar_blake3 = COALESCE(excluded.avatar_blake3, userz.avatar_blake3),
                last_seen_at  = excluded.last_seen_at
            "#,
        )
        .bind(node_id)
        .bind(display_name)
        .bind(avatar_blake3)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get(&self, node_id: &str) -> Result<Option<PeerRecord>, UserError> {
        let row = sqlx::query_as::<_, PeerRow>(
            r#"
            SELECT node_id, display_name, avatar_blake3, first_seen_at, last_seen_at, is_self
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
