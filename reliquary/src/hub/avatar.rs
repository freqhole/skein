//! image processing helpers — avatar resize + webp encode.
//!
//! replaces `grimoire::blob_data::resize_to_square_webp`. used by the hub
//! peer to process the configured avatar image into a thumbnail data URL
//! that gets cached in `userz` and served on `ProfileRequest`.

use image::imageops::FilterType;

/// resize an image to a square thumbnail and re-encode as webp.
///
/// uses lanczos3 resampling and lossy webp at quality 75 — good balance
/// between size and visual fidelity for 128px avatars (typical output:
/// 4–8KB).
pub fn resize_to_square_webp(bytes: &[u8], size: u32) -> anyhow::Result<Vec<u8>> {
    let img =
        image::load_from_memory(bytes).map_err(|e| anyhow::anyhow!("decode source image: {e}"))?;
    let resized = img.resize_to_fill(size, size, FilterType::Lanczos3);

    let encoder = webp::Encoder::from_image(&resized)
        .map_err(|e| anyhow::anyhow!("webp encode init: {e}"))?;
    Ok(encoder.encode(75.0).to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// build a tiny in-memory PNG so we don't need any test fixtures on disk.
    fn tiny_png() -> Vec<u8> {
        let img = image::RgbImage::from_fn(16, 16, |x, y| {
            image::Rgb([(x * 16) as u8, (y * 16) as u8, 0])
        });
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn round_trip_png_to_webp() {
        let png = tiny_png();
        let webp = resize_to_square_webp(&png, 32).expect("encode webp");
        assert!(!webp.is_empty(), "webp output should not be empty");
        // first 4 bytes of webp file are "RIFF"
        assert_eq!(&webp[0..4], b"RIFF", "expected RIFF header");
        // bytes 8..12 are "WEBP"
        assert_eq!(&webp[8..12], b"WEBP", "expected WEBP signature");
    }

    #[test]
    fn rejects_non_image_bytes() {
        let result = resize_to_square_webp(b"not an image at all", 64);
        assert!(result.is_err());
    }
}
