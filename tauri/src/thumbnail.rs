//! blob thumbnail generation for the `blob_thumbnail` dispatch action.
//!
//! supports four source types:
//! - image/*: decoded + resized in-process via the `image` crate (through
//!   `freqhole_reliquary::media`), returned as webp.
//! - application/pdf: rasterizes the first page via `magick` (same subprocess
//!   pattern as `pdf.rs`), returned as png.
//! - video/*: extracts a frame at ~1% of the duration via ffprobe + ffmpeg,
//!   returned as png.
//! - audio/*: renders a waveform image via ffmpeg's `showwavespic` filter,
//!   returned as png.
//! - everything else: returns `{ data: null }`.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use tokio::process::Command;
use tracing::warn;

#[derive(Debug, thiserror::Error)]
pub enum ThumbnailError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("image decode/encode: {0}")]
    Image(String),
}

/// generate a thumbnail for a blob on disk.
///
/// returns a json value of the shape `{ data: <base64-string>, mime: <str> }`
/// for supported types, or `{ data: null }` for unsupported ones.
pub async fn generate_thumbnail(
    blob_path: &Path,
    mime: &str,
    size: u32,
) -> Result<Value, ThumbnailError> {
    if mime.starts_with("image/") {
        thumbnail_image(blob_path, size).await
    } else if mime == "application/pdf" {
        thumbnail_pdf(blob_path, size).await
    } else if mime.starts_with("video/") {
        thumbnail_video(blob_path, size).await
    } else if mime.starts_with("audio/") {
        thumbnail_audio(blob_path, size).await
    } else {
        Ok(json!({ "data": null }))
    }
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe resolution
// ---------------------------------------------------------------------------

/// resolve a runnable path/name for `ffmpeg`, falling back to common install
/// directories a GUI-launched app's `PATH` typically omits (see
/// `crate::pdf::resolve_binary`'s doc comment for why: apps launched from
/// Finder/Dock/Spotlight inherit a minimal launchd `PATH` that doesn't see
/// homebrew/macports install locations even though a terminal in the same
/// session finds `ffmpeg` fine).
async fn resolve_ffmpeg() -> Option<String> {
    crate::pdf::resolve_binary("ffmpeg", "-version").await
}

/// resolve a runnable path/name for `ffprobe` — same fallback as `ffmpeg`.
async fn resolve_ffprobe() -> Option<String> {
    crate::pdf::resolve_binary("ffprobe", "-version").await
}

// ---------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------

async fn thumbnail_image(path: &Path, size: u32) -> Result<Value, ThumbnailError> {
    let bytes = tokio::fs::read(path).await?;
    let webp = freqhole_reliquary::media::resize_to_square_webp(&bytes, size)
        .map_err(|e| ThumbnailError::Image(e.to_string()))?;
    let b64 = B64.encode(&webp);
    Ok(json!({ "data": b64, "mime": "image/webp" }))
}

// ---------------------------------------------------------------------------
// pdf (first page via magick)
// ---------------------------------------------------------------------------

async fn thumbnail_pdf(path: &Path, size: u32) -> Result<Value, ThumbnailError> {
    let run_id = uuid_like();
    let work_dir = std::env::temp_dir().join(format!("skein_thumb_{run_id}"));
    tokio::fs::create_dir_all(&work_dir).await?;

    let output_path = work_dir.join("thumb.png");
    let resize_arg = format!("{size}x{size}");
    // `input.pdf[0]` selects only the first page — avoids loading the whole
    // document just to get a cover image.
    let input_arg = format!("{}[0]", path.to_string_lossy());

    let output = Command::new("magick")
        .env("PATH", crate::pdf::magick_delegate_path_env())
        .arg("-density")
        .arg("72")
        .arg(&input_arg)
        .arg("-resize")
        .arg(&resize_arg)
        .arg(&output_path)
        .output()
        .await;

    let out = match output {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(ThumbnailError::Image(
                "magick not found — install ImageMagick (brew install imagemagick / apt install imagemagick)".to_string(),
            ));
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(ThumbnailError::Io(e));
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        warn!(stderr = %stderr, "magick pdf thumbnail failed");
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(ThumbnailError::Image(format!("magick failed: {stderr}")));
    }

    let png_bytes = tokio::fs::read(&output_path).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    let png_bytes = png_bytes?;

    Ok(json!({ "data": B64.encode(&png_bytes), "mime": "image/png" }))
}

// ---------------------------------------------------------------------------
// video (first frame via ffprobe + ffmpeg)
// ---------------------------------------------------------------------------

async fn thumbnail_video(path: &Path, size: u32) -> Result<Value, ThumbnailError> {
    let Some(ffprobe) = resolve_ffprobe().await else {
        return Err(ThumbnailError::Image(
            "ffprobe not found — install ffmpeg".to_string(),
        ));
    };

    // probe duration first
    let probe_out = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .await;

    let probe_out = match probe_out {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ThumbnailError::Image(
                "ffprobe not found — install ffmpeg".to_string(),
            ));
        }
        Err(e) => return Err(ThumbnailError::Io(e)),
    };

    // compute seek time: 1% of duration, fallback to 0.5s when probe fails.
    let seek_secs: f64 = if probe_out.status.success() {
        let raw = String::from_utf8_lossy(&probe_out.stdout)
            .trim()
            .to_string();
        raw.parse::<f64>().unwrap_or(50.0) * 0.01
    } else {
        0.5
    };

    let run_id = uuid_like();
    let work_dir = std::env::temp_dir().join(format!("skein_vthumb_{run_id}"));
    tokio::fs::create_dir_all(&work_dir).await?;

    let Some(ffmpeg) = resolve_ffmpeg().await else {
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(ThumbnailError::Image(
            "ffmpeg not found — install ffmpeg".to_string(),
        ));
    };

    let output_path = work_dir.join("frame.png");
    let scale_filter = format!("scale={size}:-2");
    let seek_str = format!("{seek_secs:.3}");

    let ffmpeg_out = Command::new(&ffmpeg)
        .args(["-ss", &seek_str, "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf", &scale_filter, "-f", "image2"])
        .arg(&output_path)
        .args(["-y"]) // overwrite if temp dir collision (unlikely but safe)
        .output()
        .await;

    let ffmpeg_out = match ffmpeg_out {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(ThumbnailError::Image(
                "ffmpeg not found — install ffmpeg".to_string(),
            ));
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(ThumbnailError::Io(e));
        }
    };

    if !ffmpeg_out.status.success() {
        let stderr = String::from_utf8_lossy(&ffmpeg_out.stderr).to_string();
        warn!(stderr = %stderr, "ffmpeg video thumbnail failed");
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(ThumbnailError::Image(format!("ffmpeg failed: {stderr}")));
    }

    let png_bytes = tokio::fs::read(&output_path).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    let png_bytes = png_bytes?;

    Ok(json!({ "data": B64.encode(&png_bytes), "mime": "image/png" }))
}

