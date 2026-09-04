//! blob-fetch ACL gate for the `iroh-blobs/*` verified-transfer ALPN.
//!
//! `freqhole/1`'s `ensure_blob` handshake (`protocol::blob_proxy.rs`) only
//! decides whether the hub *imports* a blob into its iroh-blobs store by
//! reference - the actual bytes flow over `iroh-blobs/*`, which is what
//! this module gates: a peer must (a) be a hub friend and (b) have a
//! `.acl` entry on at least one canvas that references the requested blob.
//!
//! [`BlobAclGate`] implements [`freqhole_reliquary::gate::AccessGate`],
//! which supplies the generic `iroh_blobs` event-interception mechanics
//! (`ClientConnected`/`GetRequestReceived`/`GetManyRequestReceived`) via
//! [`freqhole_reliquary::gate::build_gated_blobs_events`] - this module
//! contributes only the app-specific access decision: friendz status plus
//! canvas `.acl` membership, resolved live by walking the same doc shapes
//! `snatch`'s doc-scanning logic already reads.
//!
//! three gating modes:
//! - [`BlobAclGate::for_hub`]: full canvas-ACL gating, used by
//!   `hub::HubPeerService` (the real, embedded-in-tauri hub path — see
//!   `docs/PLAN.md` §3.4). a peer must (a) be a hub friend and (b) have a
//!   `.acl` entry (any role — admin/member/viewer all get read access to
//!   referenced blobs, per the existing role model) on at least one canvas
//!   that references the requested blob.
//! - [`BlobAclGate::friend_only`]: used by `service::Service`, an older/
//!   unused-by-`main.rs` peer variant (see its module doc comment) that has
//!   no canvas tracking at all — no `BlobSnatcher`, no `canvas_doc_ids` set.
//!   falls back to hub-friend status alone. strictly weaker than the hub
//!   gate, but still closes the "any stranger can fetch anything" hole for
//!   that path too, for the same low cost.
//! - [`BlobAclGate::friend_or_known_hub`]: same as `friend_only`, plus a
//!   fallback: a peer isn't (yet) a mutual `friendz` entry but this node's
//!   own `userz` table already has them flagged `is_hub` (set as soon as
//!   a `ProfileResponse`/`FriendRequest` with `isHub: true` is seen — this
//!   can and does arrive before the separate friend-request/accept
//!   handshake completes, since a hub auto-accepts a canvas-vouched friend
//!   request asynchronously and profile exchange isn't gated on friend
//!   status at all). used by the tauri frontend's own iroh-blobs server
//!   (`skein/tauri/src/streams.rs`'s `start_with_blobs`): a hub that's
//!   actively relaying blobs for a canvas this peer just shared is exactly
//!   the case `friend_only` alone would otherwise wrongly stall on until
//!   the friend handshake catches up. this doesn't weaken real per-peer
//!   access control — a hub re-checks its own `for_hub` canvas-ACL gate
//!   before re-serving to whoever it relays for, so trusting a known hub
//!   here just avoids a redundant, laggy local precondition.
//!
//! reliquary has no persisted blake3->canvas mapping anywhere (the blob
//! store is flat/content-addressed — see `SqliteBlobStore`'s module doc
//! comment — with no canvas linkage column), so canvas membership is
//! resolved live, by walking the same doc shapes `snatch`'s doc-scanning
//! logic already reads to *find* missing blobs, reused here read-only to
//! *gate* blobs the hub already has.

use std::sync::Arc;

use async_trait::async_trait;
use iroh_blobs::provider::events::EventSender;

use crate::friendz;
use crate::hub_repo::HubRepo;
use crate::snatch::{classify_doc, read_canvas_for_file_widgets, read_widget_state, DocKind};
use crate::userz;
use freqhole_reliquary::gate::AccessGate;

// ---------------------------------------------------------------------------
// canvas membership resolution
// ---------------------------------------------------------------------------

/// resolves, on demand, which canvas(es) a blob is referenced from and
/// whether a peer has `.acl` membership on a given canvas.
#[derive(Clone)]
struct CanvasResolver {
    repo: HubRepo,
}

