# skein tauri app

desktop shell for the skein p2p canvas prototype. wraps the web frontend
(`skein/loam/`) and runs an in-process `reliquary::service::Service` sharing
a single `iroh::Endpoint` between the optional hub and the normal
browser-like p2p code paths.

## layout

```
tauri/
├── Cargo.toml         # rust crate (tauri backend)
├── build.rs
├── tauri.conf.json
├── capabilities/
├── icons/
├── gen/
└── src/
    ├── lib.rs
    ├── main.rs
    └── commands.rs    # ipc: skein_dispatch (single entry point)
```

## building

icons are placeholder 1x1 PNGs; swap in real ones before shipping. the
frontend bundle is wired through `loam`:

- `beforeDevCommand` runs `npm --prefix ../loam run dev:tauri`
- `beforeBuildCommand` runs `npm --prefix ../loam run build:tauri`
- `frontendDist` points at `../loam/dist`

```
cd skein/tauri
cargo build --no-default-features     # sanity-check the rust side
cargo tauri dev                       # full dev workflow (needs cargo-tauri)
```

`cargo tauri dev` requires the `tauri-cli`:

```
cargo install tauri-cli --version "^2.0"
```

## IPC surface

single command `skein_dispatch(action, payload)` — see
[src/commands.rs](src/commands.rs) for the action list (friend_*, blob_*,
hub_*, status, get_node_id).
