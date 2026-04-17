# skein tauri app

desktop shell for the skein p2p canvas prototype. wraps the web frontend
(`skein/skein/`) and runs an in-process `reliquary::service::Service`
sharing a single `iroh::Endpoint` between the optional hub and the normal
browser-like p2p code paths.

## layout

```
tauri/
├── Cargo.toml            # rust workspace member (tauri backend only)
├── src-tauri/            # standard tauri scaffolding
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/
│   ├── icons/
│   └── src/
│       ├── lib.rs
│       ├── main.rs
│       └── commands.rs   # ipc: skein_* + blob_* + hub_*
└── README.md
```

## building

icons are placeholder 1x1 PNGs; swap in real ones before shipping. the
frontend bundle is not yet wired (`frontendDist` points at `dist/`, expected
to be populated by `cd ../skein && npm run build:tauri`).

```
cd skein/tauri/src-tauri
cargo build --no-default-features     # sanity-check the rust side
```

full tauri workflow (`cargo tauri dev` etc.) needs the `tauri` CLI plus
matching icons. phase-1 deliverable here is the structural scaffolding +
compile-clean backend crate. see [docs/getting-started.md](../docs/getting-started.md).

## IPC surface (phase-1)

| command            | args                            | returns                              |
| ------------------ | ------------------------------- | ------------------------------------ |
| `skein_node_id`    | —                               | `String` (iroh node id hex)          |
| `skein_status`     | —                               | `{ node_id, friend_count, uptime_s }` |
| `skein_friend_add` | `{ node_id, status? }`          | `()` (upserts with status=accepted)  |
| `skein_friend_list`| —                               | `Vec<Friend>`                         |
| `blob_list`        | `{ limit?, offset? }`           | `Vec<BlobRef>`                        |

p2p message sending, canvas invites, and gossip are phase-2.
