-- generic single-device key-value store, mirroring the browser's
-- "skein-meta" indexeddb kv object store (see loam/src/storage/meta-db.ts).
-- used for small persisted values that are genuinely never synced to any
-- peer (doc-id pointers, anon device id, etc.) — no reason for a bespoke
-- table per value when a plain key/value pair is all any of them need.
CREATE TABLE meta_kv (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
