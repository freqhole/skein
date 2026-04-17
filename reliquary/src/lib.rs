//! reliquary: headless hub peer for the skein canvas p2p ecosystem.
//!
//! this crate is primarily a binary (`reliquary serve`), but its modules are
//! also exposed as a library so the skein tauri app can optionally run a hub
//! in-process and share its iroh identity.
//!
//! phase 1 scaffolding: the stores (`blobz`, `userz`, `friendz`), db handle,
//! and identity are grimoire-free. the handler modules (`freqhole`, `hub`,
//! `snatch`, `hub_repo`) still reference grimoire and will be ported in a
//! follow-up round — they're intentionally excluded from the module tree
//! below so the crate compiles.

pub mod blobz;
pub mod db;
pub mod friendz;
pub mod identity;
pub mod userz;

// TODO(phase-1): port these off grimoire, then re-enable.
// pub mod documents;
// pub mod freqhole;
// pub mod hub;
// pub mod hub_repo;
// pub mod protocol;
// pub mod snatch;
// pub mod sync;
