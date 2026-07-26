//! userz: tiny peer directory.
//!
//! tracks peers we've encountered: node id, optional display name + avatar
//! blob, first/last-seen timestamps. also marks the local node as `is_self`.
//! no passwords, no sessions, no roles.
//!
//! storage is haruspex's own `PeerDirectory`/`SqlitePeerDirectory` (its
//! `peerz` table, distinct from skein's original `userz` table). the one
//! field haruspex's `PeerProfile` shape represents differently is
//! `accent_color`: skein stores it as a `0xRRGGBB` integer, haruspex as an
//! arbitrary `#rrggbb`-style hex string - converted at this module's
//! boundary.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;

use haruspex::identity::PeerProfile;
use haruspex::sqlite::SqlitePeerDirectory;
use haruspex::stores::PeerDirectory as _;

#[derive(Debug, Error)]
pub enum UserError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("haruspex store error: {0}")]
    Store(#[from] haruspex::error::StoreError),
}

/// `0` means "no accent color set" - matches skein's original convention.
pub(crate) fn accent_color_to_hex(color: i64) -> String {
    format!("#{:06x}", color & 0xff_ffff)
}

fn hex_to_accent_color(hex: Option<String>) -> i64 {
    hex.as_deref()
        .and_then(|s| i64::from_str_radix(s.trim_start_matches('#'), 16).ok())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerRecord {
    pub node_id: String,
    pub display_name: Option<String>,
    pub alias: Option<String>,
    pub bio: Option<String>,
    pub avatar_blake3: Option<String>,
    pub accent_color: i64,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub is_self: bool,
    /// true once this peer has told us (via a `FriendRequest`/`FriendAccept`
    /// with `isHub: true`) that it's a reliquary hub. sticky — set by
    /// `mark_as_hub`, never reset back to false.
    pub is_hub: bool,
}

#[derive(Clone)]
pub struct Directory {
    /// haruspex's own sqlite db (a sibling file to this crate's own,
    /// opened via `db::open_haruspex`) - this directory carries no
    /// skein-specific side data of its own, so it needs nothing else.
    haruspex_pool: SqlitePool,
}

impl Directory {
    pub fn new(haruspex_pool: SqlitePool) -> Self {
        Self { haruspex_pool }
    }

    fn peers(&self) -> SqlitePeerDirectory {
        SqlitePeerDirectory::new(self.haruspex_pool.clone())
    }

    /// upsert the local node. called once on hub startup.
    ///
    /// `display_name`, `bio`, and `avatar_blake3` are all optional and
    /// merged with COALESCE — passing `None` for a field leaves the
    /// existing value alone, so partial updates work without read-modify-write.
    pub async fn upsert_self(
        &self,
        node_id: &str,
        display_name: Option<&str>,
        bio: Option<&str>,
        avatar_blake3: Option<&str>,
    ) -> Result<(), UserError> {
        self.upsert_self_full(node_id, display_name, None, bio, avatar_blake3, None)
            .await
    }

    /// upsert the local node with all profile fields. None preserves existing.
    pub async fn upsert_self_full(
        &self,
        node_id: &str,
        display_name: Option<&str>,
        alias: Option<&str>,
        bio: Option<&str>,
        avatar_blake3: Option<&str>,
        accent_color: Option<i64>,
    ) -> Result<(), UserError> {
        let now = now_secs();
        let profile = PeerProfile {
            node_id: node_id.to_string(),
            display_name: display_name.map(str::to_string),
            alias: alias.map(str::to_string),
            bio: bio.map(str::to_string),
            avatar_blake3: avatar_blake3.map(str::to_string),
            accent_color: accent_color.map(accent_color_to_hex),
            is_self: true,
            is_hub: false,
            first_seen: now,
            last_seen: now,
        };
        self.peers().upsert_profile(profile).await?;
        Ok(())
    }

    /// update `last_seen_at` for a peer (and insert a minimal row if new).
    pub async fn touch(&self, node_id: &str) -> Result<(), UserError> {
        let now = now_secs();
        self.peers().touch(node_id, now).await?;
        Ok(())
    }

    /// update a peer's profile (display_name + bio + avatar). any None fields
    /// are left untouched (COALESCE-based merge).
    pub async fn upsert_profile(
        &self,
        node_id: &str,
        display_name: Option<&str>,
        bio: Option<&str>,
        avatar_blake3: Option<&str>,
    ) -> Result<(), UserError> {
        self.upsert_profile_full(node_id, display_name, bio, avatar_blake3, None)
            .await
    }

    /// update a peer's profile with all optional fields, including accent
    /// color. any None fields are left untouched (COALESCE-based merge).
    pub async fn upsert_profile_full(
        &self,
        node_id: &str,
        display_name: Option<&str>,
        bio: Option<&str>,
        avatar_blake3: Option<&str>,
        accent_color: Option<i64>,
    ) -> Result<(), UserError> {
        let now = now_secs();
        let profile = PeerProfile {
            node_id: node_id.to_string(),
            display_name: display_name.map(str::to_string),
            alias: None,
            bio: bio.map(str::to_string),
            avatar_blake3: avatar_blake3.map(str::to_string),
            accent_color: accent_color.map(accent_color_to_hex),
            is_self: false,
            is_hub: false,
            first_seen: now,
            last_seen: now,
        };
        self.peers().upsert_profile(profile).await?;
        Ok(())
    }

    /// set the local user's free-form alias for a peer (or for self).
    /// the row must already exist (caller should `touch` first). `None`
    /// clears the alias back to unset.
    pub async fn set_alias(&self, node_id: &str, alias: Option<&str>) -> Result<(), UserError> {
        match alias {
            Some(alias) => {
                let now = now_secs();
                self.peers()
                    .upsert_profile(PeerProfile {
                        node_id: node_id.to_string(),
                        display_name: None,
                        alias: Some(alias.to_string()),
                        bio: None,
                        avatar_blake3: None,
                        accent_color: None,
                        is_self: false,
                        is_hub: false,
                        first_seen: now,
                        last_seen: now,
                    })
                    .await?;
            }
            None => self.peers().clear_alias(node_id).await?,
        }
        Ok(())
    }

    /// mark a peer as a reliquary hub. sticky — an `UPDATE ... SET is_hub = 1`
    /// is a one-way ratchet, so calling this repeatedly (or on a message that
    /// simply omits the flag, which callers should just not call this for)
    /// never resets a peer back to non-hub. inserts a minimal row first if
    /// the peer isn't known yet (mirrors `touch`'s upsert shape), so this can
    /// be called before any other profile data has arrived for the peer.
    pub async fn mark_as_hub(&self, node_id: &str) -> Result<(), UserError> {
        let now = now_secs();
        self.peers().mark_as_hub(node_id, now).await?;
        Ok(())
    }

    pub async fn get(&self, node_id: &str) -> Result<Option<PeerRecord>, UserError> {
        let profile = self.peers().get_profile(node_id).await?;
        Ok(profile.map(PeerRecord::from_profile))
    }

    /// fetch the local self row (the one with is_self = 1), if any.
    pub async fn get_self(&self) -> Result<Option<PeerRecord>, UserError> {
        let profile = self.peers().get_self().await?;
        Ok(profile.map(PeerRecord::from_profile))
    }
}

impl PeerRecord {
    fn from_profile(p: PeerProfile) -> Self {
        Self {
            node_id: p.node_id,
            display_name: p.display_name,
            alias: p.alias,
            bio: p.bio,
            avatar_blake3: p.avatar_blake3,
            accent_color: hex_to_accent_color(p.accent_color),
            first_seen_at: p.first_seen,
            last_seen_at: p.last_seen,
            is_self: p.is_self,
            is_hub: p.is_hub,
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

    async fn make_dir() -> Directory {
        Directory::new(haruspex::testing::open_in_memory().await)
    }

    #[tokio::test]
    async fn upsert_self_creates_row_marked_is_self() {
        let dir = make_dir().await;
        dir.upsert_self("node-self", Some("me"), Some("hi"), Some("bk3"))
            .await
            .unwrap();

        let got = dir.get("node-self").await.unwrap().expect("present");
        assert!(got.is_self);
        assert_eq!(got.display_name.as_deref(), Some("me"));
        assert_eq!(got.bio.as_deref(), Some("hi"));
        assert_eq!(got.avatar_blake3.as_deref(), Some("bk3"));
        assert_eq!(got.first_seen_at, got.last_seen_at);
    }

    #[tokio::test]
    async fn upsert_self_partial_update_preserves_existing_fields() {
        let dir = make_dir().await;
        dir.upsert_self("n", Some("name1"), Some("bio1"), Some("av1"))
            .await
            .unwrap();
        // pass None for everything except node_id; existing values must remain.
        dir.upsert_self("n", None, None, None).await.unwrap();

        let got = dir.get("n").await.unwrap().unwrap();
        assert_eq!(got.display_name.as_deref(), Some("name1"));
        assert_eq!(got.bio.as_deref(), Some("bio1"));
        assert_eq!(got.avatar_blake3.as_deref(), Some("av1"));
        assert!(got.is_self);
    }

    #[tokio::test]
    async fn touch_creates_minimal_peer_row() {
        let dir = make_dir().await;
        dir.touch("peer-1").await.unwrap();
        let got = dir.get("peer-1").await.unwrap().expect("present");
        assert!(!got.is_self);
        assert!(got.display_name.is_none());
        assert!(got.bio.is_none());
        assert!(got.avatar_blake3.is_none());
    }

    #[tokio::test]
    async fn touch_updates_last_seen_only() {
        let dir = make_dir().await;
        dir.touch("p").await.unwrap();
        let first = dir.get("p").await.unwrap().unwrap();
        // sleep past the 1s timestamp resolution so last_seen_at can advance.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        dir.touch("p").await.unwrap();
        let second = dir.get("p").await.unwrap().unwrap();
        assert_eq!(first.first_seen_at, second.first_seen_at);
        assert!(second.last_seen_at >= first.last_seen_at);
    }

    #[tokio::test]
    async fn upsert_profile_writes_then_merges() {
        let dir = make_dir().await;
        dir.upsert_profile("p", Some("alice"), Some("hello"), Some("av-a"))
            .await
            .unwrap();
        let after_first = dir.get("p").await.unwrap().unwrap();
        assert_eq!(after_first.display_name.as_deref(), Some("alice"));

        // overwrite display_name only; bio + avatar must be preserved.
        dir.upsert_profile("p", Some("alice2"), None, None)
            .await
            .unwrap();
        let after_second = dir.get("p").await.unwrap().unwrap();
        assert_eq!(after_second.display_name.as_deref(), Some("alice2"));
        assert_eq!(after_second.bio.as_deref(), Some("hello"));
        assert_eq!(after_second.avatar_blake3.as_deref(), Some("av-a"));
        assert!(!after_second.is_self);
    }

    #[tokio::test]
    async fn get_returns_none_for_unknown_node() {
        let dir = make_dir().await;
        assert!(dir.get("ghost").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mark_as_hub_creates_row_if_unknown() {
        let dir = make_dir().await;
        dir.mark_as_hub("hub-1").await.unwrap();
        let got = dir.get("hub-1").await.unwrap().expect("present");
        assert!(got.is_hub);
        assert!(!got.is_self);
    }

    #[tokio::test]
    async fn mark_as_hub_sets_flag_on_existing_peer_without_touching_other_fields() {
        let dir = make_dir().await;
        dir.upsert_profile("p", Some("alice"), Some("hello"), Some("av-a"))
            .await
            .unwrap();
        dir.mark_as_hub("p").await.unwrap();

        let got = dir.get("p").await.unwrap().unwrap();
        assert!(got.is_hub);
        assert_eq!(got.display_name.as_deref(), Some("alice"));
        assert_eq!(got.bio.as_deref(), Some("hello"));
        assert_eq!(got.avatar_blake3.as_deref(), Some("av-a"));
    }

    #[tokio::test]
    async fn mark_as_hub_is_sticky_across_subsequent_profile_updates() {
        let dir = make_dir().await;
        dir.mark_as_hub("p").await.unwrap();
        assert!(dir.get("p").await.unwrap().unwrap().is_hub);

        // a later profile update (as happens on every PeerOnline event) must
        // not reset the flag back to false.
        dir.upsert_profile("p", Some("alice"), None, None)
            .await
            .unwrap();
        assert!(dir.get("p").await.unwrap().unwrap().is_hub);

        // calling mark_as_hub again is idempotent.
        dir.mark_as_hub("p").await.unwrap();
        assert!(dir.get("p").await.unwrap().unwrap().is_hub);
    }

    #[tokio::test]
    async fn peers_default_to_not_a_hub() {
        let dir = make_dir().await;
        dir.touch("p").await.unwrap();
        assert!(!dir.get("p").await.unwrap().unwrap().is_hub);
    }
}
