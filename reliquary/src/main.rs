//! reliquary hub peer cli entrypoint.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use iroh::SecretKey;
use reliquary::{db, identity};

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
    }
}

async fn serve(data_dir: PathBuf, port: u16) -> anyhow::Result<()> {
    let secret = load_or_generate(&data_dir)?;
    let node_id = secret.public();

    let pool = db::open(&data_dir).await?;

    // mark ourselves in userz so the hub has a known "self" row
    let userz = reliquary::userz::Directory::new(pool.clone());
    userz.upsert_self(&node_id.to_string(), None).await?;

    tracing::info!(
        node_id = %node_id,
        port,
        data_dir = %data_dir.display(),
        "reliquary starting"
    );

    // TODO(phase-1): construct iroh::Endpoint(secret, port) and spawn
    // HubPeerService once the handler modules have been ported off grimoire.
    // for now this subcommand just validates wiring and waits for ctrl-c.

    tokio::signal::ctrl_c().await?;
    tracing::info!("shutdown");
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
