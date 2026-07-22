# skein/ workspace makefile

.DEFAULT_GOAL := help

.PHONY: help
help: ## show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[35m%-14s\033[0m %s\n", $$1, $$2}'

# absolute path to the sqlite dev db tumulus's sqlx `query!`/`query_as!`
# macros check queries against at compile time. `cargo tauri dev`/`cargo
# tauri build` run from tauri/ (tauri.conf.json's location) rather than this
# workspace root, so an override is needed for those targets specifically -
# `tumulus/build.rs` handles the general case (its own DATABASE_URL, resolved
# from CARGO_MANIFEST_DIR regardless of invocation cwd), but the tauri crate
# needs the same value for its own sqlx macros too.
DEV_DB := $(CURDIR)/tumulus/dev-data/skein-hub.db

.PHONY: dev-data db-migrate tauri-dev tauri-build hub-dev hub-friend-allow hub-admin-allow deps-local deps-npm

# (re)creates the sqlite dev db tumulus's sqlx macros need, by running a
# side-effect-free tumulus CLI subcommand (applies migrations, nothing else).
dev-data: ## (re)create the sqlx compile-time-check dev db
	cargo run -p tumulus -- --data-dir tumulus/dev-data friend list

# tumulus applies sqlx migrations (tumulus/migrationz/) automatically on
# every startup via sqlx::migrate! (see tumulus/src/db.rs), so "running
# migrations" = booting tumulus against the target data dir. this applies
# them to BOTH dev data dirs (sqlx compile-check db + the hub-dev hub's db)
# so a new migration lands everywhere without waiting for the next
# tauri-dev/hub-dev boot.
db-migrate: dev-data ## apply sqlx migrations to the dev dbs (dev-data + hub-dev-data)
	cargo run -p tumulus -- --data-dir tumulus/hub-dev-data friend list

tauri-dev: dev-data ## run the tauri desktop app in dev mode
	cd tauri && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri dev

tauri-build: dev-data ## build the tauri desktop app
	cd tauri && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri build

# runs a real tumulus hub against its OWN dev data dir/db, separate from
# the one `tauri-dev`/`dev-data` use — running both at once against the
# same dir would mean two independent processes sharing one iroh identity
# keypair and concurrently writing the same sqlite files (a real fight, not
# just a theoretical one). `tumulus` auto-creates a fresh data dir
# (identity + migrated dbs) on first run for any `--data-dir`, so no
# separate bootstrap target is needed here — `dev-data` is still a
# prerequisite purely because sqlx's compile-time `query!`/`query_as!`
# macros check queries against `DEV_DB` (`tumulus/dev-data/skein-hub.db`)
# regardless of which `--data-dir` the resulting binary is actually run
# against. port defaults to 0 (ephemeral) - the hub's node id (printed on
# startup) is what other peers dial, not a fixed port. RUST_LOG matches the
# level loam/tests/helpers/reliquary-hub.ts already uses for a real hub
# process.
hub-dev: dev-data ## run a real tumulus hub (own data dir, safe alongside tauri-dev)
	RUST_LOG=tumulus=debug cargo run -p tumulus -- --data-dir tumulus/hub-dev-data serve

# both target the dev hub's own data dir (tumulus/hub-dev-data, see
# hub-dev above) so they affect a hub already running via `make hub-dev`.
# NODE_ID=<hex> works for scripting; omit it and you'll get an interactive
# prompt instead.
hub-friend-allow: ## allow a peer as a friend on the dev hub (NODE_ID=<hex node id>, or prompts)
	@node_id="$(NODE_ID)"; \
	if [ -z "$$node_id" ]; then read -p "node id to allow as friend: " node_id; fi; \
	if [ -z "$$node_id" ]; then echo "no node id given, aborting"; exit 1; fi; \
	cargo run -p tumulus -- --data-dir tumulus/hub-dev-data friend allow "$$node_id"

hub-admin-allow: ## grant a peer hub-admin rights on the dev hub (NODE_ID=<hex node id>, or prompts)
	@node_id="$(NODE_ID)"; \
	if [ -z "$$node_id" ]; then read -p "node id to grant admin: " node_id; fi; \
	if [ -z "$$node_id" ]; then echo "no node id given, aborting"; exit 1; fi; \
	cargo run -p tumulus -- --data-dir tumulus/hub-dev-data admin allow "$$node_id"

# points loam's @freqhole/{haruspex,midden,reliquary} deps at the sibling
# repos on disk (file: links) and tumulus/tauri's cargo deps on haruspex +
# reliquary at local path deps on those same sibling repos, instead of
# published npm versions / the tagged tomb git dependency - for developing
# against unreleased changes in those repos.
deps-local: ## switch loam + cargo haruspex/reliquary deps to local sibling repos
	cd loam && npm run deps:local
	node scripts/toggle-cargo-deps.mjs local
	cargo check --workspace

# restores loam's @freqhole/{haruspex,midden,reliquary} deps to the
# published npm versions, and tumulus/tauri's cargo deps on haruspex +
# reliquary to the tagged git dependency on tomb - the default for ci and
# normal builds.
deps-npm: ## switch loam + cargo haruspex/reliquary deps to published npm/git-tag versions
	cd loam && npm run deps:npm
	node scripts/toggle-cargo-deps.mjs git
	cargo check --workspace
