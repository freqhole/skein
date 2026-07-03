//! maintenance sweep for soft-deleted canvas data.
//!
//! `hub/messages.rs`'s ACL-removed handler and `hub/canvas.rs`'s tombstone
//! and canvas-deleted handlers all soft-delete (see
//! `hub_repo::HubDocStorage::soft_remove_canvas_id`'s doc comment) rather
//! than immediately destroying anything — this module is where an operator
//! actually reviews and destroys that data, via `reliquary maintenance`
//! (see `main.rs`).
//!
//! kept as a standalone module (rather than folded into `hub_repo.rs` or
//! `main.rs` directly) so its core logic — in particular the
//! cross-canvas blob-reference sweep in [`purge`] — is unit-testable
//! without needing a full CLI invocation or a live `HubRepo`/iroh endpoint.

use crate::blobz;
use crate::hub_repo::HubDocStorage;
use std::collections::HashSet;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MaintenanceError {
    #[error("canvas {0} is not soft-deleted — refusing to purge an actively-tracked canvas")]
    NotRemoved(String),
}

/// a soft-deleted canvas, with its title resolved (best-effort) for display
/// — `reliquary maintenance list` shows this instead of a bare doc id so an
/// operator has some chance of recognizing what they're looking at.
#[derive(Debug, Clone)]
pub struct RemovedCanvasSummary {
    pub canvas_doc_id: String,
    /// best-effort — empty if the doc's bytes are missing/unreadable (this
    /// can legitimately happen: the canvas doc might never have synced any
    /// content to this hub before it was removed).
    pub title: String,
    pub added_at: String,
    pub removed_at: String,
}

/// report of what a [`purge`] call actually deleted, for CLI output.
#[derive(Debug, Clone, Default)]
pub struct PurgeReport {
    pub canvas_doc_id: String,
    /// per-widget automerge doc ids deleted (these are 1:1 owned by this
    /// canvas instance — never shared with another canvas — so they're
    /// always deleted unconditionally as part of purging their canvas).
    pub widget_docs_deleted: Vec<String>,
    /// blake3 hashes whose blob file+row were actually deleted (not
    /// referenced by any other still-known canvas's widgets).
    pub blobs_deleted: Vec<String>,
    /// blake3 hashes this canvas's widgets referenced but which were kept,
    /// because at least one other still-known canvas (active or
    /// soft-deleted-but-not-yet-purged) still references them too.
    pub blobs_kept_still_referenced: Vec<String>,
}

/// a page of soft-deleted canvases, with titles resolved best-effort — see
/// `reliquary maintenance list` (main.rs).
pub async fn list_removed(
    storage: &HubDocStorage,
    limit: i64,
    offset: i64,
) -> Vec<RemovedCanvasSummary> {
    let rows = storage.load_removed_canvas_ids(limit, offset).await;
    let mut summaries = Vec::with_capacity(rows.len());
    for row in rows {
        let title = storage
            .load_doc(&row.canvas_doc_id)
            .await
            .and_then(|bytes| automerge::Automerge::load(&bytes).ok())
            .map(|doc| read_root_str(&doc, "title"))
            .unwrap_or_default();
        summaries.push(RemovedCanvasSummary {
            canvas_doc_id: row.canvas_doc_id,
            title,
            added_at: row.added_at,
            removed_at: row.removed_at.unwrap_or_default(),
        });
    }
    summaries
}

/// restore (undelete) a soft-deleted canvas — see
/// `HubDocStorage::restore_canvas_id`'s doc comment for the "hub process
/// must restart to pick this up live" caveat.
pub async fn restore(storage: &HubDocStorage, canvas_doc_id: &str) -> bool {
    storage.restore_canvas_id(canvas_doc_id).await
}

