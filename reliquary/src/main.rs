//! reliquary hub peer cli entrypoint.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use iroh::SecretKey;
use reliquary::{db, friendz, identity, userz};

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
            Ok(())
        }
        Command::Serve => serve(data_dir, cli.port).await,
        Command::Friend(cmd) => friend(data_dir, cmd).await,
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
            println!("allowed {} (status = {})", friend.friend_node_id, friend.status.as_str());
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
