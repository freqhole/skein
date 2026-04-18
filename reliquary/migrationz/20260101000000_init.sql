-- initial skein schema.
-- prototype: no migration history to preserve. drop and recreate freely.

-- blob store: generic file store keyed by blake3.
-- when `external = 1`, `path` is an absolute filesystem path the store does
-- not own (zero-copy registration of a user-picked file). when 0, `path` is
-- relative to `<data_dir>/blob-files/`.
CREATE TABLE blobz (
    blake3      TEXT PRIMARY KEY NOT NULL,
    iroh_hash   TEXT NOT NULL,
    filename    TEXT,
    mime        TEXT,
    size        INTEGER NOT NULL,
    path        TEXT NOT NULL,
    external    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX blobz_iroh_hash_idx ON blobz (iroh_hash);

-- user directory: peers we've seen (ours + remote friends).
-- `alias` is the local user's free-form label for this peer (only meaningful
-- on `is_self` rows for self-profile, or on remote rows when the local user
-- has set a custom alias). `accent_color` is a 0xRRGGBB integer used for
-- per-peer UI tinting.
CREATE TABLE userz (
    node_id       TEXT PRIMARY KEY NOT NULL,
    display_name  TEXT,
    alias         TEXT,
    bio           TEXT,
    avatar_blake3 TEXT,
    accent_color  INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    is_self       INTEGER NOT NULL DEFAULT 0
);

-- friend edges: accepted two-way friendships.
-- one row per friend (directed from self_node_id). status tracks invite state.
-- `direction` is meaningful when status is 'pending' — distinguishes inbound
-- requests waiting for our accept from outbound requests waiting on them.
-- `alias` is the local user's display name for this friend (overrides their
-- broadcast display_name).
-- `group_name` is a UI-level grouping label, free-form.
CREATE TABLE friendz (
    friend_node_id  TEXT PRIMARY KEY NOT NULL,
    status          TEXT NOT NULL,          -- 'pending' | 'accepted' | 'blocked' | 'allowed'
    direction       TEXT,                   -- 'inbound' | 'outbound' (pending only)
    alias           TEXT,
    group_name      TEXT,
    narthex_doc_id  TEXT,                   -- their shared-with-us canvas doc
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (friend_node_id) REFERENCES userz (node_id)
);

-- automerge doc storage (used by the repo/ module).
-- keyed by doc id; stores serialized snapshot + change-log deltas.
CREATE TABLE docz (
    doc_id     TEXT PRIMARY KEY NOT NULL,
    snapshot   BLOB NOT NULL,
    heads      TEXT NOT NULL,            -- json array of change hash hex
    updated_at INTEGER NOT NULL
);

CREATE TABLE doc_deltaz (
    doc_id     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    delta      BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, seq),
    FOREIGN KEY (doc_id) REFERENCES docz (doc_id) ON DELETE CASCADE
);

-- friend groups: free-form named buckets used by the social UI.
-- `color` is a 0xRRGGBB integer.
CREATE TABLE friend_groupz (
    name       TEXT PRIMARY KEY NOT NULL,
    color      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- single-row key/value store for app-wide settings (profile_visibility,
-- friend_requests_from, hub_enabled mirror, etc.). values are TEXT — callers
-- coerce as needed.
CREATE TABLE settingz (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
