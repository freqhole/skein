//! friendz protocol types and codec for P2P communication.
//!
//! implements the `skein-friendz/1` ALPN wire format: JSON-encoded messages
//! with length-delimited framing over iroh BiStreams.

pub mod blob_proxy;
pub mod codec;
pub mod handler;
pub mod messages;
