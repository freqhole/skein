//! canvas invite, update, and gossip digest handling for the hub peer.
//!
//! handles:
//! - auto-accepting canvas invites from friends
//! - writing the hub peer into the canvas doc's `peers` map on accept
//! - relaying canvas updates to other online friends
//! - computing and sending gossip digests on peer-online events
//! - processing incoming gossip digests (canvas updates + pending invites)
//!
//! canvas invite/update/deletion have no equivalent in haruspex's core
//! friendz protocol, so they travel as `skein:`-namespaced app-extension
//! messages (see `super::wire`). gossip digest's canvas-specific data rides
//! in that message's generic `appPayload` field for the same reason.

use std::collections::HashSet;

use haruspex::protocol::{CoreMessage, FriendzMessage, GossipDigestPendingKnock, WireKnockScope};

use super::wire;
use super::HubPeerService;

impl HubPeerService {
    /// compute and send a gossip digest to a specific peer.
    ///
    /// scans all canvas docs the hub participates in and builds a digest with:
    /// - canvas updates: canvases where lastModified > peer's lastSeenAt
    /// - pending invites: canvases with pending invites targeting this peer
    ///
    /// mirrors the JS `computeAndSendGossipDigest()` in friendz-wiring.ts.
    pub(crate) async fn compute_and_send_gossip_digest(&self, peer_node_id: &str) {
        let doc_ids: Vec<String> = {
            let ids = self.canvas_doc_ids.lock().await;
            ids.iter().cloned().collect()
        };

        if doc_ids.is_empty() {
            tracing::debug!(peer = %peer_node_id, "no canvas docs to gossip about");
            return;
        }

        let mut canvas_updates: Vec<wire::GossipDigestCanvasUpdate> = Vec::new();
        let mut pending_invites: Vec<wire::GossipDigestPendingInvite> = Vec::new();
        let mut pending_knocks: Vec<GossipDigestPendingKnock> = Vec::new();
        let mut shared_canvas_ids: Vec<String> = Vec::new();

        let hub_repo = self.hub_repo.clone();
        let peer_node_id_owned = peer_node_id.to_string();

        for doc_id_str in &doc_ids {
            // look up the doc in hub_repo (local lookup, no parsing needed)
            let handle = match hub_repo.find(doc_id_str).await {
                Some(h) => h,
                None => {
                    tracing::debug!(doc_id = %doc_id_str, "canvas doc not found in hub_repo for gossip");
                    continue;
                }
            };

            // read the automerge doc to extract metadata
            let peer_id = peer_node_id_owned.clone();
            let (update, invite, knocks, peer_is_participant, is_deleted) =
                tokio::task::spawn_blocking(move || read_canvas_for_gossip(&handle, &peer_id))
                    .await
                    .unwrap_or_default();

            // tombstoned canvas — untrack from hub. soft-delete (see
            // `HubDocStorage::soft_remove_canvas_id`'s doc comment) rather
            // than hard-delete, so the data survives for a maintenance
            // window (`reliquary maintenance list`/`restore`/`purge`).
            if is_deleted {
                tracing::info!(
                    doc_id = %doc_id_str,
                    "canvas is tombstoned, untracking from hub (soft-delete)"
                );
                self.canvas_doc_ids.lock().await.remove(doc_id_str);
                self.hub_repo.soft_remove_canvas_id(doc_id_str).await;
                self.hub_repo.evict_doc(doc_id_str).await;
                // sweep orphan blobs — soft-delete blobs unique to this canvas.
                let blobz = self.blobz.clone();
                let storage = self.hub_repo.storage().clone();
                let doc_id_owned = doc_id_str.to_string();
                tokio::spawn(async move {
                    match crate::maintenance::sweep_canvas_blobs(
                        &storage,
                        &blobz,
                        &doc_id_owned,
                        "system:canvas-deleted",
                    )
                    .await
                    {
                        Ok(n) if n > 0 => tracing::info!(
                            canvas_doc_id = %doc_id_owned,
                            soft_deleted = n,
                            "tombstone sweep: orphan blobs soft-deleted"
                        ),
                        Ok(_) => {}
                        Err(e) => tracing::warn!(
                            canvas_doc_id = %doc_id_owned,
                            error = %e,
                            "tombstone sweep: sweep_canvas_blobs failed"
                        ),
                    }
                });
                // if there's an update entry (peer was a participant), still
                // include it in the gossip digest so the peer learns of deletion.
                // but don't add to shared_canvas_ids.
                if let Some(u) = update {
                    canvas_updates.push(u);
                }
                continue;
            }

            if peer_is_participant {
                shared_canvas_ids.push(doc_id_str.clone());
            }
            if let Some(u) = update {
                canvas_updates.push(u);
            }
            if let Some(i) = invite {
                pending_invites.push(i);
            }
            pending_knocks.extend(knocks);
        }

        // only share canvas IDs where the peer is a participant

        if canvas_updates.is_empty() && pending_invites.is_empty() && pending_knocks.is_empty() {
            tracing::debug!(
                peer = %peer_node_id,
                canvas_count = doc_ids.len(),
                "gossip digest: no updates, invites, or knocks, but sending shared canvas IDs"
            );
        }

        tracing::info!(
            peer = %peer_node_id,
            updates = canvas_updates.len(),
            invites = pending_invites.len(),
            knocks = pending_knocks.len(),
            shared_canvases = shared_canvas_ids.len(),
            "sending gossip digest"
        );

        let app_payload = serde_json::to_value(wire::SkeinGossipPayload {
            canvas_updates,
            pending_invites,
            shared_canvas_ids,
        })
        .ok();

        let digest = FriendzMessage::Core(CoreMessage::GossipDigest {
            v: 1,
            pending_knocks,
            // the hub doesn't track profile docs at all — see
            // `GossipDigestProfileEntry`'s doc comment in haruspex's
            // `protocol::messages`.
            profiles: Vec::new(),
            app_payload,
        });

        if let Err(e) = self.send_friendz_message(peer_node_id, &digest).await {
            tracing::warn!(
                peer = %peer_node_id,
                error = %e,
                "failed to send gossip digest"
            );
        }

        // after gossip, send a blob seek to this peer with our missing blob hashes.
        // this helps populate the peer blob inventory for the snatcher.
        self.send_blob_seek_to_peer(peer_node_id).await;
    }

    /// handle an incoming canvas invite from a friend.
    ///
    /// the hub auto-accepts all canvas invites from known friends:
    /// 1. send a canvas-invite-ack (receipt acknowledgment)
    /// 2. send a canvas-invite-accept (auto-accept)
    /// 3. track the canvas doc ID for future gossip
    /// 4. write ourselves into the canvas doc's peers map (async retry)
    ///
    /// hub_repo receives docs passively when the JS peer syncs them — no
    /// explicit document request is needed.
    pub(crate) async fn handle_canvas_invite(
        &self,
        from_node_id: &str,
        ext: wire::CanvasInviteExt,
    ) {
        tracing::info!(
            peer = %from_node_id,
            invite_id = %ext.invite_id,
            canvas_doc_id = %ext.canvas_doc_id,
            canvas_title = %ext.canvas_title,
            origin = %ext.origin_node_id,
            origin_username = %ext.origin_username,
            role = %ext.role,
            "received canvas invite"
        );

        // gate on friendship: only accept from known friends
        if !self.is_friend(from_node_id).await {
            tracing::info!(
                peer = %from_node_id,
                "ignoring canvas invite from non-friend"
            );
            return;
        }

        // 1. send ack (receipt confirmation)
        let ack = wire::build_extension(
            wire::EXT_CANVAS_INVITE_ACK,
            &wire::CanvasInviteAckExt {
                invite_id: ext.invite_id.clone(),
                canvas_doc_id: ext.canvas_doc_id.clone(),
                acker_node_id: self.node_id_str.clone(),
            },
        );
        if let Err(e) = self.send_friendz_message(from_node_id, &ack).await {
            tracing::warn!(
                peer = %from_node_id,
                error = %e,
                "failed to send canvas invite ack"
            );
        } else {
            tracing::info!(
                peer = %from_node_id,
                invite_id = %ext.invite_id,
                "canvas invite ack sent"
            );
        }

        // 2. auto-accept
        let accept = wire::build_extension(
            wire::EXT_CANVAS_INVITE_ACCEPT,
            &wire::CanvasInviteAcceptExt {
                invite_id: ext.invite_id.clone(),
                canvas_doc_id: ext.canvas_doc_id.clone(),
                accepter_node_id: self.node_id_str.clone(),
            },
        );
        if let Err(e) = self.send_friendz_message(from_node_id, &accept).await {
            tracing::warn!(
                peer = %from_node_id,
                error = %e,
                "failed to send canvas invite accept"
            );
        } else {
            tracing::info!(
                peer = %from_node_id,
                invite_id = %ext.invite_id,
                canvas_doc_id = %ext.canvas_doc_id,
                "canvas invite accepted"
            );
        }

        // log hub_repo connection state for diagnostics
        {
            let peer_count = self.hub_repo.connected_peer_count().await;
            let peer_ids = self.hub_repo.connected_peer_ids().await;
            tracing::info!(
                connected_peers = ?peer_ids,
                total_connections = peer_count,
                "hub_repo sync state at invite handling time"
            );
        }

        // NOTE: the hub does NOT dial the inviting peer for automerge sync.
        // instead, the JS side establishes the sync connection after receiving
        // our canvas-invite-accept (via addPeer in onCanvasInviteAccept).
        // hub_repo receives the document passively when the JS peer syncs it.

        // 3. track the canvas doc ID for gossip
        {
            let mut ids = self.canvas_doc_ids.lock().await;
            ids.insert(ext.canvas_doc_id.clone());
        }
        self.hub_repo.save_canvas_id(&ext.canvas_doc_id).await;
        tracing::info!(
            canvas_doc_id = %ext.canvas_doc_id,
            "canvas doc added to hub tracking set"
        );

        // 4. write ourselves into the canvas doc's peers map (async — doc may
        //    not be synced yet, so we retry in the background)
        self.schedule_write_self_to_canvas(&ext.canvas_doc_id);

        // 5. trigger a blob snatch scan after a delay — gives automerge sync
        //    time to deliver the canvas doc + widget state docs before scanning
        let trigger = self.snatch_trigger.clone();
        tokio::spawn(async move {
            // wait for automerge sync to deliver docs (canvas + widget state docs)
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            trigger.notify_one();
            tracing::info!("triggered blob snatcher scan after canvas invite");
        });
    }

