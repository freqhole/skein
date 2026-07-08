//! iroh protocol handler for automerge document sync.
//!
//! implements `iroh::protocol::ProtocolHandler` to accept inbound connections
//! on the `iroh/automerge-repo/1` ALPN and route them to `hub_repo` for
//! processing JS automerge-repo v2.x sync messages.

use std::pin::Pin;
use std::task::{Context, Poll};

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::Endpoint;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// ALPN protocol identifier for automerge-repo sync over iroh.
pub const AUTOMERGE_REPO_ALPN: &[u8] = b"iroh/automerge-repo/1";

/// returned (wrapped in `AcceptError::from_err`) when a peer without an
/// `Accepted`/`Allowed` friendz row dials the automerge-repo ALPN.
#[derive(Debug, thiserror::Error)]
#[error("peer is not an authorized friend")]
struct NotAuthorizedError;

// ---------------------------------------------------------------------------
// LoggingIo — transparent AsyncRead + AsyncWrite wrapper that logs all I/O
// ---------------------------------------------------------------------------

/// wraps any AsyncRead + AsyncWrite and logs every read/write at info level.
/// used to diagnose whether the peer is actually sending/receiving data.
struct LoggingIo<T> {
    inner: T,
    label: String,
    total_read: std::sync::atomic::AtomicUsize,
    total_written: std::sync::atomic::AtomicUsize,
}

