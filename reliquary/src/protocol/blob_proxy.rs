//! `freqhole/1` blob-proxy glue.
//!
//! the protocol handler, message types, and client-side probe helper all
//! come from [`freqhole_reliquary::ensure`] — this module supplies only
//! what's specific to skein: the ALPN identifier and an access gate backed
//! by [`friendz::Store`].
//!
//! gated on friend status alone, checked per `ensure_blob` request — this
//! used to be checked once per connection instead (any peer who could dial
//! the ALPN could probe for a hash's existence and trigger a local
//! `FsStore` import-by-reference, an existence-leak even though it never
//! leaked bytes on its own; actual byte transfer still requires the
//! separately-gated `iroh-blobs/*` ALPN, see `blob_acl.rs`). this is
//! deliberately the coarser "friend or not" gate, not per-canvas `.acl` —
//! unlike the byte-transfer ALPN's gate, an `ensure_blob` request has no
//! canvas context to check against, so friend status is the floor here,
//! same as everywhere else in this module a stricter per-canvas check isn't
//! practical.

use std::sync::Arc;

use async_trait::async_trait;
use iroh_blobs::store::fs::FsStore;

use crate::friendz;
use freqhole_reliquary::blobz::BlobStore;
use freqhole_reliquary::ensure::EnsureBlobHandler;
use freqhole_reliquary::gate::AccessGate;

/// ALPN protocol identifier for the shared ensure blob protocol.
pub const ENSURE_ALPN: &[u8] = b"freqhole/1";

/// gates `ensure_blob` requests on hub-friend status.
struct FriendGate {
    friendz: friendz::Store,
}

#[async_trait]
impl AccessGate for FriendGate {
    async fn allow_blob(&self, peer: &str, _blake3: &str) -> bool {
        self.friendz.is_friend(peer).await
    }
}

/// build the `freqhole/1` handler, gated on friend status.
pub fn new_handler(
    store: &'static FsStore,
    blobz: Arc<dyn BlobStore>,
    friendz: friendz::Store,
) -> EnsureBlobHandler {
    EnsureBlobHandler::new(ENSURE_ALPN, store, blobz, Arc::new(FriendGate { friendz }))
}