// ---------------------------------------------------------------------------
// audio (waveform image via ffmpeg's showwavespic filter)
// ---------------------------------------------------------------------------

async fn thumbnail_audio(path: &Path, size: u32) -> Result<Value, ThumbnailError> {
    let Some(ffmpeg) = resolve_ffmpeg().await else {
        return Err(ThumbnailError::Image(
            "ffmpeg not found — install ffmpeg".to_string(),
        ));
    };

    let run_id = uuid_like();
    let work_dir = std::env::temp_dir().join(format!("skein_athumb_{run_id}"));
    tokio::fs::create_dir_all(&work_dir).await?;

    let output_path = work_dir.join("waveform.png");
    // a 4:1 aspect ratio (matching tomb's charnel waveform renderer) reads
    // better as a scrubber/preview strip than a square image would.
    let width = size * 4;
    let height = size;
    let filter = format!(
        "color=black:s={width}x{height}[bg];[0:a]showwavespic=s={width}x{height}:colors=0xff00ff[fg];[bg][fg]overlay=format=auto"
    );

    let ffmpeg_out = Command::new(&ffmpeg)
        .arg("-i")
        .arg(path)
        .args(["-filter_complex", &filter, "-frames:v", "1", "-y"])
        .arg(&output_path)
        .output()
        .await;

    let ffmpeg_out = match ffmpeg_out {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(ThumbnailError::Image(
                "ffmpeg not found — install ffmpeg".to_string(),
            ));
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(ThumbnailError::Io(e));
        }
    };

    if !ffmpeg_out.status.success() {
        let stderr = String::from_utf8_lossy(&ffmpeg_out.stderr).to_string();
        warn!(stderr = %stderr, "ffmpeg waveform thumbnail failed");
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(ThumbnailError::Image(format!("ffmpeg failed: {stderr}")));
    }

    let png_bytes = tokio::fs::read(&output_path).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    let png_bytes = png_bytes?;

    Ok(json!({ "data": B64.encode(&png_bytes), "mime": "image/png" }))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

// ---------------------------------------------------------------------------
// unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// build a tiny in-memory PNG for use as thumbnail test fixture data.
    fn tiny_png() -> Vec<u8> {
        use image::ImageFormat;
        let img = image::RgbImage::from_fn(16, 16, |x, y| {
            image::Rgb([(x * 16) as u8, (y * 16) as u8, 0])
        });
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    #[tokio::test]
    async fn image_resize_returns_webp_base64() {
        let png = tiny_png();

        // write to a temp file
        let dir = std::env::temp_dir().join(format!("skein_thumb_test_{}", uuid_like()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("test.png");
        tokio::fs::write(&path, &png).await.unwrap();

        let result = thumbnail_image(&path, 64).await.expect("thumbnail_image");
        let _ = tokio::fs::remove_dir_all(&dir).await;

        assert_eq!(result["mime"], "image/webp");
        let b64 = result["data"].as_str().expect("data is a string");
        assert!(!b64.is_empty());

        // decode and check webp signature
        let bytes = B64.decode(b64).expect("valid base64");
        assert!(bytes.len() >= 12, "too short for a webp");
        assert_eq!(&bytes[0..4], b"RIFF", "expected RIFF header");
        assert_eq!(&bytes[8..12], b"WEBP", "expected WEBP marker");
    }

    #[tokio::test]
    async fn unsupported_mime_returns_null_data() {
        let dir = std::env::temp_dir().join(format!("skein_thumb_test_{}", uuid_like()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("doc.txt");
        tokio::fs::write(&path, b"hello").await.unwrap();

        let result = generate_thumbnail(&path, "text/plain", 200)
            .await
            .expect("generate_thumbnail should not error on unsupported mime");
        let _ = tokio::fs::remove_dir_all(&dir).await;

        assert!(result["data"].is_null());
    }
}
