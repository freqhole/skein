//! hub_admin: `iroh/skein-hub-admin/1` protocol handler.
//!
//! lets a remote, authenticated admin peer manage this hub's friendz
//! allow-list (allow / list / remove) over the network, instead of
//! requiring local filesystem/CLI access to the machine the hub runs on.
//! mirrors the CLI's `reliquary friend allow/list/remove` subcommands
//! (`main.rs`'s `FriendCommand`) for consistent semantics.
//!
//! this is deliberately distinct from `skein-friendz/1` (peer-to-peer friend
//! requests between any two skein nodes): `skein-friendz/1` is for ordinary
//! friend-request handshaking between any two peers, while this protocol is
//! for a privileged remote peer to administer *this hub's* allow-list.
//!
//! every request is checked against the `adminz` table before acting; a
//! caller whose node id isn't in `adminz` gets back [`AdminResponse::NotAdmin`]
//! and nothing is changed.
//!
//! wire format: one request/response pair per bidirectional stream, CBOR-
//! encoded via `ciborium` (the same encoding `hub_repo` uses for automerge
//! sync messages), no length prefix — the sender signals end-of-request by
//! calling `finish()` on the send stream, the same convention `skein/1`'s
//! `blob_proxy` handler uses. structure and style follow `blob_proxy.rs`.

use std::sync::Arc;

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use serde::{Deserialize, Serialize};

use crate::adminz;
use crate::friendz;
use crate::userz;

/// ALPN protocol identifier for remote hub administration.
pub const HUB_ADMIN_ALPN: &[u8] = b"iroh/skein-hub-admin/1";

/// max request/response size read off the wire. generous for a friendz list
/// on any hub that isn't wildly abused.
const MAX_MESSAGE_SIZE: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// protocol messages
// ---------------------------------------------------------------------------

/// a single friendz row as reported to a remote admin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendSummary {
    pub node_id: String,
    pub status: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AdminRequest {
    /// pre-approve a peer (mirrors `reliquary friend allow`).
    Allow { node_id: String },
    /// list every friendz row (mirrors `reliquary friend list`).
    List,
    /// remove a peer from friendz entirely (mirrors `reliquary friend remove`).
    Remove { node_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AdminResponse {
    Allowed {
        node_id: String,
        status: String,
    },
    List {
        friends: Vec<FriendSummary>,
    },
    Removed {
        node_id: String,
    },
    /// caller's node id isn't in the `adminz` table.
    NotAdmin,
    /// request-level failure (bad node_id, store error, etc).
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// HubAdminHandler
// ---------------------------------------------------------------------------

/// hub's `iroh/skein-hub-admin/1` protocol handler. clones are cheap
/// (backed by `Arc`).
#[derive(Clone)]
pub struct HubAdminHandler {
    inner: Arc<Inner>,
}

struct Inner {
    adminz: adminz::Store,
    friendz: friendz::Store,
    userz: userz::Directory,
}

impl std::fmt::Debug for HubAdminHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HubAdminHandler").finish_non_exhaustive()
    }
}

impl HubAdminHandler {
    pub fn new(adminz: adminz::Store, friendz: friendz::Store, userz: userz::Directory) -> Self {
        Self {
            inner: Arc::new(Inner {
                adminz,
                friendz,
                userz,
            }),
        }
    }
}

impl ProtocolHandler for HubAdminHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let peer_id = conn.remote_id();
        let peer_id_str = peer_id.to_string();
        tracing::info!(peer = %peer_id, "skein-hub-admin/1: accepted connection");

        loop {
            let (send, recv) = match conn.accept_bi().await {
                Ok(bi) => bi,
                Err(e) => {
                    tracing::debug!(peer = %peer_id, error = %e, "skein-hub-admin/1: connection closed");
                    break;
                }
            };

            let handler = self.clone();
            let peer_id_str = peer_id_str.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_stream(send, recv, &handler, &peer_id_str).await {
                    tracing::debug!(peer = %peer_id_str, error = %e, "skein-hub-admin/1: stream error");
                }
            });
        }

        Ok(())
    }

    async fn shutdown(&self) {
        tracing::debug!("skein-hub-admin/1: shutting down");
    }
}