impl CanvasResolver {
    /// canvas doc ids (among every doc the hub currently holds) whose
    /// `widgets` map contains a `"file"` widget whose state doc's root
    /// `blake3` field matches `blake3_hash`.
    ///
    /// this is a live scan rather than a maintained reverse index — see
    /// this module's doc comment for why. cost is proportional to the
    /// number of docs the hub holds, which is fine at this project's scale;
    /// revisit if it ever shows up as a hot path.
    async fn canvas_ids_referencing(&self, blake3_hash: &str) -> Vec<String> {
        let mut matches = Vec::new();

        for doc_id in self.repo.all_doc_ids().await {
            let handle = match self.repo.find(&doc_id).await {
                Some(h) => h,
                None => continue,
            };

            let kind = {
                let h = handle.clone();
                tokio::task::spawn_blocking(move || classify_doc(&h))
                    .await
                    .unwrap_or(DocKind::Unknown)
            };
            if !matches!(kind, DocKind::Canvas) {
                continue;
            }

            let canvas_id = doc_id.clone();
            let (placeholder_refs, _peers) = {
                let h = handle.clone();
                // local_node_id is only used to exclude "self" from the
                // returned peer list, which this resolver doesn't use.
                tokio::task::spawn_blocking(move || {
                    read_canvas_for_file_widgets(&h, &canvas_id, "")
                })
                .await
                .unwrap_or_default()
            };

            for placeholder in &placeholder_refs {
                let whandle = match self.repo.find(&placeholder.widget_doc_id).await {
                    Some(h) => h,
                    None => continue,
                };
                let canvas_id = doc_id.clone();
                let widget_doc_id = placeholder.widget_doc_id.clone();
                let blake3_hash_owned = blake3_hash.to_string();
                // a widget doc may carry more than one blob reference (an
                // animaniac doc's `clips[]` shape) — match against ANY of
                // them, not just a single value.
                let blake3_matches = tokio::task::spawn_blocking(move || {
                    read_widget_state(&whandle, &canvas_id, &widget_doc_id)
                        .into_iter()
                        .any(|r| r.blake3 == blake3_hash_owned)
                })
                .await
                .unwrap_or(false);

                if blake3_matches {
                    matches.push(doc_id.clone());
                    break;
                }
            }
        }

        matches
    }

