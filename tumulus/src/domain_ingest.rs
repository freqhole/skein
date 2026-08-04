//! hub-side domain-ingest worker: mirrors loam's `file-domain-ingest.ts`
//! claim/release protocol so a manually-picked file-widget domain still
//! gets processed even when no tauri peer has the blob locally — the hub
//! usually already has (or will soon have, via `snatch.rs`'s replication
//! engine) most blobs referenced by a canvas it's tracking.
//!
//! only produces a thumbnail (`thumbnail::generate_thumbnail`), unlike a
//! tauri peer's `runDomainIngest`, which additionally converts a
//! `domain === "document"` pdf into a peedeeeff widget — that's a
//! client-only UI transformation (adds/removes canvas widgets) with no
//! hub-side equivalent. a document domain still gets its thumbnail here so
//! the file-type select disappears and every peer sees a preview; a tauri
//! peer that later opens the widget can still perform the conversion.
//!
//! claim protocol matches loam's `file-domain-ingest.ts` field-for-field
//! (`domainIngestState`/`domainIngestClaimedBy`/`domainIngestClaimedAt`,
//! same 45s staleness window, same idempotent "last write wins is
//! harmless" tradeoff) so the hub and a tauri peer can race for the same
//! widget safely — loam's browser-tab peers never attempt this claim at
//! all (nothing to run ffmpeg/magick with), so in practice the hub (always
//! on) usually wins the race first.

use std::sync::Arc;

use freqhole_reliquary::blobz::BlobStore;
use tokio::sync::broadcast;

use crate::hub_repo::{DocHandle, HubRepo};
use crate::snatch::{classify_doc, read_str, read_u64, DocKind};

/// same staleness window as loam's `DOMAIN_INGEST_CLAIM_STALE_MS`.
const DOMAIN_INGEST_CLAIM_STALE_MS: u64 = 45_000;

