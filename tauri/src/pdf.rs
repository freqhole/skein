//! document page rendering — used by the peedeeeff widget to display
//! per-page images on the canvas.
//!
//! current backend: shells out to `magick` (ImageMagick), which in turn
//! shells out to `gs` (ghostscript) to actually rasterize pdf/postscript
//! pages. this matches the tomb prototype's pattern and works on any
//! platform where the user has imagemagick and ghostscript installed
//! (`brew install imagemagick ghostscript`, `apt install imagemagick
//! ghostscript`, etc.). the helpful error includes install hints when
//! either binary is missing.
//!
//! supported formats today: pdf, ps/eps (postscript). additionally,
//! epub/docx/odt/rtf/md/html are supported when `pandoc` and `typst` are
//! both on `PATH` (or a known fallback install location — see
//! `COMMON_BIN_DIRS`): these container/markup formats get converted to pdf
//! first via `pandoc ... --pdf-engine=typst` (typst is a much lighter pdf
//! engine than latex — single static binary, no package manager
//! ecosystem), then rasterized through the same magick+gs pipeline as a
//! native pdf. this is a purely additive capability — pandoc/typst being
//! absent doesn't affect pdf/ps rendering, which only ever needed
//! magick+gs.
//!
//! plain text (.txt/.text/.log) is NOT rendered here — it's shown directly
//! in a notepad widget instead (no rasterization needed, and no per-page
//! magick subprocess cost for large files). see loam's `file-utils.ts`
//! `isPlainTextFilename`/`readPickedFileText`.
//!
//! TODO(macos-native): swap in a PDFKit-based implementation behind
//! `#[cfg(target_os = "macos")]` once we're distributing skein outside of
//! dev environments. PDFKit is system-provided (zero binary bloat) and
//! removes the ImageMagick/ghostscript dependency on macOS.

use std::path::PathBuf;

use tokio::process::Command;
use tracing::{info, warn};

/// common install *directories* that a GUI-launched app's `PATH` often
/// doesn't include. macOS apps launched from Finder/Dock/Spotlight (as
/// opposed to a terminal) inherit a minimal launchd-provided `PATH`
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) — none of the shell-rc-file additions
/// homebrew/macports install scripts append (`~/.zprofile` etc.) are
/// present, even though a terminal in the same session finds `magick` (and
/// its delegate binaries, like `gs`) just fine. this single list backs both
/// `resolve_magick`'s absolute fallback paths for locating `magick` itself,
/// and `magick_delegate_path_env`'s `PATH` for `magick`'s own child
/// processes — `magick` shells out to delegate binaries for some formats
/// (ghostscript, `gs`, for PDFs in particular) using a plain `PATH` lookup
/// in *its* subprocess, which only inherits whatever `PATH` we hand to the
/// `magick` command, so finding `magick` via an absolute path does nothing
/// for that lookup on its own.
const COMMON_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // homebrew, apple silicon
    "/usr/local/bin",    // homebrew, intel, linux
    "/opt/local/bin",    // macports
    "/usr/bin",          // linux
];

/// build a `PATH` value for a `magick` child process: the current process's
/// `PATH` plus the common install directories above (deduped), so `magick`'s
/// own delegate lookups (e.g. `gs` for PDF rendering) can find binaries a
/// GUI-launched app's inherited `PATH` typically omits.
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

/// resolve a runnable path/name for a binary: tries the bare name first
/// (works whenever `PATH` already includes it — e.g. most linux setups, or
/// a terminal-launched dev build), then falls back to the common install
/// directories above, which a GUI-launched app's `PATH` commonly omits.
/// returns `None` if nothing is found anywhere. shared by `resolve_magick`
/// and `resolve_gs` (and, from `thumbnail.rs`, `ffmpeg`/`ffprobe`) since they
/// all need identical fallback logic.
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
/// delegate `magick` shells out to internally for pdf rasterization. finding
/// `magick` doesn't guarantee `gs` is reachable: `magick`'s own delegate
/// lookup only sees whatever `PATH` we hand it (see
/// `magick_delegate_path_env`), so a separate, independent check here is
/// what actually tells us whether pdf rendering will work end to end.
async fn resolve_gs() -> Option<String> {
    resolve_binary("gs", "--version").await
}

