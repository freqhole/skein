//! opens haruspex's own sqlite db for this hub's data directory and, the
//! first time that happens, copies skein's legacy `friendz`/`userz` rows
//! into it.
//!
//! haruspex owns a completely separate sqlite file (`haruspex.db`, a
//! sibling of this crate's own `skein-hub.db` under the same data
//! directory) - never a shared physical schema. before this module
//! existed, every friend edge and peer profile a hub had ever recorded
//! lived in this crate's own `friendz`/`userz` tables. those tables are
//! left in place, untouched, and are read here exactly once per data
//! directory to seed haruspex's equivalent stores; nothing else in this
//! crate reads them anymore.

use std::path::Path;

use haruspex::identity::PeerProfile;
use haruspex::sqlite::{OpenError, SqliteFriendStore, SqlitePeerDirectory};
use haruspex::stores::friend_store::{FriendDirection, FriendEdge, FriendStatus};
use haruspex::stores::{FriendStore, PeerDirectory};
use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("opening haruspex's own sqlite db: {0}")]
    Open(#[from] OpenError),
    #[error("reading skein's legacy friendz/userz rows: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("writing into haruspex's friendz/peerz stores: {0}")]
    Store(#[from] haruspex::error::StoreError),
}

/// open haruspex's own sqlite db under `data_dir` (a sibling file next to
/// this crate's own db, opened separately via [`crate::db::open`]) and
/// back-fill it from `skein_pool`'s legacy `friendz`/`userz` tables the
/// first time this ever runs against a given data directory.
///
/// idempotency: the friendz backfill runs only while haruspex's own friend
/// store is still empty, and the userz backfill only while haruspex's own
/// peer directory is still empty - checked independently, so either half
/// can complete on its own even if the other already has real rows in it
/// (e.g. from ordinary post-cutover traffic). once a store has any rows at
/// all, this is a no-op on every later boot - there's no dependence on it
/// ever running again.
pub async fn open(data_dir: &Path, skein_pool: &SqlitePool) -> Result<SqlitePool, BridgeError> {
    let haruspex_pool = haruspex::sqlite::open(data_dir).await?;
    if let Err(e) = backfill_friendz(skein_pool, &haruspex_pool).await {
        tracing::warn!(error = %e, "haruspex friendz backfill failed; continuing without it");
    }
    if let Err(e) = backfill_userz(skein_pool, &haruspex_pool).await {
        tracing::warn!(error = %e, "haruspex peerz backfill failed; continuing without it");
    }
    Ok(haruspex_pool)
}

#[derive(sqlx::FromRow)]
struct LegacyFriendRow {
    friend_node_id: String,
    status: String,
    direction: Option<String>,
    alias: Option<String>,
    group_name: Option<String>,
    created_at: i64,
    updated_at: i64,
}

async fn backfill_friendz(
    skein_pool: &SqlitePool,
    haruspex_pool: &SqlitePool,
) -> Result<(), BridgeError> {
    let store = SqliteFriendStore::new(haruspex_pool.clone());
    if !store.list_edges(None).await?.is_empty() {
        return Ok(());
    }

    let rows: Vec<LegacyFriendRow> = sqlx::query_as(
        r#"SELECT friend_node_id, status, direction, alias, group_name, created_at, updated_at
           FROM friendz"#,
    )
    .fetch_all(skein_pool)
    .await?;

    for row in rows {
        let Some(status) = FriendStatus::parse(&row.status) else {
            tracing::warn!(
                node_id = %row.friend_node_id,
                status = %row.status,
                "skipping legacy friendz row with unknown status during haruspex backfill"
            );
            continue;
        };
        let direction = row
            .direction
            .as_deref()
            .and_then(FriendDirection::parse)
            .unwrap_or(FriendDirection::Inbound);
        store
            .upsert_edge(FriendEdge {
                node_id: row.friend_node_id,
                status,
                direction,
                alias: row.alias,
                group_name: row.group_name,
                created_at: row.created_at,
                updated_at: row.updated_at,
            })
            .await?;
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct LegacyUserRow {
    node_id: String,
    display_name: Option<String>,
    alias: Option<String>,
    bio: Option<String>,
    avatar_blake3: Option<String>,
    accent_color: i64,
    first_seen_at: i64,
    last_seen_at: i64,
    is_self: i64,
    is_hub: i64,
}

async fn backfill_userz(
    skein_pool: &SqlitePool,
    haruspex_pool: &SqlitePool,
) -> Result<(), BridgeError> {
    let directory = SqlitePeerDirectory::new(haruspex_pool.clone());
    if !directory.list_profiles().await?.is_empty() {
        return Ok(());
    }

    let rows: Vec<LegacyUserRow> = sqlx::query_as(
        r#"SELECT node_id, display_name, alias, bio, avatar_blake3, accent_color,
                  first_seen_at, last_seen_at, is_self, is_hub
           FROM userz"#,
    )
    .fetch_all(skein_pool)
    .await?;

    for row in rows {
        directory
            .upsert_profile(PeerProfile {
                node_id: row.node_id,
                display_name: row.display_name,
                alias: row.alias,
                bio: row.bio,
                avatar_blake3: row.avatar_blake3,
                accent_color: Some(crate::userz::accent_color_to_hex(row.accent_color)),
                is_self: row.is_self != 0,
                is_hub: row.is_hub != 0,
                first_seen: row.first_seen_at,
                last_seen: row.last_seen_at,
            })
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seed_legacy_friend(pool: &SqlitePool, node_id: &str, narthex_doc_id: Option<&str>) {
        sqlx::query(
            r#"INSERT INTO friendz
               (friend_node_id, status, direction, alias, group_name, narthex_doc_id, created_at, updated_at)
               VALUES (?1, 'accepted', 'inbound', NULL, NULL, ?2, 100, 200)"#,
        )
        .bind(node_id)
        .bind(narthex_doc_id)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_legacy_user(pool: &SqlitePool, node_id: &str) {
        sqlx::query(
            r#"INSERT INTO userz
               (node_id, display_name, alias, bio, avatar_blake3, accent_color,
                first_seen_at, last_seen_at, is_self, is_hub)
               VALUES (?1, 'alice', NULL, 'hi', NULL, 0, 100, 200, 0, 0)"#,
        )
        .bind(node_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn backfill_copies_legacy_rows_into_haruspex_stores() {
        let skein_pool = crate::db::open_in_memory().await;
        seed_legacy_user(&skein_pool, "peer-a").await;
        seed_legacy_friend(&skein_pool, "peer-a", Some("doc-1")).await;

        let tmp = tempfile::tempdir().unwrap();
        let haruspex_pool = open(tmp.path(), &skein_pool).await.unwrap();

        let friend_store = SqliteFriendStore::new(haruspex_pool.clone());
        let edge = friend_store.get_edge("peer-a").await.unwrap().unwrap();
        assert_eq!(edge.status, FriendStatus::Accepted);
        assert_eq!(edge.direction, FriendDirection::Inbound);

        let directory = SqlitePeerDirectory::new(haruspex_pool);
        let profile = directory.get_profile("peer-a").await.unwrap().unwrap();
        assert_eq!(profile.display_name.as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn backfill_is_a_no_op_once_haruspex_stores_already_have_rows() {
        let skein_pool = crate::db::open_in_memory().await;
        seed_legacy_user(&skein_pool, "peer-a").await;
        seed_legacy_friend(&skein_pool, "peer-a", None).await;

        let tmp = tempfile::tempdir().unwrap();
        let haruspex_pool = open(tmp.path(), &skein_pool).await.unwrap();

        // add a second legacy row after the first backfill has already run,
        // then reopen against the same haruspex db - the store already has
        // rows, so the second legacy row must NOT get copied over.
        seed_legacy_user(&skein_pool, "peer-b").await;
        seed_legacy_friend(&skein_pool, "peer-b", None).await;
        backfill_friendz(&skein_pool, &haruspex_pool).await.unwrap();

        let friend_store = SqliteFriendStore::new(haruspex_pool);
        assert!(friend_store.get_edge("peer-a").await.unwrap().is_some());
        assert!(friend_store.get_edge("peer-b").await.unwrap().is_none());
    }
}
