//! blob thumbnail generation for the hub — serves real thumbnails to
//! browser peers over the `skein/1` proxy protocol instead of falling back
//! to raw original bytes (which is all a plain browser peer can offer).
//!
//! supports two source types (deliberately narrower than tauri's
//! `thumbnail.rs`, which also handles video/audio via ffmpeg — adding that
//! here would mean a new binary dependency on the hub host, out of scope
//! for now):
//! - image/*: decoded + resized in-process via the `image` crate (through
//!   `freqhole_reliquary::media`), returned as webp.
//! - application/pdf, application/postscript, text/plain (or a recognized
//!   document filename extension): first page only, via `magick`, returned
//!   as png. format is inferred from the stored filename's extension when
//!   available (see `crate::pdf::DocumentFormat::from_filename`), falling
//!   back to the mime type only for `application/pdf`.
//! - everything else: returns `{ data: null }`.

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