impl<T> LoggingIo<T> {
    fn new(inner: T, label: String) -> Self {
        Self {
            inner,
            label,
            total_read: std::sync::atomic::AtomicUsize::new(0),
            total_written: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for LoggingIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        match &result {
            Poll::Ready(Ok(())) => {
                let bytes_read = buf.filled().len() - before;
                if bytes_read > 0 {
                    let total = self
                        .total_read
                        .fetch_add(bytes_read, std::sync::atomic::Ordering::Relaxed)
                        + bytes_read;
                    // log first 64 bytes as hex for debugging wire format
                    let filled = buf.filled();
                    let preview_start = if before < filled.len() { before } else { 0 };
                    let preview_end = std::cmp::min(preview_start + 64, filled.len());
                    let preview: String = filled[preview_start..preview_end]
                        .iter()
                        .map(|b| format!("{:02x}", b))
                        .collect();
                    tracing::trace!(
                        label = %self.label,
                        bytes_read,
                        total_read = total,
                        preview = %preview,
                        "transport READ"
                    );
                }
            }
            Poll::Ready(Err(e)) => {
                tracing::warn!(
                    label = %self.label,
                    error = %e,
                    "transport READ error"
                );
            }
            Poll::Pending => {}
        }
        result
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for LoggingIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &result {
            let total = self
                .total_written
                .fetch_add(*n, std::sync::atomic::Ordering::Relaxed)
                + n;
            // log first 64 bytes as hex
            let preview_end = std::cmp::min(64, buf.len());
            let preview: String = buf[..preview_end]
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect();
            tracing::trace!(
                label = %self.label,
                bytes_written = n,
                total_written = total,
                preview = %preview,
                "transport WRITE"
            );
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        tracing::debug!(label = %self.label, "transport SHUTDOWN");
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

// ---------------------------------------------------------------------------
// IrohRepo
// ---------------------------------------------------------------------------

/// iroh protocol handler backed by a hub_repo sync handler.
///
/// implements `ProtocolHandler` to accept inbound connections from other iroh
/// peers and routes them to `hub_repo` for automerge-repo v2.x sync.
///
/// gated by the friendz allow-list: only peers with a `friendz` row in
/// `Accepted` or `Allowed` status (see `friendz::Store::is_friend`) may sync
/// documents through this handler. this is the actual canvas-doc CRDT sync
/// path, so it's the most security-sensitive ALPN the hub registers, every
/// other authorization gate in this codebase (`skein-friendz/1`'s canvas
/// invite handling, `HubPeerService::is_friend`) exists downstream of this
/// same check.
///
/// the `is_friend` check only runs once, at `accept()` time, so revoking a
/// peer's `friendz` row after their connection was already accepted needs a
/// second mechanism to actually tear the live connection down: see
/// `hub_repo::HubRepo::cancel_peer` and its doc comment for how that works
/// and who's expected to call it. this used to be a documented-but-unfixed
/// gap (see the old `revoking_friendz_status_does_not_tear_down_an_already_accepted_connection`
/// test, replaced by
/// `sync::tests::revoking_friendz_status_now_cancels_an_already_accepted_connection`
/// below, which proves the fix).
#[derive(Clone)]
pub struct IrohRepo {
    /// kept for future outbound dialing (hub-to-hub sync).
    #[allow(dead_code)]
    endpoint: Endpoint,
    hub_repo: crate::hub_repo::HubRepo,
    friendz_store: crate::friendz::Store,
}

impl std::fmt::Debug for IrohRepo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IrohRepo").finish_non_exhaustive()
    }
}

impl IrohRepo {
    /// create an iroh protocol handler backed by a hub_repo sync handler.
    ///
    /// `friendz_store` is consulted on every inbound connection to reject
    /// peers that aren't friends before any sync traffic is processed.
    pub fn new(
        endpoint: Endpoint,
        hub_repo: crate::hub_repo::HubRepo,
        friendz_store: crate::friendz::Store,
    ) -> Self {
        Self {
            endpoint,
            hub_repo,
            friendz_store,
        }
    }

    /// access the hub_repo.
    pub fn hub_repo(&self) -> &crate::hub_repo::HubRepo {
        &self.hub_repo
    }
}

impl ProtocolHandler for IrohRepo {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let peer_id = connection.remote_id();
        let peer_id_str = peer_id.to_string();

        if !self.friendz_store.is_friend(&peer_id_str).await {
            tracing::info!(peer = %peer_id, "automerge-repo: rejected unauthorized peer");
            return Err(AcceptError::from_err(NotAuthorizedError));
        }

        tracing::info!(peer = %peer_id, "automerge-repo: accepted inbound connection");

        let (send, recv) = connection.accept_bi().await.map_err(|e| {
            tracing::warn!(peer = %peer_id, error = %e, "automerge-repo: failed to accept bi stream");
            e
        })?;

        let joined = tokio::io::join(recv, send);
        let label = format!("accept:{}", &peer_id.to_string()[..16]);
        let logged = LoggingIo::new(joined, label);

        let hub_repo = self.hub_repo.clone();
        tokio::spawn(async move {
            hub_repo.handle_connection(peer_id_str, logged).await;
        });

        Ok(())
    }

    async fn shutdown(&self) {
        tracing::debug!("automerge-repo: shutting down");
    }
}

#[cfg(test)]
mod tests {
    use crate::hub_repo::HubRepo;
    use crate::{db, friendz, friendz::FriendStatus, userz};

    /// seed a fresh in-memory friendz store with one peer in each relevant
    /// status. these tests exercise the exact check `IrohRepo::accept`
    /// performs before doing anything else, `friendz_store.is_friend(..)`,
    /// without needing a live iroh `Connection`. spinning up two real
    /// connected iroh endpoints for a true network-level round trip isn't
    /// something any existing reliquary unit test does (that's covered at
    /// the e2e layer, e.g. `loam/tests/reliquary-hub.spec.ts`), so this is
    /// deliberately unit-level rather than an end-to-end network test.
    async fn make_repo() -> friendz::Store {
        let skein_pool = db::open_in_memory().await;
        let haruspex_pool = haruspex::testing::open_in_memory().await;
        let friendz_store = friendz::Store::new(haruspex_pool.clone(), skein_pool);
        let users = userz::Directory::new(haruspex_pool);
        // seed a peer row for each friend up front, matching real usage.
        for peer in ["friend-accepted", "friend-allowed", "friend-blocked"] {
            users.touch(peer).await.unwrap();
        }
        friendz_store
            .upsert("friend-accepted", FriendStatus::Accepted, None)
            .await
            .unwrap();
        friendz_store
            .upsert("friend-allowed", FriendStatus::Allowed, None)
            .await
            .unwrap();
        friendz_store
            .upsert("friend-blocked", FriendStatus::Blocked, None)
            .await
            .unwrap();
        friendz_store
    }

