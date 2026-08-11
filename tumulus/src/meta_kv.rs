//! meta_kv: generic single-device key-value store.
//!
//! mirrors the browser's "skein-meta" indexeddb kv object store (see
//! loam/src/storage/meta-db.ts) — small persisted values that are never
//! synced to any peer (doc-id pointers, anon device id, the messagez/social
//! local-kv doc state, etc). plain key/value pairs, no per-value schema.

use sqlx::SqlitePool;

/// read a value by key. returns `None` if the key doesn't exist.
pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM meta_kv WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(value,)| value))
}

/// write a value, overwriting any existing value for the same key.
pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO meta_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[tokio::test]
    async fn get_missing_key_returns_none() {
        let pool = open_in_memory().await;
        assert_eq!(get(&pool, "nope").await.unwrap(), None);
    }

    #[tokio::test]
    async fn set_then_get_roundtrips() {
        let pool = open_in_memory().await;
        set(&pool, "narthex-doc-id", "abc123").await.unwrap();
        assert_eq!(
            get(&pool, "narthex-doc-id").await.unwrap(),
            Some("abc123".to_string())
        );
    }

    #[tokio::test]
    async fn set_overwrites_existing_value() {
        let pool = open_in_memory().await;
        set(&pool, "k", "first").await.unwrap();
        set(&pool, "k", "second").await.unwrap();
        assert_eq!(get(&pool, "k").await.unwrap(), Some("second".to_string()));
    }
}
