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
