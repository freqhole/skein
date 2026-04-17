//! blobz: generic file blob store.
//!
//! keyed by blake3 (hex). each blob has both a filesystem copy (under
//! `data_dir/blob-files/<prefix>/<blake3>`) and a row in the `blobz` table
//! with metadata + iroh hash. no entity_id, no domain — a blob is a blob.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;

const BLOB_FILES_DIR: &str = "blob-files";

#[derive(Debug, Error)]
pub enum BlobError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("blake3 mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobRef {
    pub blake3: String,
    pub iroh_hash: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size: i64,
    pub path: String,
    pub created_at: i64,
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    blob_dir: PathBuf,
}

impl Store {
    pub fn new(pool: SqlitePool, data_dir: &Path) -> Self {
        let blob_dir = data_dir.join(BLOB_FILES_DIR);
        Self { pool, blob_dir }
    }

    /// insert a new blob: writes bytes to disk and creates a row. if the
    /// blake3 is already present, returns the existing ref without rewriting.
    pub async fn insert(
        &self,
        iroh_hash: String,
        filename: Option<String>,
        mime: Option<String>,
        bytes: &[u8],
    ) -> Result<BlobRef, BlobError> {
        let blake3 = blake3::hash(bytes).to_hex().to_string();

        if let Some(existing) = self.get(&blake3).await? {
            return Ok(existing);
        }

        let (prefix, rest) = blake3.split_at(2);
        let dir = self.blob_dir.join(prefix);
        tokio::fs::create_dir_all(&dir).await?;
        let abs_path = dir.join(rest);
        tokio::fs::write(&abs_path, bytes).await?;

        let rel_path = format!("{prefix}/{rest}");
        let size = bytes.len() as i64;
        let created_at = now_secs();

        sqlx::query(
            r#"
            INSERT INTO blobz (blake3, iroh_hash, filename, mime, size, path, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
        )
        .bind(&blake3)
        .bind(&iroh_hash)
        .bind(&filename)
        .bind(&mime)
        .bind(size)
        .bind(&rel_path)
        .bind(created_at)
        .execute(&self.pool)
        .await?;

        Ok(BlobRef {
            blake3,
            iroh_hash,
            filename,
            mime,
            size,
            path: rel_path,
            created_at,
        })
    }

    pub async fn get(&self, blake3: &str) -> Result<Option<BlobRef>, BlobError> {
        let row = sqlx::query_as::<_, BlobRow>(
            r#"
            SELECT blake3, iroh_hash, filename, mime, size, path, created_at
            FROM blobz WHERE blake3 = ?1
            "#,
        )
        .bind(blake3)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Into::into))
    }

    pub async fn get_by_iroh_hash(
        &self,
        iroh_hash: &str,
    ) -> Result<Option<BlobRef>, BlobError> {
        let row = sqlx::query_as::<_, BlobRow>(
            r#"
            SELECT blake3, iroh_hash, filename, mime, size, path, created_at
            FROM blobz WHERE iroh_hash = ?1
            "#,
        )
        .bind(iroh_hash)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Into::into))
    }

    pub fn path_for(&self, blob: &BlobRef) -> PathBuf {
        self.blob_dir.join(&blob.path)
    }

    pub async fn read_bytes(&self, blake3: &str) -> Result<Option<Vec<u8>>, BlobError> {
        let Some(blob) = self.get(blake3).await? else {
            return Ok(None);
        };
        let bytes = tokio::fs::read(self.path_for(&blob)).await?;
        Ok(Some(bytes))
    }

    pub async fn list(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<BlobRef>, BlobError> {
        let rows = sqlx::query_as::<_, BlobRow>(
            r#"
            SELECT blake3, iroh_hash, filename, mime, size, path, created_at
            FROM blobz
            ORDER BY created_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn delete(&self, blake3: &str) -> Result<(), BlobError> {
        if let Some(blob) = self.get(blake3).await? {
            let path = self.path_for(&blob);
            let _ = tokio::fs::remove_file(&path).await;
        }
        sqlx::query("DELETE FROM blobz WHERE blake3 = ?1")
            .bind(blake3)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct BlobRow {
    blake3: String,
    iroh_hash: String,
    filename: Option<String>,
    mime: Option<String>,
    size: i64,
    path: String,
    created_at: i64,
}

impl From<BlobRow> for BlobRef {
    fn from(r: BlobRow) -> Self {
        Self {
            blake3: r.blake3,
            iroh_hash: r.iroh_hash,
            filename: r.filename,
            mime: r.mime,
            size: r.size,
            path: r.path,
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
