//! video transcode: probe a video's codec/dimensions via ffprobe, and if
//! it's not h264 or has an odd width/height, re-encode to h264/yuv420p with
//! guaranteed-even dimensions via ffmpeg.
//!
//! exists because some tauri/WKWebView GPU backends throw `WebGL:
//! INVALID_VALUE: Offset overflows texture dimensions` when uploading a
//! video texture whose declared width or height is odd — arbitrary
//! user-picked/peer-authored video files aren't guaranteed to have even
//! dimensions the way most encoders' own defaults do. re-encoding with
//! `scale=trunc(iw/2)*2:trunc(ih/2)*2` sidesteps that entirely, and
//! standardizing on h264 also maximizes cross-platform playback odds
//! (WKWebView's media stack supports a narrower codec set than desktop
//! Chrome/Firefox).

use std::path::Path;

use tokio::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum TranscodeError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("probe/transcode: {0}")]
    Ffmpeg(String),
}

#[derive(Debug, Clone)]
pub struct VideoProbe {
    pub codec_name: String,
    pub width: u32,
    pub height: u32,
}

/// resolve a runnable path/name for `ffmpeg` — same fallback as
/// `thumbnail.rs`'s own `resolve_ffmpeg` (see `crate::pdf::resolve_binary`'s
/// doc comment for why GUI-launched apps need this).
async fn resolve_ffmpeg() -> Option<String> {
    crate::pdf::resolve_binary("ffmpeg", "-version").await
}

/// resolve a runnable path/name for `ffprobe` — same fallback as `ffmpeg`.
async fn resolve_ffprobe() -> Option<String> {
    crate::pdf::resolve_binary("ffprobe", "-version").await
}

/// probe a video file's primary video stream codec + pixel dimensions.
pub async fn probe_video(path: &Path) -> Result<VideoProbe, TranscodeError> {
    let Some(ffprobe) = resolve_ffprobe().await else {
        return Err(TranscodeError::Ffmpeg(
            "ffprobe not found — install ffmpeg".to_string(),
        ));
    };

    let out = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .await?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(TranscodeError::Ffmpeg(format!("ffprobe failed: {stderr}")));
    }

    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // `csv=p=0` output order follows `show_entries`'s order: codec_name,width,height
    let parts: Vec<&str> = raw.split(',').collect();
    if parts.len() < 3 {
        return Err(TranscodeError::Ffmpeg(format!(
            "unexpected ffprobe output: {raw}"
        )));
    }

    let codec_name = parts[0].to_string();
    let width: u32 = parts[1]
        .parse()
        .map_err(|_| TranscodeError::Ffmpeg(format!("bad width in ffprobe output: {raw}")))?;
    let height: u32 = parts[2]
        .parse()
        .map_err(|_| TranscodeError::Ffmpeg(format!("bad height in ffprobe output: {raw}")))?;

    Ok(VideoProbe {
        codec_name,
        width,
        height,
    })
}

/// true if this video should be re-encoded before use: wrong codec, or an
/// odd width/height (a known trigger for a WebGL video-texture upload bug
/// on some tauri/WKWebView backends — see module doc comment).
pub fn needs_transcode(probe: &VideoProbe) -> bool {
    probe.codec_name != "h264" || !probe.width.is_multiple_of(2) || !probe.height.is_multiple_of(2)
}

/// re-encode `input` to h264/aac/yuv420p with even width+height, writing to
/// `output` (overwritten if it already exists).
pub async fn transcode_to_h264(input: &Path, output: &Path) -> Result<(), TranscodeError> {
    let Some(ffmpeg) = resolve_ffmpeg().await else {
        return Err(TranscodeError::Ffmpeg(
            "ffmpeg not found — install ffmpeg".to_string(),
        ));
    };

    let out = Command::new(&ffmpeg)
        .arg("-i")
        .arg(input)
        .args([
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-y",
        ])
        .arg(output)
        .output()
        .await?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(TranscodeError::Ffmpeg(format!(
            "ffmpeg transcode failed: {stderr}"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_on_path(name: &str) -> bool {
        std::process::Command::new(name)
            .arg("-version")
            .output()
            .is_ok()
    }

    #[tokio::test]
    async fn odd_width_h264_needs_transcode() {
        let probe = VideoProbe {
            codec_name: "h264".to_string(),
            width: 631,
            height: 480,
        };
        assert!(needs_transcode(&probe));
    }

    #[tokio::test]
    async fn even_h264_does_not_need_transcode() {
        let probe = VideoProbe {
            codec_name: "h264".to_string(),
            width: 640,
            height: 480,
        };
        assert!(!needs_transcode(&probe));
    }

    #[tokio::test]
    async fn non_h264_needs_transcode() {
        let probe = VideoProbe {
            codec_name: "vp9".to_string(),
            width: 640,
            height: 480,
        };
        assert!(needs_transcode(&probe));
    }

    #[tokio::test]
    async fn probe_and_transcode_vp9_fixture() {
        if !tool_on_path("ffmpeg") || !tool_on_path("ffprobe") {
            eprintln!("skipping: ffmpeg/ffprobe not found on PATH");
            return;
        }

        let work_dir = std::env::temp_dir().join(format!(
            "skein_transcode_test_{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::create_dir_all(&work_dir).await.unwrap();

        let input_path = work_dir.join("source.webm");
        // a vp9/webm fixture — libx264 itself refuses to encode a raw odd
        // (non-mod-2) width, so a wrong-codec source (routinely produced by
        // browser MediaRecorder-style capture, or any non-h264 upload) is
        // the realistic, fabricable stand-in for `needs_transcode`'s other
        // trigger condition; the odd-width case is exercised directly via
        // the pure `needs_transcode` unit tests above instead.
        let gen = tokio::process::Command::new("ffmpeg")
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=1:size=640x480:rate=1",
                "-c:v",
                "libvpx-vp9",
                "-y",
            ])
            .arg(&input_path)
            .output()
            .await
            .expect("run ffmpeg to build test video fixture");
        assert!(gen.status.success(), "fixture generation failed");

        let probe = probe_video(&input_path).await.expect("probe fixture");
        assert_eq!(probe.codec_name, "vp9");
        assert!(needs_transcode(&probe));

        let output_path = work_dir.join("even.mp4");
        transcode_to_h264(&input_path, &output_path)
            .await
            .expect("transcode fixture");

        let reprobed = probe_video(&output_path).await.expect("probe output");
        assert_eq!(reprobed.codec_name, "h264");
        assert_eq!(reprobed.width % 2, 0);
        assert_eq!(reprobed.height % 2, 0);
        assert!(!needs_transcode(&reprobed));

        let _ = tokio::fs::remove_dir_all(&work_dir).await;
    }
}
