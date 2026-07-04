//! blobz: generic file blob store.
//!
//! keyed by blake3 (hex). each blob has both a filesystem copy (under
//! `data_dir/blob-files/<prefix>/<blake3>`) and a row in the `blobz` table
//! with metadata + iroh hash. no entity_id, no domain — a blob is a blob.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

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

    #[error("upload cancelled")]
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobRef {
    pub blake3: String,
    pub iroh_hash: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size: i64,
    /// when `external` is true, this is an absolute path the store does not
    /// own. when false, this is a relative path under `<data_dir>/blob-files/`.
    pub path: String,
    pub external: bool,
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

        // fast path: avoid the disk write below if we already have this
        // content. this is only an optimization, not a correctness
        // guarantee — two callers can both miss here and race into the
        // insert below, which is why the insert itself must be safe against
        // a concurrent duplicate (see the `ON CONFLICT` note there).
        if let Some(existing) = self.get(&blake3).await? {
            return Ok(existing);
        }

        let (prefix, rest) = blake3.split_at(2);
        let dir = self.blob_dir.join(prefix);
        tokio::fs::create_dir_all(&dir).await?;
        let abs_path = dir.join(rest);
        // same content -> same bytes at the same content-addressed path, so
        // a second concurrent writer clobbering this file is harmless.
        tokio::fs::write(&abs_path, bytes).await?;

        let rel_path = format!("{prefix}/{rest}");
        let size = bytes.len() as i64;
        let created_at = now_secs();

        // `ON CONFLICT DO NOTHING`: blake3 is the primary key, so two tasks
        // racing to insert the same content (both having missed the check
        // above) must not surface a unique-constraint error to either
        // caller — the loser's insert silently no-ops and both callers read
        // back the same canonical row below.
        sqlx::query!(
            r#"
            INSERT INTO blobz (blake3, iroh_hash, filename, mime, size, path, external, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
            ON CONFLICT (blake3) DO NOTHING
            "#,
            blake3,
            iroh_hash,
            filename,
            mime,
            size,
            rel_path,
            created_at,
        )
        .execute(&self.pool)
        .await?;

        let stored = self
            .get(&blake3)
            .await?
            .expect("row must exist immediately after insert-or-ignore");
        Ok(stored)
    }

    /// the canonical content-addressed absolute path for a blake3 hash
    /// (`<blob_dir>/<2-char-prefix>/<rest>`), creating the parent directory.
    /// used by callers that place the bytes themselves (e.g. a streamed
    /// export from an iroh-blobs store) before `register_ingested`.
    pub async fn prepare_canonical_path(&self, blake3: &str) -> Result<PathBuf, BlobError> {
        let (prefix, rest) = blake3.split_at(2);
        let dir = self.blob_dir.join(prefix);
        tokio::fs::create_dir_all(&dir).await?;
        Ok(dir.join(rest))
    }

    /// record metadata for a blob whose bytes were already written to the
    /// canonical content-addressed path by the caller (see
    /// `prepare_canonical_path`). unlike `insert`, the bytes never pass
    /// through memory here, and unlike `register_path`, no hashing pass
    /// runs — the caller vouches for the blake3 (e.g. it came out of a
    /// cryptographically verified iroh-blobs transfer). dedupes on blake3.
    pub async fn register_ingested(
        &self,
        blake3: String,
        filename: Option<String>,
        mime: Option<String>,
    ) -> Result<BlobRef, BlobError> {
        if let Some(existing) = self.get(&blake3).await? {
            return Ok(existing);
        }

        let (prefix, rest) = blake3.split_at(2);
        let rel_path = format!("{prefix}/{rest}");
        let abs_path = self.blob_dir.join(prefix).join(rest);
        let size = tokio::fs::metadata(&abs_path).await?.len() as i64;

        let iroh_hash = blake3.clone();
        let created_at = now_secs();

        // same ON CONFLICT reasoning as `insert` — racing duplicates no-op
        sqlx::query!(
            r#"
            INSERT INTO blobz (blake3, iroh_hash, filename, mime, size, path, external, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
            ON CONFLICT (blake3) DO NOTHING
            "#,
            blake3,
            iroh_hash,
            filename,
            mime,
            size,
            rel_path,
            created_at,
        )
        .execute(&self.pool)
        .await?;

        let stored = self
            .get(&blake3)
            .await?
            .expect("row must exist immediately after insert-or-ignore");
        Ok(stored)
    }

    /// register an existing on-disk file as a blob without copying its bytes.
    /// the file remains where it is; only metadata is recorded. callers are
    /// responsible for not deleting/moving the file out from under the store.    ///
    /// streams the file through blake3 so large files don't have to be loaded
    /// into memory. dedupes on blake3 — if the same content is already
    /// registered (external or not), returns the existing ref.
    ///
    /// `on_progress`, if provided, is called periodically (roughly every 4MB
    /// read, plus once at 100% completion) with `(bytes_read, total_size)` —
    /// throttled internally so a large file doesn't fire thousands of calls.
    /// callers (e.g. tauri's `blob_insert_from_path`) can use this to push
    /// incremental progress to the frontend during the hashing pass, which is
    /// the only genuinely slow part of registering a large file (the file
    /// itself is never copied — see above).
    pub async fn register_path(
        &self,
        abs_path: &Path,
        filename: Option<String>,
        mime: Option<String>,
        on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
        cancel: Option<&AtomicBool>,
    ) -> Result<BlobRef, BlobError> {
        if !abs_path.is_absolute() {
            return Err(BlobError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("register_path requires an absolute path, got {abs_path:?}"),
            )));
        }

        let total_size = tokio::fs::metadata(abs_path).await?.len();

        // stream the file through blake3 + count bytes.
        use tokio::io::AsyncReadExt;
        let mut file = tokio::fs::File::open(abs_path).await?;
        let mut hasher = blake3::Hasher::new();
        let mut size: i64 = 0;
        let mut since_last_report: u64 = 0;
        const PROGRESS_REPORT_BYTES: u64 = 4 * 1024 * 1024;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            if let Some(c) = cancel {
                if c.load(Ordering::Relaxed) {
                    return Err(BlobError::Cancelled);
                }
            }
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as i64;
            since_last_report += n as u64;
            if since_last_report >= PROGRESS_REPORT_BYTES {
                since_last_report = 0;
                if let Some(cb) = on_progress {
                    cb(size as u64, total_size);
                }
            }
        }
        drop(file);
        if let Some(cb) = on_progress {
            cb(size as u64, total_size);
        }
        let blake3_hex = hasher.finalize().to_hex().to_string();

        // see `insert()` for why a racing duplicate here is expected and
        // must not surface as an error — same reasoning applies.
        if let Some(existing) = self.get(&blake3_hex).await? {
            return Ok(existing);
        }

        let path_str = abs_path.to_string_lossy().to_string();
        let iroh_hash = blake3_hex.clone();
        let created_at = now_secs();

        sqlx::query!(
            r#"
            INSERT INTO blobz (blake3, iroh_hash, filename, mime, size, path, external, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
            ON CONFLICT (blake3) DO NOTHING
            "#,
            blake3_hex,
            iroh_hash,
            filename,
            mime,
            size,
            path_str,
            created_at,
        )
        .execute(&self.pool)
        .await?;

        let stored = self
            .get(&blake3_hex)
            .await?
            .expect("row must exist immediately after insert-or-ignore");
        Ok(stored)
    }

    pub async fn get(&self, blake3: &str) -> Result<Option<BlobRef>, BlobError> {
        let row = sqlx::query_as!(
            BlobRow,
            r#"
            SELECT blake3 as "blake3!", iroh_hash as "iroh_hash!", filename, mime,
                   size as "size!", path as "path!", external as "external!", created_at as "created_at!"
            FROM blobz WHERE blake3 = ?1 AND soft_deleted_at IS NULL
            "#,
            blake3,
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Into::into))
    }

    /// like `get`, but also returns soft-deleted blobs. used by the snatcher
    /// so that an admin-soft-deleted blob isn't re-downloaded on the next
    /// doc-change scan.
    pub async fn get_any(&self, blake3: &str) -> Result<Option<BlobRef>, BlobError> {
        let row = sqlx::query_as!(
            BlobRow,
            r#"
            SELECT blake3 as "blake3!", iroh_hash as "iroh_hash!", filename, mime,
                   size as "size!", path as "path!", external as "external!", created_at as "created_at!"
            FROM blobz WHERE blake3 = ?1
            "#,
            blake3,
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Into::into))
    }

    pub async fn get_by_iroh_hash(&self, iroh_hash: &str) -> Result<Option<BlobRef>, BlobError> {
        let row = sqlx::query_as!(
            BlobRow,
            r#"
            SELECT blake3 as "blake3!", iroh_hash as "iroh_hash!", filename, mime,
                   size as "size!", path as "path!", external as "external!", created_at as "created_at!"
            FROM blobz WHERE iroh_hash = ?1
            "#,
            iroh_hash,
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Into::into))
    }

    pub fn path_for(&self, blob: &BlobRef) -> PathBuf {
        if blob.external {
            PathBuf::from(&blob.path)
        } else {
            self.blob_dir.join(&blob.path)
        }
    }

    pub async fn read_bytes(&self, blake3: &str) -> Result<Option<Vec<u8>>, BlobError> {
        // uses get() which already excludes soft-deleted rows.
        let Some(blob) = self.get(blake3).await? else {
            return Ok(None);
        };
        let bytes = tokio::fs::read(self.path_for(&blob)).await?;
        Ok(Some(bytes))
    }

    pub async fn list(&self, limit: i64, offset: i64) -> Result<Vec<BlobRef>, BlobError> {
        let rows = sqlx::query_as!(
            BlobRow,
            r#"
            SELECT blake3 as "blake3!", iroh_hash as "iroh_hash!", filename, mime,
                   size as "size!", path as "path!", external as "external!", created_at as "created_at!"
            FROM blobz
            WHERE soft_deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
            limit,
            offset,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn delete(&self, blake3: &str) -> Result<(), BlobError> {
        if let Some(blob) = self.get(blake3).await? {
            // never touch external files — the user owns them.
            if !blob.external {
                let path = self.path_for(&blob);
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
        sqlx::query!("DELETE FROM blobz WHERE blake3 = ?1", blake3)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// the absolute path to the blob-files directory.
    /// used by callers that need to stat the filesystem (e.g. admin DiskUsage).
    pub fn blob_dir(&self) -> &std::path::Path {
        &self.blob_dir
    }

    /// sum of all non-soft-deleted blob sizes and row count — used by the admin `DiskUsage` request.
    pub async fn total_usage(&self) -> Result<(u64, u64), BlobError> {
        let row = sqlx::query!(
            r#"SELECT COALESCE(SUM(size), 0) as "total_bytes!: i64",
                      COUNT(*)              as "count!: i64"
               FROM blobz
               WHERE soft_deleted_at IS NULL"#
        )
        .fetch_one(&self.pool)
        .await?;
        Ok((row.total_bytes as u64, row.count as u64))
    }

    /// sum of soft-deleted blob sizes and row count — for the admin DiskUsage report.
    pub async fn soft_deleted_usage(&self) -> Result<(u64, u64), BlobError> {
        let row = sqlx::query!(
            r#"SELECT COALESCE(SUM(size), 0) as "total_bytes!: i64",
                      COUNT(*)              as "count!: i64"
               FROM blobz
               WHERE soft_deleted_at IS NOT NULL"#
        )
        .fetch_one(&self.pool)
        .await?;
        Ok((row.total_bytes as u64, row.count as u64))
    }

    /// all blake3 hashes in the blobz table, including soft-deleted rows.
    ///
    /// used by the iroh-blobs gc protect callback: soft-deleted blobs keep
    /// their on-disk files intact (hard-delete is a separate admin action),
    /// so they must stay protected from gc until explicitly hard-deleted.
    /// external blobs (ExportMode::TryReference) are never touched by gc
    /// anyway (DataLocation::External is a no-op in the sweep), but keeping
    /// their redb rows alive costs nothing and avoids any edge cases.
    pub async fn list_all_iroh_hashes(&self) -> Result<Vec<String>, BlobError> {
        let rows = sqlx::query!(r#"SELECT blake3 as "blake3!" FROM blobz"#)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|r| r.blake3).collect())
    }

    /// all non-soft-deleted blobs, most recently created first, without pagination.
    /// used by the admin `BlobUsage` request.
    pub async fn list_all(&self) -> Result<Vec<BlobRef>, BlobError> {
        let rows = sqlx::query_as!(
            BlobRow,
            r#"SELECT blake3 as "blake3!", iroh_hash as "iroh_hash!", filename, mime,
                      size as "size!", path as "path!", external as "external!",
                      created_at as "created_at!"
               FROM blobz
               WHERE soft_deleted_at IS NULL
               ORDER BY created_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// mark the given blake3 hashes as soft-deleted with the given actor.
    /// rows that don't exist or are already soft-deleted are added to `failed`.
    /// returns (affected_count, failed_blake3s). does NOT touch files.
    pub async fn soft_delete(
        &self,
        blake3s: &[String],
        actor: &str,
    ) -> Result<(u64, Vec<String>), BlobError> {
        let now = now_secs();
        let mut affected = 0u64;
        let mut failed = Vec::new();

        for hash in blake3s {
            let result = sqlx::query!(
                r#"UPDATE blobz
                   SET soft_deleted_at = ?1, soft_deleted_by = ?2
                   WHERE blake3 = ?3 AND soft_deleted_at IS NULL"#,
                now,
                actor,
                hash,
            )
            .execute(&self.pool)
            .await?;

            if result.rows_affected() == 0 {
                failed.push(hash.clone());
            } else {
                affected += 1;
            }
        }

        Ok((affected, failed))
    }

    /// clear soft-delete markers on the given blake3 hashes (restore them).
    /// rows that are not currently soft-deleted are added to `failed`.
    /// returns (affected_count, failed_blake3s).
    pub async fn restore(&self, blake3s: &[String]) -> Result<(u64, Vec<String>), BlobError> {
        let mut affected = 0u64;
        let mut failed = Vec::new();

        for hash in blake3s {
            let result = sqlx::query!(
                r#"UPDATE blobz
                   SET soft_deleted_at = NULL, soft_deleted_by = NULL
                   WHERE blake3 = ?1 AND soft_deleted_at IS NOT NULL"#,
                hash,
            )
            .execute(&self.pool)
            .await?;

            if result.rows_affected() == 0 {
                failed.push(hash.clone());
            } else {
                affected += 1;
            }
        }

        Ok((affected, failed))
    }

    /// paginated list of non-soft-deleted blobs with total count.
    /// limit 0 is treated as default 50; capped at 200.
    pub async fn list_paginated_with_count(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<BlobRef>, u64), BlobError> {
        let count_row = sqlx::query!(
            r#"SELECT COUNT(*) as "count!: i64" FROM blobz WHERE soft_deleted_at IS NULL"#
        )
        .fetch_one(&self.pool)
        .await?;
        let total = count_row.count as u64;

        let rows = sqlx::query_as!(
            BlobRow,
            r#"SELECT blake3 as "blake3!", iroh_hash as "iroh_hash!", filename, mime,
                      size as "size!", path as "path!", external as "external!",
                      created_at as "created_at!"
               FROM blobz
               WHERE soft_deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT ?1 OFFSET ?2"#,
            limit,
            offset,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok((rows.into_iter().map(Into::into).collect(), total))
    }

    /// paginated list of soft-deleted blobs with total count.
    /// limit 0 is treated as default 50; capped at 200.
    pub async fn list_soft_deleted_with_count(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<SoftDeletedBlobRef>, u64), BlobError> {
        let count_row = sqlx::query!(
            r#"SELECT COUNT(*) as "count!: i64" FROM blobz WHERE soft_deleted_at IS NOT NULL"#
        )
        .fetch_one(&self.pool)
        .await?;
        let total = count_row.count as u64;

        let rows = sqlx::query_as!(
            SoftDeletedRow,
            r#"SELECT blake3 as "blake3!", filename, mime,
                      size as "size!", soft_deleted_at as "soft_deleted_at!: i64",
                      soft_deleted_by as "soft_deleted_by!"
               FROM blobz
               WHERE soft_deleted_at IS NOT NULL
               ORDER BY soft_deleted_at DESC
               LIMIT ?1 OFFSET ?2"#,
            limit,
            offset,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok((rows.into_iter().map(Into::into).collect(), total))
    }

    /// list all soft-deleted blobs for the admin panel.
    pub async fn list_soft_deleted(&self) -> Result<Vec<SoftDeletedBlobRef>, BlobError> {
        let rows = sqlx::query_as!(
            SoftDeletedRow,
            r#"SELECT blake3 as "blake3!", filename, mime,
                      size as "size!", soft_deleted_at as "soft_deleted_at!: i64",
                      soft_deleted_by as "soft_deleted_by!"
               FROM blobz
               WHERE soft_deleted_at IS NOT NULL
               ORDER BY soft_deleted_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// permanently delete soft-deleted blobs.
    ///
    /// if `blake3s` is `None`, purges every soft-deleted row. if it's `Some`,
    /// only rows that are currently soft-deleted qualify — blobs in the list
    /// that aren't soft-deleted are reported in `failed`. for managed (non-
    /// external) blobs, the on-disk file is unlinked; for external blobs,
    /// only the row is removed (the user owns the file). returns
    /// (deleted_count, failed_blake3s).
    pub async fn hard_delete_soft_deleted(
        &self,
        blake3s: Option<&[String]>,
    ) -> Result<(u64, Vec<String>), BlobError> {
        let mut deleted = 0u64;
        let mut failed: Vec<String> = Vec::new();

        if let Some(hashes) = blake3s {
            for hash in hashes {
                // only qualify rows that ARE soft-deleted
                let maybe_row = sqlx::query_as!(
                    BlobRow,
                    r#"SELECT blake3 as "blake3!", iroh_hash as "iroh_hash!", filename, mime,
                              size as "size!", path as "path!", external as "external!",
                              created_at as "created_at!"
                       FROM blobz
                       WHERE blake3 = ?1 AND soft_deleted_at IS NOT NULL"#,
                    hash,
                )
                .fetch_optional(&self.pool)
                .await?;

                match maybe_row {
                    None => failed.push(hash.clone()),
                    Some(row) => {
                        let blob: BlobRef = row.into();
                        if !blob.external {
                            let _ = tokio::fs::remove_file(self.path_for(&blob)).await;
                        }
                        sqlx::query!("DELETE FROM blobz WHERE blake3 = ?1", hash)
                            .execute(&self.pool)
                            .await?;
                        deleted += 1;
                    }
                }
            }
        } else {
            // purge ALL soft-deleted rows
            let rows = sqlx::query_as!(
                BlobRow,
                r#"SELECT blake3 as "blake3!", iroh_hash as "iroh_hash!", filename, mime,
                          size as "size!", path as "path!", external as "external!",
                          created_at as "created_at!"
                   FROM blobz
                   WHERE soft_deleted_at IS NOT NULL"#,
            )
            .fetch_all(&self.pool)
            .await?;

            for row in rows {
                let blob: BlobRef = row.into();
                if !blob.external {
                    let _ = tokio::fs::remove_file(self.path_for(&blob)).await;
                }
                sqlx::query!("DELETE FROM blobz WHERE blake3 = ?1", blob.blake3)
                    .execute(&self.pool)
                    .await?;
                deleted += 1;
            }
        }

        Ok((deleted, failed))
    }
}

/// a soft-deleted blob row, as returned by `list_soft_deleted`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoftDeletedBlobRef {
    pub blake3: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size: u64,
    pub soft_deleted_at: i64,
    pub soft_deleted_by: String,
}

#[derive(Debug)]
struct SoftDeletedRow {
    blake3: String,
    filename: Option<String>,
    mime: Option<String>,
    size: i64,
    soft_deleted_at: i64,
    soft_deleted_by: String,
}

impl From<SoftDeletedRow> for SoftDeletedBlobRef {
    fn from(r: SoftDeletedRow) -> Self {
        Self {
            blake3: r.blake3,
            filename: r.filename,
            mime: r.mime,
            size: r.size as u64,
            soft_deleted_at: r.soft_deleted_at,
            soft_deleted_by: r.soft_deleted_by,
        }
    }
}

#[derive(Debug)]
struct BlobRow {
    blake3: String,
    iroh_hash: String,
    filename: Option<String>,
    mime: Option<String>,
    size: i64,
    path: String,
    external: i64,
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
            external: r.external != 0,
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

    async fn make_store() -> (Store, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = db::open_in_memory().await;
        let store = Store::new(pool, tmp.path());
        (store, tmp)
    }

    #[tokio::test]
    async fn insert_then_get_round_trips() {
        let (store, _tmp) = make_store().await;
        let bytes = b"hello blobz";
        let blob = store
            .insert(
                "ihash-1".to_string(),
                Some("hello.txt".to_string()),
                Some("text/plain".to_string()),
                bytes,
            )
            .await
            .expect("insert");

        let expected_blake3 = blake3::hash(bytes).to_hex().to_string();
        assert_eq!(blob.blake3, expected_blake3);
        assert_eq!(blob.iroh_hash, "ihash-1");
        assert_eq!(blob.size, bytes.len() as i64);
        assert!(blob.path.starts_with(&blob.blake3[..2]));

        let got = store.get(&blob.blake3).await.unwrap().expect("found");
        assert_eq!(got.blake3, blob.blake3);
        assert_eq!(got.filename.as_deref(), Some("hello.txt"));
    }

    #[tokio::test]
    async fn insert_is_idempotent_on_duplicate_blake3() {
        let (store, _tmp) = make_store().await;
        let first = store
            .insert("ihash-a".into(), None, None, b"same bytes")
            .await
            .unwrap();
        // second insert with a different iroh_hash + filename should still
        // dedupe to the existing row (blake3 is the canonical id).
        let second = store
            .insert(
                "different-ihash".into(),
                Some("ignored.txt".into()),
                Some("text/plain".into()),
                b"same bytes",
            )
            .await
            .unwrap();
        assert_eq!(first.blake3, second.blake3);
        assert_eq!(first.iroh_hash, second.iroh_hash);
        assert_eq!(first.filename, second.filename);

        // exactly one row in the table.
        let rows = store.list(100, 0).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn read_bytes_returns_payload() {
        let (store, _tmp) = make_store().await;
        let payload = b"some bytes here";
        let blob = store.insert("h".into(), None, None, payload).await.unwrap();
        let read = store.read_bytes(&blob.blake3).await.unwrap();
        assert_eq!(read.as_deref(), Some(payload.as_ref()));
    }

    #[tokio::test]
    async fn get_returns_none_for_unknown_hash() {
        let (store, _tmp) = make_store().await;
        assert!(store.get("nope").await.unwrap().is_none());
        assert!(store.read_bytes("nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn get_by_iroh_hash_works() {
        let (store, _tmp) = make_store().await;
        let blob = store
            .insert("unique-iroh".into(), None, None, b"x")
            .await
            .unwrap();
        let got = store
            .get_by_iroh_hash("unique-iroh")
            .await
            .unwrap()
            .expect("present");
        assert_eq!(got.blake3, blob.blake3);
        assert!(store.get_by_iroh_hash("missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_orders_by_created_at_desc_with_limit_offset() {
        let (store, _tmp) = make_store().await;
        for i in 0u8..5 {
            // distinct payloads -> distinct blake3 -> distinct rows.
            // sleep a tick so created_at strictly increases (resolution = 1s).
            store
                .insert(format!("h{i}"), None, None, &[i; 8])
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        }
        let page = store.list(2, 0).await.unwrap();
        assert_eq!(page.len(), 2);
        assert!(page[0].created_at >= page[1].created_at);

        let next = store.list(2, 2).await.unwrap();
        assert_eq!(next.len(), 2);
        assert!(next[0].created_at <= page[1].created_at);
    }

    #[tokio::test]
    async fn delete_removes_row_and_file() {
        let (store, _tmp) = make_store().await;
        let blob = store.insert("h".into(), None, None, b"bye").await.unwrap();
        let path = store.path_for(&blob);
        assert!(path.exists());

        store.delete(&blob.blake3).await.unwrap();
        assert!(store.get(&blob.blake3).await.unwrap().is_none());
        assert!(!path.exists());

        // delete on missing row is a no-op (no error).
        store.delete("missing-blake3").await.unwrap();
    }

    #[tokio::test]
    async fn path_for_uses_2char_prefix_split() {
        let (store, _tmp) = make_store().await;
        let blob = store.insert("h".into(), None, None, b"a").await.unwrap();
        let path = store.path_for(&blob);
        let parent = path.parent().unwrap().file_name().unwrap();
        assert_eq!(parent.to_string_lossy().len(), 2);
        let fname = path.file_name().unwrap().to_string_lossy();
        assert_eq!(fname, blob.blake3[2..]);
    }

    /// concurrent inserts of the *same content* (same blake3) from different
    /// tasks must never surface a duplicate-key error to the caller — the
    /// store's job is to dedupe, not to leak a database-level race. this
    /// uses a real file-backed pool (multiple connections, like production's
    /// `db::open`) and a multi-thread runtime so the check-then-insert
    /// window in `insert()` can actually be hit by concurrent tasks, unlike
    /// `open_in_memory()`'s single-connection pool used by the rest of this
    /// module's tests.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent_inserts_of_same_content_never_error() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = crate::db::open(tmp.path()).await.expect("open db");
        let store = Store::new(pool, tmp.path());
        let bytes = b"racing bytes, same content every time";

        let mut handles = Vec::new();
        for i in 0..8 {
            let store = store.clone();
            handles.push(tokio::spawn(async move {
                store.insert(format!("ihash-{i}"), None, None, bytes).await
            }));
        }

        let mut blake3s = std::collections::HashSet::new();
        for h in handles {
            let result = h.await.expect("task panicked");
            let blob = result.expect("insert must not error on a content race");
            blake3s.insert(blob.blake3);
        }

        // all 8 racing inserts must have resolved to the same canonical row.
        assert_eq!(blake3s.len(), 1);
        let rows = store.list(100, 0).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn register_path_streams_without_copying_the_file() {
        let (store, tmp) = make_store().await;
        let src_dir = tempfile::tempdir().expect("src tempdir");
        let src_path = src_dir.path().join("original.bin");
        let payload = vec![7u8; 1024 * 1024]; // 1MB, distinct from any other test's bytes
        tokio::fs::write(&src_path, &payload).await.unwrap();

        let blob = store
            .register_path(
                &src_path,
                Some("original.bin".into()),
                Some("application/octet-stream".into()),
                None,
                None,
            )
            .await
            .expect("register_path");

        let expected_blake3 = blake3::hash(&payload).to_hex().to_string();
        assert_eq!(blob.blake3, expected_blake3);
        assert_eq!(blob.size, payload.len() as i64);
        // "external" — path_for() must point straight at the original file,
        // not a copy under the store's own blob-files dir.
        let resolved = store.path_for(&blob);
        assert_eq!(resolved, src_path);
        assert!(!resolved.starts_with(tmp.path().join(BLOB_FILES_DIR)));

        // dedup on a second call with the same content.
        let again = store
            .register_path(&src_path, None, None, None, None)
            .await
            .expect("register_path again");
        assert_eq!(again.blake3, blob.blake3);
        let rows = store.list(100, 0).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn register_path_reports_progress_and_reaches_100_percent() {
        let (store, _tmp) = make_store().await;
        let src_dir = tempfile::tempdir().expect("src tempdir");
        let src_path = src_dir.path().join("big.bin");
        // large enough to cross the 4MB progress-report threshold at least
        // once, so this test actually exercises the throttled-report path,
        // not just the unconditional final call.
        let payload = vec![9u8; 5 * 1024 * 1024];
        tokio::fs::write(&src_path, &payload).await.unwrap();

        let reports = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(u64, u64)>::new()));
        let reports_clone = reports.clone();
        let cb = move |read: u64, total: u64| {
            reports_clone.lock().unwrap().push((read, total));
        };

        let blob = store
            .register_path(&src_path, None, None, Some(&cb), None)
            .await
            .expect("register_path");

        let calls = reports.lock().unwrap();
        assert!(!calls.is_empty(), "expected at least one progress report");
        let (last_read, last_total) = *calls.last().unwrap();
        assert_eq!(last_read, blob.size as u64);
        assert_eq!(last_total, payload.len() as u64);
        // every reported total must agree — this file's size never changes
        // mid-read.
        assert!(calls
            .iter()
            .all(|(_, total)| *total == payload.len() as u64));
    }

    #[tokio::test]
    async fn register_path_rejects_relative_paths() {
        let (store, _tmp) = make_store().await;
        let err = store
            .register_path(Path::new("relative/path.bin"), None, None, None, None)
            .await
            .expect_err("relative path must be rejected");
        assert!(matches!(err, BlobError::Io(_)));
    }

    #[tokio::test]
    async fn register_path_cancelled_flag_returns_cancelled_error() {
        use std::sync::atomic::AtomicBool;
        let (store, _tmp) = make_store().await;
        let src_dir = tempfile::tempdir().expect("src tempdir");
        let src_path = src_dir.path().join("cancel.bin");
        // large enough that the cancel check fires during the read loop.
        let payload = vec![5u8; 2 * 1024 * 1024];
        tokio::fs::write(&src_path, &payload).await.unwrap();

        // pre-set the cancel flag before calling register_path so it
        // fires on the very first loop iteration.
        let cancel = AtomicBool::new(true);
        let err = store
            .register_path(&src_path, None, None, None, Some(&cancel))
            .await
            .expect_err("should have been cancelled");
        assert!(matches!(err, BlobError::Cancelled));
        assert_eq!(err.to_string(), "upload cancelled");
    }

    #[tokio::test]
    async fn total_usage_sums_sizes_and_counts_rows() {
        let (store, _tmp) = make_store().await;

        // empty store — both values should be zero
        let (bytes, count) = store.total_usage().await.unwrap();
        assert_eq!(bytes, 0);
        assert_eq!(count, 0);

        store
            .insert("h1".into(), None, None, b"hello")
            .await
            .unwrap();
        store
            .insert("h2".into(), None, None, b"world!!")
            .await
            .unwrap();

        let (bytes, count) = store.total_usage().await.unwrap();
        assert_eq!(count, 2);
        assert_eq!(bytes, (b"hello".len() + b"world!!".len()) as u64);
    }

    #[tokio::test]
    async fn list_all_returns_every_row_without_limit() {
        let (store, _tmp) = make_store().await;
        for i in 0u8..5 {
            store
                .insert(format!("h{i}"), None, None, &[i; 4])
                .await
                .unwrap();
        }
        let all = store.list_all().await.unwrap();
        assert_eq!(all.len(), 5);
    }

    // --- soft-delete tests ---

    #[tokio::test]
    async fn soft_delete_hides_from_get_list_total_usage_but_get_any_finds_it() {
        let (store, _tmp) = make_store().await;
        let blob = store
            .insert("h-sd".into(), Some("f.txt".into()), None, b"soft del me")
            .await
            .unwrap();

        let (_, count_before) = store.total_usage().await.unwrap();
        assert_eq!(count_before, 1);

        let (affected, failed) = store
            .soft_delete(&[blob.blake3.clone()], "admin-node")
            .await
            .unwrap();
        assert_eq!(affected, 1);
        assert!(failed.is_empty());

        // get() returns None after soft-delete
        assert!(store.get(&blob.blake3).await.unwrap().is_none());
        // read_bytes() returns None
        assert!(store.read_bytes(&blob.blake3).await.unwrap().is_none());
        // list() excludes it
        assert!(store.list(100, 0).await.unwrap().is_empty());
        // list_all() excludes it
        assert!(store.list_all().await.unwrap().is_empty());
        // total_usage() excludes it
        let (bytes, count) = store.total_usage().await.unwrap();
        assert_eq!(bytes, 0);
        assert_eq!(count, 0);

        // get_any() still finds it
        let found = store.get_any(&blob.blake3).await.unwrap();
        assert!(found.is_some());
    }

    #[tokio::test]
    async fn soft_delete_stamps_actor_and_list_soft_deleted_returns_it() {
        let (store, _tmp) = make_store().await;
        let blob = store
            .insert("h-actor".into(), None, None, b"actor test")
            .await
            .unwrap();

        store
            .soft_delete(&[blob.blake3.clone()], "node-abc123")
            .await
            .unwrap();

        let sd = store.list_soft_deleted().await.unwrap();
        assert_eq!(sd.len(), 1);
        assert_eq!(sd[0].blake3, blob.blake3);
        assert_eq!(sd[0].soft_deleted_by, "node-abc123");
        assert!(sd[0].soft_deleted_at > 0);
    }

    #[tokio::test]
    async fn soft_delete_already_deleted_row_goes_to_failed() {
        let (store, _tmp) = make_store().await;
        let blob = store
            .insert("h-dbl".into(), None, None, b"double del")
            .await
            .unwrap();

        store
            .soft_delete(&[blob.blake3.clone()], "a1")
            .await
            .unwrap();
        // second call: already soft-deleted — should land in failed
        let (affected, failed) = store
            .soft_delete(&[blob.blake3.clone()], "a2")
            .await
            .unwrap();
        assert_eq!(affected, 0);
        assert_eq!(failed, vec![blob.blake3.clone()]);
    }

    #[tokio::test]
    async fn restore_clears_soft_delete_marker() {
        let (store, _tmp) = make_store().await;
        let blob = store
            .insert("h-res".into(), None, None, b"restore me")
            .await
            .unwrap();

        store
            .soft_delete(&[blob.blake3.clone()], "actor")
            .await
            .unwrap();
        assert!(store.get(&blob.blake3).await.unwrap().is_none());

        let (affected, failed) = store.restore(&[blob.blake3.clone()]).await.unwrap();
        assert_eq!(affected, 1);
        assert!(failed.is_empty());

        // visible again after restore
        assert!(store.get(&blob.blake3).await.unwrap().is_some());
        assert!(store.list_soft_deleted().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn restore_non_soft_deleted_row_goes_to_failed() {
        let (store, _tmp) = make_store().await;
        let blob = store
            .insert("h-nores".into(), None, None, b"not deleted")
            .await
            .unwrap();

        let (affected, failed) = store.restore(&[blob.blake3.clone()]).await.unwrap();
        assert_eq!(affected, 0);
        assert_eq!(failed, vec![blob.blake3.clone()]);
    }

    #[tokio::test]
    async fn hard_delete_soft_deleted_unlinks_managed_file_and_row() {
        let (store, _tmp) = make_store().await;
        let blob = store
            .insert("h-hd".into(), None, None, b"hard del me")
            .await
            .unwrap();
        let path = store.path_for(&blob);
        assert!(path.exists());

        store
            .soft_delete(&[blob.blake3.clone()], "actor")
            .await
            .unwrap();
        let (deleted, failed) = store
            .hard_delete_soft_deleted(Some(&[blob.blake3.clone()]))
            .await
            .unwrap();
        assert_eq!(deleted, 1);
        assert!(failed.is_empty());

        // row is gone
        assert!(store.get_any(&blob.blake3).await.unwrap().is_none());
        // file is unlinked
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn hard_delete_refuses_non_soft_deleted_row() {
        let (store, _tmp) = make_store().await;
        let blob = store
            .insert("h-hd-ref".into(), None, None, b"live blob")
            .await
            .unwrap();

        let (deleted, failed) = store
            .hard_delete_soft_deleted(Some(&[blob.blake3.clone()]))
            .await
            .unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(failed, vec![blob.blake3.clone()]);
        // blob is still present
        assert!(store.get(&blob.blake3).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn soft_deleted_usage_counts_only_soft_deleted() {
        let (store, _tmp) = make_store().await;
        let b1 = store
            .insert("h-u1".into(), None, None, b"alive")
            .await
            .unwrap();
        let b2 = store
            .insert("h-u2".into(), None, None, b"soft")
            .await
            .unwrap();

        store
            .soft_delete(&[b2.blake3.clone()], "actor")
            .await
            .unwrap();

        let (sd_bytes, sd_count) = store.soft_deleted_usage().await.unwrap();
        assert_eq!(sd_count, 1);
        assert_eq!(sd_bytes, b2.size as u64);

        let (live_bytes, live_count) = store.total_usage().await.unwrap();
        assert_eq!(live_count, 1);
        assert_eq!(live_bytes, b1.size as u64);
    }
}
