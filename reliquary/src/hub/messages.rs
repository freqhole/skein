//! friendz message dispatch for the hub peer service.
//!
//! handles incoming friendz events (peer online/offline, messages) and
//! dispatches to the appropriate handler. friend request/accept logic,
//! profile exchange, and routing to canvas/gossip handlers all live here.

use std::collections::HashSet;

use crate::protocol::handler::FriendzEvent;
use crate::protocol::messages::{AclRole, FriendzMessage};

use super::friendz_msg_type_name;
use super::HubPeerService;

impl HubPeerService {
    /// handle a single friendz event.
    ///
    /// this is where hub-specific behavior goes: auto-accepting canvas invites,
    /// participating in gossip, etc.
    pub(crate) async fn handle_friendz_event(&self, event: FriendzEvent) {
        match event {
            FriendzEvent::PeerOnline { node_id, username } => {
                tracing::info!(
                    peer = %node_id,
                    username = %username,
                    "peer came online"
                );
                // bump last_seen_at in userz (also inserts a stub row if new)
                if let Err(e) = self.userz.touch(&node_id).await {
                    tracing::debug!(peer = %node_id, error = %e, "userz.touch failed");
                }

                // send gossip digest to this peer if they're a friend
                if self.is_friend(&node_id).await {
                    // NOTE: the hub does NOT dial peers for automerge sync.
                    // the JS side dials the hub, and the hub's acceptor
                    // handles inbound connections correctly.

                    // delay gossip slightly to allow the peer to establish
                    // automerge sync via the acceptor path
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

                    self.compute_and_send_gossip_digest(&node_id).await;
                }
            }
            FriendzEvent::PeerOffline { node_id } => {
                tracing::info!(peer = %node_id, "peer went offline");

                // clear peer blob inventory when peer goes offline
                let mut inventory = self.peer_blob_inventory.lock().await;
                if inventory.remove(&node_id).is_some() {
                    tracing::debug!(peer = %node_id, "cleared peer blob inventory");
                }
            }
            FriendzEvent::MessageReceived {
                from_node_id,
                message,
            } => {
                tracing::info!(
                    from = %from_node_id,
                    msg_type = %friendz_msg_type_name(&message),
                    "received friendz message"
                );
                self.handle_message(&from_node_id, message).await;
            }
        }
    }

    /// handle a specific friendz message from a peer.
    ///
    /// the hub peer shares its profile with everyone (no visibility gate) and
    /// auto-accepts friend requests only from peers that are already pre-approved
    /// in `friendz` with status `Allowed` (operator must run e.g.
    /// `reliquary friend allow <node-id>` first).
    pub(crate) async fn handle_message(&self, from_node_id: &str, message: FriendzMessage) {
        match message {
            FriendzMessage::ProfileRequest => {
                // hub peer shares its profile with anyone — no visibility check
                tracing::info!(
                    peer = %from_node_id,
                    username = %self.profile_username,
                    bio_len = self.profile_bio.len(),
                    avatar_len = self.profile_avatar_data_url.len(),
                    "responding to profile request"
                );
                let response = FriendzMessage::ProfileResponse {
                    username: self.profile_username.clone(),
                    bio: self.profile_bio.clone(),
                    avatar_data_url: self.profile_avatar_data_url.clone(),
                };
                if let Err(e) = self.friendz.send_message(from_node_id, &response).await {
                    tracing::warn!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to send profile response"
                    );
                }
            }
            FriendzMessage::ProfileResponse {
                username,
                bio,
                avatar_data_url,
            } => {
                // update the remote peer's profile in userz.
                //
                // avatar handling: decode the data URL, re-encode to a
                // canonical 128px webp, persist into blobz (deduped by
                // blake3), and store only the blake3 reference in
                // userz.avatar_blake3. mirrors how `process_hub_avatar`
                // handles the hub's own avatar in hub/mod.rs.
                tracing::debug!(
                    peer = %from_node_id,
                    username = %username,
                    "received profile response"
                );

                let avatar_blake3 = self
                    .persist_peer_avatar(from_node_id, &avatar_data_url)
                    .await;

                if let Err(e) = self
                    .userz
                    .upsert_profile(
                        from_node_id,
                        Some(&username),
                        Some(&bio),
                        avatar_blake3.as_deref(),
                    )
                    .await
                {
                    tracing::debug!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to update remote peer profile in userz"
                    );
                }
            }
            FriendzMessage::FriendRequest {
                from_node_id: _req_node_id,
                from_username,
            } => {
                // policy: auto-accept only if the peer was pre-approved by the
                // operator (status = Allowed) or already accepted. unknown peers
                // are recorded as Pending so the operator can promote them later
                // (e.g. via `reliquary friend allow <node-id>`).
                tracing::info!(
                    peer = %from_node_id,
                    username = %from_username,
                    "received friend request"
                );

                use crate::friendz::FriendStatus;
                let existing = self.friendz_store.get(from_node_id).await.ok().flatten();
                let auto_accept = matches!(
                    existing.as_ref().map(|f| f.status),
                    Some(FriendStatus::Allowed) | Some(FriendStatus::Accepted)
                );

                if !auto_accept {
                    // record as pending and stop here — operator must promote
                    if let Err(e) = self
                        .friendz_store
                        .upsert(from_node_id, FriendStatus::Pending, None)
                        .await
                    {
                        tracing::warn!(
                            peer = %from_node_id,
                            error = %e,
                            "failed to record pending friend request"
                        );
                    } else {
                        tracing::info!(
                            peer = %from_node_id,
                            "friend request recorded as pending (use `reliquary friend allow` to accept)"
                        );
                    }
                    return;
                }

                // promote to accepted
                if let Err(e) = self
                    .friendz_store
                    .upsert(from_node_id, FriendStatus::Accepted, None)
                    .await
                {
                    tracing::warn!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to promote friend to accepted"
                    );
                    return;
                }
                tracing::info!(
                    peer = %from_node_id,
                    "promoted to accepted friend"
                );

