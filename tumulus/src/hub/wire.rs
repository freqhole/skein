//! skein-specific wire shapes layered on top of `haruspex::protocol`.
//!
//! canvas invite/update/deletion have no equivalent in haruspex's core
//! message set, so they travel as `skein:`-namespaced
//! [`haruspex::protocol::FriendzMessage::AppExtension`] payloads. gossip
//! digest's canvas-specific data (updates, pending invites, shared canvas
//! ids) has no dedicated field on haruspex's core `gossip-digest` either,
//! so it rides in that message's generic `appPayload` field as
//! [`SkeinGossipPayload`].

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use haruspex::protocol::FriendzMessage;

// ---------------------------------------------------------------------------
// app-extension message type tags
// ---------------------------------------------------------------------------

pub(crate) const EXT_CANVAS_INVITE: &str = "skein:canvas-invite";
pub(crate) const EXT_CANVAS_INVITE_ACK: &str = "skein:canvas-invite-ack";
pub(crate) const EXT_CANVAS_INVITE_ACCEPT: &str = "skein:canvas-invite-accept";
pub(crate) const EXT_CANVAS_INVITE_DECLINE: &str = "skein:canvas-invite-decline";
pub(crate) const EXT_CANVAS_UPDATE: &str = "skein:canvas-update";
pub(crate) const EXT_CANVAS_DELETED: &str = "skein:canvas-deleted";

/// build a namespaced `skein:`-prefixed app-extension message from a typed
/// payload. haruspex's app-extension mechanism round-trips the whole
/// received json object (`type`/`v` included), so a message this hub sends
/// has to carry those fields too — inserted here rather than on every
/// payload struct.
pub(crate) fn build_extension<T: Serialize>(message_type: &str, payload: &T) -> FriendzMessage {
    let mut value = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
    if let serde_json::Value::Object(map) = &mut value {
        map.insert(
            "type".to_string(),
            serde_json::Value::String(message_type.to_string()),
        );
        map.insert("v".to_string(), serde_json::Value::from(1));
    }
    FriendzMessage::AppExtension {
        message_type: message_type.to_string(),
        payload: value,
    }
}

/// parse an inbound app-extension payload into a typed struct. unknown
/// fields (`type`/`v`) are dropped by serde by default, so no special
/// handling is needed for them here.
pub(crate) fn parse_extension<T: DeserializeOwned>(payload: &serde_json::Value) -> Option<T> {
    serde_json::from_value(payload.clone()).ok()
}

// ---------------------------------------------------------------------------
// canvas invite / update / deletion payloads (skein:-namespaced extensions)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasInviteExt {
    pub invite_id: String,
    pub canvas_doc_id: String,
    pub canvas_title: String,
    #[serde(default)]
    pub canvas_description: Option<String>,
    #[serde(default)]
    pub canvas_color: Option<u32>,
    #[serde(default)]
    pub canvas_preview_url: Option<String>,
    pub origin_node_id: String,
    pub origin_username: String,
    pub role: String,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub acked: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasInviteAckExt {
    pub invite_id: String,
    pub canvas_doc_id: String,
    pub acker_node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasInviteAcceptExt {
    pub invite_id: String,
    pub canvas_doc_id: String,
    pub accepter_node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasInviteDeclineExt {
    pub invite_id: String,
    pub canvas_doc_id: String,
    pub decliner_node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasUpdateExt {
    pub canvas_doc_id: String,
    pub last_modified_at: String,
    pub widget_count: u32,
    pub modified_by_node_id: String,
    pub modified_by_username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasDeletedExt {
    pub canvas_doc_id: String,
    pub canvas_title: String,
    pub deleted_by: String,
    pub deleted_by_username: String,
    pub delete_mode: String,
    pub deleted_at: String,
}

// ---------------------------------------------------------------------------
// gossip digest app payload (skein-specific data riding in `appPayload`)
// ---------------------------------------------------------------------------

/// a canvas update entry in a gossip digest.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GossipDigestCanvasUpdate {
    pub canvas_doc_id: String,
    pub last_modified_at: String,
    pub last_modified_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

/// a pending invite entry in a gossip digest.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GossipDigestPendingInvite {
    pub canvas_doc_id: String,
    pub canvas_title: String,
    pub canvas_description: String,
    pub canvas_color: u32,
    pub canvas_preview_url: String,
    pub invited_by: String,
    pub invited_by_username: String,
    pub role: String,
    pub invited_at: String,
}

/// skein's app-specific gossip data, carried in `gossip-digest`'s generic
/// `appPayload` field alongside haruspex's core `pendingKnocks`/`profiles`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkeinGossipPayload {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub canvas_updates: Vec<GossipDigestCanvasUpdate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_invites: Vec<GossipDigestPendingInvite>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shared_canvas_ids: Vec<String>,
}
