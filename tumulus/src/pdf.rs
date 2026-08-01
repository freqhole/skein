//! document page rendering — hub-side counterpart to tauri's `pdf.rs`, used
//! to serve the peedeeeff widget's per-page images to browser peers (who
//! have no native rendering backend of their own).
//!
//! current backend: shells out to `magick` (ImageMagick), which in turn
//! shells out to `gs` (ghostscript) to actually rasterize pdf/postscript
//! pages. works on any host where the operator has installed imagemagick
//! and ghostscript — e.g. `apt install imagemagick ghostscript` on the
//! raspberry pi this hub typically runs on.
//!
//! supported formats today: pdf, ps/eps (postscript). deliberately NOT
//! supported without new dependencies: epub, docx, odt, rtf, etc. — these
//! are zip/xml container formats magick can't parse on its own. adding
//! them would mean either a libreoffice/pandoc subprocess step (convert to
//! pdf first, then reuse this pipeline unchanged) or format-specific rust
//! crates. plain text (.txt/.text/.log) is also NOT rendered here — it's
//! shown directly in a notepad widget instead (see loam's `file-utils.ts`
//! `isPlainTextFilename`).
//!
//! NOTE: this module is intentionally a near-duplicate of
//! `tauri/src/pdf.rs` (kept in sync by hand for now). both tauri and
//! tumulus already depend on `freqhole_reliquary` — moving this shared
//! subprocess-rendering logic there would remove the duplication, but that
//! wasn't done yet (cross-repo refactor, left as a follow-up).

use std::path::PathBuf;

use tokio::process::Command;
use tracing::{info, warn};

/// common install *directories* that a headless/service-launched process's
/// `PATH` often doesn't include (e.g. a systemd unit with a minimal
/// environment). backs both `resolve_magick`'s absolute fallback paths for
/// locating `magick` itself, and `magick_delegate_path_env`'s `PATH` for
/// `magick`'s own child processes.
const COMMON_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // homebrew, apple silicon
    "/usr/local/bin",    // homebrew, intel, linux
    "/opt/local/bin",    // macports
    "/usr/bin",          // linux / raspberry pi (apt)
];

/// build a `PATH` value for a `magick` child process: the current process's
/// `PATH` plus the common install directories above (deduped), so `magick`'s
/// own delegate lookups (e.g. `gs` for PDF rendering) can find binaries a
/// minimal-environment host process's inherited `PATH` typically omits.
pub(crate) fn magick_delegate_path_env() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    for dir in COMMON_BIN_DIRS {
        let dir = PathBuf::from(dir);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }

    std::env::join_paths(dirs).unwrap_or_default()
}

/// resolve a runnable path/name for a binary: tries the bare name first,
/// then falls back to the common install directories above. returns `None`
/// if nothing is found anywhere.
pub(crate) async fn resolve_binary(name: &str, version_flag: &str) -> Option<String> {
    if Command::new(name).arg(version_flag).output().await.is_ok() {
        return Some(name.to_string());
    }

    for dir in COMMON_BIN_DIRS {
        let candidate = PathBuf::from(dir).join(name);
        if tokio::fs::metadata(&candidate).await.is_ok() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }

    None
}

/// resolve a runnable path/name for the `magick` binary.
async fn resolve_magick() -> Option<String> {
    resolve_binary("magick", "-version").await
}

/// resolve a runnable path/name for the `gs` (ghostscript) binary — the
/// delegate `magick` shells out to internally for pdf rasterization.
async fn resolve_gs() -> Option<String> {
    resolve_binary("gs", "--version").await
}

/// check whether both `magick` and its `gs` (ghostscript) delegate are
/// available. used to decide whether the hub can render documents on
/// behalf of browser peers at all — `magick` alone isn't enough, since pdf
/// rasterization still fails at render time if `gs` can't be found.
pub async fn pdf_backend_available() -> bool {
    resolve_magick().await.is_some() && resolve_gs().await.is_some()
}

#[derive(Debug, thiserror::Error)]
pub enum PdfRenderError {
    #[error("magick binary not found on PATH — install ImageMagick (apt install imagemagick / brew install imagemagick)")]
    MagickMissing,

    #[error("magick exited with status {status}: {stderr}")]
    MagickFailed { status: i32, stderr: String },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("magick produced no output pages")]
    NoPages,
}

/// which document format is being rendered — determines how we invoke
/// `magick`'s multi-page delegate render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentFormat {
    Pdf,
    /// .ps / .eps — magick+gs handles these exactly like pdf.
    Postscript,
}