/// check whether both `magick` and its `gs` (ghostscript) delegate are
/// available (bare `PATH` lookup or a known fallback install location).
/// used at app startup to decide whether the peedeeeff widget should be
/// offered at all — `magick` alone isn't enough, since pdf rasterization
/// still fails at render time if `gs` can't be found, even when `magick`
/// itself is present.
pub async fn pdf_backend_available() -> bool {
    resolve_magick().await.is_some() && resolve_gs().await.is_some()
}

/// resolve a runnable path/name for the `pandoc` binary.
async fn resolve_pandoc() -> Option<String> {
    resolve_binary("pandoc", "--version").await
}

/// resolve a runnable path/name for the `typst` binary — the pdf engine
/// `pandoc` shells out to for the epub/docx/etc.-to-pdf conversion step.
async fn resolve_typst() -> Option<String> {
    resolve_binary("typst", "--version").await
}

/// check whether both `pandoc` and `typst` are available. this is a purely
/// additive capability check, separate from `pdf_backend_available` — pdf/
/// postscript/plain-text rendering only ever needed magick+gs and keeps
/// working regardless of this. used to decide whether the peedeeeff
/// widget's file picker (and the file/bin widgets' document-routing during
/// multi-file upload) should offer the broader epub/docx/odt/rtf/md/html
/// format list.
pub async fn pandoc_backend_available() -> bool {
    resolve_pandoc().await.is_some() && resolve_typst().await.is_some()
}

#[derive(Debug, thiserror::Error)]
pub enum PdfRenderError {
    #[error("magick binary not found on PATH — install ImageMagick (brew install imagemagick / apt install imagemagick)")]
    MagickMissing,

    #[error("magick exited with status {status}: {stderr}")]
    MagickFailed { status: i32, stderr: String },

    #[error("pandoc binary not found on PATH — install pandoc (brew install pandoc / apt install pandoc)")]
    PandocMissing,

    #[error("typst binary not found on PATH — install typst (brew install typst / cargo install typst-cli)")]
    TypstMissing,

    #[error("pandoc exited with status {status}: {stderr}")]
    PandocFailed { status: i32, stderr: String },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("magick produced no output pages")]
    NoPages,
}

/// which document format is being rendered — determines how we invoke
/// `magick` (multi-page delegate render vs. per-page `caption:` text render)
/// or, for pandoc-convertible formats, the pandoc+typst conversion step run
/// ahead of the magick delegate render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentFormat {
    Pdf,
    /// .ps / .eps — magick+gs handles these exactly like pdf.
    Postscript,
    /// epub/docx/odt/rtf/md/html — converted to pdf via
    /// `pandoc ... --pdf-engine=typst` first (see `pandoc_backend_available`),
    /// then rasterized through the same magick delegate path as a native
    /// pdf. carries the original extension for the pandoc input file name.
    PandocConvertible(String),
}

impl DocumentFormat {
    /// infer a document format from a filename's extension. returns `None`
    /// for extensions we don't recognize at all.
    pub fn from_filename(filename: &str) -> Option<Self> {
        let ext = filename.rsplit('.').next()?.to_ascii_lowercase();
        match ext.as_str() {
            "pdf" => Some(Self::Pdf),
            "ps" | "eps" => Some(Self::Postscript),
            "epub" | "docx" | "odt" | "rtf" | "md" | "markdown" | "html" | "htm" => {
                Some(Self::PandocConvertible(ext))
            }
            _ => None,
        }
    }