/// permanently purge a soft-deleted canvas: its own automerge doc, its
/// per-widget docs, and — only if no other still-known canvas's widgets
/// reference them — the blob files those widgets pointed at.
///
/// refuses (returns `Err`) if `canvas_doc_id` isn't currently soft-deleted,
/// matching `HubDocStorage::purge_canvas_id`'s own guard (checked again
/// here explicitly so the caller gets a specific error rather than a
/// silent `false`).
pub async fn purge(
    storage: &HubDocStorage,
    blobz: &blobz::Store,
    canvas_doc_id: &str,
) -> Result<PurgeReport, MaintenanceError> {
    let removed_ids = storage.load_removed_canvas_ids(i64::MAX, 0).await;
    if !removed_ids.iter().any(|r| r.canvas_doc_id == canvas_doc_id) {
        return Err(MaintenanceError::NotRemoved(canvas_doc_id.to_string()));
    }

    // 1. read this canvas's own widgets (doc id -> blake3, where readable)
    //    BEFORE deleting anything.
    let this_canvas_widget_docs = widget_doc_ids_for_canvas(storage, canvas_doc_id).await;
    let mut this_canvas_blake3s: HashSet<String> = HashSet::new();
    for widget_doc_id in &this_canvas_widget_docs {
        if let Some(hash) = blake3_for_widget_doc(storage, widget_doc_id).await {
            this_canvas_blake3s.insert(hash);
        }
    }

    // 2. collect every blake3 hash referenced by any OTHER still-known
    //    canvas (active or soft-deleted-but-not-yet-purged) — the "still
    //    referenced elsewhere" set a blob must be absent from before it's
    //    safe to delete.
    let mut still_referenced: HashSet<String> = HashSet::new();
    for other_canvas_id in storage.load_all_tracked_canvas_ids().await {
        if other_canvas_id == canvas_doc_id {
            continue;
        }
        for widget_doc_id in widget_doc_ids_for_canvas(storage, &other_canvas_id).await {
            if let Some(hash) = blake3_for_widget_doc(storage, &widget_doc_id).await {
                still_referenced.insert(hash);
            }
        }
    }

    // 3. delete this canvas's own widget docs unconditionally — never
    //    shared with another canvas.
    for widget_doc_id in &this_canvas_widget_docs {
        storage.delete_doc(widget_doc_id).await;
    }

    // 4. delete blobs this canvas referenced, unless some other still-known
    //    canvas also references them.
    let mut blobs_deleted = Vec::new();
    let mut blobs_kept = Vec::new();
    for hash in &this_canvas_blake3s {
        if still_referenced.contains(hash) {
            blobs_kept.push(hash.clone());
        } else {
            let _ = blobz.delete(hash).await;
            blobs_deleted.push(hash.clone());
        }
    }

    // 5. finally, delete the canvas doc itself + its tracking row.
    storage.purge_canvas_id(canvas_doc_id).await;

    Ok(PurgeReport {
        canvas_doc_id: canvas_doc_id.to_string(),
        widget_docs_deleted: this_canvas_widget_docs,
        blobs_deleted,
        blobs_kept_still_referenced: blobs_kept,
    })
}

// ---------------------------------------------------------------------------
// automerge doc-reading helpers
// ---------------------------------------------------------------------------

/// read a top-level string field off a loaded automerge doc. returns an
/// empty string for anything missing/unreadable/non-string (mirrors
/// `hub/canvas.rs`'s `read_str` helper, duplicated here rather than shared
/// since that one is private to its module and takes a live `DocHandle`
/// rather than a bare loaded `Automerge`).
fn read_root_str(doc: &automerge::Automerge, key: &str) -> String {
    use automerge::ReadDoc;
    match doc.get(automerge::ROOT, key) {
        Ok(Some((automerge::Value::Object(automerge::ObjType::Text), text_id))) => {
            doc.text(&text_id).unwrap_or_default()
        }
        Ok(Some((v, _))) => v.to_str().map(|s| s.to_string()).unwrap_or_default(),
        _ => String::new(),
    }
}

