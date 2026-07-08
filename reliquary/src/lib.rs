//! reliquary: headless hub peer for the skein canvas p2p ecosystem.
//!
//! this crate is primarily a binary (`reliquary serve`), but its modules are
//! also exposed as a library so the skein tauri app can optionally run a hub
//! in-process and share its iroh identity.
//!
//! all modules are grimoire-free: stores (`userz`, `friendz`) provide direct
//! sqlx access; the hub layer (`hub`, `hub_repo`, `snatch`) talks to those
//! stores plus iroh-blobs `FsStore` and the `freqhole_reliquary` blob store
//! directly.

pub mod adminz;
pub mod blob_acl;
pub mod db;
pub mod documents;
pub mod friendz;
pub mod groupz;
pub mod haruspex_bridge;
pub mod hub;
pub mod hub_repo;

pub mod maintenance;
pub mod protocol;
pub mod service;
pub mod settingz;
pub mod snatch;
pub mod sync;
pub mod userz;
