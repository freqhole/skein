//! shells out to macOS's `say` binary — the actual `say`-specific logic
//! (voice listing, wav generation, duration calc), kept separate from
//! `tts/mod.rs`'s tauri-command-facing glue (blob storage, `DispatchError`
//! mapping) so this file has zero tauri/reliquary dependencies and could be
//! swapped for a different tts backend later without touching `mod.rs`'s
//! public shape.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

/// common install *directories* a GUI-launched app's `PATH` often omits —
/// same list as `pdf.rs`'s `COMMON_BIN_DIRS`, duplicated rather than shared
/// across modules since it's a 4-line const and this keeps `tts/` fully
/// independent of `pdf.rs`'s internals.
const COMMON_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // homebrew, apple silicon
    "/usr/local/bin",    // homebrew, intel, linux
    "/opt/local/bin",    // macports
    "/usr/bin",          // linux
];

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SayVoice {
    pub name: String,
    pub lang: String,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum TtsError {
    #[error("`say` not found on this machine")]
    SayMissing,
    #[error("say failed (exit {status}): {stderr}")]
    SayFailed { status: i32, stderr: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// runs `say -v ?`, which the `say(1)` man page documents as printing every
/// installed voice and exiting immediately — unlike a bare `say` with no
/// text/`-f` argument (which reads from stdin and would hang forever on a
/// pipe with no eof), this never blocks, so it's safe to use both as the
/// availability probe and to fetch the real voice list in one subprocess
/// call instead of two.
pub(super) async fn resolve_say_and_voices() -> Option<(String, Vec<SayVoice>)> {
    async fn try_path(path: &str) -> Option<std::process::Output> {
        Command::new(path).arg("-v").arg("?").output().await.ok()
    }

    if let Some(output) = try_path("say").await {
        if output.status.success() {
            return Some(("say".to_string(), parse_say_voices(&output.stdout)));
        }
    }

    for dir in COMMON_BIN_DIRS {
        let candidate = PathBuf::from(dir).join("say");
        let candidate_str = candidate.to_string_lossy().into_owned();
        if let Some(output) = try_path(&candidate_str).await {
            if output.status.success() {
                return Some((candidate_str, parse_say_voices(&output.stdout)));
            }
        }
    }

    None
}

/// parses `say -v ?`'s output — one voice per line, roughly
/// `<name...>   <lang_code>   # <sample text>` (voice names can contain
/// spaces, e.g. "Bad News") — into a `{ name, lang }` list, normalizing
/// say's underscore locale form (`en_US`) to the BCP-47 dash form
/// (`en-US`) already used by `AudioClip`/the tts widget's `ttsVoiceLang`.
fn parse_say_voices(stdout: &[u8]) -> Vec<SayVoice> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                return None;
            }
            let mut parts: Vec<&str> = line.split_whitespace().collect();
            let lang_raw = parts.pop()?;
            if parts.is_empty() {
                return None;
            }
            Some(SayVoice {
                name: parts.join(" "),
                lang: lang_raw.replace('_', "-"),
            })
        })
        .collect()
}

/// `say`'s own default speech rate, in words per minute — the baseline the
/// portable `ttsRate`/`ttsDefaultRate` multiplier (1.0 = normal speed)
/// scales from. say's actual per-voice default varies slightly; this is a
/// reasonable, documented middle value (see `say(1)`'s `-r` option).
const SAY_BASE_WPM: f64 = 175.0;
const SAY_MIN_WPM: f64 = 30.0;
const SAY_MAX_WPM: f64 = 500.0;

/// the fixed linear-pcm format `generate_speech_wav` always requests from
/// `say` — mono/16-bit/22050hz plays back universally in an html `<audio>`
/// element (say's own default, aiff, does not in chromium-based
/// browsers/webviews — confirmed by hand: `say -o out.wav` alone fails
/// with "Opening output file failed: fmt?", `--file-format`/`--data-format`
/// are required to get a real wav). knowing the exact format up front also
/// lets `wav_duration_secs` compute duration analytically, without a real
/// wav-parsing dependency.
const SAY_SAMPLE_RATE: u32 = 22050;
const SAY_CHANNELS: u32 = 1;
const SAY_BITS_PER_SAMPLE: u32 = 16;

/// generates real speech audio for `text` via `say`, writing a `.wav` file
/// at `out_path` (the caller — `tts_generate` in `tts/mod.rs` — picks a
/// fresh temp path and adopts the result into managed blob storage
/// afterward). `rate` is the portable `ttsRate` multiplier; `voice_name`,
/// if given, is passed straight through to `-v` — the caller is
/// responsible for resolving a name the local `say` actually has (see
/// `resolve_say_and_voices`'s voice list) before calling this, since `say`
/// itself just falls back to the system-default voice on an unknown name.
pub(super) async fn generate_speech_wav(
    text: &str,
    voice_name: Option<&str>,
    rate: Option<f64>,
    out_path: &Path,
) -> Result<(), TtsError> {
    let Some((say_path, _)) = resolve_say_and_voices().await else {
        return Err(TtsError::SayMissing);
    };

    let wpm = (SAY_BASE_WPM * rate.unwrap_or(1.0)).clamp(SAY_MIN_WPM, SAY_MAX_WPM) as u32;

    let mut cmd = Command::new(&say_path);
    if let Some(voice) = voice_name {
        cmd.arg("-v").arg(voice);
    }
    cmd.arg("-r")
        .arg(wpm.to_string())
        .arg("--file-format=WAVE")
        .arg(format!("--data-format=LEI16@{SAY_SAMPLE_RATE}"))
        .arg("-o")
        .arg(out_path)
        .arg(text);

    let output = cmd.output().await?;
    if !output.status.success() {
        return Err(TtsError::SayFailed {
            status: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }
    Ok(())
}

/// duration in seconds for a wav file `generate_speech_wav` just wrote —
/// computed analytically from the fixed format we always request (see
/// `SAY_SAMPLE_RATE`/`SAY_CHANNELS`/`SAY_BITS_PER_SAMPLE`) by scanning for
/// the `data` riff subchunk and dividing its byte length by
/// bytes-per-second, rather than pulling in a full wav-parsing dependency
/// for a format we chose ourselves. cross-checked by hand against
/// `afinfo`'s reported duration on a real generated file and matched
/// exactly.
pub(super) fn wav_duration_secs(wav_bytes: &[u8]) -> Option<f64> {
    let data_len = find_riff_data_chunk_len(wav_bytes)?;
    let bytes_per_second =
        SAY_SAMPLE_RATE as f64 * SAY_CHANNELS as f64 * (SAY_BITS_PER_SAMPLE as f64 / 8.0);
    Some(data_len as f64 / bytes_per_second)
}

fn find_riff_data_chunk_len(bytes: &[u8]) -> Option<u32> {
    let mut i = 12usize; // past the 12-byte RIFF/WAVE header
    while i + 8 <= bytes.len() {
        let chunk_id = &bytes[i..i + 4];
        let chunk_len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().ok()?);
        if chunk_id == b"data" {
            return Some(chunk_len.min((bytes.len() - i - 8) as u32));
        }
        // riff chunks are word-aligned: an odd-length chunk has one pad byte.
        i += 8 + chunk_len as usize + (chunk_len % 2) as usize;
    }
    None
}

/// quick non-cryptographic unique id for temp dir naming — same approach as
/// `pdf.rs`'s private `uuid_like()`, duplicated here for the same reason as
/// `COMMON_BIN_DIRS` above.
pub(super) fn temp_run_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
