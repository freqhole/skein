//! skein tauri backend — wraps `reliquary::service::Service` and exposes
//! it to the webview via tauri IPC commands.

mod commands;

use std::path::PathBuf;
use std::time::Instant;

use reliquary::{db, identity, service};
use tauri::Listener;
use tokio_util::sync::CancellationToken;

use commands::AppState;

const APP_IDENTIFIER: &str = "net.freqhole.skein";

fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library/Application Support")
                .join(APP_IDENTIFIER);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(xdg).join(APP_IDENTIFIER);
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local/share").join(APP_IDENTIFIER);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join(APP_IDENTIFIER);
        }
    }
    PathBuf::from("./skein-data")
}

/// start the reliquary service and return its handle plus a join handle
/// for the run loop.
async fn start_service() -> anyhow::Result<(
    service::ServiceHandle,
    CancellationToken,
    tokio::task::JoinHandle<()>,
)> {
    let data_dir = std::env::var("SKEIN_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_data_dir());
    tokio::fs::create_dir_all(&data_dir).await?;

    let secret = match identity::load_keypair(&data_dir) {
        Ok(s) => s,
        Err(identity::IdentityError::NotFound { .. }) => {
            tracing::info!("no keypair found; generating a new one");
            identity::generate_keypair(&data_dir)?
        }
        Err(e) => return Err(e.into()),
    };

    let pool = db::open(&data_dir).await?;

    let builder = iroh::Endpoint::builder(iroh::endpoint::presets::N0).secret_key(secret);
    let endpoint = builder.bind().await?;

    let username = std::env::var("SKEIN_USERNAME").unwrap_or_else(|_| "skein".to_string());
    let svc = service::Service::start(
        endpoint,
        pool,
        service::ServiceConfig {
            data_dir,
            username,
            bio: String::new(),
            avatar_path: None,
        },
    )
    .await?;
    let handle = svc.handle();

    let cancel = CancellationToken::new();
    let run_cancel = cancel.clone();
    let join = tokio::spawn(async move {
        svc.run(run_cancel).await;
    });

    Ok((handle, cancel, join))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let runtime = tokio::runtime::Runtime::new().expect("build tokio runtime");
    let (service_handle, cancel, _run_handle) = runtime
        .block_on(start_service())
        .expect("start reliquary service");

    let app_state = AppState {
        service: service_handle,
        started_at: Instant::now(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(app_state)
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![
            commands::skein_dispatch,
        ])
        .setup(move |app| {
            let cancel = cancel.clone();
            app.listen_any("tauri://close-requested", move |_| {
                cancel.cancel();
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
