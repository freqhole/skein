# skein/ workspace makefile

.DEFAULT_GOAL := help

.PHONY: help
help: ## show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[35m%-14s\033[0m %s\n", $$1, $$2}'

# absolute path to the sqlite dev db reliquary's sqlx `query!`/`query_as!`
# macros check queries against at compile time. `.cargo/config.toml` sets
# DATABASE_URL to a *relative* path ("sqlite:reliquary/dev-data/skein-hub.db"),
# which only resolves correctly when cargo is invoked with the workspace root
# (this directory) as cwd. `cargo tauri dev`/`cargo tauri build` run from
# tauri/ (tauri.conf.json's location), so the relative path breaks there
# ("unable to open database file") - override it with an absolute path for
# those targets instead of touching the checked-in-locally .cargo/config.toml.
DEV_DB := $(CURDIR)/reliquary/dev-data/skein-hub.db

.PHONY: dev-data tauri-dev tauri-build hub-dev hub-friend-allow hub-admin-allow

# (re)creates the sqlite dev db reliquary's sqlx macros need, by running a
# side-effect-free reliquary CLI subcommand (applies migrations, nothing else).
dev-data: ## (re)create the sqlx compile-time-check dev db
	cargo run -p reliquary -- --data-dir reliquary/dev-data friend list

tauri-dev: dev-data ## run the tauri desktop app in dev mode
	cd tauri && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri dev

tauri-build: dev-data ## build the tauri desktop app
	cd tauri && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri build

# runs a real reliquary hub against its OWN dev data dir/db, separate from
# the one `tauri-dev`/`dev-data` use — running both at once against the
# same dir would mean two independent processes sharing one iroh identity
# keypair and concurrently writing the same sqlite files (a real fight, not
# just a theoretical one). `reliquary` auto-creates a fresh data dir
# (identity + migrated dbs) on first run for any `--data-dir`, so no
# separate bootstrap target is needed here — `dev-data` is still a
# prerequisite purely because sqlx's compile-time `query!`/`query_as!`
# macros check queries against `DEV_DB` (`reliquary/dev-data/skein-hub.db`,
# via `.cargo/config.toml`) regardless of which `--data-dir` the resulting
# binary is actually run against. port defaults to 0 (ephemeral) - the
# hub's node id (printed on startup) is what other peers dial, not a fixed
# port. RUST_LOG matches the level loam/tests/helpers/reliquary-hub.ts
# already uses for a real hub process.
hub-dev: dev-data ## run a real reliquary hub (own data dir, safe alongside tauri-dev)
	RUST_LOG=reliquary=debug cargo run -p reliquary -- --data-dir reliquary/hub-dev-data serve

# both target the dev hub's own data dir (reliquary/hub-dev-data, see
# hub-dev above) so they affect a hub already running via `make hub-dev`.
# NODE_ID=<hex> works for scripting; omit it and you'll get an interactive
# prompt instead.
hub-friend-allow: ## allow a peer as a friend on the dev hub (NODE_ID=<hex node id>, or prompts)
	@node_id="$(NODE_ID)"; \
	if [ -z "$$node_id" ]; then read -p "node id to allow as friend: " node_id; fi; \
	if [ -z "$$node_id" ]; then echo "no node id given, aborting"; exit 1; fi; \
	cargo run -p reliquary -- --data-dir reliquary/hub-dev-data friend allow "$$node_id"

hub-admin-allow: ## grant a peer hub-admin rights on the dev hub (NODE_ID=<hex node id>, or prompts)
	@node_id="$(NODE_ID)"; \
	if [ -z "$$node_id" ]; then read -p "node id to grant admin: " node_id; fi; \
	if [ -z "$$node_id" ]; then echo "no node id given, aborting"; exit 1; fi; \
	cargo run -p reliquary -- --data-dir reliquary/hub-dev-data admin allow "$$node_id"
