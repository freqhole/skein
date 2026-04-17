# getting started with skein

skein is a peer-to-peer canvas prototype. there are three ways to run it
depending on how much of the stack you want:

| mode                      | binary                | runs what                                                  |
| ------------------------- | --------------------- | ---------------------------------------------------------- |
| **web only**              | `skein/skein/` (vite) | browser-only p2p — iroh-over-webtransport via `midden` wasm |
| **web + reliquary hub**   | `reliquary` + browser | long-lived headless hub peer + your browser tab            |
| **desktop (tauri)**       | `skein-tauri`         | tauri shell with reliquary running in-process              |

all three share:

- a single automerge sync ALPN (`iroh/automerge-repo/1`)
- the friendz protocol (`skein-friendz/1`)
- the skein blob-proxy protocol (`skein/1`)
- iroh-blobs verified transfer

---

## prerequisites

- rust (stable)
- node 20+ and npm
- for the web target: `wasm-pack` (https://rustwasm.github.io/wasm-pack/installer/)
- for tauri bundling: `cargo install tauri-cli --version ^2`

---

## 1. web-only mode

the skein browser app drives its own iroh endpoint via webtransport through
a compiled-to-wasm helper crate (`midden`). no reliquary required.

```sh
# build the midden wasm bundle (first time + whenever rust source changes)
cd skein/midden
wasm-pack build --target web --out-dir pkg --release
# drop the auto-generated .gitignore so we can commit pkg/
rm -f pkg/.gitignore

# run the dev server
cd ../skein
npm install
npm run dev
```

open `http://localhost:5173`. in devtools:

```js
await window.skein.identity.nodeId()   // hex node id
await window.skein.friends.list()      // [] on first run
```

peers are added by pasting invites (see below).

---

## 2. web + reliquary hub

running a reliquary peer alongside gives you a stable always-on node id,
durable blob storage, and lets you bridge canvases between browsers that
aren't both online at the same time.

```sh
cd skein
cargo build --release -p reliquary

# generate a keypair (idempotent — remembers its node id across restarts)
./target/release/reliquary --data-dir ~/.skein-hub init
./target/release/reliquary --data-dir ~/.skein-hub node-id
# -> prints the node id you'll paste into a browser invite

# run the hub (ctrl-c to stop; graceful shutdown on signal)
./target/release/reliquary --data-dir ~/.skein-hub serve
```

environment:

- `SKEIN_DATA_DIR` — overrides `--data-dir` (xdg-ish default otherwise)
- `SKEIN_USERNAME` — display name advertised in friendz profile responses
- `RUST_LOG=info` (or `debug`) — `tracing` filter

data layout under `<data_dir>`:

```
skein-hub.db        # sqlite: blobz, userz, friendz, docz
skein-docs.db       # sqlite: persisted automerge docs
iroh-blobs/         # iroh-blobs FsStore (outboard trees; data-by-reference)
blob-files/         # raw blob bytes laid out as <prefix>/<rest>
identity.secret     # iroh ed25519 secret key (chmod 600)
```

---

## 3. desktop (tauri)

the tauri app runs a full reliquary peer in-process and shares its iroh
endpoint with the webview. **not yet bundle-ready** — icons are placeholders
copied from tomb/charnel; frontend wiring (`beforeDevCommand`/`frontendDist`)
still needs a `npm run build:tauri` target in `skein/skein/`.

structural sanity-check of the rust side:

```sh
cd skein/tauri/src-tauri
cargo check
```

the IPC surface exposed to the webview (see
[tauri/src-tauri/src/commands.rs](../tauri/src-tauri/src/commands.rs)):

| command            | args                        | returns                    |
| ------------------ | --------------------------- | -------------------------- |
| `skein_node_id`    | —                           | `String`                   |
| `skein_status`     | —                           | `{ node_id, friend_count, uptime_s }` |
| `skein_friend_add` | `{ nodeId, status? }`       | `null`                     |
| `skein_friend_list`| —                           | `Friend[]`                 |
| `blob_list`        | `{ limit?, offset? }`       | `Blob[]`                   |

full `cargo tauri dev` workflow will arrive once real icons + the skein
vite-tauri build target land (phase-1 backlog item).

---

## invite format

a skein invite is just a node id (64-char blake3 hex). peers find each
other through iroh's n0 relay discovery — no explicit multiaddr gymnastics.

```json
{
  "nodeId": "35a4bdc6b533c24622546d39b0ea454a7071169365104b0e4a7690a71c47fb82",
  "username": "optional display name"
}
```

one peer adds the other via `skein_friend_add` (tauri/reliquary) or the
equivalent browser helper; the other side auto-accepts on first contact for
the phase-1 prototype. proper ACL and invite round-tripping come in phase-2.

---

## what's in phase-2

- canvas invite orchestration (ported from `hub/` + `canvas.rs`)
- blob snatcher (ported from `snatch.rs`)
- gossip digests for cross-canvas peer discovery
- tauri frontend wiring + real icons + bundler targets
- typed `skein-api-client` (zod schemas from rust types, like tomb's
  `client-codegen`)

see [PLAN.md](PLAN.md) for the full multi-phase roadmap.
