//! pdf page rendering — used by the peedeeeff widget to display per-page
//! images on the canvas.
//!
//! current backend: shells out to `magick` (ImageMagick). this matches the
//! tomb prototype's pattern and works on any platform where the user has
//! ImageMagick installed (`brew install imagemagick`, `apt install imagemagick`,
//! etc.). the helpful error includes install hints when `magick` is missing.
//!
//! TODO(macos-native): swap in a PDFKit-based implementation behind
//! `#[cfg(target_os = "macos")]` once we're distributing skein outside of
//! dev environments. PDFKit is system-provided (zero binary bloat) and
//! removes the ImageMagick dependency on macOS.

use std::path::PathBuf;

use tokio::process::Command;
use tracing::{info, warn};

/// common install locations for `magick` that a GUI-launched app's `PATH`
/// often doesn't include. macOS apps launched from Finder/Dock/Spotlight
/// (as opposed to a terminal) inherit a minimal launchd-provided `PATH`
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) — none of the shell-rc-file additions
/// homebrew/macports install scripts append (`~/.zprofile` etc.) are
/// present, even though a terminal in the same session finds `magick` just
/// fine. bare `Command::new("magick")` relies entirely on the process's
/// inherited `PATH`, so it fails to find a binary that's actually installed.
const MAGICK_FALLBACK_PATHS: &[&str] = &[
    "/opt/homebrew/bin/magick", // homebrew, apple silicon
    "/usr/local/bin/magick",    // homebrew, intel, linux
    "/opt/local/bin/magick",    // macports
    "/usr/bin/magick",          // linux
];

/// resolve a runnable path/name for the `magick` binary.
///
/// tries the bare name first (works whenever `PATH` already includes it —
/// e.g. most linux setups, or a terminal-launched dev build), then falls
/// back to well-known install locations that a GUI-launched app's `PATH`
/// commonly omits. returns `None` if nothing is found anywhere.
async fn resolve_magick() -> Option<String> {
    if Command::new("magick")
        .arg("-version")
        .output()
        .await
        .is_ok()
    {
        return Some("magick".to_string());
    }

    for candidate in MAGICK_FALLBACK_PATHS {
        if tokio::fs::metadata(candidate).await.is_ok() {
            return Some((*candidate).to_string());
        }
    }

    None
}

/// check whether `magick` is available (bare `PATH` lookup or a known
/// fallback install location). used at app startup to decide whether the
/// peedeeeff widget should be offered at all.
pub async fn magick_available() -> bool {
    resolve_magick().await.is_some()
}

#[derive(Debug, thiserror::Error)]
pub enum PdfRenderError {
    #[error("magick binary not found on PATH — install ImageMagick (brew install imagemagick / apt install imagemagick)")]
    MagickMissing,

    #[error("magick exited with status {status}: {stderr}")]
    MagickFailed { status: i32, stderr: String },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("magick produced no output pages")]
    NoPages,
}

/// rasterize every page of a PDF to a per-page PNG.
///
/// returns one Vec<u8> of PNG bytes per page, in order.
pub async fn render_pdf_pages(pdf_bytes: &[u8]) -> Result<Vec<Vec<u8>>, PdfRenderError> {
    // write the input pdf to a temp file so we can hand it to `magick`.
    let run_id = uuid_like();
    let work_dir: PathBuf = std::env::temp_dir().join(format!("skein_pdf_{run_id}"));
    tokio::fs::create_dir_all(&work_dir).await?;

    let input_path = work_dir.join("input.pdf");
    tokio::fs::write(&input_path, pdf_bytes).await?;

    let output_pattern = work_dir.join("page-%03d.png");

    let Some(magick_path) = resolve_magick().await else {
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(PdfRenderError::MagickMissing);
    };

    // mirror tomb's render args — 150 dpi gives readable text without huge
    // file sizes. quality flag is ignored by PNG but harmless.
    let status = Command::new(&magick_path)
        .arg("-density")
        .arg("150")
        .arg(&input_path)
        .arg("-quality")
        .arg("80")
        .arg(&output_pattern)
        .output()
        .await;

    let output = match status {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(PdfRenderError::MagickMissing);
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(PdfRenderError::Io(e));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        warn!(stderr = %stderr, "magick failed");
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(PdfRenderError::MagickFailed {
            status: output.status.code().unwrap_or(-1),
            stderr,
        });
    }

    // collect rendered page files in lexical order (page-000.png, page-001.png, …)
    let mut entries = vec![];
    let mut rd = tokio::fs::read_dir(&work_dir).await?;
    while let Some(e) = rd.next_entry().await? {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("page-") && name.ends_with(".png") {
            entries.push((name, e.path()));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    if entries.is_empty() {
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(PdfRenderError::NoPages);
    }

    info!(pages = entries.len(), "rendered pdf pages");

    let mut pages = Vec::with_capacity(entries.len());
    for (_, path) in &entries {
        pages.push(tokio::fs::read(path).await?);
    }

    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    Ok(pages)
}

/// quick non-cryptographic unique id for temp dir naming.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