/// every non-null `widgets[*].docId` on a canvas doc, best-effort (empty if
/// the doc's bytes are missing/unreadable/have no `widgets` map).
async fn widget_doc_ids_for_canvas(storage: &HubDocStorage, canvas_doc_id: &str) -> Vec<String> {
    use automerge::ReadDoc;

    let Some(bytes) = storage.load_doc(canvas_doc_id).await else {
        return Vec::new();
    };
    let Ok(doc) = automerge::Automerge::load(&bytes) else {
        return Vec::new();
    };

    let Ok(Some((_, widgets_obj))) = doc.get(automerge::ROOT, "widgets") else {
        return Vec::new();
    };

    let mut doc_ids = Vec::new();
    for widget_key in doc.keys(&widgets_obj) {
        let Ok(Some((_, widget_obj))) = doc.get(&widgets_obj, widget_key.as_str()) else {
            continue;
        };
        if let Ok(Some((v, _))) = doc.get(&widget_obj, "docId") {
            if let Some(s) = v.to_str() {
                if !s.is_empty() {
                    doc_ids.push(s.to_string());
                }
            }
        }
    }
    doc_ids
}

/// read a widget state doc's root-level `blake3` field, if present — mirrors
/// `hub/canvas.rs`'s `send_blob_seek_to_peer`'s "widget state docs have this
/// at root" reasoning. returns `None` if the doc is missing/unreadable or
/// has no blake3 field (most widget types don't reference a blob at all).
async fn blake3_for_widget_doc(storage: &HubDocStorage, widget_doc_id: &str) -> Option<String> {
    use automerge::ReadDoc;

    let bytes = storage.load_doc(widget_doc_id).await?;
    let doc = automerge::Automerge::load(&bytes).ok()?;
    let (v, _) = doc.get(automerge::ROOT, "blake3").ok().flatten()?;
    let s = v.to_str()?;
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make_storage() -> (HubDocStorage, blobz::Store, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let docs_db = tmp.path().join("hub-docs.db");
        let storage = HubDocStorage::new(&docs_db).await.expect("storage");
        let pool = crate::db::open_in_memory().await;
        let blob_store = blobz::Store::new(pool, tmp.path());
        (storage, blob_store, tmp)
    }

    /// build a minimal canvas doc's raw bytes with a `widgets` map whose
    /// entries carry the given `docId`s (title also set, for `list_removed`
    /// coverage).
    fn build_canvas_doc_bytes(title: &str, widget_doc_ids: &[&str]) -> Vec<u8> {
        use automerge::transaction::Transactable;
        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            tx.put(automerge::ROOT, "title", title)?;
            let widgets_obj = tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;
            for (i, wid) in widget_doc_ids.iter().enumerate() {
                let widget_id = format!("widget-{i}");
                let widget_obj =
                    tx.put_object(&widgets_obj, widget_id.as_str(), automerge::ObjType::Map)?;
                tx.put(&widget_obj, "docId", *wid)?;
            }
            Ok(())
        })
        .expect("transact");
        doc.save()
    }

    /// build a minimal widget-state doc's raw bytes with a `blake3` field.
    fn build_widget_doc_bytes(blake3: &str) -> Vec<u8> {
        use automerge::transaction::Transactable;
        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            tx.put(automerge::ROOT, "blake3", blake3)?;
            Ok(())
        })
        .expect("transact");
        doc.save()
    }

    #[tokio::test]
    async fn list_removed_resolves_titles_and_only_returns_soft_deleted_canvases() {
        let (storage, _blobz, _tmp) = make_storage().await;

        storage.save_canvas_id("active-canvas").await;
        storage
            .save_doc("active-canvas", &build_canvas_doc_bytes("still active", &[]))
            .await;

        storage.soft_remove_canvas_id("trashed-canvas").await;
        storage
            .save_doc(
                "trashed-canvas",
                &build_canvas_doc_bytes("in the trash", &[]),
            )
            .await;

        let removed = list_removed(&storage, 20, 0).await;
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].canvas_doc_id, "trashed-canvas");
        assert_eq!(removed[0].title, "in the trash");
        assert!(!removed[0].removed_at.is_empty());
    }

    #[tokio::test]
    async fn restore_reactivates_a_soft_deleted_canvas() {
        let (storage, _blobz, _tmp) = make_storage().await;
        storage.soft_remove_canvas_id("c1").await;

        assert_eq!(storage.count_removed_canvas_ids().await, 1);
        assert!(restore(&storage, "c1").await);
        assert_eq!(storage.count_removed_canvas_ids().await, 0);
        assert!(storage.load_canvas_ids().await.contains(&"c1".to_string()));
    }

    #[tokio::test]
    async fn purge_refuses_a_canvas_that_is_not_soft_deleted() {
        let (storage, blobz, _tmp) = make_storage().await;
        storage.save_canvas_id("active-canvas").await;

        let result = purge(&storage, &blobz, "active-canvas").await;
        assert!(matches!(result, Err(MaintenanceError::NotRemoved(id)) if id == "active-canvas"));
    }

    #[tokio::test]
    async fn purge_deletes_the_canvas_doc_and_its_own_widget_docs() {
        let (storage, blobz, _tmp) = make_storage().await;

        storage.soft_remove_canvas_id("c1").await;
        storage
            .save_doc("c1", &build_canvas_doc_bytes("gone", &["w1"]))
            .await;
        storage.save_doc("w1", &build_widget_doc_bytes("")).await;

        let report = purge(&storage, &blobz, "c1").await.expect("purge succeeds");
        assert_eq!(report.widget_docs_deleted, vec!["w1".to_string()]);
        assert!(storage.load_doc("c1").await.is_none());
        assert!(storage.load_doc("w1").await.is_none());
        assert_eq!(storage.count_removed_canvas_ids().await, 0);
    }

    #[tokio::test]
    async fn purge_deletes_a_blob_only_referenced_by_the_purged_canvas() {
        let (storage, blobz_store, tmp) = make_storage().await;

        let bytes = b"orphan blob content";
        let blob = blobz_store
            .insert("iroh-hash-1".to_string(), Some("f.txt".to_string()), None, bytes)
            .await
            .expect("insert blob");
        let hash = blob.blake3.clone();

        storage.soft_remove_canvas_id("c1").await;
        storage
            .save_doc("c1", &build_canvas_doc_bytes("solo canvas", &["w1"]))
            .await;
        storage.save_doc("w1", &build_widget_doc_bytes(&hash)).await;

        let report = purge(&storage, &blobz_store, "c1")
            .await
            .expect("purge succeeds");
        assert_eq!(report.blobs_deleted, vec![hash.clone()]);
        assert!(report.blobs_kept_still_referenced.is_empty());
        assert!(blobz_store.get(&hash).await.expect("get ok").is_none());
        let _ = tmp; // keep tempdir alive through the assertions above
    }

    #[tokio::test]
    async fn purge_keeps_a_blob_still_referenced_by_another_canvas() {
        let (storage, blobz_store, _tmp) = make_storage().await;

        let blob = blobz_store
            .insert("iroh-hash-2".to_string(), Some("f.txt".to_string()), None, b"shared content")
            .await
            .expect("insert blob");
        let hash = blob.blake3.clone();

        // c1 (about to be purged) and c2 (still active) both reference the
        // same blob through their own separate widget docs.
        storage.soft_remove_canvas_id("c1").await;
        storage
            .save_doc("c1", &build_canvas_doc_bytes("purging this one", &["w1"]))
            .await;
        storage.save_doc("w1", &build_widget_doc_bytes(&hash)).await;

        storage.save_canvas_id("c2").await;
        storage
            .save_doc("c2", &build_canvas_doc_bytes("keep this one", &["w2"]))
            .await;
        storage.save_doc("w2", &build_widget_doc_bytes(&hash)).await;

        let report = purge(&storage, &blobz_store, "c1")
            .await
            .expect("purge succeeds");
        assert!(report.blobs_deleted.is_empty());
        assert_eq!(report.blobs_kept_still_referenced, vec![hash.clone()]);
        assert!(blobz_store.get(&hash).await.expect("get ok").is_some());

        // c1's own widget doc is still gone even though the blob survives —
        // widget docs are never shared, only the underlying blob is.
        assert!(storage.load_doc("w1").await.is_none());
        assert!(storage.load_doc("c1").await.is_none());
        // c2 and its widget doc are completely untouched.
        assert!(storage.load_doc("c2").await.is_some());
        assert!(storage.load_doc("w2").await.is_some());
    }
}
