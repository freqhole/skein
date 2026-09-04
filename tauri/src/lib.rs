//! skein tauri backend.
//!
//! boots the always-on parts (`SqlitePool`, stores) and exposes a single
//! `skein_dispatch` tauri command. the iroh endpoint is NOT always-on: it's
//! bound eagerly at boot only for a returning user who already has a
//! keypair on disk, and otherwise deferred until the frontend actually
//! needs P2P (see `commands::ensure_network`) — never generated just
//! because the process started.

mod commands;
mod epub_repair;
mod pdf;
mod streams;
mod thumbnail;
mod transcode;
mod tts;
mod unfurl;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

#[cfg(desktop)]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;
use tauri::WindowEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex;
use tumulus::{db, friendz, userz};

use commands::AppState;

const APP_IDENTIFIER: &str = "net.freqhole.skein";
const APP_CONFIG_FILENAME: &str = "skein-app.toml";
/** log file name, written alongside the app's sqlite databases in the data dir. */
const LOG_FILE_NAME: &str = "skein.log";
/** log file is truncated (keeping the newest lines) once it exceeds this many lines. */
const MAX_LOG_LINES: usize = 10_000;

fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "android")]
    {
        // no android-specific env var for this; tauri's android runtime sets
        // HOME (falling back to TMPDIR) to the app's private, writable storage.
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("TMPDIR")) {
            return PathBuf::from(home).join(APP_IDENTIFIER);
        }
    }
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

