//! skein tauri backend.
//!
//! boots the always-on parts (`SqlitePool`, stores) and exposes a single
//! `skein_dispatch` tauri command. the iroh endpoint is NOT always-on: it's
//! bound eagerly at boot only for a returning user who already has a
//! keypair on disk, and otherwise deferred until the frontend actually
//! needs P2P (see `commands::ensure_network`) — never generated just
//! because the process started. the hub peer can be started / stopped at
//! runtime via `hub_start` / `hub_stop` IPC actions once the endpoint
//! exists.

mod commands;
mod pdf;
mod streams;
mod thumbnail;
mod unfurl;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use reliquary::{blobz, db, friendz, identity, userz};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Listener;
use tauri::Manager;
use tauri::WindowEvent;
use tokio::sync::Mutex;

use commands::{AppConfig, AppState};

const APP_IDENTIFIER: &str = "net.freqhole.skein";
const APP_CONFIG_FILENAME: &str = "skein-app.toml";

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

/// build the always-on `AppState`: endpoint, pool, stores, and an empty hub
/// slot. the hub is started later if the persisted app config says so.
///
/// the iroh endpoint is NOT created here unconditionally -- that would
/// generate a brand-new P2P identity the very first time the app is ever
/// launched, before the user has done anything at all. instead: if a
/// keypair already exists on disk (a returning user, who already
/// consented to P2P in an earlier session), the endpoint is bound eagerly
/// below, same as before. if no keypair exists yet, `network` is left
/// `None` and stays that way until the frontend actually needs it --
/// [`commands::ensure_network`] lazily builds it (generating a keypair for
/// the first time, if needed) the moment the user shares/joins a canvas,
/// starts the hub, fetches a blob from a peer, or clicks "generate
/// identity" in the profile widget.
async fn build_state() -> anyhow::Result<AppState> {
    let data_dir = std::env::var("SKEIN_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_data_dir());
    tokio::fs::create_dir_all(&data_dir).await?;

    let pool = db::open(&data_dir).await?;
    let username = std::env::var("SKEIN_USERNAME").unwrap_or_else(|_| "skein".to_string());
    let blobz_store = blobz::Store::new(pool.clone(), &data_dir);
    let friendz_store = friendz::Store::new(pool.clone());
    let userz_dir = userz::Directory::new(pool.clone());
    let app_config_path = data_dir.join(APP_CONFIG_FILENAME);

    // boot the iroh-blobs FsStore that backs verified blob streaming. peers
    // (browser midden) hit us on `iroh-blobs/4` and pull bytes directly out
    // of this store; the `blob_iroh_ensure` dispatch action pre-loads the
    // requested blob from `blobz` so the FsStore has the bytes when the
    // peer asks for them. leaked to satisfy `BlobsProtocol`'s `&'static`
    // requirement -- there's only ever one of these per process. this is
    // independent of the iroh endpoint/identity, so it's always built.
    let fs_store_dir = data_dir.join("iroh-blobs");
    tokio::fs::create_dir_all(&fs_store_dir).await?;

    // in-flight download set: hashes currently being fetched by
    // blob_iroh_download. shared between AppState (for command access) and
    // the gc protect callback below, so the gc never sweeps a blob that is
    // mid-download.
    let blobs_in_flight: Arc<std::sync::Mutex<std::collections::HashSet<iroh_blobs::Hash>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

    // gc-protected hash cache: refreshed every 10 min by a background task.
    // None = never refreshed → abort gc cycle to avoid sweeping blind.
    let protected: Arc<std::sync::RwLock<Option<std::collections::HashSet<iroh_blobs::Hash>>>> =
        Arc::new(std::sync::RwLock::new(None));
    {
        let protected_bg = Arc::clone(&protected);
        let blobz_bg = blobz_store.clone();
        tokio::spawn(async move {
            loop {
                match blobz_bg.list_all_iroh_hashes().await {
                    Ok(hex_hashes) => {
                        let mut set = std::collections::HashSet::new();
                        for hex in &hex_hashes {
                            if let Ok(h) = hex.parse::<iroh_blobs::Hash>() {
                                set.insert(h);
                            }
                        }
                        if let Ok(mut guard) = protected_bg.write() {
                            *guard = Some(set);
                        }
                        tracing::debug!(
                            count = hex_hashes.len(),
                            "gc protect: refreshed protected hashes from blobz"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "gc protect: failed to refresh protected hashes from blobz"
                        );
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            }
        });
    }

    let protect_cb: iroh_blobs::store::ProtectCb = {
        let inf = Arc::clone(&blobs_in_flight);
        Arc::new(move |live: &mut std::collections::HashSet<iroh_blobs::Hash>| {
            let p = Arc::clone(&protected);
            let inf2 = Arc::clone(&inf);
            Box::pin(async move {
                match p.read() {
                    Ok(guard) => match guard.as_ref() {
                        None => {
                            tracing::debug!(
                                "gc protect: protected set not yet initialized, aborting cycle"
                            );
                            return iroh_blobs::store::ProtectOutcome::Abort;
                        }
                        Some(set) => {
                            live.extend(set.iter().cloned());
                        }
                    },
                    Err(_) => return iroh_blobs::store::ProtectOutcome::Abort,
                }
                // also protect blobs mid-download
                if let Ok(inf_guard) = inf2.lock() {
                    live.extend(inf_guard.iter().cloned());
                }
                iroh_blobs::store::ProtectOutcome::Continue
            })
        })
    };

    let mut fs_opts = iroh_blobs::store::fs::options::Options::new(&fs_store_dir);
    fs_opts.gc = Some(iroh_blobs::store::GcConfig {
        interval: std::time::Duration::from_secs(3600),
        add_protected: Some(protect_cb),
    });
    let fs_store: &'static iroh_blobs::store::fs::FsStore = Box::leak(Box::new(
        iroh_blobs::store::fs::FsStore::load_with_opts(
            fs_store_dir.join("blobs.db"),
            fs_opts,
        )
        .await?,
    ));

    let app_state = AppState {
        network: Arc::new(Mutex::new(None)),
        pool,
        data_dir,
        username,
        blobz: blobz_store,
        friendz_store,
        userz: userz_dir,
        process_started_at: Instant::now(),
        app_config_path,
        hub: Arc::new(Mutex::new(None)),
        fs_store,
        blobs_in_flight,
    };

    if identity::keypair_path(&app_state.data_dir).exists() {
        let net = commands::build_network_state(&app_state).await?;
        tracing::info!(node_id = %net.node_id, "restored existing identity on boot");
        *app_state.network.lock().await = Some(net);
    } else {
        tracing::info!("no identity yet -- P2P endpoint deferred until user-initiated");
    }

    Ok(app_state)
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
    let app_state = runtime
        .block_on(build_state())
        .expect("build tauri app state");

    // honour the persisted toggle: if the last run had the hub on, start it.
    let startup_cfg = AppConfig::load(&app_state.app_config_path);
    if startup_cfg.hub_enabled {
        tracing::info!("persisted hub_enabled=true — starting hub on boot");
        if let Err(e) = runtime.block_on(commands::hub_start(&app_state)) {
            tracing::warn!(error = %e, "failed to start hub on boot");
        }
    }

    // arc-clone the hub slot so the close-requested handler can shut it down.
    let hub_slot = app_state.hub.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(app_state)
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![commands::skein_dispatch])
        .setup(move |app| {
            // -- app menu with settings shortcut (cmd+, / ctrl+,) ----------
            let settings_item = MenuItemBuilder::with_id("open_settings", "Settings...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let about = PredefinedMenuItem::about(app, Some("About skein"), None)?;
            let services = PredefinedMenuItem::services(app, None)?;
            let hide = PredefinedMenuItem::hide(app, None)?;
            let hide_others = PredefinedMenuItem::hide_others(app, None)?;
            let show_all = PredefinedMenuItem::show_all(app, None)?;
            let separator1 = PredefinedMenuItem::separator(app)?;
            let separator2 = PredefinedMenuItem::separator(app)?;
            let separator3 = PredefinedMenuItem::separator(app)?;
            let separator4 = PredefinedMenuItem::separator(app)?;
            let quit = PredefinedMenuItem::quit(app, None)?;

            let app_submenu = SubmenuBuilder::new(app, "skein")
                .item(&about)
                .item(&separator1)
                .item(&settings_item)
                .item(&separator2)
                .item(&services)
                .item(&separator3)
                .item(&hide)
                .item(&hide_others)
                .item(&show_all)
                .item(&separator4)
                .item(&quit)
                .build()?;

            // edit submenu — required for cmd+c/v/x/a accelerators to reach
            // the webview text inputs on macos.
            let undo = PredefinedMenuItem::undo(app, None)?;
            let redo = PredefinedMenuItem::redo(app, None)?;
            let edit_sep = PredefinedMenuItem::separator(app)?;
            let cut = PredefinedMenuItem::cut(app, None)?;
            let copy = PredefinedMenuItem::copy(app, None)?;
            let paste = PredefinedMenuItem::paste(app, None)?;
            let select_all = PredefinedMenuItem::select_all(app, None)?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .item(&undo)
                .item(&redo)
                .item(&edit_sep)
                .item(&cut)
                .item(&copy)
                .item(&paste)
                .item(&select_all)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .build()?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "open_settings" {
                    show_settings_window(app);
                }
            });

            // intercept close on the settings window: hide instead of destroy
            // so the menu/shortcut can re-show it without recreating state.
            if let Some(settings_win) = app.get_webview_window("settings") {
                let win = settings_win.clone();
                settings_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            // -- existing hub teardown on app close ------------------------
            let rt: tauri::State<'_, tokio::runtime::Runtime> = app.state();
            let rt_handle = rt.inner().handle().clone();
            let hub_slot = hub_slot.clone();
            app.listen_any("tauri://close-requested", move |_| {
                let hub_slot = hub_slot.clone();
                let rt_handle = rt_handle.clone();
                rt_handle.spawn(async move {
                    if let Some(hub) = hub_slot.lock().await.take() {
                        hub.cancel.cancel();
                        let _ = hub.join.await;
                    }
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// show + focus the pre-declared settings window. logs on failure but never
/// panics — the menu shortcut should always feel responsive.
fn show_settings_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    match app.get_webview_window("settings") {
        Some(win) => {
            if let Err(e) = win.show() {
                tracing::warn!(error = %e, "failed to show settings window");
            }
            if let Err(e) = win.set_focus() {
                tracing::warn!(error = %e, "failed to focus settings window");
            }
        }
        None => tracing::warn!("settings window not found in app config"),
    }
}