    /// handle an incoming canvas knock sent directly to the hub.
    ///
    /// **gated on friendship, same as [`Self::handle_canvas_invite`]**: a
    /// knock's entire purpose is to let a stranger ask for canvas access,
    /// but the requester and the hub are, by definition, not friends yet
    /// (that's the whole reason a knock is a knock and not a normal
    /// friend-and-invite flow) — so the hub can never be a stranger-facing
    /// knock target, only a relay between peers it's already friends with.
    /// a knock from a non-friend is dropped here: no ack, no record, just a
    /// log line. this is a deliberate reversal of an earlier design where
    /// the hub accepted any knock it could resolve a doc for, regardless of
    /// friendship — see `docs/knock-and-hub-relay-plan.md` section 5.2. the
    /// hub still *does* help relay an already-recorded knock between actual
    /// friends: see [`Self::handle_gossip_digest`]'s `pending_knocks`
    /// handling, which a friend who already holds the canvas doc (and thus
    /// already has the knock in their own `pendingKnocks`) gossips to the
    /// hub — that path requires no direct contact between the hub and the
    /// original (non-friend) requester at all.
    pub(crate) async fn handle_canvas_knock(
        &self,
        from_node_id: &str,
        knock_id: &str,
        canvas_doc_id: &str,
        requester_node_id: &str,
        requester_username: &str,
        message: &str,
    ) {
        if !self.is_friend(from_node_id).await {
            tracing::info!(
                peer = %from_node_id,
                knock_id = %knock_id,
                canvas_doc_id = %canvas_doc_id,
                "ignoring canvas knock sent directly by a non-friend"
            );
            return;
        }

        tracing::info!(
            peer = %from_node_id,
            knock_id = %knock_id,
            canvas_doc_id = %canvas_doc_id,
            requester = %requester_node_id,
            requester_username = %requester_username,
            "received canvas knock"
        );

        let handle = match self.hub_repo.find(canvas_doc_id).await {
            Some(h) => h,
            None => {
                tracing::info!(
                    peer = %from_node_id,
                    canvas_doc_id = %canvas_doc_id,
                    "ignoring canvas knock for a canvas doc the hub doesn't hold"
                );
                return;
            }
        };

        let knock_id_owned = knock_id.to_string();
        let requester_node_id_owned = requester_node_id.to_string();
        let requester_username_owned = requester_username.to_string();
        let message_owned = message.to_string();

        let recorded = tokio::task::spawn_blocking(move || {
            record_knock_in_canvas_doc(
                &handle,
                &knock_id_owned,
                &requester_node_id_owned,
                &requester_username_owned,
                &message_owned,
            )
        })
        .await
        .unwrap_or(false);

        if !recorded {
            tracing::info!(
                canvas_doc_id = %canvas_doc_id,
                "canvas knock not recorded — doc has no content yet (not synced)"
            );
            return;
        }

        let ack = FriendzMessage::Core(CoreMessage::KnockAck {
            v: 1,
            knock_id: knock_id.to_string(),
            acker_node_id: self.node_id_str.clone(),
            resource_id: Some(canvas_doc_id.to_string()),
        });
        if let Err(e) = self.send_friendz_message(from_node_id, &ack).await {
            tracing::warn!(
                peer = %from_node_id,
                error = %e,
                "failed to send canvas knock ack"
            );
        } else {
            tracing::info!(
                peer = %from_node_id,
                knock_id = %knock_id,
                canvas_doc_id = %canvas_doc_id,
                "canvas knock ack sent"
            );
        }
    }

