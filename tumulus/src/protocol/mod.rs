//! hub-specific iroh protocol handlers not owned by `haruspex::protocol`.
//!
//! the friendz/presence/knock/gossip wire protocol itself
//! (`freqhole-friendz/1`) lives entirely in `haruspex::protocol` now - see
//! `crate::hub` for the business logic wired onto its `FriendzService`/
//! `FriendzProtocolHandler`. this module only holds hub-specific protocols
//! that have no haruspex equivalent: the blob-proxy (`freqhole/1`) and
//! remote hub administration (`iroh/skein-hub-admin/1`).

pub mod blob_proxy;
pub mod hub_admin;
