//! adminz: hub administrators allowed to manage the friendz allow-list
//! remotely, over the `iroh/skein-hub-admin/1` protocol (see
//! `protocol::hub_admin`).
//!
//! this is a deliberately separate concept from `friendz::FriendStatus`:
//! being an admin says nothing about being a friend (an admin doesn't need
//! a canvas-sharing relationship with the hub to manage its allow-list), and
//! being a friend says nothing about being an admin (most friends should
//! never be able to touch the allow-list). one row per admin node id, no
//! extra state — there's no "pending admin" or "blocked admin" concept,
//! unlike `friendz`.
//!
//! populated locally via `reliquary admin allow/remove/list` (mirrors
//! `reliquary friend allow/remove/list`), and consulted on every inbound
//! `iroh/skein-hub-admin/1` request before acting.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AdminError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Admin {
    pub node_id: String,
    pub created_at: i64,
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// grant admin rights to a node id. idempotent — allowing an
    /// already-admin peer again is a no-op that returns the existing row.
    pub async fn allow(&self, node_id: &str) -> Result<Admin, AdminError> {
        let now = now_secs();
        sqlx::query(
            r#"
            INSERT INTO hub_adminz (node_id, created_at)
            VALUES (?1, ?2)
            ON CONFLICT(node_id) DO NOTHING
            "#,
        )
        .bind(node_id)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get(node_id)
            .await?
            .ok_or(AdminError::Sqlx(sqlx::Error::RowNotFound))
    }

    pub async fn get(&self, node_id: &str) -> Result<Option<Admin>, AdminError> {
        let row = sqlx::query_as::<_, AdminRow>(
            "SELECT node_id, created_at FROM hub_adminz WHERE node_id = ?1",
        )
        .bind(node_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(Into::into))
    }

    /// check whether `node_id` is a hub admin. returns `false` (and logs) on
    /// a store error rather than propagating, since callers use this as a
    /// yes/no gate on a hot request path.
    pub async fn is_admin(&self, node_id: &str) -> bool {
        match self.get(node_id).await {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(e) => {
                tracing::warn!(peer = %node_id, error = %e, "is_admin: hub_adminz store error");
                false
            }
        }
    }

    pub async fn list(&self) -> Result<Vec<Admin>, AdminError> {
        let rows: Vec<AdminRow> =
            sqlx::query_as("SELECT node_id, created_at FROM hub_adminz ORDER BY created_at ASC")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn remove(&self, node_id: &str) -> Result<(), AdminError> {
        sqlx::query("DELETE FROM hub_adminz WHERE node_id = ?1")
            .bind(node_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct AdminRow {
    node_id: String,
    created_at: i64,
}

impl From<AdminRow> for Admin {
    fn from(r: AdminRow) -> Self {
        Self {
            node_id: r.node_id,
            created_at: r.created_at,
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

    #[tokio::test]
    async fn allow_inserts_then_is_idempotent() {
        let pool = db::open_in_memory().await;
        let store = Store::new(pool);

        let first = store.allow("node-a").await.unwrap();
        assert_eq!(first.node_id, "node-a");

        // second call should be a no-op, not an error, and should keep the
        // original created_at.
        let second = store.allow("node-a").await.unwrap();
        assert_eq!(second.created_at, first.created_at);

        assert_eq!(store.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn is_admin_true_for_allowed_false_otherwise() {
        let pool = db::open_in_memory().await;
        let store = Store::new(pool);
        store.allow("node-a").await.unwrap();

        assert!(store.is_admin("node-a").await);
        assert!(!store.is_admin("node-b").await);
    }

    #[tokio::test]
    async fn remove_revokes_admin_rights() {
        let pool = db::open_in_memory().await;
        let store = Store::new(pool);
        store.allow("node-a").await.unwrap();
        assert!(store.is_admin("node-a").await);

        store.remove("node-a").await.unwrap();
        assert!(!store.is_admin("node-a").await);

        // removing a never-admin node id is a no-op.
        store.remove("never-existed").await.unwrap();
    }

    #[tokio::test]
    async fn list_returns_all_admins_in_creation_order() {
        let pool = db::open_in_memory().await;
        let store = Store::new(pool);
        for n in ["a", "b", "c"] {
            store.allow(n).await.unwrap();
        }

        let admins = store.list().await.unwrap();
        assert_eq!(admins.len(), 3);
        assert_eq!(
            admins
                .iter()
                .map(|a| a.node_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }
}
