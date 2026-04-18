//! settingz: tiny key/value store for app-wide settings.
//!
//! values are TEXT — callers coerce as needed. used for things like
//! `profile_visibility`, `friend_requests_from`, etc.

use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>, SettingsError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM settingz WHERE key = ?1")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|(v,)| v))
    }

    pub async fn set(&self, key: &str, value: &str) -> Result<(), SettingsError> {
        sqlx::query(
            r#"
            INSERT INTO settingz (key, value) VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            "#,
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// fetch with a fallback default. convenient for settings that always
    /// have a value.
    pub async fn get_or(&self, key: &str, default: &str) -> Result<String, SettingsError> {
        Ok(self.get(key).await?.unwrap_or_else(|| default.to_string()))
    }
}
