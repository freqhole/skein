-- indexes to support sorting the local-files list (filez tab 2) by size or
-- filename without a full table scan each time. mirrors freqhole_reliquary's
-- own bundled 0003_blobz_list_indexes.sql migration - same gap as
-- 20260904000000_blobz_canvas_refs.sql (see its own doc comment): skein
-- maintains its own copy of the blobz-adjacent schema rather than pulling
-- reliquary's migrations in directly.
CREATE INDEX blobz_size_idx ON blobz (size);
CREATE INDEX blobz_filename_idx ON blobz (filename);
