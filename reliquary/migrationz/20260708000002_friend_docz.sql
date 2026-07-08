-- friend_docz: per-friend narthex canvas doc id (which canvas a friend
-- shares with us). friend-relationship state itself (status, direction,
-- alias, group_name) lives entirely in haruspex's own sqlite db, a sibling
-- file next to this one under the same data directory - the narthex doc id
-- is an app-specific concept with no equivalent field on haruspex's
-- friend-edge shape, so it gets its own small table here instead, keyed by
-- node id with no foreign key (the friend row it corresponds to lives in a
-- different database file entirely).
CREATE TABLE friend_docz (
  node_id TEXT PRIMARY KEY,
  narthex_doc_id TEXT NOT NULL
);

-- backfill from this database's own (pre-existing) friendz table, which
-- still carries the original narthex_doc_id column at this point in the
-- migration history.
INSERT INTO friend_docz (node_id, narthex_doc_id)
SELECT friend_node_id, narthex_doc_id
FROM friendz
WHERE narthex_doc_id IS NOT NULL;
