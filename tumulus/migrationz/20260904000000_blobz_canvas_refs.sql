-- blobz_canvas_refs: tracks which canvas documents currently have a widget
-- referencing a given blob, so a widget-delete cleanup can tell whether
-- purging a blob's local bytes would break another widget still using it,
-- without iterating every canvas. purely a reference index - never the
-- source of truth for "does this blob exist" (that's still the blobz
-- table). mirrors freqhole_reliquary's own bundled 0002_blobz_canvas_refs.sql
-- migration - skein maintains its own copy of the blobz-adjacent schema
-- (see the init migration's own blobz table) rather than pulling reliquary's
-- migrations in directly, so this table needs its own migration here too.
CREATE TABLE blobz_canvas_refs (
    blake3        TEXT NOT NULL,
    canvas_doc_id TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (blake3, canvas_doc_id)
);

CREATE INDEX blobz_canvas_refs_canvas_idx ON blobz_canvas_refs (canvas_doc_id);
