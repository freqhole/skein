-- add soft-delete support to blobz.
--
-- soft-deleted blobs are hidden from normal reads and listings but their
-- on-disk files are kept intact. the canvas-lifecycle cleanup path
-- (deleted canvas -> orphan blob sweep) marks orphaned blobs soft-deleted
-- rather than immediately unlinking them. an admin can hard-delete later
-- (which does unlink managed files) or restore them if the decision was
-- premature.
ALTER TABLE blobz ADD COLUMN soft_deleted_at INTEGER NULL;

-- who performed the soft delete, for the admin listing and for auditing
-- restores. either the hex node id of the admin peer that issued the
-- admin-channel command, or a system marker for automatic lifecycle
-- sweeps (e.g. "system:canvas-deleted", "system:hub-uninvited").
-- NULL when soft_deleted_at is NULL.
ALTER TABLE blobz ADD COLUMN soft_deleted_by TEXT NULL;
