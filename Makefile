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

# ---------------------------------------------------------------------------
# release builds
#
# cross-platform tumulus cli binaries + skein tauri desktop/android apps, all
# versioned in lockstep off Cargo.toml's [workspace.package] version. builds
# run natively on each target platform's own runner (no docker) - unlike
# tomb, skein doesn't cross-compile linux builds from macOS, so there's no
# need for a container to pin an older glibc.
#
# run `make info` to see available commands, `make build-all` to build
# everything for the current platform.
# ---------------------------------------------------------------------------

VERSION := $(shell grep '^version = ' Cargo.toml | head -1 | cut -d '"' -f 2)
GIT_SHA := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DIR := build

MAC_ARM_TARGET := aarch64-apple-darwin
MAC_INTEL_TARGET := x86_64-apple-darwin
LINUX_TARGET := x86_64-unknown-linux-gnu
LINUX_ARM64_TARGET := aarch64-unknown-linux-gnu

TAURI_DIR := tauri

# android tauri build env (override via env or .env)
ANDROID_SDK_ROOT ?= $(HOME)/Library/Android/sdk
ANDROID_BUILD_TOOLS_VERSION ?= 34.0.0
ANDROID_KEYSTORE ?= $(HOME)/Documents/freqhole-cert/skein/skein-release-key.keystore
ANDROID_KEY_ALIAS ?= my-key-alias
ANDROID_APKSIGNER := $(ANDROID_SDK_ROOT)/build-tools/$(ANDROID_BUILD_TOOLS_VERSION)/apksigner
JAVA_HOME ?= /Applications/Android Studio.app/Contents/jbr/Contents/Home
export JAVA_HOME

.PHONY: build-all
build-all: ## build tumulus cli + tauri app for the current platform (mac arm64 assumed)
	$(MAKE) build-mac-arm
	$(MAKE) build-tauri-mac-arm
	@echo ""
	@echo "all targets built! artifacts in $(BUILD_DIR)/$(VERSION)/:"
	@find $(BUILD_DIR)/$(VERSION) -type f | sort | sed 's|^|  |'

# ---- tumulus cli binaries --------------------------------------------------

.PHONY: build-mac-arm build-mac-intel build-linux build-linux-arm64

build-mac-arm: ## build tumulus cli for macOS arm64 (signs if APPLE_SIGNING_IDENTITY set)
	@echo "building tumulus cli for macOS arm64..."
	cargo build --package tumulus --release --target $(MAC_ARM_TARGET)
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp target/$(MAC_ARM_TARGET)/release/tumulus $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-aarch64
	@echo "built: $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-aarch64"
	@if [ -n "$(APPLE_SIGNING_IDENTITY)" ]; then \
		echo "signing..."; \
		codesign --force --options runtime --sign "$(APPLE_SIGNING_IDENTITY)" $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-aarch64; \
		codesign --verify --verbose $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-aarch64; \
		echo "signed: $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-aarch64"; \
	else \
		echo "skipping signing (APPLE_SIGNING_IDENTITY not set)"; \
	fi

build-mac-intel: ## build tumulus cli for macOS x86_64 (signs if APPLE_SIGNING_IDENTITY set)
	@echo "building tumulus cli for macOS x86_64..."
	cargo build --package tumulus --release --target $(MAC_INTEL_TARGET)
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp target/$(MAC_INTEL_TARGET)/release/tumulus $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-x86_64
	@echo "built: $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-x86_64"
	@if [ -n "$(APPLE_SIGNING_IDENTITY)" ]; then \
		echo "signing..."; \
		codesign --force --options runtime --sign "$(APPLE_SIGNING_IDENTITY)" $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-x86_64; \
		codesign --verify --verbose $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-x86_64; \
		echo "signed: $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_darwin-x86_64"; \
	else \
		echo "skipping signing (APPLE_SIGNING_IDENTITY not set)"; \
	fi

