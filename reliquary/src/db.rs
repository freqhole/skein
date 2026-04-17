//! database handle: a single sqlx `SqlitePool` used by all reliquary modules.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use thiserror::Error;

pub const DB_FILENAME: &str = "skein-hub.db";

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// open (creating if needed) the skein sqlite db under `data_dir` and run
/// migrations. returns a cloneable pool.
pub async fn open(data_dir: &Path) -> Result<SqlitePool, DbError> {
    tokio::fs::create_dir_all(data_dir).await?;
    let db_path = data_dir.join(DB_FILENAME);

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrationz").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
pub(crate) async fn open_in_memory() -> SqlitePool {
    // each :memory: connection is a separate database — share-cache + a single
    // connection ensures every checked-out connection sees the same schema and
    // rows. ideal for fast, isolated unit tests.
    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("connect in-memory sqlite");

    sqlx::migrate!("./migrationz")
        .run(&pool)
        .await
        .expect("run migrations on in-memory sqlite");

    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_creates_db_file_and_runs_migrations() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = open(tmp.path()).await.expect("open db");

        // confirm at least one of the expected tables exists by querying it.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blobz")
            .fetch_one(&pool)
            .await
            .expect("query blobz table");
        assert_eq!(count.0, 0);

        // db file should be on disk under data_dir.
        assert!(tmp.path().join(DB_FILENAME).exists());
    }

    #[tokio::test]
    async fn in_memory_helper_runs_migrations() {
        let pool = open_in_memory().await;
        // expect every migrated table to be queryable.
        for table in ["blobz", "userz", "friendz", "docz", "doc_deltaz"] {
            let q = format!("SELECT COUNT(*) FROM {table}");
            let (c,): (i64,) = sqlx::query_as(&q)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("query {table}: {e}"));
            assert_eq!(c, 0, "fresh table {table} should be empty");
        }
    }
}