    /// schedule a background task to write the hub peer into a canvas doc's
    /// `peers` map and remove from `pendingInvites`.
    ///
    /// the document may not be synced yet when this is called, so the task
    /// retries up to ~30s with 2s intervals.
    /// mirrors what the JS client does in `registerAndReconnectPeers()`:
    /// `canvas.store.addPeer(identity.node_id)` +
    /// `canvas.store.removePendingInvite(identity.node_id)`.
    pub(crate) fn schedule_write_self_to_canvas(&self, canvas_doc_id: &str) {
        let hub_repo = self.hub_repo.clone();
        let node_id = self.node_id_str.clone();
        let doc_id_str = canvas_doc_id.to_string();

        tokio::spawn(async move {
            tracing::info!(
                canvas_doc_id = %doc_id_str,
                node_id = %node_id,
                "schedule_write_self_to_canvas: starting background peer-write task"
            );

            // retry up to 60 times with 2s delay = ~2min total. patience
            // matters after a hub restart: a SIGKILL'd process sends no
            // QUIC close frames, so the inviting browser peer only notices
            // its stream to the old process is dead after the QUIC idle
            // timeout (~30s) and only then reconnects and syncs the canvas
            // doc content — a ~30s retry budget lost that race (observed in
            // the restart-mid-flight e2e once browser boot got marginally
            // slower). this is an idle background task; extra patience is
            // free.
            for attempt in 0u32..60 {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }

                tracing::info!(
                    doc_id = %doc_id_str,
                    attempt,
                    "peer-write: looking up doc in hub_repo"
                );

                // use wait_for_doc on first attempt (gives the doc a chance to
                // arrive via sync), plain find on retries
                let handle = if attempt == 0 {
                    hub_repo
                        .wait_for_doc(&doc_id_str, std::time::Duration::from_secs(5))
                        .await
                } else {
                    hub_repo.find(&doc_id_str).await
                };

                let handle = match handle {
                    Some(h) => {
                        tracing::info!(
                            doc_id = %doc_id_str,
                            attempt,
                            hub_repo_doc_id = %h.document_id(),
                            "peer-write: found doc handle"
                        );
                        h
                    }
                    None => {
                        tracing::info!(
                            doc_id = %doc_id_str,
                            attempt,
                            "peer-write: doc not available yet — will retry"
                        );
                        continue;
                    }
                };

                let nid = node_id.clone();
                let did = doc_id_str.clone();

                let wrote = tokio::task::spawn_blocking(move || {
                    write_self_to_canvas_doc(&handle, &nid, &did)
                })
                .await
                .unwrap_or(false);

                if wrote {
                    tracing::info!(
                        canvas_doc_id = %doc_id_str,
                        node_id = %node_id,
                        attempt,
                        "peer-write: SUCCESS — wrote hub peer into canvas doc peers map"
                    );
                    // this mutation happened outside the normal request/
                    // response sync cycle, so nothing would otherwise tell
                    // an already-connected peer's `handle_connection` loop
                    // to push it — see `notify_doc_changed`'s doc comment
                    // for the bug this closes (a real one, 2026-07-02: the
                    // hub wrote itself into `.peers` successfully but the
                    // inviting peer never found out).
                    hub_repo.notify_doc_changed(&doc_id_str);
                    return;
                }

                tracing::info!(
                    doc_id = %doc_id_str,
                    attempt,
                    "peer-write: doc not ready yet (no content synced), will retry"
                );
            }

            tracing::warn!(
                doc_id = %doc_id_str,
                "peer-write: GAVE UP after 60 attempts — canvas doc never had content"
            );
        });
    }

    /// handle an incoming canvas update notification.
    ///
    /// if the hub participates in this canvas, log the update info for
    /// future gossip relay to other peers.
    pub(crate) async fn handle_canvas_update(
        &self,
        from_node_id: &str,
        ext: wire::CanvasUpdateExt,
    ) {
        let is_tracked = {
            let ids = self.canvas_doc_ids.lock().await;
            ids.contains(&ext.canvas_doc_id)
        };

        if is_tracked {
            tracing::info!(
                peer = %from_node_id,
                canvas_doc_id = %ext.canvas_doc_id,
                last_modified_at = %ext.last_modified_at,
                widget_count = ext.widget_count,
                modified_by = %ext.modified_by_node_id,
                modified_by_username = %ext.modified_by_username,
                "canvas update on tracked canvas (available for gossip relay)"
            );

            // relay this update to other online friends who are on this canvas
            // (but not the sender and not the modifier)
            let online_peers = self.friendz.service().online_peers().await;
            for peer_id in &online_peers {
                if peer_id == from_node_id || peer_id == &ext.modified_by_node_id {
                    continue;
                }
                // only relay to friends
                if !self.is_friend(peer_id).await {
                    continue;
                }
                let update = wire::build_extension(
                    wire::EXT_CANVAS_UPDATE,
                    &wire::CanvasUpdateExt {
                        canvas_doc_id: ext.canvas_doc_id.clone(),
                        last_modified_at: ext.last_modified_at.clone(),
                        widget_count: ext.widget_count,
                        modified_by_node_id: ext.modified_by_node_id.clone(),
                        modified_by_username: ext.modified_by_username.clone(),
                    },
                );
                if let Err(e) = self.send_friendz_message(peer_id, &update).await {
                    tracing::debug!(
                        peer = %peer_id,
                        error = %e,
                        "failed to relay canvas update"
                    );
                } else {
                    tracing::debug!(
                        peer = %peer_id,
                        canvas_doc_id = %ext.canvas_doc_id,
                        "relayed canvas update"
                    );
                }
            }
        } else {
            tracing::debug!(
                peer = %from_node_id,
                canvas_doc_id = %ext.canvas_doc_id,
                "received canvas update for untracked canvas — ignoring"
            );
        }
    }

    /// handle a canvas-deleted notification from a peer.
    ///
    /// if the hub tracks this canvas, untrack it and relay the deletion
    /// to other online friends who are on this canvas.
    pub(crate) async fn handle_canvas_deleted(
        &self,
        from_node_id: &str,
        ext: wire::CanvasDeletedExt,
    ) {
        let is_tracked = {
            let ids = self.canvas_doc_ids.lock().await;
            ids.contains(&ext.canvas_doc_id)
        };

        if !is_tracked {
            tracing::debug!(
                peer = %from_node_id,
                canvas_doc_id = %ext.canvas_doc_id,
                "received canvas-deleted for untracked canvas — ignoring"
            );
            return;
        }

        tracing::info!(
            peer = %from_node_id,
            canvas_doc_id = %ext.canvas_doc_id,
            canvas_title = %ext.canvas_title,
            deleted_by = %ext.deleted_by,
            deleted_by_username = %ext.deleted_by_username,
            delete_mode = %ext.delete_mode,
            deleted_at = %ext.deleted_at,
            "canvas deleted — untracking (soft-delete) and relaying"
        );

        // untrack the canvas — soft-delete rather than hard-delete (see
        // `HubDocStorage::soft_remove_canvas_id`'s doc comment), same
        // reasoning as the tombstone-detection path above and the
        // ACL-removed path in hub/messages.rs: the maintenance CLI is the
        // one place that actually destroys data, not this passive
        // notification handler.
        {
            let mut ids = self.canvas_doc_ids.lock().await;
            ids.remove(&ext.canvas_doc_id);
        }
        self.hub_repo
            .soft_remove_canvas_id(&ext.canvas_doc_id)
            .await;
        self.hub_repo.evict_doc(&ext.canvas_doc_id).await;

        // sweep orphan blobs — soft-delete blobs unique to this now-deleted canvas.
        {
            let blobz = self.blobz.clone();
            let storage = self.hub_repo.storage().clone();
            let doc_id_owned = ext.canvas_doc_id.clone();
            tokio::spawn(async move {
                match crate::maintenance::sweep_canvas_blobs(
                    &storage,
                    &blobz,
                    &doc_id_owned,
                    "system:canvas-deleted",
                )
                .await
                {
                    Ok(n) if n > 0 => tracing::info!(
                        canvas_doc_id = %doc_id_owned,
                        soft_deleted = n,
                        "canvas-deleted sweep: orphan blobs soft-deleted"
                    ),
                    Ok(_) => {}
                    Err(e) => tracing::warn!(
                        canvas_doc_id = %doc_id_owned,
                        error = %e,
                        "canvas-deleted sweep: sweep_canvas_blobs failed"
                    ),
                }
            });
        }

        // relay to other online friends (not the sender, not the deleter)
        let online_peers = self.friendz.service().online_peers().await;
        for peer_id in &online_peers {
            if peer_id == from_node_id || peer_id == &ext.deleted_by {
                continue;
            }
            if !self.is_friend(peer_id).await {
                continue;
            }
            let msg = wire::build_extension(
                wire::EXT_CANVAS_DELETED,
                &wire::CanvasDeletedExt {
                    canvas_doc_id: ext.canvas_doc_id.clone(),
                    canvas_title: ext.canvas_title.clone(),
                    deleted_by: ext.deleted_by.clone(),
                    deleted_by_username: ext.deleted_by_username.clone(),
                    delete_mode: ext.delete_mode.clone(),
                    deleted_at: ext.deleted_at.clone(),
                },
            );
            if let Err(e) = self.send_friendz_message(peer_id, &msg).await {
                tracing::debug!(
                    peer = %peer_id,
                    error = %e,
                    "failed to relay canvas-deleted"
                );
            } else {
                tracing::debug!(
                    peer = %peer_id,
                    canvas_doc_id = %ext.canvas_doc_id,
                    "relayed canvas-deleted"
                );
            }
        }
    }

    /// handle an incoming gossip digest from a peer that just came online.
    ///
    /// processes:
    /// - canvas_updates: for canvases the hub knows about, log the update
    ///   (the hub sees changes via automerge sync anyway)
    /// - pending_invites: for canvases the hub doesn't know about yet, treat
    ///   as a new invite — track the doc and start writing ourselves in
    /// - pending_knocks: for canvases the hub already tracks, merge each
    ///   relayed knock into the hub's own copy of the canvas doc (same
    ///   idempotent `record_knock_in_canvas_doc` helper `handle_canvas_knock`
    ///   uses) — this is what actually makes the hub a real relay for
    ///   knocks: once merged into the hub's doc, ordinary automerge sync
    ///   carries it to every other peer connected to the hub, including
    ///   ones that come online later and were never directly connected to
    ///   the original requester.
    /// - profiles: not yet handled — the hub has no profile-doc tracking of
    ///   its own (see `GossipDigestProfileEntry`'s doc comment in
    ///   haruspex's `protocol::messages`). logged for visibility, not acted
    ///   on.
    ///
    /// hub_repo receives docs passively via sync — no explicit request needed.
    pub(crate) async fn handle_gossip_digest(
        &self,
        from_node_id: &str,
        canvas_updates: Vec<wire::GossipDigestCanvasUpdate>,
        pending_invites: Vec<wire::GossipDigestPendingInvite>,
        pending_knocks: Vec<GossipDigestPendingKnock>,
        shared_canvas_ids: Vec<String>,
        profiles: Vec<haruspex::protocol::GossipDigestProfileEntry>,
    ) {
        // gossip is a friends-only relay mechanism, full stop: a non-friend
        // could otherwise hand the hub fabricated canvas updates/invites/
        // knocks and get it to start tracking an arbitrary canvas doc,
        // send an invite-accept to an arbitrary target, or merge a bogus
        // knock into a doc it holds — none of which requires ever having
        // been on the canvas together, let alone being an actual friend.
        if !self.is_friend(from_node_id).await {
            tracing::info!(
                peer = %from_node_id,
                "ignoring gossip digest from a non-friend"
            );
            return;
        }

        tracing::info!(
            peer = %from_node_id,
            updates = canvas_updates.len(),
            invites = pending_invites.len(),
            knocks = pending_knocks.len(),
            profiles = profiles.len(),
            "received gossip digest"
        );

        if !profiles.is_empty() {
            tracing::debug!(
                peer = %from_node_id,
                count = profiles.len(),
                "gossip: profile-doc pointers received, hub does not track profile docs — ignoring"
            );
        }

        // process canvas update notifications
        for update in &canvas_updates {
            let is_tracked = {
                let ids = self.canvas_doc_ids.lock().await;
                ids.contains(&update.canvas_doc_id)
            };

            if is_tracked {
                tracing::info!(
                    peer = %from_node_id,
                    canvas_doc_id = %update.canvas_doc_id,
                    last_modified_at = %update.last_modified_at,
                    last_modified_by = %update.last_modified_by,
                    "gossip: canvas has updates (hub will sync via automerge)"
                );
            } else {
                tracing::debug!(
                    peer = %from_node_id,
                    canvas_doc_id = %update.canvas_doc_id,
                    "gossip: canvas update for untracked canvas — ignoring"
                );
            }
        }

        // process pending invite notifications — treat as new invites for
        // canvases the hub doesn't already participate in
        for invite in &pending_invites {
            let already_tracked = {
                let ids = self.canvas_doc_ids.lock().await;
                ids.contains(&invite.canvas_doc_id)
            };

            if already_tracked {
                tracing::debug!(
                    canvas_doc_id = %invite.canvas_doc_id,
                    "gossip: pending invite for already-tracked canvas — skipping"
                );
                continue;
            }

            tracing::info!(
                peer = %from_node_id,
                canvas_doc_id = %invite.canvas_doc_id,
                canvas_title = %invite.canvas_title,
                invited_by = %invite.invited_by,
                invited_by_username = %invite.invited_by_username,
                role = %invite.role,
                "gossip: treating pending invite as new canvas invite"
            );

            // track it (hub_repo will receive the doc passively when peers sync)
            {
                let mut ids = self.canvas_doc_ids.lock().await;
                ids.insert(invite.canvas_doc_id.clone());
            }
            self.hub_repo.save_canvas_id(&invite.canvas_doc_id).await;

            // send accept back to the inviter (if they're online and not the
            // relay peer, send to them; otherwise send to the relay peer)
            let accept_target = if self.friendz.service().is_online(&invite.invited_by).await {
                &invite.invited_by
            } else {
                from_node_id
            };

            let invite_id = uuid::Uuid::new_v4().to_string();
            let accept = wire::build_extension(
                wire::EXT_CANVAS_INVITE_ACCEPT,
                &wire::CanvasInviteAcceptExt {
                    invite_id,
                    canvas_doc_id: invite.canvas_doc_id.clone(),
                    accepter_node_id: self.node_id_str.clone(),
                },
            );
            if let Err(e) = self.send_friendz_message(accept_target, &accept).await {
                tracing::debug!(
                    peer = %accept_target,
                    error = %e,
                    "failed to send canvas invite accept for gossip invite"
                );
            } else {
                tracing::info!(
                    peer = %accept_target,
                    canvas_doc_id = %invite.canvas_doc_id,
                    "sent canvas invite accept for gossip-relayed invite"
                );
            }

            // write ourselves into the canvas doc's peers map
            self.schedule_write_self_to_canvas(&invite.canvas_doc_id);

            // trigger a blob snatch scan after a delay — gives automerge sync
            // time to deliver the canvas doc + widget state docs before scanning
            let trigger = self.snatch_trigger.clone();
            tokio::spawn(async move {
                // wait for automerge sync to deliver docs (canvas + widget state docs)
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                trigger.notify_one();
                tracing::info!("triggered blob snatcher scan after gossip digest invite");
            });
        }

        // process relayed pending knocks — merge each one into the hub's own
        // copy of the referenced canvas doc (if the hub tracks it). once
        // merged, ordinary automerge sync carries it to every other peer
        // connected to the hub, including ones that come online later and
        // were never directly connected to the original requester. best
        // effort per entry: silently skipped if the hub doesn't hold that
        // canvas doc at all, or if the knock's scope isn't a resource scope
        // (a canvas knock is always `WireKnockScope::Resource`).
        for knock in &pending_knocks {
            let canvas_doc_id = match &knock.scope {
                WireKnockScope::Resource { resource_id, .. } => resource_id.clone(),
                _ => {
                    tracing::debug!(
                        peer = %from_node_id,
                        knock_id = %knock.knock_id,
                        "gossip: relayed knock has a non-resource scope — skipping"
                    );
                    continue;
                }
            };
            let handle = match self.hub_repo.find(&canvas_doc_id).await {
                Some(h) => h,
                None => {
                    tracing::debug!(
                        canvas_doc_id = %canvas_doc_id,
                        peer = %from_node_id,
                        "gossip: relayed knock for a canvas the hub doesn't hold — skipping"
                    );
                    continue;
                }
            };
            let knock_id = knock.knock_id.clone();
            let requester_node_id = knock.node_id.clone();
            let requester_username = knock.username.clone().unwrap_or_default();
            let message = knock.message.clone();
            let recorded = tokio::task::spawn_blocking(move || {
                record_knock_in_canvas_doc(
                    &handle,
                    &knock_id,
                    &requester_node_id,
                    &requester_username,
                    &message,
                )
            })
            .await
            .unwrap_or(false);
            if recorded {
                tracing::info!(
                    peer = %from_node_id,
                    canvas_doc_id = %canvas_doc_id,
                    requester = %knock.node_id,
                    "gossip: merged relayed knock into hub's canvas doc"
                );
            }
        }

        // process shared canvas IDs — discover canvases we should be on but aren't
        if !shared_canvas_ids.is_empty() {
            let our_ids: HashSet<String> = {
                let ids = self.canvas_doc_ids.lock().await;
                ids.clone()
            };

            for canvas_id in &shared_canvas_ids {
                if our_ids.contains(canvas_id) {
                    continue; // already tracking
                }

                // check if we're in this canvas's peers or pendingInvites
                // by looking at the doc (if we have it)
                let handle = match self.hub_repo.find(canvas_id).await {
                    Some(h) => h,
                    None => {
                        tracing::debug!(
                            canvas_doc_id = %canvas_id,
                            peer = %from_node_id,
                            "peer shared canvas we don't have — may need invite"
                        );
                        continue;
                    }
                };

                let node_id = self.node_id_str.clone();
                let canvas_id_owned = canvas_id.clone();
                let should_track = tokio::task::spawn_blocking(move || {
                    let mut result = false;
                    handle.with_document(|doc| {
                        use automerge::ReadDoc;
                        // check if we're in the peers map
                        if let Ok(Some((_, peers_obj))) = doc.get(automerge::ROOT, "peers") {
                            if doc
                                .get(&peers_obj, node_id.as_str())
                                .ok()
                                .flatten()
                                .is_some()
                            {
                                result = true;
                                return;
                            }
                        }
                        // check if we're in pendingInvites
                        if let Ok(Some((_, pending_obj))) =
                            doc.get(automerge::ROOT, "pendingInvites")
                        {
                            if doc
                                .get(&pending_obj, node_id.as_str())
                                .ok()
                                .flatten()
                                .is_some()
                            {
                                result = true;
                            }
                        }
                    });
                    result
                })
                .await
                .unwrap_or(false);

                if should_track {
                    tracing::info!(
                        canvas_doc_id = %canvas_id_owned,
                        peer = %from_node_id,
                        "discovered untracked canvas via gossip — starting to track"
                    );

                    {
                        let mut ids = self.canvas_doc_ids.lock().await;
                        ids.insert(canvas_id_owned.clone());
                    }
                    self.hub_repo.save_canvas_id(&canvas_id_owned).await;

                    // write ourselves into the canvas doc's peers map
                    self.schedule_write_self_to_canvas(&canvas_id_owned);

                    // trigger a blob snatch scan after a delay
                    let trigger = self.snatch_trigger.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        trigger.notify_one();
                        tracing::info!(
                            "triggered blob snatcher scan after gossip canvas discovery"
                        );
                    });
                }
            }
        }
    }

    /// true if `node_id` is named in the `acl` or `pendingInvites` of any
    /// canvas doc the hub currently holds — i.e. an actual canvas admin
    /// already decided to grant (or offer) this peer canvas access, even
    /// though the hub itself has no prior friend relationship with them.
    ///
    /// this is the "canvas-vouched" auto-accept condition for an inbound
    /// `FriendRequest` (see `hub/messages.rs`): it's what lets a brand-new
    /// invitee discover a hub's node id from a canvas share link, send it
    /// a friend request, and get auto-accepted — without the canvas owner
    /// needing to be online, and without the hub operator needing to
    /// manually pre-approve the invitee's node id via the hub-admin
    /// protocol. the hub already holds a synced copy of the canvas doc
    /// (that's how it came to be tracking it at all), so this check is
    /// just a local doc read, no network round-trip.
    pub(crate) async fn is_vouched_by_any_canvas(&self, node_id: &str) -> bool {
        let doc_ids: Vec<String> = {
            let ids = self.canvas_doc_ids.lock().await;
            ids.iter().cloned().collect()
        };

        for doc_id in doc_ids {
            let Some(handle) = self.hub_repo.find(&doc_id).await else {
                continue;
            };
            let node_id_owned = node_id.to_string();
            let vouched = tokio::task::spawn_blocking(move || {
                canvas_acl_or_invite_contains(&handle, &node_id_owned)
            })
            .await
            .unwrap_or(false);
            if vouched {
                return true;
            }
        }
        false
    }

    /// send a BlobSeek to a peer with all missing blob hashes.
    ///
    /// called after gossip digest exchange. the peer responds with BlobOffer
    /// listing which blobs they have, populating the peer blob inventory.
    pub(crate) async fn send_blob_seek_to_peer(&self, peer_node_id: &str) {
        // collect missing blob blake3 hashes from the snatcher's perspective.
        // scan all docs for file widgets that reference blobs we don't have.
        let doc_ids = self.hub_repo.all_doc_ids().await;
        if doc_ids.is_empty() {
            return;
        }

        let mut missing_hashes: Vec<String> = Vec::new();

        for doc_id in &doc_ids {
            let handle = match self.hub_repo.find(doc_id).await {
                Some(h) => h,
                None => continue,
            };

            // read root-level blake3 (widget state docs have this at root)
            let blake3 = tokio::task::spawn_blocking(move || {
                let mut result = String::new();
                handle.with_document(|doc| {
                    use automerge::ReadDoc;
                    if let Ok(Some((v, _))) = doc.get(automerge::ROOT, "blake3") {
                        if let Some(s) = v.to_str() {
                            result = s.to_string();
                        }
                    }
                });
                result
            })
            .await
            .unwrap_or_default();

            if blake3.is_empty() {
                continue;
            }

            // check if we already have this blob
            match self.blobz.get(&blake3).await {
                Ok(Some(_)) => {} // already have it
                _ => {
                    if !missing_hashes.contains(&blake3) {
                        missing_hashes.push(blake3);
                    }
                }
            }
        }

        if missing_hashes.is_empty() {
            tracing::debug!(peer = %peer_node_id, "no missing blobs to seek");
            return;
        }

        tracing::info!(
            peer = %peer_node_id,
            count = missing_hashes.len(),
            "sending blob seek"
        );

        let seek = FriendzMessage::Core(CoreMessage::BlobSeek {
            v: 1,
            needed: missing_hashes,
        });
        if let Err(e) = self.send_friendz_message(peer_node_id, &seek).await {
            tracing::warn!(
                peer = %peer_node_id,
                error = %e,
                "failed to send blob seek"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// automerge doc write helpers
// ---------------------------------------------------------------------------

/// write the hub peer into a canvas document's `peers` map and remove from
/// `pendingInvites`. returns `true` if the write succeeded (or the peer was
/// already present), `false` if the doc isn't ready yet (no content synced).
///
/// runs inside `spawn_blocking` because doc access holds a lock.
fn write_self_to_canvas_doc(
    handle: &crate::hub_repo::DocHandle,
    node_id: &str,
    canvas_doc_id: &str,
) -> bool {
    use automerge::ReadDoc;

    handle.with_document_mut(|doc| {
        // dump all root-level keys for diagnostics
        let root_keys: Vec<String> = doc.keys(automerge::ROOT).collect();
        tracing::info!(
            canvas_doc_id = %canvas_doc_id,
            root_keys = ?root_keys,
            root_key_count = root_keys.len(),
            "write_self_to_canvas_doc: inspecting doc state"
        );

        // check if the doc has any content — if it's completely empty the
        // document hasn't synced from a peer yet
        let has_version = doc.get(automerge::ROOT, "version").ok().flatten().is_some();
        let has_widgets = doc.get(automerge::ROOT, "widgets").ok().flatten().is_some();
        let has_title = doc.get(automerge::ROOT, "title").ok().flatten().is_some();
        let has_peers = doc.get(automerge::ROOT, "peers").ok().flatten().is_some();

        tracing::info!(
            canvas_doc_id = %canvas_doc_id,
            has_version,
            has_widgets,
            has_title,
            has_peers,
            "write_self_to_canvas_doc: content check"
        );

        if !has_version && !has_widgets && !has_title {
            tracing::info!(
                canvas_doc_id = %canvas_doc_id,
                "write_self_to_canvas_doc: doc has no content — not synced yet"
            );
            return false; // doc not synced yet
        }

        // check if already in peers
        let already_in_peers = if let Ok(Some((_, peers_obj))) = doc.get(automerge::ROOT, "peers") {
            let peer_keys: Vec<String> = doc.keys(&peers_obj).collect();
            let found = doc.get(&peers_obj, node_id).ok().flatten().is_some();
            tracing::info!(
                canvas_doc_id = %canvas_doc_id,
                peer_keys = ?peer_keys,
                our_node_id = %node_id,
                found_self = found,
                "write_self_to_canvas_doc: existing peers in doc"
            );
            found
        } else {
            tracing::info!(
                canvas_doc_id = %canvas_doc_id,
                "write_self_to_canvas_doc: no peers map in doc yet"
            );
            false
        };

        if already_in_peers {
            // stamp lastSeenAt so the hub doesn't appear stale in gossip
            let now = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

            let nid2 = node_id.to_string();
            match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
                use automerge::transaction::Transactable;
                if let Some((_, peers_obj)) = tx.get(automerge::ROOT, "peers")? {
                    if let Some((_, peer_obj)) = tx.get(&peers_obj, nid2.as_str())? {
                        tx.put(&peer_obj, "lastSeenAt", now.as_str())?;
                    }
                }
                Ok(())
            }) {
                Ok(_) => {
                    tracing::debug!(
                        canvas_doc_id = %canvas_doc_id,
                        "write_self_to_canvas_doc: stamped lastSeenAt"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        canvas_doc_id = %canvas_doc_id,
                        error = ?e,
                        "write_self_to_canvas_doc: failed to stamp lastSeenAt"
                    );
                }
            }
            return true;
        }

        // check pendingInvites state before writing
        if let Ok(Some((_, pending_obj))) = doc.get(automerge::ROOT, "pendingInvites") {
            let pending_keys: Vec<String> = doc.keys(&pending_obj).collect();
            let has_our_invite = doc.get(&pending_obj, node_id).ok().flatten().is_some();
            tracing::info!(
                canvas_doc_id = %canvas_doc_id,
                pending_keys = ?pending_keys,
                has_our_invite,
                "write_self_to_canvas_doc: pendingInvites state"
            );
        } else {
            tracing::info!(
                canvas_doc_id = %canvas_doc_id,
                "write_self_to_canvas_doc: no pendingInvites map in doc"
            );
        }

        // generate ISO timestamp matching JS `new Date().toISOString()`
        let joined_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

        tracing::info!(
            canvas_doc_id = %canvas_doc_id,
            node_id = %node_id,
            joined_at = %joined_at,
            "write_self_to_canvas_doc: writing peer entry via transact"
        );

        let nid = node_id.to_string();

        match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;

            // ensure peers map exists
            let peers_obj = match tx.get(automerge::ROOT, "peers")? {
                Some((_, obj_id)) => {
                    tracing::debug!(
                        canvas_doc_id = %canvas_doc_id,
                        "transact: using existing peers map"
                    );
                    obj_id
                }
                None => {
                    tracing::info!(
                        canvas_doc_id = %canvas_doc_id,
                        "transact: creating new peers map"
                    );
                    tx.put_object(automerge::ROOT, "peers", automerge::ObjType::Map)?
                }
            };

            // create our peer entry: { nodeId, joinedAt, lastSeenAt }
            let peer_obj = tx.put_object(&peers_obj, nid.as_str(), automerge::ObjType::Map)?;
            tx.put(&peer_obj, "nodeId", nid.as_str())?;
            tx.put(&peer_obj, "joinedAt", joined_at.as_str())?;
            tx.put(&peer_obj, "lastSeenAt", joined_at.as_str())?;

            tracing::info!(
                canvas_doc_id = %canvas_doc_id,
                node_id = %nid,
                "transact: wrote peer entry {{ nodeId, joinedAt, lastSeenAt }}"
            );

            // remove from pendingInvites if present
            if let Some((_, pending_obj)) = tx.get(automerge::ROOT, "pendingInvites")? {
                if tx.get(&pending_obj, nid.as_str())?.is_some() {
                    tx.delete(&pending_obj, nid.as_str())?;
                    tracing::info!(
                        canvas_doc_id = %canvas_doc_id,
                        "transact: removed hub peer from pendingInvites"
                    );
                }
            }

            Ok(())
        }) {
            Ok(_) => {
                tracing::info!(
                    canvas_doc_id = %canvas_doc_id,
                    "write_self_to_canvas_doc: transact committed successfully"
                );
                true
            }
            Err(e) => {
                tracing::warn!(
                    canvas_doc_id = %canvas_doc_id,
                    error = ?e,
                    "write_self_to_canvas_doc: transact FAILED"
                );
                false
            }
        }
    })
}