                // send friend-accept back with the hub's username from config
                tracing::info!(
                    peer = %from_node_id,
                    hub_username = %self.profile_username,
                    hub_node_id = %self.node_id_str,
                    "sending friend-accept"
                );
                let accept = FriendzMessage::FriendAccept {
                    from_node_id: self.node_id_str.clone(),
                    from_username: self.profile_username.clone(),
                };
                match self.friendz.send_message(from_node_id, &accept).await {
                    Ok(()) => {
                        tracing::info!(peer = %from_node_id, "friend-accept sent successfully");
                    }
                    Err(e) => {
                        tracing::warn!(
                            peer = %from_node_id,
                            error = %e,
                            "failed to send friend-accept"
                        );
                    }
                }

                // proactively send our profile so the peer has our display name,
                // bio, and avatar immediately (without waiting for a profile-request)
                let profile_resp = FriendzMessage::ProfileResponse {
                    username: self.profile_username.clone(),
                    bio: self.profile_bio.clone(),
                    avatar_data_url: self.profile_avatar_data_url.clone(),
                };
                match self.friendz.send_message(from_node_id, &profile_resp).await {
                    Ok(()) => {
                        tracing::info!(peer = %from_node_id, "profile-response sent after friend-accept");
                    }
                    Err(e) => {
                        tracing::warn!(
                            peer = %from_node_id,
                            error = %e,
                            "failed to send profile after friend-accept"
                        );
                    }
                }

                // request their profile so we have their display name, bio, avatar
                let profile_req = FriendzMessage::ProfileRequest;
                match self.friendz.send_message(from_node_id, &profile_req).await {
                    Ok(()) => {
                        tracing::info!(peer = %from_node_id, "profile-request sent after friend-accept");
                    }
                    Err(e) => {
                        tracing::warn!(
                            peer = %from_node_id,
                            error = %e,
                            "failed to request profile after friend-accept"
                        );
                    }
                }

