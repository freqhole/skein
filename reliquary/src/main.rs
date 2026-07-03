//! reliquary hub peer cli entrypoint.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use iroh::SecretKey;
use reliquary::{adminz, db, friendz, identity, userz};

#[derive(Parser, Debug)]
#[command(name = "reliquary", version, about = "skein hub peer")]
struct Cli {
    /// data directory for keypair, sqlite db, and blob files
    #[arg(long, env = "SKEIN_DATA_DIR")]
    data_dir: Option<PathBuf>,

    /// iroh listen port (0 = ephemeral)
    #[arg(long, default_value_t = 0)]
    port: u16,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// generate a keypair (errors if one already exists) and print the node id
    Init,

    /// run the hub peer (default)
    Serve,

    /// print the persisted node id and exit
    NodeId,

    /// manage the friendz allow-list (operator-controlled access to the hub)
    #[command(subcommand)]
    Friend(FriendCommand),

    /// manage hub admins (node ids allowed to administer the friendz
    /// allow-list remotely, over the `iroh/skein-hub-admin/1` protocol)
    #[command(subcommand)]
    Admin(AdminCommand),

    /// review and clean up canvases the hub was removed from (soft-deleted
    /// — see `hub_repo::HubDocStorage`'s `removed_at` doc comment): list
    /// what's in the trash, restore something removed by mistake, or
    /// permanently purge a canvas's automerge doc + its own widget docs +
    /// any blobs no longer referenced by any other canvas the hub still
    /// holds. reads/writes the same `skein-docs.db` a running `reliquary
    /// serve` process uses (same file-sharing caveat as `friend`/`admin`
    /// above — a live process's in-memory state won't reflect a `restore`
    /// until it restarts or the canvas is re-invited).
    #[command(subcommand)]
    Maintenance(MaintenanceCommand),
}

#[derive(Subcommand, Debug)]
enum FriendCommand {
    /// pre-approve a peer so the hub auto-accepts an inbound friend-request from them
    Allow {
        /// the peer's iroh node id (hex public key)
        node_id: String,
    },
    /// list every peer the hub knows about, with status
    List,
    /// remove a peer from the friendz table entirely (revokes any prior approval)
    Remove {
        /// the peer's iroh node id (hex public key)
        node_id: String,
    },
}

#[derive(Subcommand, Debug)]
enum AdminCommand {
    /// grant a peer admin rights over this hub's friendz allow-list
    Allow {
        /// the peer's iroh node id (hex public key)
        node_id: String,
    },
    /// list every admin node id
    List,
    /// revoke a peer's admin rights
    Remove {
        /// the peer's iroh node id (hex public key)
        node_id: String,
    },
}

#[derive(Subcommand, Debug)]
enum MaintenanceCommand {
    /// list soft-deleted canvases, most-recently-removed first
    List {
        /// max rows to show
        #[arg(long, default_value_t = 20)]
        limit: i64,
        /// rows to skip (for paging through a long trash list)
        #[arg(long, default_value_t = 0)]
        offset: i64,
    },
    /// restore (undelete) a soft-deleted canvas
    Restore {
        /// the canvas's automerge document id
        canvas_doc_id: String,
    },
    /// permanently purge a soft-deleted canvas: its automerge doc, its own
    /// per-widget docs, and any blobs no longer referenced by any other
    /// canvas the hub still holds. irreversible — asks for confirmation
    /// unless `--yes` is passed.
    Purge {
        /// the canvas's automerge document id
        canvas_doc_id: String,
        /// skip the interactive confirmation prompt
        #[arg(long)]
        yes: bool,
    },
}

fn default_data_dir() -> PathBuf {
    dirs_data_local()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("skein-hub")
}

