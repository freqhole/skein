//! blob thumbnail generation for the hub — serves real thumbnails to
//! browser peers over the `skein/1` proxy protocol instead of falling back
//! to raw original bytes (which is all a plain browser peer can offer).
//!
//! supports four source types:
//! - image/*: decoded + resized in-process via the `image` crate (through
//!   `freqhole_reliquary::media`), returned as webp.
//! - application/pdf, application/postscript (or a recognized document
//!   filename extension): first page only, via `magick`, returned as png.
//!   format is inferred from the stored filename's extension when
//!   available (see `crate::pdf::DocumentFormat::from_filename`), falling
//!   back to the mime type only for `application/pdf`.
//! - video/*: first frame via ffprobe/ffmpeg, returned as png.
//! - audio/*: waveform image via ffmpeg's `showwavespic` filter, returned
//!   as png.
//! - everything else: returns `{ data: null }`.
//!
//! video/audio are delegated to `freqhole_reliquary::media::thumbnails`
//! (feature `thumbnails`), which already links ffmpeg/ffprobe as
//! subprocesses on the hub host — no new binary dependency here since this
//! workspace already depends on reliquary.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};

#[derive(Debug, thiserror::Error)]
pub enum ThumbnailError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("image decode/encode: {0}")]
    Image(String),

    #[error("document render: {0}")]
    Render(#[from] crate::pdf::PdfRenderError),

    #[error("media thumbnail: {0}")]
    Media(#[from] freqhole_reliquary::media::thumbnails::ThumbnailError),
}

/// generate a thumbnail for a blob given its bytes, mime, and (if any)
/// stored filename — filename is used to distinguish pdf/postscript/plain
/// text when mime alone doesn't (e.g. a generic `application/octet-stream`).
///
/// returns a json value of the shape `{ data: <base64-string>, mime: <str> }`
/// for supported types, or `{ data: null }` for unsupported ones.
pub async fn generate_thumbnail(
    blob_bytes: &[u8],
    mime: &str,
    filename: Option<&str>,
    size: u32,
) -> Result<Value, ThumbnailError> {
    if mime.starts_with("image/") {
        return thumbnail_image(blob_bytes, size);
    }

    let format = filename
        .and_then(crate::pdf::DocumentFormat::from_filename)
        .or({
            if mime == "application/pdf" {
                Some(crate::pdf::DocumentFormat::Pdf)
            } else {
                None
            }
        });

    if let Some(format) = format {
        return thumbnail_document(blob_bytes, format, size).await;
    }

    if mime.starts_with("video/") || mime.starts_with("audio/") {
        return thumbnail_media(blob_bytes, mime, size).await;
    }

    Ok(json!({ "data": null }))
}

fn thumbnail_image(bytes: &[u8], size: u32) -> Result<Value, ThumbnailError> {
    let webp = freqhole_reliquary::media::resize_to_square_webp(bytes, size)
        .map_err(|e| ThumbnailError::Image(e.to_string()))?;
    Ok(json!({ "data": B64.encode(&webp), "mime": "image/webp" }))
}

async fn thumbnail_document(
    bytes: &[u8],
    format: crate::pdf::DocumentFormat,
    size: u32,
) -> Result<Value, ThumbnailError> {
    let png_bytes = crate::pdf::render_first_page_thumbnail(bytes, format, size).await?;
    Ok(json!({ "data": B64.encode(&png_bytes), "mime": "image/png" }))
}

// reliquary's `generate_thumbnail` works on a file path, not bytes, so we
// write the blob to a scratch temp dir first and always clean it up
// afterward (even on the error path), mirroring reliquary's own
// thumbnail_video/thumbnail_pdf temp-dir style.
async fn thumbnail_media(bytes: &[u8], mime: &str, size: u32) -> Result<Value, ThumbnailError> {
    let work_dir = std::env::temp_dir().join(format!("tumulus_thumb_{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&work_dir).await?;
    let blob_path = work_dir.join("blob");

    if let Err(e) = tokio::fs::write(&blob_path, bytes).await {
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return Err(ThumbnailError::Io(e));
    }

    let result =
        freqhole_reliquary::media::thumbnails::generate_thumbnail(&blob_path, mime, size).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;

    match result? {
        Some(freqhole_reliquary::media::thumbnails::ThumbnailBytes { data, mime }) => {
            Ok(json!({ "data": B64.encode(&data), "mime": mime }))
        }
        None => Ok(json!({ "data": null })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// true if `name` resolves on `PATH`. used to skip (not fail) the
    /// subprocess-backed tests below on machines without ffmpeg/ffprobe
    /// installed.
    fn tool_on_path(name: &str) -> bool {
        std::process::Command::new(name)
            .arg("-version")
            .output()
            .is_ok()
    }

    #[tokio::test]
    async fn video_mime_produces_a_png_thumbnail_via_ffmpeg() {
        if !tool_on_path("ffmpeg") || !tool_on_path("ffprobe") {
            eprintln!("skipping: ffmpeg/ffprobe not found on PATH");
            return;
        }

        let tmp = tempfile::tempdir().expect("tempdir");
        let video_path = tmp.path().join("clip.mp4");

        // synthesize a tiny 1-second test-pattern clip - no real footage needed.
        let gen = tokio::process::Command::new("ffmpeg")
            .args(["-f", "lavfi", "-i", "color=red:size=64x64:duration=1"])
            .arg("-y")
            .arg(&video_path)
            .output()
            .await
            .expect("run ffmpeg to build test video fixture");
        assert!(
            gen.status.success(),
            "failed to build test video fixture: {}",
            String::from_utf8_lossy(&gen.stderr)
        );

        let bytes = tokio::fs::read(&video_path).await.expect("read fixture");

        let thumb = generate_thumbnail(&bytes, "video/mp4", None, 32)
            .await
            .expect("generate_thumbnail");
        assert_eq!(thumb["mime"], "image/png");
        let data = thumb["data"].as_str().expect("data should be present");
        let decoded = B64.decode(data).expect("valid base64");
        assert_eq!(&decoded[1..4], b"PNG");
    }

    #[tokio::test]
    async fn audio_mime_produces_a_png_thumbnail_via_ffmpeg() {
        if !tool_on_path("ffmpeg") {
            eprintln!("skipping: ffmpeg not found on PATH");
            return;
        }

        let tmp = tempfile::tempdir().expect("tempdir");
        let audio_path = tmp.path().join("tone.wav");

        // synthesize a tiny 1-second test tone - no real audio needed.
        let gen = tokio::process::Command::new("ffmpeg")
            .args(["-f", "lavfi", "-i", "sine=frequency=1000:duration=1"])
            .arg("-y")
            .arg(&audio_path)
            .output()
            .await
            .expect("run ffmpeg to build test audio fixture");
        assert!(
            gen.status.success(),
            "failed to build test audio fixture: {}",
            String::from_utf8_lossy(&gen.stderr)
        );

        let bytes = tokio::fs::read(&audio_path).await.expect("read fixture");

        let thumb = generate_thumbnail(&bytes, "audio/wav", None, 32)
            .await
            .expect("generate_thumbnail");
        assert_eq!(thumb["mime"], "image/png");
        let data = thumb["data"].as_str().expect("data should be present");
        let decoded = B64.decode(data).expect("valid base64");
        assert_eq!(&decoded[1..4], b"PNG");
    }
}