/// mirrors loam's `domainToMimeOverride()` — a generic mime matching the
/// user's manually-picked domain, used in place of the original (apparently
/// wrong, since auto-detection couldn't classify it) mime when generating a
/// thumbnail. retrying with the same mime that already failed
/// classification would just fail identically.
fn domain_to_mime_override(domain: &str) -> Option<&'static str> {
    match domain {
        "photo" => Some("image/jpeg"),
        "video" => Some("video/mp4"),
        "audio" => Some("audio/mpeg"),
        "document" => Some("application/pdf"),
        _ => None,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// spawns the background worker: an initial sweep over every doc the hub
/// already holds, then reacts to `hub_repo.subscribe_doc_changes()` for the
/// lifetime of the hub.
pub(crate) fn spawn(repo: HubRepo, blobz: Arc<dyn BlobStore>, local_node_id: String) {
    tokio::spawn(async move {
        for doc_id in repo.all_doc_ids().await {
            try_ingest_doc(&repo, &blobz, &local_node_id, &doc_id).await;
        }

        let mut changes = repo.subscribe_doc_changes();
        loop {
            match changes.recv().await {
                Ok(doc_id) => try_ingest_doc(&repo, &blobz, &local_node_id, &doc_id).await,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// the subset of a file-widget state doc this module reads.
struct IngestCandidate {
    domain: String,
    mime: String,
    filename: String,
    blake3: String,
    thumbnail_data_url: String,
    claimed_by: String,
    claimed_at: u64,
}

async fn try_ingest_doc(
    repo: &HubRepo,
    blobz: &Arc<dyn BlobStore>,
    local_node_id: &str,
    doc_id: &str,
) {
    let Some(handle) = repo.find(doc_id).await else {
        return;
    };

    let h = handle.clone();
    let kind = tokio::task::spawn_blocking(move || classify_doc(&h))
        .await
        .unwrap_or(DocKind::Unknown);
    if kind != DocKind::WidgetState {
        return;
    }

    let h = handle.clone();
    let candidate = tokio::task::spawn_blocking(move || read_ingest_candidate(&h))
        .await
        .ok()
        .flatten();
    let Some(candidate) = candidate else {
        return;
    };

    // "file"/unset is the generic catch-all — nothing to ingest.
    if candidate.domain.is_empty() || candidate.domain == "file" {
        return;
    }
    if !candidate.thumbnail_data_url.is_empty() || candidate.blake3.is_empty() {
        return;
    }

    let claim_age = now_ms().saturating_sub(candidate.claimed_at);
    let claimed_fresh_elsewhere = !candidate.claimed_by.is_empty()
        && candidate.claimed_by != local_node_id
        && claim_age < DOMAIN_INGEST_CLAIM_STALE_MS;
    if claimed_fresh_elsewhere {
        return;
    }

    // opportunistic/fallback pass only — don't trigger a snatch here, just
    // skip if the hub doesn't already have the bytes (`snatch.rs`'s
    // replication engine is what fetches missing blobs).
    let Ok(Some(bytes)) = blobz.read_bytes(&candidate.blake3).await else {
        return;
    };

    if !claim_domain_ingest(&handle, local_node_id, doc_id).await {
        return;
    }
    repo.notify_doc_changed(doc_id);

    let effective_mime =
        domain_to_mime_override(&candidate.domain).unwrap_or(candidate.mime.as_str());
    let result = crate::thumbnail::generate_thumbnail(
        &bytes,
        effective_mime,
        Some(candidate.filename.as_str()),
        200,
    )
    .await;

    let data_url = match &result {
        Ok(value) => value.get("data").and_then(|d| d.as_str()).map(|data| {
            let mime = value
                .get("mime")
                .and_then(|m| m.as_str())
                .unwrap_or("application/octet-stream");
            format!("data:{mime};base64,{data}")
        }),
        Err(_) => None,
    };

    match (&result, &data_url) {
        (Ok(_), Some(_)) => {
            tracing::info!(doc_id, domain = %candidate.domain, "hub domain-ingest succeeded");
        }
        (Ok(_), None) => {
            tracing::warn!(doc_id, domain = %candidate.domain, "hub domain-ingest: no thumbnail produced");
        }
        (Err(e), _) => {
            tracing::warn!(doc_id, domain = %candidate.domain, error = %e, "hub domain-ingest failed");
        }
    }

    finish_domain_ingest(&handle, local_node_id, doc_id, data_url.as_deref()).await;
    repo.notify_doc_changed(doc_id);
}

fn read_ingest_candidate(handle: &DocHandle) -> Option<IngestCandidate> {
    let mut out = None;
    handle.with_document(|doc| {
        let blake3 = read_str(doc, &automerge::ROOT, "blake3");
        if blake3.is_empty() {
            return;
        }
        out = Some(IngestCandidate {
            domain: read_str(doc, &automerge::ROOT, "domain"),
            mime: read_str(doc, &automerge::ROOT, "mime"),
            filename: read_str(doc, &automerge::ROOT, "filename"),
            blake3,
            thumbnail_data_url: read_str(doc, &automerge::ROOT, "thumbnailDataUrl"),
            claimed_by: read_str(doc, &automerge::ROOT, "domainIngestClaimedBy"),
            claimed_at: read_u64(doc, &automerge::ROOT, "domainIngestClaimedAt"),
        });
    });
    out
}

/// claim the ingest job for the hub, unless someone else already holds a
/// fresh claim — re-checked inside the doc lock to avoid a race against a
/// concurrent claim attempt from another thread/connection.
async fn claim_domain_ingest(handle: &DocHandle, local_node_id: &str, doc_id: &str) -> bool {
    let h = handle.clone();
    let local_id = local_node_id.to_string();
    let did = doc_id.to_string();
    tokio::task::spawn_blocking(move || {
        h.with_document_mut(|doc| -> bool {
            use automerge::transaction::Transactable;

            let claimed_by = read_str(doc, &automerge::ROOT, "domainIngestClaimedBy");
            let claimed_at = read_u64(doc, &automerge::ROOT, "domainIngestClaimedAt");
            let age = now_ms().saturating_sub(claimed_at);
            if !claimed_by.is_empty()
                && claimed_by != local_id
                && age < DOMAIN_INGEST_CLAIM_STALE_MS
            {
                return false;
            }

            let now = now_ms();
            match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
                tx.put(automerge::ROOT, "domainIngestClaimedBy", local_id.as_str())?;
                tx.put(automerge::ROOT, "domainIngestClaimedAt", now as f64)?;
                tx.put(automerge::ROOT, "domainIngestState", "processing")?;
                Ok(())
            }) {
                Ok(_) => true,
                Err(e) => {
                    tracing::warn!(doc_id = %did, error = ?e, "domain-ingest claim write failed");
                    false
                }
            }
        })
    })
    .await
    .unwrap_or(false)
}

/// write the ingest result back: a thumbnail on success, or a reverted
/// `domain` (so the file-type select reappears) on failure — same outcome
/// as loam's `runDomainIngest` catch block. releases the claim only if it's
/// still the hub's own (mirrors `releaseDomainIngestClaim`'s guard).
async fn finish_domain_ingest(
    handle: &DocHandle,
    local_node_id: &str,
    doc_id: &str,
    thumbnail_data_url: Option<&str>,
) {
    let h = handle.clone();
    let local_id = local_node_id.to_string();
    let did = doc_id.to_string();
    let data_url = thumbnail_data_url.map(|s| s.to_string());
    tokio::task::spawn_blocking(move || {
        h.with_document_mut(|doc| {
            use automerge::transaction::Transactable;

            let still_ours = read_str(doc, &automerge::ROOT, "domainIngestClaimedBy") == local_id;

            let result = doc.transact::<_, _, automerge::AutomergeError>(|tx| {
                tx.put(automerge::ROOT, "domainIngestState", "")?;
                match &data_url {
                    Some(url) => {
                        tx.put(automerge::ROOT, "thumbnailDataUrl", url.as_str())?;
                    }
                    None => {
                        tx.put(automerge::ROOT, "domain", "")?;
                    }
                }
                if still_ours {
                    tx.put(automerge::ROOT, "domainIngestClaimedBy", "")?;
                    tx.put(automerge::ROOT, "domainIngestClaimedAt", 0f64)?;
                }
                Ok(())
            });
            if let Err(e) = result {
                tracing::warn!(doc_id = %did, error = ?e, "domain-ingest finish write failed");
            }
        })
    })
    .await
    .ok();
}