    #[tokio::test]
    async fn accepted_friend_is_authorized() {
        let friendz_store = make_repo().await;
        assert!(friendz_store.is_friend("friend-accepted").await);
    }

    #[tokio::test]
    async fn allowed_friend_is_authorized() {
        let friendz_store = make_repo().await;
        assert!(friendz_store.is_friend("friend-allowed").await);
    }

    #[tokio::test]
    async fn stranger_with_no_friendz_row_is_rejected() {
        let friendz_store = make_repo().await;
        assert!(!friendz_store.is_friend("total-stranger").await);
    }

    #[tokio::test]
    async fn blocked_peer_is_rejected() {
        let friendz_store = make_repo().await;
        assert!(!friendz_store.is_friend("friend-blocked").await);
    }

    /// proves the fix for the gap the `IrohRepo` doc comment above used to
    /// describe as unfixed: `IrohRepo::accept` only ever calls `is_friend()`
    /// once, at the moment a connection is first accepted, but revoking a
    /// peer's `friendz` row now also cancels that peer's already-accepted
    /// connection via `hub_repo::HubRepo::cancel_peer`, instead of letting
    /// it keep syncing until the peer disconnects on its own.
    ///
    /// this doesn't spin up a real `iroh::endpoint::Connection` (no existing
    /// unit test in this crate does, see `make_repo`'s doc comment above),
    /// but it does exercise a real `hub_repo::HubRepo::handle_connection`
    /// loop over an in-memory `tokio::io::duplex` pair, which is the actual
    /// code `IrohRepo::accept` hands connections off to, so this proves the
    /// fix at the same level of abstraction `hub_repo::tests` uses (see
    /// `hub_repo::tests::cancel_peer_terminates_an_active_connection_promptly`,
    /// the more focused, registry-only version of this same scenario).
    #[tokio::test]
    async fn revoking_friendz_status_now_cancels_an_already_accepted_connection() {
        let friendz_store = make_repo().await;
        let peer_id = "friend-accepted";

        // this is exactly what `IrohRepo::accept` evaluates once, at
        // connection-accept time.
        assert!(friendz_store.is_friend(peer_id).await);

        // set up a HubRepo with an active "connection" for this peer, the
        // same object `IrohRepo::accept` hands accepted streams off to.
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("hub-docs.db");
        let hub_repo = HubRepo::new("hub-node".to_string(), &db_path)
            .await
            .expect("HubRepo::new should succeed");

        let (client_side, server_side) = tokio::io::duplex(8192);
        let repo_for_task = hub_repo.clone();
        let handle = tokio::spawn(async move {
            repo_for_task
                .handle_connection(peer_id.to_string(), server_side)
                .await;
        });

        for _ in 0..100 {
            if hub_repo.connected_peer_count().await == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(hub_repo.connected_peer_count().await, 1);

        // operator revokes mid-session (`reliquary friend remove`, or a
        // remote hub_admin `Remove` request) — the caller is expected to do
        // both steps: revoke in friendz::Store, then cancel in HubRepo (see
        // `HubRepo::cancel_peer`'s doc comment for why it's split this way).
        friendz_store.delete(peer_id).await.unwrap();
        assert!(!friendz_store.is_friend(peer_id).await);
        assert!(hub_repo.cancel_peer(peer_id).await);

        // the already-accepted connection actually gets torn down promptly,
        // rather than continuing to sync until the peer disconnects.
        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("handle_connection should return promptly once cancelled")
            .expect("handle_connection task should not panic");
        assert_eq!(hub_repo.connected_peer_count().await, 0);

        drop(client_side);
    }
}
