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
            INSERT INTO blobz (blake3, iroh_hash, filename, mime, size, path, external, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
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
            external: false,
            created_at,
        })
    }

    /// register an existing on-disk file as a blob without copying its bytes.
    /// the file remains where it is; only metadata is recorded. callers are
    /// responsible for not deleting/moving the file out from under the store.
    ///
    /// streams the file through blake3 so large files don't have to be loaded
    /// into memory. dedupes on blake3 — if the same content is already
    /// registered (external or not), returns the existing ref.
    pub async fn register_path(
        &self,
        abs_path: &Path,
        filename: Option<String>,
        mime: Option<String>,
    ) -> Result<BlobRef, BlobError> {
        if !abs_path.is_absolute() {
            return Err(BlobError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("register_path requires an absolute path, got {abs_path:?}"),
            )));
        }

        // stream the file through blake3 + count bytes.
        use tokio::io::AsyncReadExt;
        let mut file = tokio::fs::File::open(abs_path).await?;
        let mut hasher = blake3::Hasher::new();
        let mut size: i64 = 0;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as i64;
        }
        drop(file);
        let blake3_hex = hasher.finalize().to_hex().to_string();

        if let Some(existing) = self.get(&blake3_hex).await? {
            return Ok(existing);
        }

        let path_str = abs_path.to_string_lossy().to_string();
        let iroh_hash = blake3_hex.clone();
        let created_at = now_secs();

        sqlx::query(
            r#"
            INSERT INTO blobz (blake3, iroh_hash, filename, mime, size, path, external, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
            "#,
        )
        .bind(&blake3_hex)
        .bind(&iroh_hash)
        .bind(&filename)
        .bind(&mime)
        .bind(size)
        .bind(&path_str)
        .bind(created_at)
        .execute(&self.pool)
        .await?;

        Ok(BlobRef {
            blake3: blake3_hex,
            iroh_hash,
            filename,
            mime,
            size,
            path: path_str,
            external: true,
            created_at,
        })
    }

    pub async fn get(&self, blake3: &str) -> Result<Option<BlobRef>, BlobError> {
        let row = sqlx::query_as::<_, BlobRow>(
            r#"
            SELECT blake3, iroh_hash, filename, mime, size, path, external, created_at
            FROM blobz WHERE blake3 = ?1
            "#,
        )
        .bind(blake3)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Into::into))
    }

    pub async fn get_by_iroh_hash(&self, iroh_hash: &str) -> Result<Option<BlobRef>, BlobError> {
        let row = sqlx::query_as::<_, BlobRow>(
            r#"
            SELECT blake3, iroh_hash, filename, mime, size, path, external, created_at
            FROM blobz WHERE iroh_hash = ?1
            "#,
        )
        .bind(iroh_hash)
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
        let rows = sqlx::query_as::<_, BlobRow>(
            r#"
            SELECT blake3, iroh_hash, filename, mime, size, path, external, created_at
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
            // never touch external files — the user owns them.
            if !blob.external {
                let path = self.path_for(&blob);
                let _ = tokio::fs::remove_file(&path).await;
            }
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
}