    /// true if `peer_node_id` has a `.acl` entry (any role) on canvas
    /// `canvas_doc_id`. the canvas creator is stamped `admin` in `.acl` at
    /// creation time (see `loam/src/canvas/canvas-doc.ts`'s
    /// `CanvasStore.stampAdmin()`), so this single membership check also
    /// covers "is the creator" — there's no separate creator field to read.
    async fn peer_in_acl(&self, canvas_doc_id: &str, peer_node_id: &str) -> bool {
        let handle = match self.repo.find(canvas_doc_id).await {
            Some(h) => h,
            None => return false,
        };
        let peer = peer_node_id.to_string();
        tokio::task::spawn_blocking(move || {
            use automerge::ReadDoc;
            handle.with_document(|doc| match doc.get(automerge::ROOT, "acl") {
                Ok(Some((_, acl_obj))) => doc.get(&acl_obj, peer.as_str()).ok().flatten().is_some(),
                _ => false,
            })
        })
        .await
        .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

/// per-peer blob-fetch gate. construct via [`BlobAclGate::for_hub`],
/// [`BlobAclGate::friend_only`], or [`BlobAclGate::friend_or_known_hub`],
/// then pass to [`freqhole_reliquary::gate::build_gated_blobs_events`].
#[derive(Clone)]
pub struct BlobAclGate {
    friendz: friendz::Store,
    canvas: Option<CanvasResolver>,
    /// known-hub fallback trust (see this module's doc comment) — only
    /// ever set by [`BlobAclGate::friend_or_known_hub`].
    userz: Option<userz::Directory>,
}

impl BlobAclGate {
    /// full gate: friend status *and* canvas ACL membership for the
    /// specific blob being requested. used by `hub::HubPeerService`.
    pub fn for_hub(friendz: friendz::Store, repo: HubRepo) -> Self {
        Self {
            friendz,
            canvas: Some(CanvasResolver { repo }),
            userz: None,
        }
    }

    /// reduced gate for peer variants with no canvas tracking: friend
    /// status only. used by `service::Service`.
    pub fn friend_only(friendz: friendz::Store) -> Self {
        Self {
            friendz,
            canvas: None,
            userz: None,
        }
    }

    /// like [`BlobAclGate::friend_only`], plus a known-hub fallback: a peer
    /// who isn't (yet) a mutual friendz entry but who `userz` already has
    /// flagged `is_hub` is still allowed. used by the tauri frontend's own
    /// iroh-blobs server (`streams.rs`'s `start_with_blobs`) — see this
    /// module's doc comment for the rationale.
    pub fn friend_or_known_hub(friendz: friendz::Store, userz: userz::Directory) -> Self {
        Self {
            friendz,
            canvas: None,
            userz: Some(userz),
        }
    }
}

#[async_trait]
impl AccessGate for BlobAclGate {
    /// true if `peer_node_id` may fetch the blob identified by
    /// `blake3_hash`.
    ///
    /// `for_hub` mode: canvas-ACL membership on a canvas referencing this
    /// blob is sufficient on its own — the canvas owner already decided to
    /// share this specific file with this specific peer, which is a
    /// stronger, more specific authorization than generic hub-friendship
    /// (see this module's doc comment). this deliberately does NOT also
    /// require `is_friend`: a newly-invited peer can be served their
    /// canvas's blobs even before they've accepted a friend request the
    /// hub sent them (see `hub::HubPeerService::maybe_send_proactive_friend_request`)
    /// — friendship is a separate, stronger relationship the hub still
    /// requires before it will accept new blobs *from* that peer or sync
    /// more broadly. an operator-`Blocked` peer is still denied outright
    /// even so, in case a stale canvas ACL entry still lists them.
    ///
    /// `friend_only`/`friend_or_known_hub` modes have no canvas concept at
    /// all, so friendz status is the only signal available there and
    /// remains a necessary condition.
    async fn allow_blob(&self, peer_node_id: &str, blake3_hash: &str) -> bool {
        tracing::info!(
            peer = peer_node_id,
            blake3 = %blake3_hash,
            mode = if self.canvas.is_some() {
                "for_hub"
            } else if self.userz.is_some() {
                "friend_or_known_hub"
            } else {
                "friend_only"
            },
            "blob-acl: allow_blob called"
        );

        if let Some(canvas) = &self.canvas {
            if matches!(
                self.friendz.get(peer_node_id).await,
                Ok(Some(f)) if f.status == friendz::FriendStatus::Blocked
            ) {
                tracing::info!(peer = peer_node_id, "blob-acl: denied, peer is blocked");
                return false;
            }

            let canvases = canvas.canvas_ids_referencing(blake3_hash).await;
            if canvases.is_empty() {
                tracing::info!(
                    blake3 = %blake3_hash,
                    "blob-acl: denied, blob not referenced by any known canvas"
                );
                return false;
            }

            for canvas_doc_id in &canvases {
                if canvas.peer_in_acl(canvas_doc_id, peer_node_id).await {
                    tracing::info!(
                        peer = peer_node_id,
                        canvas_doc_id = %canvas_doc_id,
                        "blob-acl: allowed, peer is in this canvas's acl"
                    );
                    return true;
                }
            }

            tracing::info!(
                peer = peer_node_id,
                blake3 = %blake3_hash,
                canvases = ?canvases,
                "blob-acl: denied, not a member of any canvas referencing this blob"
            );
            return false;
        }

        // friend_only / friend_or_known_hub mode: no canvas concept, fall
        // back to friendz status (+ known-hub fallback) as the sole gate.
        if !self.friendz.is_friend(peer_node_id).await {
            let known_hub = match &self.userz {
                Some(userz) => {
                    matches!(userz.get(peer_node_id).await, Ok(Some(rec)) if rec.is_hub)
                }
                None => false,
            };
            if known_hub {
                tracing::info!(
                    peer = peer_node_id,
                    "blob-acl: allowed via known-hub fallback (userz says is_hub, not yet a mutual friendz entry)"
                );
            } else {
                tracing::info!(peer = peer_node_id, "blob-acl: denied, not a hub friend");
                return false;
            }
        } else {
            tracing::info!(peer = peer_node_id, "blob-acl: peer is a hub friend");
        }

        tracing::info!(
            peer = peer_node_id,
            "blob-acl: allowed, no canvas check in this mode"
        );
        true
    }
}

// ---------------------------------------------------------------------------
// EventSender wiring
// ---------------------------------------------------------------------------

/// build an `EventSender` that intercepts `iroh_blobs`' connect/get/get_many
/// events and gates them against `gate`. thin wrapper over
/// [`freqhole_reliquary::gate::build_gated_blobs_events`], which owns the
/// generic interception-loop mechanics; this module only supplies the
/// access decision via `BlobAclGate`'s [`AccessGate`] implementation above.
///
/// when `transfers` is supplied, outgoing (this node serving a peer) blob
/// transfer progress is also tracked into it - see
/// [`freqhole_reliquary::gate::TransferRegistry`].
pub fn build_gated_blobs_events(
    gate: BlobAclGate,
    transfers: Option<Arc<freqhole_reliquary::gate::TransferRegistry>>,
) -> EventSender {
    freqhole_reliquary::gate::build_gated_blobs_events(Arc::new(gate), transfers)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// persist a canvas doc (with a single "file" widget pointing at
    /// `widget_doc_id`, plus the given `.acl` entries) and its widget-state
    /// doc (with the given `blake3`), then construct a `HubRepo` against
    /// the same backing sqlite file so `find()`/`all_doc_ids()` see them.
    ///
    /// seeds via `HubDocStorage` directly (the same `hub_docs` sqlite table
    /// `HubRepo` reloads from at construction time) rather than through a
    /// `HubRepo` instance — `HubRepo` has no public "insert this doc and
    /// make it immediately findable" method outside of applying a real
    /// automerge sync message, which isn't available in a unit test without
    /// a live network.
    async fn seed_canvas_and_widget(
        db_path: &std::path::Path,
        peer_id: &str,
        canvas_doc_id: &str,
        widget_doc_id: &str,
        acl_peers: &[&str],
        blake3: &str,
    ) -> HubRepo {
        {
            let storage = crate::hub_repo::HubDocStorage::new(db_path)
                .await
                .expect("HubDocStorage::new for seeding should succeed");

            let mut canvas_doc = automerge::Automerge::new();
            canvas_doc
                .transact::<_, _, automerge::AutomergeError>(|tx| {
                    use automerge::transaction::Transactable;
                    let widgets =
                        tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;
                    let widget = tx.put_object(&widgets, "w1", automerge::ObjType::Map)?;
                    tx.put(&widget, "type", "file")?;
                    tx.put(&widget, "docId", widget_doc_id)?;

                    let acl = tx.put_object(automerge::ROOT, "acl", automerge::ObjType::Map)?;
                    for peer in acl_peers {
                        let entry = tx.put_object(&acl, *peer, automerge::ObjType::Map)?;
                        tx.put(&entry, "role", "member")?;
                    }
                    Ok(())
                })
                .expect("canvas doc transact should succeed");
            storage.save_doc(canvas_doc_id, &canvas_doc.save()).await;

            let mut widget_doc = automerge::Automerge::new();
            widget_doc
                .transact::<_, _, automerge::AutomergeError>(|tx| {
                    use automerge::transaction::Transactable;
                    tx.put(automerge::ROOT, "blake3", blake3)?;
                    tx.put(automerge::ROOT, "blobId", "blob-1")?;
                    Ok(())
                })
                .expect("widget doc transact should succeed");
            storage.save_doc(widget_doc_id, &widget_doc.save()).await;
        }

        HubRepo::new(peer_id.to_string(), db_path)
            .await
            .expect("HubRepo::new (reload) should succeed")
    }

    #[tokio::test]
    async fn canvas_resolver_finds_the_canvas_that_references_a_blob() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_and_widget(
            &db_path,
            "hub-node",
            "canvas-1",
            "widget-1",
            &["alice"],
            "abc123",
        )
        .await;

        let resolver = CanvasResolver { repo: hub_repo };
        let canvases = resolver.canvas_ids_referencing("abc123").await;
        assert_eq!(canvases, vec!["canvas-1".to_string()]);

        // a hash nothing references resolves to no canvases at all.
        let none = resolver.canvas_ids_referencing("does-not-exist").await;
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn peer_in_acl_reflects_membership_and_creator_via_stamped_admin_entry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_and_widget(
            &db_path,
            "hub-node",
            "canvas-1",
            "widget-1",
            &["alice", "bob"],
            "abc123",
        )
        .await;

        let resolver = CanvasResolver { repo: hub_repo };
        assert!(resolver.peer_in_acl("canvas-1", "alice").await);
        assert!(resolver.peer_in_acl("canvas-1", "bob").await);
        assert!(!resolver.peer_in_acl("canvas-1", "mallory").await);
        // unknown canvas doc id: no panic, just false.
        assert!(!resolver.peer_in_acl("no-such-canvas", "alice").await);
    }

    #[tokio::test]
    async fn hub_gate_allows_a_friend_who_is_a_canvas_member() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let hub_db = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_and_widget(
            &hub_db,
            "hub-node",
            "canvas-1",
            "widget-1",
            &["alice"],
            "abc123",
        )
        .await;

        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        crate::userz::Directory::new(haruspex_pool.clone())
            .touch("alice")
            .await
            .expect("touch userz row");
        let friendz_store = friendz::Store::new(haruspex_pool, pool);
        friendz_store
            .upsert("alice", friendz::FriendStatus::Accepted, None)
            .await
            .expect("upsert friend");

        let gate = BlobAclGate::for_hub(friendz_store, hub_repo);
        assert!(gate.allow_blob("alice", "abc123").await);
    }

