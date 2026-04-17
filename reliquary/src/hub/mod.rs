//! hub peer service — orchestrates the always-on p2p hub.
//!
//! ties together the iroh endpoint, friendz handler, hub_repo (custom
//! automerge sync), iroh-blobs, canvas invite/gossip, and the blob snatcher
//! into a single service.
//!
//! **status:** mid-port from the freqhole/grimoire-coupled implementation.
//! the legacy code lives next to this file as `_legacy_mod.rs.txt`,
//! `_legacy_messages.rs.txt`, and `_legacy_canvas.rs.txt` and is being
//! ported piecewise per [`docs/phase-2-port-plan.md`](../../../docs/phase-2-port-plan.md).
//!
//! currently exposed: [`avatar`] — image processing for hub profile.

pub mod avatar;
