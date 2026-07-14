-- friend-relationship state (status, direction, alias, group_name) and peer
-- directory data (display name, bio, avatar, accent color) now live
-- entirely in haruspex's own sqlite db - a sibling file under the same data
-- directory, owned by haruspex's `FriendStore`/`PeerDirectory`. this crate's
-- own `friendz`/`userz` tables no longer have any reader or writer; drop
-- them. `friendz` first, since it holds a foreign key into `userz`.
DROP TABLE friendz;
DROP TABLE userz;