// ---------------------------------------------------------------------------
// stream handling
// ---------------------------------------------------------------------------

async fn handle_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    handler: &HubAdminHandler,
    peer_id_str: &str,
) -> Result<(), String> {
    let msg_bytes = recv
        .read_to_end(MAX_MESSAGE_SIZE)
        .await
        .map_err(|e| format!("failed to read request: {e}"))?;

    let request: AdminRequest = ciborium::from_reader(msg_bytes.as_slice())
        .map_err(|e| format!("failed to decode CBOR request: {e}"))?;

    let response = handle_request(handler, peer_id_str, request).await;
    send_response(&mut send, &response).await
}

/// handle a single decoded request, checking `adminz` authorization first.
/// kept separate from `handle_stream` so it's testable without a live iroh
/// `Connection` (see `mod tests` below).
async fn handle_request(
    handler: &HubAdminHandler,
    peer_id_str: &str,
    request: AdminRequest,
) -> AdminResponse {
    if !handler.inner.adminz.is_admin(peer_id_str).await {
        tracing::info!(peer = %peer_id_str, "skein-hub-admin/1: rejected non-admin caller");
        return AdminResponse::NotAdmin;
    }

    match request {
        AdminRequest::Allow { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                return AdminResponse::Error {
                    message: "node_id cannot be empty".to_string(),
                };
            }

            // mirror the CLI's promote-or-leave semantics (see main.rs's
            // `FriendCommand::Allow` handler): never demote an
            // already-Accepted friend back to Allowed.
            let existing = match handler.inner.friendz.get(node_id).await {
                Ok(f) => f,
                Err(e) => {
                    return AdminResponse::Error {
                        message: format!("friendz lookup failed: {e}"),
                    }
                }
            };
            if matches!(
                existing.as_ref().map(|f| f.status),
                Some(friendz::FriendStatus::Accepted)
            ) {
                return AdminResponse::Allowed {
                    node_id: node_id.to_string(),
                    status: friendz::FriendStatus::Accepted.as_str().to_string(),
                };
            }

            // ensure a userz row exists so the FK on friendz.friend_node_id holds.
            if let Err(e) = handler.inner.userz.touch(node_id).await {
                return AdminResponse::Error {
                    message: format!("userz touch failed: {e}"),
                };
            }
            match handler
                .inner
                .friendz
                .upsert(node_id, friendz::FriendStatus::Allowed, None)
                .await
            {
                Ok(friend) => AdminResponse::Allowed {
                    node_id: friend.friend_node_id,
                    status: friend.status.as_str().to_string(),
                },
                Err(e) => AdminResponse::Error {
                    message: format!("friendz upsert failed: {e}"),
                },
            }
        }
        AdminRequest::List => match handler.inner.friendz.list(false).await {
            Ok(friends) => AdminResponse::List {
                friends: friends
                    .into_iter()
                    .map(|f| FriendSummary {
                        node_id: f.friend_node_id,
                        status: f.status.as_str().to_string(),
                        updated_at: f.updated_at,
                    })
                    .collect(),
            },
            Err(e) => AdminResponse::Error {
                message: format!("friendz list failed: {e}"),
            },
        },
        AdminRequest::Remove { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                return AdminResponse::Error {
                    message: "node_id cannot be empty".to_string(),
                };
            }
            match handler.inner.friendz.delete(node_id).await {
                Ok(()) => AdminResponse::Removed {
                    node_id: node_id.to_string(),
                },
                Err(e) => AdminResponse::Error {
                    message: format!("friendz delete failed: {e}"),
                },
            }
        }
    }
}