                // NOTE: no outbound sync dial — see PeerOnline handler comment.
                // the JS side will establish sync when it needs to.
            }
            FriendzMessage::FriendAccept {
                from_node_id: _accept_node_id,
                from_username,
            } => {
                // a peer accepted our friend request (or is confirming mutual friendship).
                // honor only if we already have a row for them — either Allowed
                // (operator pre-approved), Pending (we initiated the request),
                // or Accepted (idempotent re-confirmation). silently drop
                // unsolicited accepts to avoid letting a peer force itself into
                // our friend list.
                tracing::info!(
                    peer = %from_node_id,
                    username = %from_username,
                    "received friend-accept"
                );

                use crate::friendz::FriendStatus;
                let existing = self.friendz_store.get(from_node_id).await.ok().flatten();
                let honor = matches!(
                    existing.as_ref().map(|f| f.status),
                    Some(FriendStatus::Allowed)
                        | Some(FriendStatus::Pending)
                        | Some(FriendStatus::Accepted)
                );
                if !honor {
                    tracing::info!(
                        peer = %from_node_id,
                        "ignoring unsolicited friend-accept (no prior friendz row)"
                    );
                    return;
                }
                if let Err(e) = self
                    .friendz_store
                    .upsert(from_node_id, FriendStatus::Accepted, None)
                    .await
                {
                    tracing::debug!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to upsert friend on accept"
                    );
                }

                // send ack to complete the two-phase handshake
                let ack = FriendzMessage::FriendAcceptAck {
                    from_node_id: self.node_id_str.clone(),
                };
                if let Err(e) = self.friendz.send_message(from_node_id, &ack).await {
                    tracing::debug!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to send friend-accept-ack"
                    );
                }

                // request their profile
                let profile_req = FriendzMessage::ProfileRequest;
                if let Err(e) = self.friendz.send_message(from_node_id, &profile_req).await {
                    tracing::debug!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to request profile after friend-accept"
                    );
                }

                // NOTE: no outbound sync dial — see PeerOnline handler comment.
                // the JS side will establish sync when it needs to.
            }
            FriendzMessage::FriendAcceptAck {
                from_node_id: _ack_node_id,
            } => {
                tracing::debug!(
                    peer = %from_node_id,
                    "received friend-accept-ack, handshake complete"
                );
            }
            FriendzMessage::Heartbeat { .. } => {
                // heartbeats are handled by the handler layer (presence tracking).
                // nothing extra to do here.
            }
            FriendzMessage::CanvasInvite {
                invite_id,
                canvas_doc_id,
                canvas_title,
                origin_node_id,
                origin_username,
                role,
                ..
            } => {
                self.handle_canvas_invite(
                    from_node_id,
                    &invite_id,
                    &canvas_doc_id,
                    &canvas_title,
                    &origin_node_id,
                    &origin_username,
                    &role,
                )
                .await;
            }
            FriendzMessage::CanvasInviteAck {
                invite_id,
                canvas_doc_id,
                acker_node_id,
            } => {
                tracing::info!(
                    peer = %from_node_id,
                    invite_id = %invite_id,
                    canvas_doc_id = %canvas_doc_id,
                    acker = %acker_node_id,
                    "received canvas invite ack"
                );
            }
            FriendzMessage::CanvasInviteAccept {
                invite_id,
                canvas_doc_id,
                accepter_node_id,
            } => {
                tracing::info!(
                    peer = %from_node_id,
                    invite_id = %invite_id,
                    canvas_doc_id = %canvas_doc_id,
                    accepter = %accepter_node_id,
                    "received canvas invite accept"
                );
            }
            FriendzMessage::CanvasInviteDecline {
                invite_id,
                canvas_doc_id,
                decliner_node_id,
            } => {
                tracing::info!(
                    peer = %from_node_id,
                    invite_id = %invite_id,
                    canvas_doc_id = %canvas_doc_id,
                    decliner = %decliner_node_id,
                    "received canvas invite decline"
                );
            }
            FriendzMessage::CanvasUpdate {
                canvas_doc_id,
                last_modified_at,
                widget_count,
                modified_by_node_id,
                modified_by_username,
            } => {
                self.handle_canvas_update(
                    from_node_id,
                    &canvas_doc_id,
                    &last_modified_at,
                    widget_count,
                    &modified_by_node_id,
                    &modified_by_username,
                )
                .await;
            }
            FriendzMessage::CanvasDeleted {
                canvas_doc_id,
                canvas_title,
                deleted_by,
                deleted_by_username,
                delete_mode,
                deleted_at,
            } => {
                self.handle_canvas_deleted(
                    from_node_id,
                    &canvas_doc_id,
                    &canvas_title,
                    &deleted_by,
                    &deleted_by_username,
                    &delete_mode,
                    &deleted_at,
                )
                .await;
            }
            FriendzMessage::GossipDigest {
                canvas_updates,
                pending_invites,
                shared_canvas_ids,
            } => {
                self.handle_gossip_digest(
                    from_node_id,
                    canvas_updates,
                    pending_invites,
                    shared_canvas_ids,
                )
                .await;
            }
            FriendzMessage::AclChange {
                canvas_doc_id,
                canvas_title,
                target_node_id,
                new_role,
                changed_by,
                changed_by_username,
            } => {
                tracing::info!(
                    peer = %from_node_id,
                    canvas_doc_id = %canvas_doc_id,
                    canvas_title = %canvas_title,
                    target = %target_node_id,
                    new_role = ?new_role,
                    changed_by = %changed_by,
                    changed_by_username = %changed_by_username,
                    "received ACL change notification"
                );

                // if the hub was removed from this canvas, stop tracking it
                if target_node_id == self.node_id_str && new_role == AclRole::Removed {
                    tracing::info!(
                        canvas_doc_id = %canvas_doc_id,
                        canvas_title = %canvas_title,
                        changed_by = %changed_by,
                        "hub removed from canvas — untracking"
                    );

                    {
                        let mut ids = self.canvas_doc_ids.lock().await;
                        ids.remove(&canvas_doc_id);
                    }
                    self.hub_repo.remove_canvas_id(&canvas_doc_id).await;
                }
            }
            FriendzMessage::FriendReject {
                from_node_id: reject_node_id,
            } => {
                tracing::info!(
                    peer = %from_node_id,
                    reject_from = %reject_node_id,
                    "received friend rejection"
                );
            }
            FriendzMessage::OfflineAnnouncement { node_id } => {
                tracing::info!(
                    peer = %from_node_id,
                    announced_node = %node_id,
                    "received offline announcement"
                );
            }
            FriendzMessage::BlobSeek { needed } => {
                tracing::info!(
                    peer = %from_node_id,
                    count = needed.len(),
                    "received blob seek, checking local availability"
                );

                // check blobz for each requested blake3 hash
                let mut available = Vec::new();
                for hash in &needed {
                    if matches!(self.blobz.get(hash).await, Ok(Some(_))) {
                        available.push(hash.clone());
                    }
                }

                tracing::info!(
                    peer = %from_node_id,
                    requested = needed.len(),
                    available = available.len(),
                    "responding to blob seek with blob offer"
                );

                if !available.is_empty() {
                    let offer = FriendzMessage::BlobOffer { available };
                    if let Err(e) = self.friendz.send_message(from_node_id, &offer).await {
                        tracing::warn!(
                            peer = %from_node_id,
                            error = %e,
                            "failed to send blob offer"
                        );
                    }
                }
            }
            FriendzMessage::BlobOffer { available } => {
                tracing::info!(
                    peer = %from_node_id,
                    count = available.len(),
                    "received blob offer, updating peer inventory"
                );

                // store in peer blob inventory
                let mut inventory = self.peer_blob_inventory.lock().await;
                let entry = inventory
                    .entry(from_node_id.to_string())
                    .or_insert_with(HashSet::new);
                for hash in available {
                    entry.insert(hash);
                }

                // trigger a snatch scan since we now have new information about
                // where blobs might be available
                self.snatch_trigger.notify_one();
            }
        }
    }

    /// re-encode an inbound peer avatar data URL to a canonical 128px webp
    /// blob, persist it into `blobz`, and return the blake3 ref.
    ///
    /// returns `None` for empty/malformed data URLs or when image processing
    /// fails — callers should fall through to clearing the avatar reference.
    pub(crate) async fn persist_peer_avatar(
        &self,
        peer_node_id: &str,
        data_url: &str,
    ) -> Option<String> {
        use crate::hub::avatar;

        let (_mime, raw_bytes) = avatar::decode_data_url(data_url)?;
        if raw_bytes.is_empty() {
            return None;
        }

        let webp = match avatar::resize_to_square_webp(&raw_bytes, 128) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!(
                    peer = %peer_node_id,
                    error = %e,
                    "failed to re-encode peer avatar; skipping"
                );
                return None;
            }
        };

        let blake3_hash = blake3::hash(&webp).to_hex().to_string();

        // dedupe: skip insert if already present.
        match self.blobz.get(&blake3_hash).await {
            Ok(Some(_)) => Some(blake3_hash),
            Ok(None) => match self
                .blobz
                .insert(
                    blake3_hash.clone(),
                    Some("peer-avatar.webp".to_string()),
                    Some("image/webp".to_string()),
                    &webp,
                )
                .await
            {
                Ok(blob_ref) => Some(blob_ref.blake3),
                Err(e) => {
                    tracing::warn!(
                        peer = %peer_node_id,
                        error = %e,
                        "failed to persist peer avatar to blobz"
                    );
                    None
                }
            },
            Err(e) => {
                tracing::warn!(
                    peer = %peer_node_id,
                    error = %e,
                    "blobz lookup for peer avatar failed"
                );
                None
            }
        }
    }
}
