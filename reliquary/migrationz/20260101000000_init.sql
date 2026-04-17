-- initial skein schema.
-- prototype: no migration history to preserve. drop and recreate freely.

-- blob store: generic file store keyed by blake3.
CREATE TABLE blobz (
    blake3      TEXT PRIMARY KEY NOT NULL,
    iroh_hash   TEXT NOT NULL,
    filename    TEXT,
    mime        TEXT,
    size        INTEGER NOT NULL,
    path        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX blobz_iroh_hash_idx ON blobz (iroh_hash);

-- user directory: peers we've seen (ours + remote friends).
CREATE TABLE userz (
    node_id       TEXT PRIMARY KEY NOT NULL,
    display_name  TEXT,
    avatar_blake3 TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    is_self       INTEGER NOT NULL DEFAULT 0
);

-- friend edges: accepted two-way friendships.
-- one row per friend (directed from self_node_id). status tracks invite state.
CREATE TABLE friendz (
    friend_node_id  TEXT PRIMARY KEY NOT NULL,
    status          TEXT NOT NULL,          -- 'pending' | 'accepted' | 'blocked'
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