build-linux: ## build tumulus cli for linux x86_64 (native, no docker)
	@echo "building tumulus cli for linux x86_64..."
	cargo build --package tumulus --release --target $(LINUX_TARGET)
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp target/$(LINUX_TARGET)/release/tumulus $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_linux-x86_64
	@echo "built: $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_linux-x86_64"

build-linux-arm64: ## build tumulus cli for linux aarch64 (native, no docker - run on an arm64 runner)
	@echo "building tumulus cli for linux aarch64..."
	cargo build --package tumulus --release --target $(LINUX_ARM64_TARGET)
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp target/$(LINUX_ARM64_TARGET)/release/tumulus $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_linux-aarch64
	@echo "built: $(BUILD_DIR)/$(VERSION)/tumulus_$(VERSION)_linux-aarch64"

# ---- skein tauri desktop/android apps --------------------------------------

.PHONY: build-tauri-mac-arm build-tauri-mac-intel build-tauri-linux-intel build-tauri-linux-arm64 build-tauri-android build-tauri-android-arm64

build-tauri-mac-arm: dev-data ## build the tauri desktop app for macOS arm64 (.dmg, signs if APPLE_SIGNING_IDENTITY set)
	@echo "building tauri app for macOS arm64..."
	@if [ -n "$(APPLE_SIGNING_IDENTITY)" ]; then \
		echo "  signing enabled (APPLE_SIGNING_IDENTITY set)"; \
		cd $(TAURI_DIR) && DATABASE_URL=sqlite:$(DEV_DB) APPLE_SIGNING_IDENTITY="$(APPLE_SIGNING_IDENTITY)" cargo tauri build --target $(MAC_ARM_TARGET); \
	else \
		echo "  no signing identity - ad-hoc signing (runs locally; not distributable or notarizable)"; \
		cd $(TAURI_DIR) && DATABASE_URL=sqlite:$(DEV_DB) APPLE_SIGNING_IDENTITY=- cargo tauri build --target $(MAC_ARM_TARGET); \
	fi
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp $(TAURI_DIR)/target/$(MAC_ARM_TARGET)/release/bundle/dmg/*.dmg $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.dmg
	@echo "built: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.dmg"
	@if [ -n "$(APPLE_SIGNING_IDENTITY)" ] && [ -n "$(APPLE_ID)" ] && [ -n "$(APPLE_PASSWORD)" ] && [ -n "$(APPLE_TEAM_ID)" ]; then \
		echo "notarizing dmg (this may take a few minutes)..."; \
		xcrun notarytool submit $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.dmg \
			--apple-id "$(APPLE_ID)" --password "$(APPLE_PASSWORD)" --team-id "$(APPLE_TEAM_ID)" --wait; \
		xcrun stapler staple $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.dmg; \
		echo "notarized + stapled: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.dmg"; \
	fi

build-tauri-mac-intel: dev-data ## build the tauri desktop app for macOS x86_64 (.dmg, signs if APPLE_SIGNING_IDENTITY set)
	@echo "building tauri app for macOS x86_64..."
	@if [ -n "$(APPLE_SIGNING_IDENTITY)" ]; then \
		echo "  signing enabled (APPLE_SIGNING_IDENTITY set)"; \
		cd $(TAURI_DIR) && DATABASE_URL=sqlite:$(DEV_DB) APPLE_SIGNING_IDENTITY="$(APPLE_SIGNING_IDENTITY)" cargo tauri build --target $(MAC_INTEL_TARGET); \
	else \
		echo "  no signing identity - ad-hoc signing (runs locally; not distributable or notarizable)"; \
		cd $(TAURI_DIR) && DATABASE_URL=sqlite:$(DEV_DB) APPLE_SIGNING_IDENTITY=- cargo tauri build --target $(MAC_INTEL_TARGET); \
	fi
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp $(TAURI_DIR)/target/$(MAC_INTEL_TARGET)/release/bundle/dmg/*.dmg $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.dmg
	@echo "built: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.dmg"
	@if [ -n "$(APPLE_SIGNING_IDENTITY)" ] && [ -n "$(APPLE_ID)" ] && [ -n "$(APPLE_PASSWORD)" ] && [ -n "$(APPLE_TEAM_ID)" ]; then \
		echo "notarizing dmg (this may take a few minutes)..."; \
		xcrun notarytool submit $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.dmg \
			--apple-id "$(APPLE_ID)" --password "$(APPLE_PASSWORD)" --team-id "$(APPLE_TEAM_ID)" --wait; \
		xcrun stapler staple $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.dmg; \
		echo "notarized + stapled: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.dmg"; \
	fi

build-tauri-linux-intel: dev-data ## build the tauri desktop app for linux x86_64 (.deb/.rpm, native, no docker)
	@echo "building tauri app for linux x86_64..."
	cd $(TAURI_DIR) && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri build --target $(LINUX_TARGET)
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp $(TAURI_DIR)/target/$(LINUX_TARGET)/release/bundle/deb/*.deb $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.deb
	cp $(TAURI_DIR)/target/$(LINUX_TARGET)/release/bundle/rpm/*.rpm $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.rpm
	@echo "built: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.deb"
	@echo "built: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_x86_64.rpm"

build-tauri-linux-arm64: dev-data ## build the tauri desktop app for linux aarch64 (.deb/.rpm, native - run on an arm64 runner)
	@echo "building tauri app for linux aarch64..."
	cd $(TAURI_DIR) && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri build --target $(LINUX_ARM64_TARGET)
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp $(TAURI_DIR)/target/$(LINUX_ARM64_TARGET)/release/bundle/deb/*.deb $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.deb
	cp $(TAURI_DIR)/target/$(LINUX_ARM64_TARGET)/release/bundle/rpm/*.rpm $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.rpm
	@echo "built: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.deb"
	@echo "built: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_aarch64.rpm"

# android apk (release, signed with apksigner). requires ANDROID_SDK_ROOT,
# ANDROID_KEYSTORE (optionally ANDROID_BUILD_TOOLS_VERSION, ANDROID_KEY_ALIAS,
# ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_PASSWORD). arch selection mirrors
# tomb's charnel: universal drops 32-bit arm (armv7, dead since play store
# dropped support in 2019); arm64-only is for real-device distribution at
# roughly 1/3 the universal apk's size.
build-tauri-android: dev-data ## build the android app (universal apk, no 32-bit arm, signed)
	@echo "building tauri app for android (universal apk, no 32-bit arm)..."
	@if [ ! -d "$(ANDROID_SDK_ROOT)" ]; then \
		echo "error: ANDROID_SDK_ROOT not found at $(ANDROID_SDK_ROOT)"; \
		echo "set ANDROID_SDK_ROOT in .env or your environment"; exit 1; \
	fi
	@if [ ! -x "$(ANDROID_APKSIGNER)" ]; then \
		echo "error: apksigner not found at $(ANDROID_APKSIGNER)"; \
		echo "install android build-tools $(ANDROID_BUILD_TOOLS_VERSION) or set ANDROID_BUILD_TOOLS_VERSION"; exit 1; \
	fi
	@if [ ! -f "$(ANDROID_KEYSTORE)" ]; then \
		echo "error: keystore not found at $(ANDROID_KEYSTORE)"; \
		echo "set ANDROID_KEYSTORE in .env or your environment"; exit 1; \
	fi
	cd $(TAURI_DIR) && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri android build -- --apk --target aarch64 --target x86_64 --target i686
	@echo "signing apk with apksigner..."
	$(ANDROID_APKSIGNER) sign \
		--ks "$(ANDROID_KEYSTORE)" \
		--ks-key-alias "$(ANDROID_KEY_ALIAS)" \
		$(if $(ANDROID_KEYSTORE_PASSWORD),--ks-pass pass:$(ANDROID_KEYSTORE_PASSWORD)) \
		$(if $(ANDROID_KEY_PASSWORD),--key-pass pass:$(ANDROID_KEY_PASSWORD)) \
		$(TAURI_DIR)/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp $(TAURI_DIR)/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk \
		$(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_android-universal.apk
	@echo "built: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_android-universal.apk"

build-tauri-android-arm64: dev-data ## build the android app (arm64-only apk, signed, ~1/3 the universal apk's size)
	@echo "building tauri app for android (arm64-only apk)..."
	@if [ ! -d "$(ANDROID_SDK_ROOT)" ]; then \
		echo "error: ANDROID_SDK_ROOT not found at $(ANDROID_SDK_ROOT)"; \
		echo "set ANDROID_SDK_ROOT in .env or your environment"; exit 1; \
	fi
	@if [ ! -x "$(ANDROID_APKSIGNER)" ]; then \
		echo "error: apksigner not found at $(ANDROID_APKSIGNER)"; \
		echo "install android build-tools $(ANDROID_BUILD_TOOLS_VERSION) or set ANDROID_BUILD_TOOLS_VERSION"; exit 1; \
	fi
	@if [ ! -f "$(ANDROID_KEYSTORE)" ]; then \
		echo "error: keystore not found at $(ANDROID_KEYSTORE)"; \
		echo "set ANDROID_KEYSTORE in .env or your environment"; exit 1; \
	fi
	cd $(TAURI_DIR) && DATABASE_URL=sqlite:$(DEV_DB) cargo tauri android build -- --apk --target aarch64
	@echo "signing apk with apksigner..."
	$(ANDROID_APKSIGNER) sign \
		--ks "$(ANDROID_KEYSTORE)" \
		--ks-key-alias "$(ANDROID_KEY_ALIAS)" \
		$(if $(ANDROID_KEYSTORE_PASSWORD),--ks-pass pass:$(ANDROID_KEYSTORE_PASSWORD)) \
		$(if $(ANDROID_KEY_PASSWORD),--key-pass pass:$(ANDROID_KEY_PASSWORD)) \
		$(TAURI_DIR)/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
	@mkdir -p $(BUILD_DIR)/$(VERSION)
	cp $(TAURI_DIR)/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk \
		$(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_android-arm64.apk
	@echo "built: $(BUILD_DIR)/$(VERSION)/skein_$(VERSION)_android-arm64.apk"

.PHONY: clean-build
clean-build: ## remove build/ artifacts + tauri bundle output
	rm -rf $(BUILD_DIR)/
	rm -rf $(TAURI_DIR)/target/release/bundle

# ---- version management -----------------------------------------------------

# add a changeset describing your change (interactive). run this in a PR
# before merging to main; the changeset drives the version bump + changelog.
.PHONY: changes
changes: ## add a changeset for your PR (interactive)
	@if [ ! -d node_modules ]; then npm install; fi
	@npm run changeset

# portable across macos (BSD sed) and linux (GNU sed) via `sed -i.bak` + rm, so
# the same target runs locally and in ci (changesets opens the version PR on a
# linux runner). pass NEW_VERSION=x.y.z or run interactively.
.PHONY: bump-version
bump-version: ## bump all skein package versions in lockstep (NEW_VERSION=x.y.z, or prompts)
	@echo "current version: $(VERSION)"
	@if [ -z "$(NEW_VERSION)" ]; then \
		read -p "enter new version: " ver && \
		if [ -z "$$ver" ]; then \
			echo "error: version cannot be empty"; \
			exit 1; \
		fi && \
		$(MAKE) bump-version NEW_VERSION=$$ver; \
	else \
		echo "bumping version to $(NEW_VERSION)..."; \
		echo "  updating Cargo.toml (workspace.package version)..."; \
		sed -i.bak 's/^version = "[^"]*"/version = "$(NEW_VERSION)"/' Cargo.toml && rm -f Cargo.toml.bak; \
		echo "  updating tumulus/Cargo.toml..."; \
		sed -i.bak 's/^version = "[^"]*"/version = "$(NEW_VERSION)"/' tumulus/Cargo.toml && rm -f tumulus/Cargo.toml.bak; \
		echo "  updating tauri/Cargo.toml..."; \
		sed -i.bak 's/^version = "[^"]*"/version = "$(NEW_VERSION)"/' tauri/Cargo.toml && rm -f tauri/Cargo.toml.bak; \
		echo "  updating tauri/tauri.conf.json..."; \
		sed -i.bak 's/"version": "[^"]*"/"version": "$(NEW_VERSION)"/' tauri/tauri.conf.json && rm -f tauri/tauri.conf.json.bak; \
		echo "  updating loam/package.json..."; \
		node -e "const fs=require('fs'); const p='loam/package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.version='$(NEW_VERSION)'; fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');"; \
		echo ""; \
		echo "version bumped to $(NEW_VERSION)"; \
		echo ""; \
		echo "verify changes with: git diff"; \
	fi

.PHONY: info
info: ## show available release build commands
	@echo "skein release build"
	@echo "===================="
	@echo "version: $(VERSION)"
	@echo "output:  $(BUILD_DIR)/$(VERSION)/"
	@echo ""
	@echo "tumulus cli binaries:"
	@echo "  make build-mac-arm      - macOS arm64 (signs if APPLE_SIGNING_IDENTITY set)"
	@echo "  make build-mac-intel    - macOS x86_64 (signs if APPLE_SIGNING_IDENTITY set)"
	@echo "  make build-linux        - linux x86_64 (native, no docker)"
	@echo "  make build-linux-arm64  - linux aarch64 (native, no docker)"
	@echo ""
	@echo "tauri desktop/android apps:"
	@echo "  make build-tauri-mac-arm      - macOS arm64 .dmg (signs if APPLE_SIGNING_IDENTITY set)"
	@echo "  make build-tauri-mac-intel    - macOS x86_64 .dmg (signs if APPLE_SIGNING_IDENTITY set)"
	@echo "  make build-tauri-linux-intel  - linux x86_64 .deb/.rpm (native, no docker)"
	@echo "  make build-tauri-linux-arm64  - linux aarch64 .deb/.rpm (native, no docker)"
	@echo "  make build-tauri-android        - android universal .apk, no 32-bit arm (signed)"
	@echo "  make build-tauri-android-arm64  - android arm64-only .apk (signed, ~1/3 size of universal)"
	@echo ""
	@echo "code signing env vars (set in .env):"
	@echo "  APPLE_SIGNING_IDENTITY - signing identity (e.g. \"Developer ID Application: ...\")"
	@echo "  APPLE_ID               - apple id email (for notarization)"
	@echo "  APPLE_PASSWORD          - app-specific password (for notarization)"
	@echo "  APPLE_TEAM_ID           - team id (for notarization)"
	@echo ""
	@echo "android build env vars (set in .env):"
	@echo "  ANDROID_SDK_ROOT             - android sdk path (default: ~/Library/Android/sdk)"
	@echo "  ANDROID_BUILD_TOOLS_VERSION  - build-tools version (default: 37.0.0)"
	@echo "  ANDROID_KEYSTORE             - path to .keystore file"
	@echo "  ANDROID_KEY_ALIAS            - key alias (default: my-key-alias)"
	@echo "  ANDROID_KEYSTORE_PASSWORD    - keystore password (optional, prompts if unset)"
	@echo "  ANDROID_KEY_PASSWORD         - key password (optional, prompts if unset)"
	@echo ""
	@echo "build all (current platform):"
	@echo "  make build-all       - build tumulus cli + tauri app"
	@echo "  make clean-build     - remove build artifacts"
	@echo ""
	@echo "version:"
	@echo "  make changes                     - add a changeset for your PR (interactive)"
	@echo "  make bump-version NEW_VERSION=x.y.z"
