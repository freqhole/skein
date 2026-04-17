//! reliquary: headless hub peer for the skein canvas p2p ecosystem.
//!
//! this crate is primarily a binary (`reliquary serve`), but its modules are
//! also exposed as a library so the skein tauri app can optionally run a hub
//! in-process and share its iroh identity.
//!
//! all modules are grimoire-free as of phase-2: stores (`blobz`, `userz`,
//! `friendz`) provide direct sqlx access; the hub layer (`hub`, `hub_repo`,
//! `snatch`) talks to those stores plus iroh-blobs `FsStore` directly.

pub mod blobz;
pub mod db;
pub mod documents;
pub mod friendz;
pub mod hub;
pub mod hub_repo;
pub mod identity;
pub mod protocol;
pub mod service;
pub mod snatch;
pub mod sync;
pub mod userz;