    #[tokio::test]
    async fn hub_gate_denies_a_stranger_with_no_canvas_access_and_no_friend_status() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let hub_db = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_and_widget(
            &hub_db,
            "hub-node",
            "canvas-1",
            "widget-1",
            &["alice"],
            "abc123",
        )
        .await;

        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let friendz_store = friendz::Store::new(haruspex_pool, pool);
        // mallory has no friendz row at all, and is not in canvas-1's acl.

        let gate = BlobAclGate::for_hub(friendz_store, hub_repo);
        assert!(!gate.allow_blob("mallory", "abc123").await);
    }

    #[tokio::test]
    async fn hub_gate_denies_a_hub_friend_who_is_not_invited_to_the_specific_canvas() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let hub_db = tmp.path().join("hub-docs.db");
        // canvas-1's acl only has alice, not bob.
        let hub_repo = seed_canvas_and_widget(
            &hub_db,
            "hub-node",
            "canvas-1",
            "widget-1",
            &["alice"],
            "abc123",
        )
        .await;

        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        crate::userz::Directory::new(haruspex_pool.clone())
            .touch("bob")
            .await
            .expect("touch userz row");
        let friendz_store = friendz::Store::new(haruspex_pool, pool);
        // bob IS a hub friend...
        friendz_store
            .upsert("bob", friendz::FriendStatus::Accepted, None)
            .await
            .expect("upsert friend");

        let gate = BlobAclGate::for_hub(friendz_store, hub_repo);
        // ...but is not on canvas-1's acl, so the fetch must still be denied.
        // this is the key distinction from the sync-ALPN gate (`sync::IrohRepo::accept`),
        // which only checks hub-level friendz status.
        assert!(!gate.allow_blob("bob", "abc123").await);
    }

    #[tokio::test]
    async fn hub_gate_denies_a_friend_for_a_blake3_no_canvas_references() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let hub_db = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_and_widget(
            &hub_db,
            "hub-node",
            "canvas-1",
            "widget-1",
            &["alice"],
            "abc123",
        )
        .await;

        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        crate::userz::Directory::new(haruspex_pool.clone())
            .touch("alice")
            .await
            .expect("touch userz row");
        let friendz_store = friendz::Store::new(haruspex_pool, pool);
        friendz_store
            .upsert("alice", friendz::FriendStatus::Accepted, None)
            .await
            .expect("upsert friend");

        let gate = BlobAclGate::for_hub(friendz_store, hub_repo);
        // alice is a friend and a canvas-1 member, but this hash isn't
        // referenced by any canvas at all (e.g. an unrelated blob) — fail
        // closed rather than defaulting to "no known link means unrestricted".
        assert!(!gate.allow_blob("alice", "some-other-hash").await);
    }

    #[tokio::test]
    async fn hub_gate_allows_a_canvas_member_who_is_not_yet_a_hub_friend() {
        // this is the key case motivating the for_hub gate's canvas-ACL-
        // alone check: a peer invited to a canvas by its owner can fetch
        // that canvas's blobs from the hub even before accepting a friend
        // request the hub may have sent them (see
        // `hub::HubPeerService::maybe_send_proactive_friend_request`) —
        // the owner's ACL decision is itself sufficient authorization.
        let tmp = tempfile::tempdir().expect("tempdir");
        let hub_db = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_and_widget(
            &hub_db,
            "hub-node",
            "canvas-1",
            "widget-1",
            &["alice"],
            "abc123",
        )
        .await;

        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let friendz_store = friendz::Store::new(haruspex_pool, pool);
        // alice has no friendz row at all — not a friend yet.

        let gate = BlobAclGate::for_hub(friendz_store, hub_repo);
        assert!(gate.allow_blob("alice", "abc123").await);
    }

    #[tokio::test]
    async fn hub_gate_denies_a_blocked_peer_even_if_still_in_a_canvas_acl() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let hub_db = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_and_widget(
            &hub_db,
            "hub-node",
            "canvas-1",
            "widget-1",
            &["alice"],
            "abc123",
        )
        .await;

        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        crate::userz::Directory::new(haruspex_pool.clone())
            .touch("alice")
            .await
            .expect("touch userz row");
        let friendz_store = friendz::Store::new(haruspex_pool, pool);
        friendz_store
            .upsert("alice", friendz::FriendStatus::Blocked, None)
            .await
            .expect("upsert blocked");

        let gate = BlobAclGate::for_hub(friendz_store, hub_repo);
        // even though alice is still listed in canvas-1's acl (a stale
        // entry the operator hasn't cleaned up), an explicit block wins.
        assert!(!gate.allow_blob("alice", "abc123").await);
    }

    #[tokio::test]
    async fn friend_only_gate_allows_any_hub_friend_regardless_of_hash() {
        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        crate::userz::Directory::new(haruspex_pool.clone())
            .touch("alice")
            .await
            .expect("touch userz row");
        let friendz_store = friendz::Store::new(haruspex_pool, pool);
        friendz_store
            .upsert("alice", friendz::FriendStatus::Accepted, None)
            .await
            .expect("upsert friend");

        let gate = BlobAclGate::friend_only(friendz_store);
        assert!(gate.allow_blob("alice", "anything-at-all").await);
    }

    #[tokio::test]
    async fn friend_only_gate_denies_a_non_friend() {
        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let friendz_store = friendz::Store::new(haruspex_pool, pool);

        let gate = BlobAclGate::friend_only(friendz_store);
        assert!(!gate.allow_blob("mallory", "anything-at-all").await);
    }

    #[tokio::test]
    async fn friend_or_known_hub_gate_allows_a_known_hub_that_is_not_yet_a_friend() {
        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let userz_dir = crate::userz::Directory::new(haruspex_pool.clone());
        // hub-1 has a userz row (e.g. from an earlier ProfileResponse) with
        // is_hub set, but no friendz entry at all yet.
        userz_dir.mark_as_hub("hub-1").await.expect("mark_as_hub");
        let friendz_store = friendz::Store::new(haruspex_pool, pool);

        let gate = BlobAclGate::friend_or_known_hub(friendz_store, userz_dir);
        assert!(gate.allow_blob("hub-1", "anything-at-all").await);
    }

    #[tokio::test]
    async fn friend_or_known_hub_gate_denies_a_stranger_that_is_neither() {
        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let userz_dir = crate::userz::Directory::new(haruspex_pool.clone());
        let friendz_store = friendz::Store::new(haruspex_pool, pool);

        let gate = BlobAclGate::friend_or_known_hub(friendz_store, userz_dir);
        assert!(!gate.allow_blob("mallory", "anything-at-all").await);
    }

    #[tokio::test]
    async fn friend_or_known_hub_gate_still_allows_a_regular_friend() {
        let pool = crate::db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let userz_dir = crate::userz::Directory::new(haruspex_pool.clone());
        userz_dir.touch("alice").await.expect("touch userz row");
        let friendz_store = friendz::Store::new(haruspex_pool, pool);
        friendz_store
            .upsert("alice", friendz::FriendStatus::Accepted, None)
            .await
            .expect("upsert friend");

        let gate = BlobAclGate::friend_or_known_hub(friendz_store, userz_dir);
        assert!(gate.allow_blob("alice", "anything-at-all").await);
    }
}
