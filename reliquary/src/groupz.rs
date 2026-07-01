//! groupz: free-form named friend groups used by the social UI.
//!
//! one row per group name. `color` is a 0xRRGGBB integer, defaults to 0.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GroupError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub name: String,
    pub color: i64,
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

    /// idempotent: insert if missing, update color if present.
    pub async fn upsert(&self, name: &str, color: i64) -> Result<Group, GroupError> {
        let now = now_secs();
        sqlx::query!(
            r#"
            INSERT INTO friend_groupz (name, color, created_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(name) DO UPDATE SET color = excluded.color
            "#,
            name,
            color,
            now,
        )
        .execute(&self.pool)
        .await?;
        Ok(self.get(name).await?.expect("group present after upsert"))
    }

    pub async fn get(&self, name: &str) -> Result<Option<Group>, GroupError> {
        sqlx::query_as!(
            Group,
            r#"SELECT name as "name!", color as "color!", created_at as "created_at!"
               FROM friend_groupz WHERE name = ?1"#,
            name,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(GroupError::from)
    }

    pub async fn list(&self) -> Result<Vec<Group>, GroupError> {
        sqlx::query_as!(
            Group,
            r#"SELECT name as "name!", color as "color!", created_at as "created_at!"
               FROM friend_groupz ORDER BY created_at ASC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(GroupError::from)
    }

    pub async fn delete(&self, name: &str) -> Result<(), GroupError> {
        sqlx::query!("DELETE FROM friend_groupz WHERE name = ?1", name)
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
