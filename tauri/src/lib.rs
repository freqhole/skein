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

#[cfg(desktop)]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Listener;
use tauri::Manager;
use tauri::WindowEvent;
use tokio::sync::Mutex;
use tumulus::{db, friendz, userz};

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
            return PathBuf::from(home)
                .join(".local/share")
                .join(APP_IDENTIFIER);
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
    let haruspex_pool = db::open_haruspex(&data_dir).await?;
    let username = std::env::var("SKEIN_USERNAME").unwrap_or_else(|_| "skein".to_string());
    let blobz_store: std::sync::Arc<dyn freqhole_reliquary::blobz::BlobStore> = std::sync::Arc::new(
        freqhole_reliquary::blobz::SqliteBlobStore::new(pool.clone(), &data_dir),
    );
    let friendz_store = friendz::Store::new(haruspex_pool.clone(), pool.clone());
    let userz_dir = userz::Directory::new(haruspex_pool);
    let app_config_path = data_dir.join(APP_CONFIG_FILENAME);

    // the iroh-blobs FsStore + gc-protect + downloader bundle. boots fully
    // offline -- no iroh endpoint/identity needed yet -- so it's ready the
    // moment the process starts, independent of whether the user already
    // has an identity on disk. a downloader attaches moments later in this
    // same function for a returning user, or whenever the frontend first
    // needs the network for a first-time user (see
    // `commands::ensure_network`); either way it's the same `StorageNode`,
    // never a second one.
    let storage = Arc::new(
        freqhole_reliquary::node::StorageNode::init_local(
            &data_dir,
            blobz_store,
            freqhole_reliquary::node::StorageNodeOptions::default(),
        )
        .await?,
    );

    let app_state = AppState {
        network: Arc::new(Mutex::new(None)),
        pool,
        data_dir,
        username,
        storage,
        downloader_cell: Arc::new(std::sync::RwLock::new(None)),
        friendz_store,
        userz: userz_dir,
        process_started_at: Instant::now(),
        app_config_path,
        hub: Arc::new(Mutex::new(None)),
    };

    if freqhole_reliquary::identity::keypair_path(
        &app_state.data_dir,
        freqhole_reliquary::identity::DEFAULT_KEYPAIR_FILENAME,
    )
    .exists()
    {
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

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        .manage(app_state)
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![commands::skein_dispatch])
        .setup(move |app| {
            // -- app menu with settings shortcut (cmd+, / ctrl+,) ----------
            // (desktop only: mobile has no window menu bar / menu events)
            #[cfg(desktop)]
            {
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
            }

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
/// (desktop only: only ever called from the desktop-only menu-event handler.)
#[cfg(desktop)]
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