/// record a knock into a canvas doc's `pendingKnocks` map, or leave it
/// unchanged if an entry for this requester already exists.
///
/// mirrors `CanvasStore.recordKnock()`'s TS-side idempotency rules (see
/// `canvas-doc.ts`'s `PendingCanvasKnock` doc comment and
/// `docs/knock-and-hub-relay-plan.md` section 3.2) — tomb's
/// `UNIQUE(node_id)` + idempotent-retry + silent-rejection behavior,
/// adapted to an automerge map instead of a SQL constraint. in every
/// "entry already exists" case (still fully pending, already declined, or
/// already approved) the existing entry is left untouched — no update, no
/// duplicate — so this function only ever needs two branches: "insert a
/// fresh entry" or "no-op, it's already there."
///
/// this is the hub's own durable persistence for canvas knocks: the entry
/// lives in the canvas automerge doc, which `hub_repo` persists to sqlite
/// and syncs to every peer on the canvas, so a knock survives a hub
/// restart without needing a separate relational knock store.
///
/// returns `true` if the knock is now recorded (either freshly inserted or
/// already present from an earlier attempt), `false` if the canvas doc has
/// no content yet (not synced) and nothing could be written — same
/// "is this doc actually synced" gate `write_self_to_canvas_doc` uses.
///
/// runs inside `spawn_blocking` because doc access holds a lock.
fn record_knock_in_canvas_doc(
    handle: &crate::hub_repo::DocHandle,
    knock_id: &str,
    requester_node_id: &str,
    requester_username: &str,
    message: &str,
) -> bool {
    use automerge::ReadDoc;

    handle.with_document_mut(|doc| {
        let has_version = doc.get(automerge::ROOT, "version").ok().flatten().is_some();
        let has_widgets = doc.get(automerge::ROOT, "widgets").ok().flatten().is_some();
        let has_title = doc.get(automerge::ROOT, "title").ok().flatten().is_some();
        if !has_version && !has_widgets && !has_title {
            tracing::info!("record_knock_in_canvas_doc: doc has no content yet — not synced");
            return false;
        }

        // idempotent: an entry already exists for this requester (pending,
        // approved, or declined) — leave it untouched, this is just a retry.
        if let Ok(Some((_, pending_obj))) = doc.get(automerge::ROOT, "pendingKnocks") {
            if doc
                .get(&pending_obj, requester_node_id)
                .ok()
                .flatten()
                .is_some()
            {
                tracing::debug!(
                    requester = %requester_node_id,
                    "record_knock_in_canvas_doc: knock already recorded, idempotent no-op"
                );
                return true;
            }
        }

        let knocked_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

        let kid = knock_id.to_string();
        let nid = requester_node_id.to_string();
        let uname = requester_username.to_string();
        let msg = message.to_string();

        match doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;

            let pending_obj = match tx.get(automerge::ROOT, "pendingKnocks")? {
                Some((_, obj_id)) => obj_id,
                None => tx.put_object(automerge::ROOT, "pendingKnocks", automerge::ObjType::Map)?,
            };

            // re-check inside the transaction: another writer may have
            // recorded this same knock between the read above and here.
            if tx.get(&pending_obj, nid.as_str())?.is_some() {
                return Ok(());
            }

            let knock_obj = tx.put_object(&pending_obj, nid.as_str(), automerge::ObjType::Map)?;
            tx.put(&knock_obj, "knockId", kid.as_str())?;
            tx.put(&knock_obj, "requesterNodeId", nid.as_str())?;
            tx.put(&knock_obj, "requesterUsername", uname.as_str())?;
            tx.put(&knock_obj, "message", msg.as_str())?;
            tx.put(&knock_obj, "knockedAt", knocked_at.as_str())?;
            tx.put_object(&knock_obj, "decisions", automerge::ObjType::List)?;

            Ok(())
        }) {
            Ok(_) => true,
            Err(e) => {
                tracing::warn!(
                    requester = %requester_node_id,
                    error = ?e,
                    "record_knock_in_canvas_doc: transact FAILED"
                );
                false
            }
        }
    })
}

