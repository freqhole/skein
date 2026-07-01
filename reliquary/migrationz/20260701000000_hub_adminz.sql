-- hub_adminz: node ids allowed to administer this hub's friendz allow-list
-- remotely via the `iroh/skein-hub-admin/1` protocol (see
-- reliquary/src/protocol/hub_admin.rs). deliberately separate from
-- `friendz`: an admin doesn't need to be a friend, and a friend doesn't
-- need to be an admin. one row per admin node id, no extra state.
CREATE TABLE hub_adminz (
    node_id    TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL
);