    /// input extension for the magick-delegate render path. only valid for
    /// the variants that path handles directly (pdf/postscript) — pandoc-
    /// convertible formats go through their own function.
    fn input_extension(&self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Postscript => "ps",
            Self::PandocConvertible(_) => unreachable!("pandoc formats don't use input_extension"),
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
    match &format {
        DocumentFormat::Pdf | DocumentFormat::Postscript => {
            render_via_magick_delegate(input_bytes, format.input_extension()).await
        }
        DocumentFormat::PandocConvertible(ext) => render_via_pandoc(input_bytes, ext).await,
    }
}

/// rasterize a pdf/postscript document via `magick`'s multi-page delegate
/// render (which shells out to `gs` internally for the actual rasterization).
async fn render_via_magick_delegate(
    input_bytes: &[u8],
    input_ext: &str,
) -> Result<Vec<Vec<u8>>, PdfRenderError> {
    // write the input document to a temp file so we can hand it to `magick`.
    let run_id = uuid_like();
    let work_dir: PathBuf = std::env::temp_dir().join(format!("skein_pdf_{run_id}"));
    tokio::fs::create_dir_all(&work_dir).await?;

    let input_path = work_dir.join(format!("input.{input_ext}"));
    tokio::fs::write(&input_path, input_bytes).await?;

    let output_pattern = work_dir.join("page-%03d.png");

    let Some(magick_path) = resolve_magick().await else {
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(PdfRenderError::MagickMissing);
    };

    // mirror tomb's render args — 150 dpi gives readable text without huge
    // file sizes. quality flag is ignored by PNG but harmless.
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

    info!(pages = entries.len(), "rendered document pages");

    let mut pages = Vec::with_capacity(entries.len());
    for (_, path) in &entries {
        pages.push(tokio::fs::read(path).await?);
    }

    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    Ok(pages)
}

/// pandoc lua filter that strips internal same-document link targets —
/// see the file itself for why (typst hard-fails on unresolved labels that
/// legacy/messy epub markup produces). embedded in the binary so no extra
/// resource-bundling config or install step is needed; written out
/// alongside the rest of a conversion run's temp files.
const STRIP_INTERNAL_LINKS_LUA: &str = include_str!("pdf_filters/strip_internal_links.lua");

/// convert an epub/docx/odt/rtf/md/html document to pdf via
/// `pandoc ... --pdf-engine=typst`, then rasterize the resulting pdf through
/// the existing magick delegate path — no new page-rendering code needed,
/// just one conversion step in front of what's already there.
async fn render_via_pandoc(
    input_bytes: &[u8],
    input_ext: &str,
) -> Result<Vec<Vec<u8>>, PdfRenderError> {
    let Some(pandoc_path) = resolve_pandoc().await else {
        return Err(PdfRenderError::PandocMissing);
    };
    let Some(typst_path) = resolve_typst().await else {
        return Err(PdfRenderError::TypstMissing);
    };

    let run_id = uuid_like();
    let work_dir: PathBuf = std::env::temp_dir().join(format!("skein_pandoc_{run_id}"));
    tokio::fs::create_dir_all(&work_dir).await?;

    let input_path = work_dir.join(format!("input.{input_ext}"));
    tokio::fs::write(&input_path, input_bytes).await?;
    let output_path = work_dir.join("output.pdf");
    let lua_filter_path = work_dir.join("strip_internal_links.lua");
    tokio::fs::write(&lua_filter_path, STRIP_INTERNAL_LINKS_LUA).await?;

    let status = Command::new(&pandoc_path)
        .env("PATH", magick_delegate_path_env())
        // pandoc's epub/media handling opens temp files relative to the
        // process's cwd (ghc's `openTempFile "."`), not a system temp dir.
        // a gui-launched app inherits a cwd that's often read-only (e.g.
        // the app bundle itself on macos), so pin it to our writable
        // work_dir instead.
        .current_dir(&work_dir)
        .arg(&input_path)
        .arg("-o")
        .arg(&output_path)
        .arg("--pdf-engine")
        .arg(&typst_path)
        .arg("--lua-filter")
        .arg(&lua_filter_path)
        .output()
        .await;

    let output = match status {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(PdfRenderError::PandocMissing);
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(PdfRenderError::Io(e));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // pandoc/typst failures on messy epubs can dump many KB of
        // duplicate-label warnings — truncate what we log so one bad
        // document doesn't flood the console, while still keeping the
        // full text in the returned error for whoever wants it.
        let logged_stderr = match stderr.char_indices().nth(2000) {
            Some((idx, _)) => format!("{}... [truncated]", &stderr[..idx]),
            None => stderr.clone(),
        };
        warn!(stderr = %logged_stderr, "pandoc failed");
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(PdfRenderError::PandocFailed {
            status: output.status.code().unwrap_or(-1),
            stderr,
        });
    }

    let pdf_bytes = tokio::fs::read(&output_path).await?;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;

    info!(input_ext, "converted document to pdf via pandoc+typst");
    render_via_magick_delegate(&pdf_bytes, "pdf").await
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