// ---------------------------------------------------------------------------
// automerge doc reading helpers
// ---------------------------------------------------------------------------

/// true if `node_id` appears as a key in a canvas doc's `acl` map or its
/// `pendingInvites` map. runs inside `spawn_blocking` because doc access
/// holds a lock. see [`HubPeerService::is_vouched_by_any_canvas`] for why
/// this check exists.
fn canvas_acl_or_invite_contains(handle: &crate::hub_repo::DocHandle, node_id: &str) -> bool {
    use automerge::ReadDoc;

    handle.with_document(|doc| {
        if let Ok(Some((_, acl_obj))) = doc.get(automerge::ROOT, "acl") {
            if doc.get(&acl_obj, node_id).ok().flatten().is_some() {
                return true;
            }
        }
        if let Ok(Some((_, pending_obj))) = doc.get(automerge::ROOT, "pendingInvites") {
            if doc.get(&pending_obj, node_id).ok().flatten().is_some() {
                return true;
            }
        }
        false
    })
}

/// read a canvas document's automerge state to extract gossip-relevant data
/// for a specific peer.
///
/// returns (optional canvas update, optional pending invite, pending knocks,
/// peer_is_participant, is_deleted) for gossip digest. runs inside
/// spawn_blocking because doc access holds a lock.
fn read_canvas_for_gossip(
    handle: &crate::hub_repo::DocHandle,
    peer_node_id: &str,
) -> (
    Option<wire::GossipDigestCanvasUpdate>,
    Option<wire::GossipDigestPendingInvite>,
    Vec<GossipDigestPendingKnock>,
    bool, // peer_is_participant: true if peer is in peers or pendingInvites
    bool, // is_deleted: true if canvas has been tombstoned
) {
    use automerge::ReadDoc;

    let canvas_doc_id = handle.document_id().to_string();

    // helper: read a string field from an automerge object
    fn read_str(doc: &automerge::Automerge, obj: &automerge::ObjId, key: &str) -> String {
        use automerge::ReadDoc;
        match doc.get(obj, key) {
            Ok(Some((automerge::Value::Object(automerge::ObjType::Text), text_id))) => {
                doc.text(&text_id).unwrap_or_default()
            }
            Ok(Some((v, _))) => v.to_str().map(|s| s.to_string()).unwrap_or_default(),
            _ => String::new(),
        }
    }

    handle.with_document(|doc| {
        let mut update: Option<wire::GossipDigestCanvasUpdate> = None;
        let mut invite: Option<wire::GossipDigestPendingInvite> = None;
        let mut peer_is_participant = false;

        // check for tombstone
        let is_deleted = match doc.get(automerge::ROOT, "deleted") {
            Ok(Some((automerge::Value::Scalar(s), _))) => {
                s.as_ref() == &automerge::ScalarValue::Boolean(true)
            }
            _ => false,
        };

        if is_deleted {
            let delete_mode = read_str(doc, &automerge::ROOT, "deleteMode");
            tracing::info!(
                canvas_doc_id = %canvas_doc_id,
                delete_mode = %delete_mode,
                "detected tombstone on canvas doc"
            );

            // check if the peer is a participant so we can include
            // a deletion entry in the gossip digest for them
            let mut peer_was_participant = false;
            if let Ok(Some((_, peers_obj))) = doc.get(automerge::ROOT, "peers") {
                if doc.get(&peers_obj, peer_node_id).ok().flatten().is_some() {
                    peer_was_participant = true;
                }
            }
            if !peer_was_participant {
                if let Ok(Some((_, pending_obj))) = doc.get(automerge::ROOT, "pendingInvites") {
                    if doc.get(&pending_obj, peer_node_id).ok().flatten().is_some() {
                        peer_was_participant = true;
                    }
                }
            }

            if peer_was_participant {
                let last_modified = read_str(doc, &automerge::ROOT, "lastModified");
                let last_modified_by = read_str(doc, &automerge::ROOT, "lastModifiedBy");
                return (
                    Some(wire::GossipDigestCanvasUpdate {
                        canvas_doc_id: canvas_doc_id.clone(),
                        last_modified_at: last_modified,
                        last_modified_by,
                        deleted: Some(true),
                    }),
                    None,
                    Vec::new(),
                    true,
                    true,
                );
            }

            return (None, None, Vec::new(), false, true);
        }

        // read lastModified
        let last_modified: String = read_str(doc, &automerge::ROOT, "lastModified");

        // read lastModifiedBy
        let last_modified_by: String = read_str(doc, &automerge::ROOT, "lastModifiedBy");

        // check if peer is on this canvas and has stale state
        let mut peer_is_full_member = false;
        if let Ok(Some((_, peers_obj))) = doc.get(automerge::ROOT, "peers") {
            if let Ok(Some((_, peer_entry_obj))) = doc.get(peers_obj, peer_node_id) {
                peer_is_participant = true;
                peer_is_full_member = true;
                // peer is on this canvas — check if they have stale data
                let peer_last_seen = read_str(doc, &peer_entry_obj, "lastSeenAt");

                if !last_modified.is_empty() && last_modified > peer_last_seen {
                    update = Some(wire::GossipDigestCanvasUpdate {
                        canvas_doc_id: canvas_doc_id.clone(),
                        last_modified_at: last_modified.clone(),
                        last_modified_by: last_modified_by.clone(),
                        deleted: None,
                    });
                }
            }
        }

        // check for pending knocks this peer can see and potentially relay
        // onward — mirrors the JS `computeAndSendGossipDigest()` exactly:
        // unlike pendingInvites (keyed by the invite's target), pendingKnocks
        // is keyed by the *requester*'s node id, so "is this entry for
        // peerNodeId" doesn't apply here. instead, gossip every open knock
        // on canvases the peer already fully participates in (only full
        // members/admins are in a position to act on or relay a knock
        // further) — hence gating on `peer_is_full_member`, not the more
        // permissive `peer_is_participant` (which also includes a peer who
        // merely has a pending invite here, not yet a real member).
        let mut pending_knocks: Vec<GossipDigestPendingKnock> = Vec::new();
        if peer_is_full_member {
            if let Ok(Some((_, pending_knocks_obj))) = doc.get(automerge::ROOT, "pendingKnocks") {
                let keys: Vec<String> = doc.keys(&pending_knocks_obj).collect();
                for requester_node_id in keys {
                    if requester_node_id == peer_node_id {
                        continue;
                    }
                    let knock_obj = match doc.get(&pending_knocks_obj, requester_node_id.as_str()) {
                        Ok(Some((_, obj_id))) => obj_id,
                        _ => continue,
                    };
                    let requester_username = read_str(doc, &knock_obj, "requesterUsername");
                    let message = read_str(doc, &knock_obj, "message");
                    let knocked_at = read_str(doc, &knock_obj, "knockedAt");
                    let knock_id = read_str(doc, &knock_obj, "knockId");
                    pending_knocks.push(GossipDigestPendingKnock {
                        knock_id,
                        node_id: requester_node_id,
                        username: if requester_username.is_empty() {
                            None
                        } else {
                            Some(requester_username)
                        },
                        message,
                        scope: WireKnockScope::Resource {
                            resource_id: canvas_doc_id.clone(),
                            requested_role: None,
                        },
                        knocked_at,
                    });
                }
            }
        }

        // check for pending invites targeting this peer
        if let Ok(Some((_, pending_obj))) = doc.get(automerge::ROOT, "pendingInvites") {
            if let Ok(Some((_, invite_obj))) = doc.get(pending_obj, peer_node_id) {
                peer_is_participant = true;
                // there's a pending invite for this peer — check they haven't already joined
                let peer_is_member = doc
                    .get(automerge::ROOT, "peers")
                    .ok()
                    .flatten()
                    .and_then(|(_, peers_obj)| doc.get(peers_obj, peer_node_id).ok().flatten())
                    .is_some();

                if !peer_is_member {
                    let invited_by = read_str(doc, &invite_obj, "invitedBy");
                    let invited_by_username = read_str(doc, &invite_obj, "invitedByUsername");

                    // "admin"/"member"/"viewer" straight from the doc, no
                    // enum conversion (skein's canvas roles are plain
                    // strings, unlike haruspex's typed `Role`).
                    let role = read_str(doc, &invite_obj, "role");

                    let invited_at = read_str(doc, &invite_obj, "invitedAt");

                    // read canvas metadata for the invite
                    let title = read_str(doc, &automerge::ROOT, "title");
                    let description = read_str(doc, &automerge::ROOT, "description");

                    let color: u32 = doc
                        .get(automerge::ROOT, "color")
                        .ok()
                        .flatten()
                        .and_then(|(v, _)| v.to_u64().map(|n| n as u32))
                        .unwrap_or(0);

                    let preview_url = read_str(doc, &automerge::ROOT, "previewUrl");

                    invite = Some(wire::GossipDigestPendingInvite {
                        canvas_doc_id: canvas_doc_id.clone(),
                        canvas_title: title,
                        canvas_description: description,
                        canvas_color: color,
                        canvas_preview_url: preview_url,
                        invited_by,
                        invited_by_username,
                        role,
                        invited_at,
                    });

                    tracing::info!(
                        canvas_doc_id = %canvas_doc_id,
                        canvas_title = ?invite.as_ref().map(|i| &i.canvas_title),
                        invited_by = ?invite.as_ref().map(|i| &i.invited_by),
                        invited_by_username = ?invite.as_ref().map(|i| &i.invited_by_username),
                        "gossip: constructed pending invite for digest"
                    );
                }
            }
        }

        (update, invite, pending_knocks, peer_is_participant, false)
    })
}