impl DocumentFormat {
    /// infer a document format from a filename's extension. returns `None`
    /// for anything we don't know how to rasterize (e.g. epub, docx — no
    /// delegate available without new binary dependencies).
    pub fn from_filename(filename: &str) -> Option<Self> {
        let ext = filename.rsplit('.').next()?.to_ascii_lowercase();
        match ext.as_str() {
            "pdf" => Some(Self::Pdf),
            "ps" | "eps" => Some(Self::Postscript),
            _ => None,
        }
    }

    fn input_extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Postscript => "ps",
        }
    }
}

/// rasterize every page of a document to a per-page PNG.
///
/// returns one Vec<u8> of PNG bytes per page, in order.
pub async fn render_document_pages(
    input_bytes: &[u8],
    format: DocumentFormat,
) -> Result<Vec<Vec<u8>>, PdfRenderError> {
    match format {
        DocumentFormat::Pdf | DocumentFormat::Postscript => {
            render_via_magick_delegate(input_bytes, format.input_extension()).await
        }
    }
}

/// rasterize a pdf/postscript document via `magick`'s multi-page delegate
/// render (which shells out to `gs` internally for the actual rasterization).
async fn render_via_magick_delegate(
    input_bytes: &[u8],
    input_ext: &str,
) -> Result<Vec<Vec<u8>>, PdfRenderError> {
    let run_id = uuid_like();
    let work_dir: PathBuf = std::env::temp_dir().join(format!("skein_hub_pdf_{run_id}"));
    tokio::fs::create_dir_all(&work_dir).await?;

    let input_path = work_dir.join(format!("input.{input_ext}"));
    tokio::fs::write(&input_path, input_bytes).await?;

    let output_pattern = work_dir.join("page-%03d.png");

    let Some(magick_path) = resolve_magick().await else {
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(PdfRenderError::MagickMissing);
    };

    // 150 dpi gives readable text without huge file sizes. quality flag is
    // ignored by PNG but harmless.
    let status = Command::new(&magick_path)
        .env("PATH", magick_delegate_path_env())
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

    info!(pages = entries.len(), "hub: rendered document pages");

    let mut pages = Vec::with_capacity(entries.len());
    for (_, path) in &entries {
        pages.push(tokio::fs::read(path).await?);
    }

    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    Ok(pages)
}

/// render only the first page of a document, at thumbnail resolution —
/// used by thumbnail generation, which shouldn't pay for a full multi-page
/// render just to get a cover image. mirrors tauri's `thumbnail.rs`
/// `input.pdf[0]` page-selection trick for pdf/postscript.
pub async fn render_first_page_thumbnail(
    input_bytes: &[u8],
    format: DocumentFormat,
    size: u32,
) -> Result<Vec<u8>, PdfRenderError> {
    match format {
        DocumentFormat::Pdf | DocumentFormat::Postscript => {
            render_first_page_via_magick(input_bytes, format.input_extension(), size).await
        }
    }
}

async fn render_first_page_via_magick(
    input_bytes: &[u8],
    input_ext: &str,
    size: u32,
) -> Result<Vec<u8>, PdfRenderError> {
    let run_id = uuid_like();
    let work_dir: PathBuf = std::env::temp_dir().join(format!("skein_hub_thumb_{run_id}"));
    tokio::fs::create_dir_all(&work_dir).await?;

    let input_path = work_dir.join(format!("input.{input_ext}"));
    tokio::fs::write(&input_path, input_bytes).await?;
    let output_path = work_dir.join("thumb.png");

    let Some(magick_path) = resolve_magick().await else {
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(PdfRenderError::MagickMissing);
    };

    // `input.ext[0]` selects only the first page — avoids rendering the
    // whole document just to get a cover image.
    let first_page_arg = format!("{}[0]", input_path.to_string_lossy());
    let resize_arg = format!("{size}x{size}");

    let status = Command::new(&magick_path)
        .env("PATH", magick_delegate_path_env())
        .arg("-density")
        .arg("72")
        .arg(&first_page_arg)
        .arg("-resize")
        .arg(&resize_arg)
        .arg(&output_path)
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
        warn!(stderr = %stderr, "magick thumbnail failed");
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(PdfRenderError::MagickFailed {
            status: output.status.code().unwrap_or(-1),
            stderr,
        });
    }

    let png_bytes = tokio::fs::read(&output_path).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    png_bytes.map_err(PdfRenderError::Io)
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
