-- align blobz with freqhole-reliquary::blobz::SqliteBlobStore's schema ahead
-- of cutting the store implementation itself over (see
-- tomb/docs/xl-refactor/PHASE_2_RELIQUARY_RUST.md's "schema" section).
--
-- sha256/old_grimoire_id are migration-era lookup columns (never populated
-- by this hub itself); blob_type/parent_blake3/width/height/metadata carry
-- the derived-blob relation (thumbnail/waveform/preview rows pointing back
-- at their original). iroh_hash stays NOT NULL here (unlike the new crate's
-- own schema) since every insert path in this table always sets it to the
-- blake3 value - no migrated-with-a-null-hash rows exist in this database.
ALTER TABLE blobz ADD COLUMN sha256 TEXT NULL;
ALTER TABLE blobz ADD COLUMN old_grimoire_id TEXT NULL;
ALTER TABLE blobz ADD COLUMN blob_type TEXT NOT NULL DEFAULT 'original';
ALTER TABLE blobz ADD COLUMN parent_blake3 TEXT NULL;
ALTER TABLE blobz ADD COLUMN width INTEGER NULL;
ALTER TABLE blobz ADD COLUMN height INTEGER NULL;
ALTER TABLE blobz ADD COLUMN metadata TEXT NULL;

CREATE INDEX blobz_sha256_idx ON blobz (sha256);
CREATE UNIQUE INDEX blobz_old_id_idx ON blobz (old_grimoire_id) WHERE old_grimoire_id IS NOT NULL;
CREATE INDEX blobz_parent_idx ON blobz (parent_blake3);