/// resolve the data directory the same way `build_state()` does, without
/// needing an `AppState` - tracing has to be set up before anything else
/// runs, including `build_state()` itself.
fn resolve_data_dir() -> PathBuf {
    std::env::var("SKEIN_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_data_dir())
}

/// truncate a log file to its newest `max_lines` lines, if it's grown past
/// that - keeps a first-run (or long-running) log from growing unbounded.
fn truncate_log_file_if_needed(path: &std::path::Path, max_lines: usize) {
    use std::io::{BufRead, BufReader, Write};

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };

    let reader = BufReader::new(file);
    let lines: Vec<String> = reader.lines().map_while(Result::ok).collect();

    if lines.len() <= max_lines {
        return;
    }

    let keep_from = lines.len() - max_lines;
    if let Ok(mut file) = std::fs::File::create(path) {
        for line in &lines[keep_from..] {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// set up tracing to write to both stdout and a log file in the data dir
/// (`<data_dir>/skein.log`), and install a panic hook that logs panics
/// through the same subscriber - a plain Rust panic only prints to stderr
/// by default, which is invisible on a packaged desktop build with no
/// attached terminal (the common way a first-load crash on Linux would
/// otherwise leave no trace at all). returns the log file path if file
/// logging was set up successfully, for a one-time startup log message.
fn setup_tracing() -> Option<PathBuf> {
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let data_dir = resolve_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    let log_path = data_dir.join(LOG_FILE_NAME);
    truncate_log_file_if_needed(&log_path, MAX_LOG_LINES);

    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    let result = if let Some(file) = log_file {
        let file_layer = tracing_subscriber::fmt::layer()
            .with_writer(std::sync::Mutex::new(file))
            .with_ansi(false);
        tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(tracing_subscriber::fmt::layer())
            .init();
        Some(log_path)
    } else {
        // fall back to stdout-only logging rather than failing to start -
        // a read-only/missing data dir shouldn't prevent the app from
        // running, just from persisting logs.
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer())
            .init();
        None
    };

    std::panic::set_hook(Box::new(|info| {
        tracing::error!("panic: {info}");
    }));

    result
}

/// build the always-on `AppState`: pool and stores. `network` always
/// starts `None` here -- see `restore_network_on_boot` for why the iroh
/// endpoint is never bound this early.
async fn build_state() -> anyhow::Result<AppState> {
    let data_dir = resolve_data_dir();
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
        data_dir,
        username,
        storage,
        downloader_cell: Arc::new(std::sync::RwLock::new(None)),
        friendz_store,
        userz: userz_dir,
        transfers: freqhole_reliquary::gate::TransferRegistry::new(),
        process_started_at: Instant::now(),
        app_config_path,
        pool,
    };

    Ok(app_state)
}

/// restore a returning user's iroh endpoint (if a keypair already exists on
/// disk) once the app is fully up and running.
///
/// this must NOT run any earlier than `tauri::Builder`'s `.setup()` -- a
/// real android crash dump (abort message: `android context was not
/// initialized`) showed the endpoint being bound from `run()`'s
/// `runtime.block_on(build_state())`, *before* `Builder::run()` ever
/// starts: iroh's network-interface watcher (`netwatch`/`netdev`) needs
/// android's JNI `ndk-context`, which tao/tauri only wires up while
/// building the actual activity/webview -- so binding here every boot
/// (for any returning user with a keypair on disk) reliably aborted the
/// whole process, permanently, since the keypair persists across restarts.
/// tomb's charnel android app never hits this: it only ever binds its
/// iroh endpoint from inside an already-running tauri command
/// (`toggle_federation_enabled` -> `P2pState::start()`), never from its
/// own pre-`Builder` boot path -- this mirrors that by deferring the bind
/// to a task spawned from `.setup()` instead.
///
/// errors are logged and swallowed, same as before: `ensure_network` lazily
/// retries the same `build_network_state` call the next time the frontend
/// actually needs the network.
async fn restore_network_on_boot(state: tauri::State<'_, AppState>) {
    if !freqhole_reliquary::identity::keypair_path(
        &state.data_dir,
        freqhole_reliquary::identity::DEFAULT_KEYPAIR_FILENAME,
    )
    .exists()
    {
        tracing::info!("no identity yet -- P2P endpoint deferred until user-initiated");
        return;
    }

    match commands::build_network_state(&state).await {
        Ok(net) => {
            tracing::info!(node_id = %net.node_id, "restored existing identity on boot");
            *state.network.lock().await = Some(net);
        }
        Err(e) => {
            tracing::warn!(error = %e, "failed to restore network on boot -- continuing offline, will retry lazily");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // android only: install rustls' ring crypto provider before anything can
    // construct a TLS client (reqwest, wry's WebViewClient, etc.) - rustls
    // 0.23 panics ("no provider set") if no default provider is installed,
    // which aborts the whole process. desktop targets are unaffected.
    #[cfg(target_os = "android")]
    {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let log_path = setup_tracing();
    if let Some(path) = &log_path {
        tracing::info!(log_file = %path.display(), "logging to file");
    }

    let runtime = tokio::runtime::Runtime::new().expect("build tokio runtime");
    let app_state = runtime
        .block_on(build_state())
        .expect("build tauri app state");

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
            // windows are built here (not declared in tauri.conf.json's
            // `app.windows`) so android gets exactly one window and no
            // trace of the desktop-only settings window - mirrors
            // tomb/client/charnel's pattern. a declarative `app.windows`
            // array plus a per-platform config override was tried first
            // and DID correctly reduce the merged android config down to
            // just "main", but the android webview still ended up loading
            // settings.html's content anyway - so window creation is fully
            // explicit instead of relying on platform config merging.
            let main_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default());
            #[cfg(desktop)]
            let main_builder = main_builder
                .title("skein")
                .inner_size(1280.0, 800.0)
                .resizable(true)
                .fullscreen(false);
            main_builder.build()?;

            // spawned (not awaited) so `.setup()` returns immediately --
            // see `restore_network_on_boot`'s doc comment for why this
            // can't run any earlier than here.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                restore_network_on_boot(handle.state::<AppState>()).await;
            });

            // -- app menu with settings shortcut (cmd+, / ctrl+,) ----------
            // (desktop only: mobile has no window menu bar / menu events, and
            // no settings window at all)
            #[cfg(desktop)]
            {
                let settings_builder = WebviewWindowBuilder::new(
                    app,
                    "settings",
                    WebviewUrl::App(PathBuf::from("settings.html")),
                )
                .title("skein settings")
                .inner_size(520.0, 480.0)
                .min_inner_size(360.0, 320.0)
                .resizable(true)
                .visible(false)
                .center()
                .focused(true);
                settings_builder.build()?;

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

                // intercept close on the settings window: hide instead of
                // destroy so the menu/shortcut can re-show it without
                // recreating state.
                if let Some(settings_win) = app.get_webview_window("settings") {
                    let win = settings_win.clone();
                    settings_win.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = win.hide();
                        }
                    });
                }
            }

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
