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