fn dirs_data_local() -> Option<PathBuf> {
    // minimal xdg_data_home / %LOCALAPPDATA% resolver; avoids a `dirs` dep.
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return Some(PathBuf::from(xdg));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return Some(PathBuf::from(home).join("Library/Application Support"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("LOCALAPPDATA") {
            return Some(PathBuf::from(appdata));
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return Some(PathBuf::from(home).join(".local/share"));
        }
    }
    None
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let data_dir = cli.data_dir.unwrap_or_else(default_data_dir);
    tokio::fs::create_dir_all(&data_dir).await?;

    match cli.command.unwrap_or(Command::Serve) {
        Command::Init => {
            let secret = identity::generate_keypair(&data_dir)?;
            let node_id = secret.public();
            println!("node_id = {node_id}");
            println!("data_dir = {}", data_dir.display());
            Ok(())
        }
        Command::NodeId => {
            let secret = identity::load_keypair(&data_dir)?;
            println!("{}", secret.public());
            eprintln!("data_dir = {}", data_dir.display());
            Ok(())
        }
        Command::Serve => serve(data_dir, cli.port).await,
        Command::Friend(cmd) => friend(data_dir, cmd).await,
        Command::Admin(cmd) => admin(data_dir, cmd).await,
        Command::Maintenance(cmd) => maintenance(data_dir, cmd).await,
    }
}

async fn serve(data_dir: PathBuf, port: u16) -> anyhow::Result<()> {
    let secret = load_or_generate(&data_dir)?;
    let node_id = secret.public();

    let pool = db::open(&data_dir).await?;

    tracing::info!(
        node_id = %node_id,
        port,
        data_dir = %data_dir.display(),
        "reliquary starting"
    );

    // build the iroh endpoint with n0 discovery + the persisted secret key
    let builder = iroh::Endpoint::builder(iroh::endpoint::presets::N0).secret_key(secret);
    let builder = if port != 0 {
        use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
        let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port));
        tracing::info!(port, "binding to specific UDP port");
        builder.bind_addr(addr)?
    } else {
        builder
    };
    let endpoint = builder.bind().await?;

    let config = reliquary::service::ServiceConfig {
        data_dir: data_dir.clone(),
        username: std::env::var("SKEIN_USERNAME").unwrap_or_else(|_| "reliquary".to_string()),
        bio: std::env::var("SKEIN_BIO").unwrap_or_default(),
        avatar_path: std::env::var("SKEIN_AVATAR_PATH").ok(),
    };

    let service = reliquary::service::start_hub(endpoint, pool, config).await?;

    let cancel = tokio_util::sync::CancellationToken::new();
    let ctrlc_cancel = cancel.clone();
    tokio::spawn(async move {
        if let Ok(()) = tokio::signal::ctrl_c().await {
            tracing::info!("ctrl-c received");
            ctrlc_cancel.cancel();
        }
    });

    service.run(cancel).await;
    Ok(())
}

async fn friend(data_dir: PathBuf, cmd: FriendCommand) -> anyhow::Result<()> {
    // print the resolved data_dir up front on every invocation — `--data-dir`
    // is a top-level flag that must be repeated on every separate CLI
    // invocation (it is NOT persisted/remembered anywhere), and a mismatch
    // between this and whatever data_dir a running `reliquary serve`/embedded
    // hub process actually uses means this command silently operates on a
    // *different* sqlite file — succeeding here with zero effect on the
    // actually-running hub. surfacing this plainly is cheap insurance
    // against exactly that class of "i ran friend allow but it's still
    // rejecting me" confusion.
    eprintln!("data_dir = {}", data_dir.display());
    let pool = db::open(&data_dir).await?;
    let users = userz::Directory::new(pool.clone());
    let store = friendz::Store::new(pool);

    match cmd {
        FriendCommand::Allow { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                anyhow::bail!("node_id cannot be empty");
            }
            // promote-or-leave: never demote an already-Accepted friend back to Allowed.
            let existing = store.get(node_id).await?;
            if matches!(
                existing.as_ref().map(|f| f.status),
                Some(friendz::FriendStatus::Accepted)
            ) {
                println!("{node_id} is already an accepted friend; leaving as-is");
                return Ok(());
            }
            // ensure a userz row exists so the FK on friendz.friend_node_id holds.
            users.touch(node_id).await?;
            let friend = store
                .upsert(node_id, friendz::FriendStatus::Allowed, None)
                .await?;
            println!(
                "allowed {} (status = {})",
                friend.friend_node_id,
                friend.status.as_str()
            );
        }
        FriendCommand::List => {
            let friends = store.list(false).await?;
            if friends.is_empty() {
                println!("(no friendz rows)");
                return Ok(());
            }
            println!("{:<64}  {:<10}  updated_at", "node_id", "status");
            for f in friends {
                println!(
                    "{:<64}  {:<10}  {}",
                    f.friend_node_id,
                    f.status.as_str(),
                    f.updated_at
                );
            }
        }
        FriendCommand::Remove { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                anyhow::bail!("node_id cannot be empty");
            }
            store.delete(node_id).await?;
            println!("removed {node_id}");
            // note: this only updates the friendz table in the sqlite
            // database. if a `reliquary serve` process is currently running
            // against this same data_dir and has an already-accepted
            // connection from this peer, that connection is NOT torn down
            // by this command: the cli and a running server are always
            // separate os processes that share the sqlite file but nothing
            // in-memory, so there's no `hub_repo::HubRepo` handle here to
            // call `cancel_peer` on. removal still takes effect immediately
            // for that peer's *next* new connection attempt (rejected by
            // `is_friend()` in `sync::IrohRepo::accept`). the live,
            // in-process revocation path is `protocol::hub_admin`'s remote
            // `Remove` handler, which runs inside the same process as the
            // hub's `HubRepo` and can cancel an active connection directly.
        }
    }

    Ok(())
}