async fn send_response(
    send: &mut iroh::endpoint::SendStream,
    resp: &AdminResponse,
) -> Result<(), String> {
    let mut buf = Vec::new();
    ciborium::into_writer(resp, &mut buf)
        .map_err(|e| format!("failed to encode CBOR response: {e}"))?;
    send.write_all(&buf)
        .await
        .map_err(|e| format!("failed to write response: {e}"))?;
    send.finish()
        .map_err(|e| format!("failed to finish stream: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    async fn make_handler() -> (
        HubAdminHandler,
        adminz::Store,
        friendz::Store,
        userz::Directory,
    ) {
        let pool = db::open_in_memory().await;
        let adminz_store = adminz::Store::new(pool.clone());
        let friendz_store = friendz::Store::new(pool.clone());
        let userz_dir = userz::Directory::new(pool);
        (
            HubAdminHandler::new(
                adminz_store.clone(),
                friendz_store.clone(),
                userz_dir.clone(),
            ),
            adminz_store,
            friendz_store,
            userz_dir,
        )
    }

    #[test]
    fn request_and_response_cbor_round_trip() {
        let req = AdminRequest::Allow {
            node_id: "abc".to_string(),
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&req, &mut buf).unwrap();
        let decoded: AdminRequest = ciborium::from_reader(buf.as_slice()).unwrap();
        assert!(matches!(decoded, AdminRequest::Allow { node_id } if node_id == "abc"));

        let resp = AdminResponse::Removed {
            node_id: "abc".to_string(),
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&resp, &mut buf).unwrap();
        let decoded: AdminResponse = ciborium::from_reader(buf.as_slice()).unwrap();
        assert!(matches!(decoded, AdminResponse::Removed { node_id } if node_id == "abc"));
    }

    #[tokio::test]
    async fn non_admin_is_rejected_for_all_operations() {
        let (handler, _adminz, _friendz, _userz) = make_handler().await;
        let stranger = "stranger-node";

        let allow = handle_request(
            &handler,
            stranger,
            AdminRequest::Allow {
                node_id: "target".to_string(),
            },
        )
        .await;
        assert!(matches!(allow, AdminResponse::NotAdmin));

        let list = handle_request(&handler, stranger, AdminRequest::List).await;
        assert!(matches!(list, AdminResponse::NotAdmin));

        let remove = handle_request(
            &handler,
            stranger,
            AdminRequest::Remove {
                node_id: "target".to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::NotAdmin));
    }

    #[tokio::test]
    async fn admin_can_allow_list_and_remove() {
        let (handler, adminz_store, _friendz, _userz) = make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        let allow = handle_request(
            &handler,
            admin_node,
            AdminRequest::Allow {
                node_id: "target-peer".to_string(),
            },
        )
        .await;
        match allow {
            AdminResponse::Allowed { node_id, status } => {
                assert_eq!(node_id, "target-peer");
                assert_eq!(status, "allowed");
            }
            other => panic!("expected Allowed, got {other:?}"),
        }

        let list = handle_request(&handler, admin_node, AdminRequest::List).await;
        match list {
            AdminResponse::List { friends } => {
                assert_eq!(friends.len(), 1);
                assert_eq!(friends[0].node_id, "target-peer");
            }
            other => panic!("expected List, got {other:?}"),
        }

        let remove = handle_request(
            &handler,
            admin_node,
            AdminRequest::Remove {
                node_id: "target-peer".to_string(),
            },
        )
        .await;
        assert!(matches!(remove, AdminResponse::Removed { .. }));

        let list_after = handle_request(&handler, admin_node, AdminRequest::List).await;
        match list_after {
            AdminResponse::List { friends } => assert!(friends.is_empty()),
            other => panic!("expected List, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn admin_allow_does_not_demote_an_already_accepted_friend() {
        let (handler, adminz_store, friendz_store, userz_dir) = make_handler().await;
        let admin_node = "admin-node";
        adminz_store.allow(admin_node).await.unwrap();

        // simulate a friend that's already gone through the full handshake.
        // needs a userz row first to satisfy the friendz FK.
        userz_dir.touch("already-accepted").await.unwrap();
        friendz_store
            .upsert("already-accepted", friendz::FriendStatus::Accepted, None)
            .await
            .unwrap();

        let allow = handle_request(
            &handler,
            admin_node,
            AdminRequest::Allow {
                node_id: "already-accepted".to_string(),
            },
        )
        .await;
        match allow {
            AdminResponse::Allowed { status, .. } => assert_eq!(status, "accepted"),
            other => panic!("expected Allowed, got {other:?}"),
        }
    }
}
