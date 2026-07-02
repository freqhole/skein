# skein/ workspace makefile

# absolute path to the sqlite dev db reliquary's sqlx `query!`/`query_as!`
# macros check queries against at compile time. `.cargo/config.toml` sets
# DATABASE_URL to a *relative* path ("sqlite:reliquary/dev-data/skein-hub.db"),
# which only resolves correctly when cargo is invoked with the workspace root
# (this directory) as cwd. `cargo tauri dev`/`cargo tauri build` run from
# tauri/ (tauri.conf.json's location), so the relative path breaks there
# ("unable to open database file") - override it with an absolute path for
# those targets instead of touching the checked-in-locally .cargo/config.toml.
DEV_DB := $(CURDIR)/reliquary/dev-data/skein-hub.db

.PHONY: dev-data tauri-dev tauri-build hub-dev

# (re)creates the sqlite dev db reliquary's sqlx macros need, by running a
# side-effect-free reliquary CLI subcommand (applies migrations, nothing else).
dev-data:
	cargo run -p reliquary -- --data-dir reliquary/dev-data friend list

tauri-dev: dev-data
	cd tauri && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri dev

tauri-build: dev-data
	cd tauri && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri build

# runs a real reliquary hub against the same dev-data dir/db the sqlx macros
# and `tauri-dev` use, so `reliquary admin allow`/`reliquary friend allow`
# invocations against that same --data-dir affect this running hub. port
# defaults to 0 (ephemeral) - the hub's node id (printed on startup) is what
# other peers dial, not a fixed port. RUST_LOG matches the level
# loam/tests/helpers/reliquary-hub.ts already uses for a real hub process.
hub-dev: dev-data
	RUST_LOG=reliquary=debug cargo run -p reliquary -- --data-dir reliquary/dev-data serve
