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
        sqlx::query!(
            r#"
            INSERT INTO hub_adminz (node_id, created_at)
            VALUES (?1, ?2)
            ON CONFLICT(node_id) DO NOTHING
            "#,
            node_id,
            now,
        )
        .execute(&self.pool)
        .await?;

        self.get(node_id)
            .await?
            .ok_or(AdminError::Sqlx(sqlx::Error::RowNotFound))
    }

    pub async fn get(&self, node_id: &str) -> Result<Option<Admin>, AdminError> {
        sqlx::query_as!(
            Admin,
            r#"SELECT node_id as "node_id!", created_at as "created_at!"
               FROM hub_adminz WHERE node_id = ?1"#,
            node_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AdminError::from)
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
        sqlx::query_as!(
            Admin,
            r#"SELECT node_id as "node_id!", created_at as "created_at!"
               FROM hub_adminz ORDER BY created_at ASC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AdminError::from)
    }

    pub async fn remove(&self, node_id: &str) -> Result<(), AdminError> {
        sqlx::query!("DELETE FROM hub_adminz WHERE node_id = ?1", node_id)
            .execute(&self.pool)
            .await?;
        Ok(())
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

    /// `hub_adminz` has no FK, no "self" concept, and no minimum-admin-count
    /// guard — `remove()` doesn't know or care whether `node_id` is the
    /// caller's own id or the last remaining admin. removing yourself (or
    /// the last admin) is allowed and leaves zero admins. this is judged
    /// acceptable rather than a bug: `adminz` mutations are only reachable
    /// via local CLI (`reliquary admin allow/remove`, see `main.rs`) — the
    /// remote `iroh/skein-hub-admin/1` protocol only ever mutates `friendz`
    /// (see `protocol::hub_admin::AdminRequest`), never `hub_adminz` itself
    /// — so a "lockout" is always recoverable by whoever already has
    /// filesystem/CLI access to the hub, never a remote-only footgun.
    #[tokio::test]
    async fn removing_the_last_admin_leaves_zero_admins_no_built_in_protection() {
        let pool = db::open_in_memory().await;
        let store = Store::new(pool);
        store.allow("only-admin").await.unwrap();
        assert!(store.is_admin("only-admin").await);

        // an admin removing their own node id (self-lockout) succeeds; the
        // store has no notion of "caller identity" to special-case.
        store.remove("only-admin").await.unwrap();
        assert!(!store.is_admin("only-admin").await);
        assert!(store.list().await.unwrap().is_empty());
    }

    /// `adminz` and `friendz` are documented as orthogonal concepts (see
    /// module doc comment): a node can be an admin, a friend, both, or
    /// neither, and mutating one table must never touch the other. verify
    /// this rather than trusting the comment.
    #[tokio::test]
    async fn admin_status_and_friend_status_are_independent() {
        let pool = db::open_in_memory().await;
        let admin_store = Store::new(pool.clone());
        let friend_store = crate::friendz::Store::new(pool.clone());
        let users = crate::userz::Directory::new(pool);

        users.touch("both-roles").await.unwrap();
        admin_store.allow("both-roles").await.unwrap();
        friend_store
            .upsert("both-roles", crate::friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();

        // a node can hold both roles simultaneously.
        assert!(admin_store.is_admin("both-roles").await);
        assert!(friend_store.is_friend("both-roles").await);

        // removing admin rights must not touch the friendz row.
        admin_store.remove("both-roles").await.unwrap();
        assert!(!admin_store.is_admin("both-roles").await);
        assert!(
            friend_store.is_friend("both-roles").await,
            "removing admin rights must not affect friend status"
        );

        // and the reverse: deleting the friendz row must not touch adminz.
        admin_store.allow("both-roles").await.unwrap();
        friend_store.delete("both-roles").await.unwrap();
        assert!(!friend_store.is_friend("both-roles").await);
        assert!(
            admin_store.is_admin("both-roles").await,
            "removing a friendz row must not affect admin status"
        );
    }

    /// `allow()`'s `INSERT ... ON CONFLICT(node_id) DO NOTHING` followed by
    /// a separate `get()` (rather than trusting a locally-built `Admin`
    /// value) means a concurrent call for the same node id from two
    /// different requests should always converge on the same row — whoever
    /// wins the INSERT race, every caller re-reads the actual row afterward.
    /// uses a real file-backed pool (multiple connections) + a multi-thread
    /// runtime so the race is actually exercised, unlike `open_in_memory()`'s
    /// single-connection pool used by the rest of this module's tests.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent_allow_same_node_id_never_errors_and_converges() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = crate::db::open(tmp.path()).await.expect("open db");
        let store = Store::new(pool);

        let mut handles = Vec::new();
        for _ in 0..8 {
            let store = store.clone();
            handles.push(tokio::spawn(
                async move { store.allow("racing-admin").await },
            ));
        }

        let mut created_ats = std::collections::HashSet::new();
        for h in handles {
            let admin = h
                .await
                .expect("task panicked")
                .expect("allow must not error on a race");
            created_ats.insert(admin.created_at);
        }

        // every racing caller must have converged on the same row.
        assert_eq!(created_ats.len(), 1);
        let admins = store.list().await.unwrap();
        assert_eq!(admins.len(), 1);
    }
}
