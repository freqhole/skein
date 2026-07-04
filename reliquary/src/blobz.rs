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
            .register_path(&src_path, None, None, None)
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
            .register_path(&src_path, None, None, Some(&cb))
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
            .register_path(Path::new("relative/path.bin"), None, None, None)
            .await
            .expect_err("relative path must be rejected");
        assert!(matches!(err, BlobError::Io(_)));
    }
}