// ---------------------------------------------------------------------------
// app-extension dispatch (called from hub/messages.rs)
// ---------------------------------------------------------------------------

impl HubPeerService {
    /// route a `skein:`-namespaced app-extension message to the right
    /// handler. unrecognized extension types are logged and dropped.
    pub(crate) async fn handle_app_extension(
        &self,
        from_node_id: &str,
        message_type: &str,
        payload: &serde_json::Value,
    ) {
        match message_type {
            wire::EXT_CANVAS_INVITE => match wire::parse_extension(payload) {
                Some(ext) => self.handle_canvas_invite(from_node_id, ext).await,
                None => {
                    tracing::warn!(peer = %from_node_id, "malformed skein:canvas-invite payload")
                }
            },
            wire::EXT_CANVAS_INVITE_ACK => {
                if let Some(ext) = wire::parse_extension::<wire::CanvasInviteAckExt>(payload) {
                    tracing::info!(
                        peer = %from_node_id,
                        invite_id = %ext.invite_id,
                        canvas_doc_id = %ext.canvas_doc_id,
                        acker = %ext.acker_node_id,
                        "received canvas invite ack"
                    );
                }
            }
            wire::EXT_CANVAS_INVITE_ACCEPT => {
                if let Some(ext) = wire::parse_extension::<wire::CanvasInviteAcceptExt>(payload) {
                    tracing::info!(
                        peer = %from_node_id,
                        invite_id = %ext.invite_id,
                        canvas_doc_id = %ext.canvas_doc_id,
                        accepter = %ext.accepter_node_id,
                        "received canvas invite accept"
                    );
                }
            }
            wire::EXT_CANVAS_INVITE_DECLINE => {
                if let Some(ext) = wire::parse_extension::<wire::CanvasInviteDeclineExt>(payload) {
                    tracing::info!(
                        peer = %from_node_id,
                        invite_id = %ext.invite_id,
                        canvas_doc_id = %ext.canvas_doc_id,
                        decliner = %ext.decliner_node_id,
                        "received canvas invite decline"
                    );
                }
            }
            wire::EXT_CANVAS_UPDATE => match wire::parse_extension(payload) {
                Some(ext) => self.handle_canvas_update(from_node_id, ext).await,
                None => {
                    tracing::warn!(peer = %from_node_id, "malformed skein:canvas-update payload")
                }
            },
            wire::EXT_CANVAS_DELETED => match wire::parse_extension(payload) {
                Some(ext) => self.handle_canvas_deleted(from_node_id, ext).await,
                None => {
                    tracing::warn!(peer = %from_node_id, "malformed skein:canvas-deleted payload")
                }
            },
            other => {
                tracing::debug!(peer = %from_node_id, message_type = %other, "ignoring unknown app extension");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_repo::HubRepo;

    /// seed a canvas doc with "synced" content (`version`/`widgets`/`title`
    /// present — the same fields `record_knock_in_canvas_doc`'s and
    /// `write_self_to_canvas_doc`'s "has this doc actually synced any
    /// content yet" gate checks for) via `HubDocStorage`, then construct a
    /// `HubRepo` against the same backing sqlite file so `find()` sees it.
    /// mirrors `blob_acl.rs`'s `seed_canvas_and_widget` seeding pattern —
    /// `HubRepo` has no public "insert this doc and make it immediately
    /// findable" method outside of applying a real automerge sync message.
    async fn seed_synced_canvas_doc(db_path: &std::path::Path, canvas_doc_id: &str) -> HubRepo {
        let storage = crate::hub_repo::HubDocStorage::new(db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");

        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            tx.put(automerge::ROOT, "version", 1_i64)?;
            tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;
            tx.put(automerge::ROOT, "title", "test canvas")?;
            Ok(())
        })
        .expect("canvas doc transact should succeed");
        storage.save_doc(canvas_doc_id, &doc.save()).await;

        HubRepo::new("hub-node".to_string(), db_path)
            .await
            .expect("HubRepo::new (reload) should succeed")
    }

    /// seed a canvas doc with an `acl` entry and/or a `pendingInvites` entry
    /// for `node_id` — for exercising `canvas_acl_or_invite_contains`.
    async fn seed_canvas_with_acl_or_invite(
        db_path: &std::path::Path,
        canvas_doc_id: &str,
        node_id: &str,
        in_acl: bool,
        in_pending_invites: bool,
    ) -> HubRepo {
        let storage = crate::hub_repo::HubDocStorage::new(db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");

        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            tx.put(automerge::ROOT, "version", 1_i64)?;
            tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;
            tx.put(automerge::ROOT, "title", "test canvas")?;

            if in_acl {
                let acl = tx.put_object(automerge::ROOT, "acl", automerge::ObjType::Map)?;
                let entry = tx.put_object(&acl, node_id, automerge::ObjType::Map)?;
                tx.put(&entry, "role", "member")?;
            }
            if in_pending_invites {
                let pending =
                    tx.put_object(automerge::ROOT, "pendingInvites", automerge::ObjType::Map)?;
                let entry = tx.put_object(&pending, node_id, automerge::ObjType::Map)?;
                tx.put(&entry, "invitedBy", "someone-else")?;
                tx.put(&entry, "role", "member")?;
            }
            Ok(())
        })
        .expect("canvas doc transact should succeed");
        storage.save_doc(canvas_doc_id, &doc.save()).await;

        HubRepo::new("hub-node".to_string(), db_path)
            .await
            .expect("HubRepo::new (reload) should succeed")
    }

    #[tokio::test]
    async fn canvas_acl_or_invite_contains_finds_an_acl_entry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo =
            seed_canvas_with_acl_or_invite(&db_path, "canvas-1", "peer-b", true, false).await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        let found =
            tokio::task::spawn_blocking(move || canvas_acl_or_invite_contains(&handle, "peer-b"))
                .await
                .expect("spawn_blocking should not panic");

        assert!(found, "a node id in the canvas's acl should be found");
    }