async fn admin(data_dir: PathBuf, cmd: AdminCommand) -> anyhow::Result<()> {
    // see the matching comment in `friend()` above — same reasoning.
    eprintln!("data_dir = {}", data_dir.display());
    let pool = db::open(&data_dir).await?;
    let store = adminz::Store::new(pool);

    match cmd {
        AdminCommand::Allow { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                anyhow::bail!("node_id cannot be empty");
            }
            let admin = store.allow(node_id).await?;
            println!("granted admin rights to {}", admin.node_id);
        }
        AdminCommand::List => {
            let admins = store.list().await?;
            if admins.is_empty() {
                println!("(no hub admins)");
                return Ok(());
            }
            println!("{:<64}  created_at", "node_id");
            for a in admins {
                println!("{:<64}  {}", a.node_id, a.created_at);
            }
        }
        AdminCommand::Remove { node_id } => {
            let node_id = node_id.trim();
            if node_id.is_empty() {
                anyhow::bail!("node_id cannot be empty");
            }
            store.remove(node_id).await?;
            println!("revoked admin rights from {node_id}");
        }
    }

    Ok(())
}

async fn maintenance(data_dir: PathBuf, cmd: MaintenanceCommand) -> anyhow::Result<()> {
    // see the matching comment in `friend()` above — same reasoning: a
    // `restore` here won't take live effect in an already-running
    // `reliquary serve` process against this same data_dir until it
    // restarts or the canvas is re-invited (see
    // `hub_repo::HubDocStorage::restore_canvas_id`'s doc comment).
    eprintln!("data_dir = {}", data_dir.display());

    let docs_db_path = data_dir.join("skein-docs.db");
    let storage = reliquary::hub_repo::HubDocStorage::new(&docs_db_path).await?;
    let pool = db::open(&data_dir).await?;
    let blobz_store = reliquary::blobz::Store::new(pool, &data_dir);

    match cmd {
        MaintenanceCommand::List { limit, offset } => {
            let removed = reliquary::maintenance::list_removed(&storage, limit, offset).await;
            if removed.is_empty() {
                println!("(no soft-deleted canvases)");
                return Ok(());
            }
            println!(
                "{:<64}  {:<10}  removed_at",
                "canvas_doc_id (title)", "added_at"
            );
            for c in removed {
                let label = if c.title.is_empty() {
                    c.canvas_doc_id.clone()
                } else {
                    format!("{} ({})", c.canvas_doc_id, c.title)
                };
                println!("{:<64}  {:<10}  {}", label, c.added_at, c.removed_at);
            }
        }
        MaintenanceCommand::Restore { canvas_doc_id } => {
            let canvas_doc_id = canvas_doc_id.trim();
            if canvas_doc_id.is_empty() {
                anyhow::bail!("canvas_doc_id cannot be empty");
            }
            if reliquary::maintenance::restore(&storage, canvas_doc_id).await {
                println!("restored {canvas_doc_id}");
            } else {
                println!("{canvas_doc_id} was not soft-deleted — nothing to restore");
            }
        }
        MaintenanceCommand::Purge { canvas_doc_id, yes } => {
            let canvas_doc_id = canvas_doc_id.trim();
            if canvas_doc_id.is_empty() {
                anyhow::bail!("canvas_doc_id cannot be empty");
            }
            if !yes {
                print!(
                    "this will permanently delete canvas {canvas_doc_id} and any blobs it \
                     alone references. this cannot be undone. type \"yes\" to continue: "
                );
                use std::io::Write;
                std::io::stdout().flush().ok();
                let mut input = String::new();
                std::io::stdin().read_line(&mut input)?;
                if input.trim() != "yes" {
                    println!("aborted — nothing was deleted");
                    return Ok(());
                }
            }
            match reliquary::maintenance::purge(&storage, &blobz_store, canvas_doc_id).await {
                Ok(report) => {
                    println!("purged canvas {canvas_doc_id}");
                    println!(
                        "  widget docs deleted: {}",
                        report.widget_docs_deleted.len()
                    );
                    println!("  blobs deleted: {}", report.blobs_deleted.len());
                    if !report.blobs_kept_still_referenced.is_empty() {
                        println!(
                            "  blobs kept (still referenced elsewhere): {}",
                            report.blobs_kept_still_referenced.len()
                        );
                    }
                }
                Err(e) => anyhow::bail!("{e}"),
            }
        }
    }

    Ok(())
}

fn load_or_generate(data_dir: &std::path::Path) -> anyhow::Result<SecretKey> {
    match identity::load_keypair(data_dir) {
        Ok(secret) => Ok(secret),
        Err(identity::IdentityError::NotFound { .. }) => {
            tracing::info!("no keypair found; generating a new one");
            Ok(identity::generate_keypair(data_dir)?)
        }
        Err(e) => Err(e.into()),
    }
}
