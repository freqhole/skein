//! friendz message dispatch for the hub peer service.
//!
//! handles incoming friendz events (peer online/offline, messages) and
//! dispatches to the appropriate handler. friend request/accept logic,
//! profile exchange, and routing to canvas/gossip handlers all live here.
//!
//! `profile-request`, `hello`, and `heartbeat` are auto-answered by
//! `haruspex::protocol::FriendzService::dispatch` itself (directly on the
//! inbound stream, before this hub ever sees them) - this module only
//! reacts to messages the service surfaces via `FriendzEvent::MessageReceived`
//! for real business logic: friend requests, acl changes, gossip, canvas
//! knocks, and blob inventory.

use haruspex::protocol::{CoreMessage, FriendzEvent, FriendzMessage};
use haruspex::stores::Role;

use super::wire;
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
                // drop the peer's fallback blob-availability entries so the
                // snatch engine doesn't keep trying candidates that can no
                // longer answer.
                self.engine.clear_peer(&node_id);
            }
            FriendzEvent::MessageReceived {
                from_node_id,
                message,
            } => {
                tracing::info!(
                    from = %from_node_id,
                    msg_type = %message.message_type(),
                    "received friendz message"
                );
                self.handle_message(&from_node_id, *message).await;
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
            FriendzMessage::Core(core) => self.handle_core_message(from_node_id, core).await,
            FriendzMessage::AppExtension {
                message_type,
                payload,
            } => {
                self.handle_app_extension(from_node_id, &message_type, &payload)
                    .await;
            }
        }
    }

    async fn handle_core_message(&self, from_node_id: &str, message: CoreMessage) {
        match message {
            CoreMessage::ProfileRequest { .. } => {
                // auto-answered by FriendzService::dispatch from the local
                // profile configured in hub/mod.rs - nothing to do here.
            }
            CoreMessage::ProfileResponse {
                username,
                bio,
                avatar_data_url,
                ..
            } => {
                // update the remote peer's profile in userz.
                //
                // avatar handling: decode the data URL, re-encode to a
                // canonical 128px webp, persist into blobz (deduped by
                // blake3), and store only the blake3 reference in
                // userz.avatar_blake3. mirrors how `process_hub_avatar`
                // handles the hub's own avatar in hub/mod.rs.
                //
                // `profile_doc_id`/`profile_updated_at` are ignored - the
                // hub doesn't track profile docs at all (see
                // `GossipDigestProfileEntry`'s doc comment in haruspex's
                // `protocol::messages`).
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
            CoreMessage::FriendRequest { from_username, .. } => {
                // policy: auto-accept only if the peer was pre-approved by the
                // operator (status = Allowed) or already accepted. unknown peers
                // are recorded as Pending so the operator can promote them later
                // (e.g. via `reliquary friend allow <node-id>`).
                tracing::info!(
                    peer = %from_node_id,
                    username = %from_username,
                    "received friend request"
                );

                // record a peer row before writing to friendz — this keeps a
                // profile entry available for the peer even if the
                // `FriendRequest` message races ahead of `PeerOnline`.
                if let Err(e) = self
                    .userz
                    .upsert_profile(from_node_id, Some(&from_username), None, None)
                    .await
                {
                    tracing::warn!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to touch userz row for incoming friend request"
                    );
                }

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
                let (hub_username, hub_bio, hub_avatar_data_url, hub_accent_color) = {
                    let p = self.hub_profile.read().await;
                    (
                        p.username.clone(),
                        p.bio.clone(),
                        p.avatar_data_url.clone(),
                        p.accent_color,
                    )
                };
                tracing::info!(
                    peer = %from_node_id,
                    hub_username = %hub_username,
                    hub_node_id = %self.node_id_str,
                    "sending friend-accept"
                );
                let accept = FriendzMessage::Core(CoreMessage::FriendAccept {
                    v: 1,
                    from_node_id: self.node_id_str.clone(),
                    from_username: hub_username.clone(),
                    // this router is a hub's friendz handler — always flag
                    // ourselves as a hub node (see docs/hub-and-profile-plan.md
                    // section 3.2; the tauri-desktop-peer router in service.rs
                    // is NOT a hub and must never set this).
                    is_hub: Some(true),
                });
                match self.send_friendz_message(from_node_id, &accept).await {
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
                let profile_resp = FriendzMessage::Core(CoreMessage::ProfileResponse {
                    v: 1,
                    username: hub_username,
                    bio: hub_bio,
                    avatar_data_url: hub_avatar_data_url,
                    accent_color: Some(hub_accent_color),
                    profile_doc_id: None,
                    profile_updated_at: None,
                });
                match self.send_friendz_message(from_node_id, &profile_resp).await {
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
                let profile_req = FriendzMessage::Core(CoreMessage::ProfileRequest { v: 1 });
                match self.send_friendz_message(from_node_id, &profile_req).await {
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
            CoreMessage::FriendAccept { from_username, .. } => {
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
                let ack = FriendzMessage::Core(CoreMessage::FriendAcceptAck {
                    v: 1,
                    from_node_id: self.node_id_str.clone(),
                });
                if let Err(e) = self.send_friendz_message(from_node_id, &ack).await {
                    tracing::debug!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to send friend-accept-ack"
                    );
                }

                // request their profile
                let profile_req = FriendzMessage::Core(CoreMessage::ProfileRequest { v: 1 });
                if let Err(e) = self.send_friendz_message(from_node_id, &profile_req).await {
                    tracing::debug!(
                        peer = %from_node_id,
                        error = %e,
                        "failed to request profile after friend-accept"
                    );
                }

                // NOTE: no outbound sync dial — see PeerOnline handler comment.
                // the JS side will establish sync when it needs to.
            }
            CoreMessage::FriendAcceptAck { .. } => {
                tracing::debug!(
                    peer = %from_node_id,
                    "received friend-accept-ack, handshake complete"
                );
            }
            CoreMessage::FriendReject { .. } => {
                tracing::info!(
                    peer = %from_node_id,
                    "received friend rejection"
                );
            }
            CoreMessage::Heartbeat { .. } => {
                // auto-handled by FriendzService::dispatch (presence
                // tracking + the fast-ack reply on first appearance).
                // nothing extra to do here.
            }
            CoreMessage::OfflineAnnouncement { .. } => {
                // auto-handled by FriendzService::dispatch (removes the
                // peer from presence and emits PeerOffline).
                tracing::info!(peer = %from_node_id, "received offline announcement");
            }
            CoreMessage::Hello { .. } | CoreMessage::HelloOk { .. } => {
                // no capabilities are configured on this service today, so
                // `dispatch` never sends `hello` on its own and never
                // replies to one — inert for this hub until capabilities
                // are wired up.
                tracing::debug!(peer = %from_node_id, "received hello/hello-ok (unused)");
            }
            CoreMessage::IdentityUpdate { .. } => {
                // not adopted yet — low-risk to add later (see the friendz
                // protocol spec's message-mapping table), no current caller.
                tracing::debug!(peer = %from_node_id, "received identity-update (unused)");
            }
            CoreMessage::AclChange {
                resource_id,
                resource_title,
                target_node_id,
                new_role,
                changed_by,
                changed_by_username,
                ..
            } => {
                tracing::info!(
                    peer = %from_node_id,
                    resource_id = %resource_id,
                    resource_title = ?resource_title,
                    target = %target_node_id,
                    new_role = ?new_role,
                    changed_by = %changed_by,
                    changed_by_username = %changed_by_username,
                    "received ACL change notification"
                );

                // if the hub was removed from this canvas, stop tracking it.
                // an absent `new_role` means revoked (haruspex's `AclChange`
                // has no "removed" string literal - see the friendz protocol
                // spec's message-mapping table). soft-delete rather than
                // hard-delete (see `HubDocStorage::soft_remove_canvas_id`'s
                // doc comment) — the automerge doc + its persisted bytes
                // survive so `reliquary maintenance restore` (or a later
                // re-invite, which reactivates via `save_canvas_id`) can
                // bring it back without re-syncing from scratch; a separate
                // `reliquary maintenance purge` sweep is what actually
                // deletes the data, once an admin confirms it's safe to.
                if target_node_id == self.node_id_str && new_role.is_none() {
                    tracing::info!(
                        resource_id = %resource_id,
                        resource_title = ?resource_title,
                        changed_by = %changed_by,
                        "hub removed from canvas — soft-deleting (untracking, keeping data for maintenance)"
                    );

                    {
                        let mut ids = self.canvas_doc_ids.lock().await;
                        ids.remove(&resource_id);
                    }
                    self.hub_repo.soft_remove_canvas_id(&resource_id).await;
                    self.hub_repo.evict_doc(&resource_id).await;

                    // sweep orphan blobs — soft-delete blobs unique to this canvas.
                    {
                        let blobz = self.blobz.clone();
                        let storage = self.hub_repo.storage().clone();
                        let doc_id_owned = resource_id.clone();
                        tokio::spawn(async move {
                            match crate::maintenance::sweep_canvas_blobs(
                                &storage,
                                &blobz,
                                &doc_id_owned,
                                "system:hub-uninvited",
                            )
                            .await
                            {
                                Ok(n) if n > 0 => tracing::info!(
                                    canvas_doc_id = %doc_id_owned,
                                    soft_deleted = n,
                                    "acl-removed sweep: orphan blobs soft-deleted"
                                ),
                                Ok(_) => {}
                                Err(e) => tracing::warn!(
                                    canvas_doc_id = %doc_id_owned,
                                    error = %e,
                                    "acl-removed sweep: sweep_canvas_blobs failed"
                                ),
                            }
                        });
                    }
                }
            }
            CoreMessage::GossipDigest {
                pending_knocks,
                profiles,
                app_payload,
                ..
            } => {
                let skein_payload: wire::SkeinGossipPayload = app_payload
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();
                self.handle_gossip_digest(
                    from_node_id,
                    skein_payload.canvas_updates,
                    skein_payload.pending_invites,
                    pending_knocks,
                    skein_payload.shared_canvas_ids,
                    profiles,
                )
                .await;
            }
            CoreMessage::BlobSeek { needed, .. } => {
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
                    let offer = FriendzMessage::Core(CoreMessage::BlobOffer { v: 1, available });
                    if let Err(e) = self.send_friendz_message(from_node_id, &offer).await {
                        tracing::warn!(
                            peer = %from_node_id,
                            error = %e,
                            "failed to send blob offer"
                        );
                    }
                }
            }
            CoreMessage::BlobOffer { available, .. } => {
                tracing::info!(
                    peer = %from_node_id,
                    count = available.len(),
                    "received blob offer, updating peer inventory"
                );

                self.engine.offer_peer_blobs(from_node_id, available);
            }
            CoreMessage::KnockRequest {
                knock_id,
                node_id,
                username,
                message,
                scope,
                ..
            } => {
                let canvas_doc_id = match scope {
                    haruspex::protocol::WireKnockScope::Resource { resource_id, .. } => resource_id,
                    other => {
                        tracing::debug!(
                            peer = %from_node_id,
                            scope = ?other,
                            "ignoring knock-request with a non-resource scope"
                        );
                        return;
                    }
                };
                self.handle_canvas_knock(
                    from_node_id,
                    &knock_id,
                    &canvas_doc_id,
                    &node_id,
                    username.as_deref().unwrap_or(""),
                    &message,
                )
                .await;
            }
            CoreMessage::KnockAck {
                knock_id,
                acker_node_id,
                resource_id,
                ..
            } => {
                tracing::info!(
                    peer = %from_node_id,
                    knock_id = %knock_id,
                    resource_id = ?resource_id,
                    acker = %acker_node_id,
                    "received knock ack"
                );
            }
            CoreMessage::KnockOutcome {
                knock_id,
                status,
                granted_role,
                granted_resource_ids,
                by_node_id,
                ..
            } => {
                tracing::info!(
                    peer = %from_node_id,
                    knock_id = ?knock_id,
                    status = ?status,
                    granted_role = ?granted_role.map(role_str),
                    granted_resource_ids = ?granted_resource_ids,
                    by_node_id = ?by_node_id,
                    "received knock outcome"
                );
            }
            CoreMessage::Error { code, message, .. } => {
                tracing::warn!(
                    peer = %from_node_id,
                    code = %code,
                    message = %message,
                    "received protocol error message"
                );
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
        use freqhole_reliquary::media;

        let (_mime, raw_bytes) = media::decode_data_url(data_url)?;
        if raw_bytes.is_empty() {
            return None;
        }

        let webp = match media::resize_to_square_webp(&raw_bytes, 128) {
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
                    &webp,
                    freqhole_reliquary::blobz::NewBlobMeta {
                        filename: Some("peer-avatar.webp".to_string()),
                        mime: Some("image/webp".to_string()),
                        ..Default::default()
                    },
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

/// `Role`'s `Display`/logging helper - haruspex's `Role` derives `Serialize`
/// (snake_case) but not `Display`; a small string view is nicer in tracing
/// fields than the derived `Debug`.
fn role_str(role: Role) -> &'static str {
    role.as_str()
}