    #[tokio::test]
    async fn canvas_acl_or_invite_contains_finds_a_pending_invite_entry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo =
            seed_canvas_with_acl_or_invite(&db_path, "canvas-1", "peer-b", false, true).await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        let found =
            tokio::task::spawn_blocking(move || canvas_acl_or_invite_contains(&handle, "peer-b"))
                .await
                .expect("spawn_blocking should not panic");

        assert!(
            found,
            "a node id in the canvas's pendingInvites should be found"
        );
    }

    #[tokio::test]
    async fn canvas_acl_or_invite_contains_excludes_an_unrelated_stranger() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo =
            seed_canvas_with_acl_or_invite(&db_path, "canvas-1", "peer-b", true, false).await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        let found = tokio::task::spawn_blocking(move || {
            canvas_acl_or_invite_contains(&handle, "total-stranger")
        })
        .await
        .expect("spawn_blocking should not panic");

        assert!(
            !found,
            "a node id absent from both acl and pendingInvites must not be vouched for"
        );
    }

    /// optionally, a `pendingKnocks` entry for `requester_node_id` — for
    /// exercising `read_canvas_for_gossip`'s knock-scanning gate (only
    /// gossips knocks to peers who are full `peers` members).
    async fn seed_canvas_with_peer_and_knock(
        db_path: &std::path::Path,
        canvas_doc_id: &str,
        member_node_id: &str,
        knock: Option<(&str, &str, &str, &str)>, // (knock_id, requester_node_id, username, message)
    ) -> HubRepo {
        let storage = crate::hub_repo::HubDocStorage::new(db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");

        let mut doc = automerge::Automerge::new();
        doc.transact::<_, _, automerge::AutomergeError>(|tx| {
            use automerge::transaction::Transactable;
            tx.put(automerge::ROOT, "version", 1_i64)?;
            tx.put_object(automerge::ROOT, "widgets", automerge::ObjType::Map)?;
            tx.put(automerge::ROOT, "title", "test canvas")?;

            let peers = tx.put_object(automerge::ROOT, "peers", automerge::ObjType::Map)?;
            let peer_entry = tx.put_object(&peers, member_node_id, automerge::ObjType::Map)?;
            tx.put(&peer_entry, "lastSeenAt", "2025-01-01T00:00:00Z")?;

            if let Some((knock_id, requester_node_id, username, message)) = knock {
                let pending =
                    tx.put_object(automerge::ROOT, "pendingKnocks", automerge::ObjType::Map)?;
                let knock_obj =
                    tx.put_object(&pending, requester_node_id, automerge::ObjType::Map)?;
                tx.put(&knock_obj, "knockId", knock_id)?;
                tx.put(&knock_obj, "requesterNodeId", requester_node_id)?;
                tx.put(&knock_obj, "requesterUsername", username)?;
                tx.put(&knock_obj, "message", message)?;
                tx.put(&knock_obj, "knockedAt", "2025-06-01T00:00:00Z")?;
                tx.put_object(&knock_obj, "decisions", automerge::ObjType::List)?;
            }
            Ok(())
        })
        .expect("canvas doc transact should succeed");
        storage.save_doc(canvas_doc_id, &doc.save()).await;

        HubRepo::new("hub-node".to_string(), db_path)
            .await
            .expect("HubRepo::new (reload) should succeed")
    }

    #[tokio::test]
    async fn read_canvas_for_gossip_includes_pending_knocks_for_a_full_member() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_with_peer_and_knock(
            &db_path,
            "canvas-1",
            "member-node",
            Some(("knock-1", "requester-1", "alice", "let me in")),
        )
        .await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        let (_, _, knocks, peer_is_participant, is_deleted) =
            tokio::task::spawn_blocking(move || read_canvas_for_gossip(&handle, "member-node"))
                .await
                .expect("spawn_blocking should not panic");

        assert!(peer_is_participant);
        assert!(!is_deleted);
        assert_eq!(knocks.len(), 1);
        assert_eq!(knocks[0].knock_id, "knock-1");
        assert_eq!(knocks[0].node_id, "requester-1");
        assert_eq!(knocks[0].username.as_deref(), Some("alice"));
        assert_eq!(knocks[0].message, "let me in");
        match &knocks[0].scope {
            WireKnockScope::Resource { resource_id, .. } => assert_eq!(resource_id, "canvas-1"),
            other => panic!("expected a resource scope, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_canvas_for_gossip_excludes_the_requesters_own_knock() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        // the requester is ALSO a full member here (an edge case, but the
        // gate should still exclude gossiping a peer their own knock back
        // to them) — mirrors the JS `computeAndSendGossipDigest()`'s
        // `if (knock.requesterNodeId === peerNodeId) continue;`.
        let hub_repo = seed_canvas_with_peer_and_knock(
            &db_path,
            "canvas-1",
            "requester-1",
            Some(("knock-1", "requester-1", "alice", "let me in")),
        )
        .await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        let (_, _, knocks, _, _) =
            tokio::task::spawn_blocking(move || read_canvas_for_gossip(&handle, "requester-1"))
                .await
                .expect("spawn_blocking should not panic");

        assert!(knocks.is_empty());
    }

    #[tokio::test]
    async fn read_canvas_for_gossip_excludes_knocks_for_a_non_member_peer() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo = seed_canvas_with_peer_and_knock(
            &db_path,
            "canvas-1",
            "member-node",
            Some(("knock-1", "requester-1", "alice", "let me in")),
        )
        .await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        // "stranger-node" isn't in the `peers` map at all — only full
        // members should ever be gossiped a canvas's pending knocks.
        let (_, _, knocks, peer_is_participant, _) =
            tokio::task::spawn_blocking(move || read_canvas_for_gossip(&handle, "stranger-node"))
                .await
                .expect("spawn_blocking should not panic");

        assert!(!peer_is_participant);
        assert!(knocks.is_empty());
    }

    #[tokio::test]
    async fn read_canvas_for_gossip_returns_empty_knocks_when_none_pending() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo =
            seed_canvas_with_peer_and_knock(&db_path, "canvas-1", "member-node", None).await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        let (_, _, knocks, peer_is_participant, _) =
            tokio::task::spawn_blocking(move || read_canvas_for_gossip(&handle, "member-node"))
                .await
                .expect("spawn_blocking should not panic");

        assert!(peer_is_participant);
        assert!(
            knocks.is_empty(),
            "a canvas with no pendingKnocks map at all must produce an empty vec, not panic"
        );
    }

    #[tokio::test]
    async fn record_knock_creates_a_pending_knocks_entry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo = seed_synced_canvas_doc(&db_path, "canvas-1").await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        // `DocHandle::with_document`/`record_knock_in_canvas_doc` use
        // blocking RwLock calls — always run inside `spawn_blocking`, same
        // as every production call site.
        tokio::task::spawn_blocking(move || {
            let recorded = record_knock_in_canvas_doc(
                &handle,
                "knock-1",
                "requester-1",
                "alice",
                "hello, let me in",
            );
            assert!(recorded, "a knock into a synced doc should be recorded");

            use automerge::ReadDoc;
            handle.with_document(|doc| {
                let (_, pending_obj) = doc
                    .get(automerge::ROOT, "pendingKnocks")
                    .unwrap()
                    .expect("pendingKnocks map should exist");
                let (_, knock_obj) = doc
                    .get(&pending_obj, "requester-1")
                    .unwrap()
                    .expect("knock entry should exist");

                let (knock_id_val, _) = doc.get(&knock_obj, "knockId").unwrap().unwrap();
                assert_eq!(knock_id_val.to_str(), Some("knock-1"));
                let (username_val, _) = doc.get(&knock_obj, "requesterUsername").unwrap().unwrap();
                assert_eq!(username_val.to_str(), Some("alice"));
                let (message_val, _) = doc.get(&knock_obj, "message").unwrap().unwrap();
                assert_eq!(message_val.to_str(), Some("hello, let me in"));
                let (node_id_val, _) = doc.get(&knock_obj, "requesterNodeId").unwrap().unwrap();
                assert_eq!(node_id_val.to_str(), Some("requester-1"));

                let (_, decisions_obj) = doc
                    .get(&knock_obj, "decisions")
                    .unwrap()
                    .expect("decisions list should exist");
                assert_eq!(
                    doc.length(&decisions_obj),
                    0,
                    "a fresh knock has no decisions yet"
                );
            });
        })
        .await
        .expect("spawn_blocking should not panic");
    }

    #[tokio::test]
    async fn record_knock_retry_is_idempotent_and_does_not_overwrite() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo = seed_synced_canvas_doc(&db_path, "canvas-1").await;
        let handle = hub_repo
            .find("canvas-1")
            .await
            .expect("doc should be found");

        tokio::task::spawn_blocking(move || {
            assert!(record_knock_in_canvas_doc(
                &handle,
                "knock-1",
                "requester-1",
                "alice",
                "first message"
            ));
            // retry with a different username/message — a legitimate retry
            // (e.g. the requester never got an ack) must NOT overwrite the
            // original entry, mirroring `CanvasStore.recordKnock()`'s
            // "already pending, no decisions yet -> return unchanged" rule.
            assert!(record_knock_in_canvas_doc(
                &handle,
                "knock-1",
                "requester-1",
                "mallory",
                "second message"
            ));

            use automerge::ReadDoc;
            handle.with_document(|doc| {
                let (_, pending_obj) = doc.get(automerge::ROOT, "pendingKnocks").unwrap().unwrap();
                let keys: Vec<String> = doc.keys(&pending_obj).collect();
                assert_eq!(keys.len(), 1, "retry must not create a duplicate entry");

                let (_, knock_obj) = doc.get(&pending_obj, "requester-1").unwrap().unwrap();
                let (username_val, _) = doc.get(&knock_obj, "requesterUsername").unwrap().unwrap();
                assert_eq!(
                    username_val.to_str(),
                    Some("alice"),
                    "retry must not overwrite the original requesterUsername"
                );
                let (message_val, _) = doc.get(&knock_obj, "message").unwrap().unwrap();
                assert_eq!(
                    message_val.to_str(),
                    Some("first message"),
                    "retry must not overwrite the original message"
                );
            });
        })
        .await
        .expect("spawn_blocking should not panic");
    }

    #[tokio::test]
    async fn record_knock_returns_false_when_doc_has_no_content_yet() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");

        // an empty doc (no version/widgets/title) — mirrors the "not synced
        // yet" state a canvas doc can be in right after the hub starts
        // tracking it, before any content has arrived.
        let storage = crate::hub_repo::HubDocStorage::new(&db_path)
            .await
            .expect("HubDocStorage::new for seeding should succeed");
        let empty_doc = automerge::Automerge::new();
        storage.save_doc("canvas-empty", &empty_doc.save()).await;

        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");
        let handle = hub_repo
            .find("canvas-empty")
            .await
            .expect("doc should be found");

        let recorded = tokio::task::spawn_blocking(move || {
            record_knock_in_canvas_doc(&handle, "knock-1", "requester-1", "alice", "hi")
        })
        .await
        .expect("spawn_blocking should not panic");
        assert!(!recorded, "an unsynced doc must not be written to");
    }
}
