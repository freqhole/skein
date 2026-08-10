//! standalone tts widget backend: macOS `say`-backed speech generation.
//!
//! `say.rs` holds the actual `say`-shelling-out logic (voice listing, wav
//! generation, duration calc); this file is the tauri-command-facing half —
//! capability probing and adopting a generated wav into managed blob
//! storage, mirroring `commands.rs`'s existing `blob_insert`/
//! `blob_insert_from_path` shape.

mod say;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use freqhole_reliquary::blobz::NewBlobMeta;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::{prewarm_fs_store, AppState, BlobDto, DispatchError, MIRROR_DATA_MAX_BYTES};

pub(crate) use say::SayVoice;

/// checks whether `say` is available on this machine, and if so, returns
/// its full voice list — called once at boot (mirrors
/// `pandoc_backend_available`) and cached frontend-side; also re-checked
/// per-call by `tts_generate` below since this is cheap and the capability
/// is never assumed to be stable across peers.
pub(crate) async fn say_check_available() -> Option<Vec<SayVoice>> {
    say::resolve_say_and_voices()
        .await
        .map(|(_, voices)| voices)
}

/// best-effort removal of `tts_generate`'s working directory on every exit
/// path — `say` writes its output wav inside, alongside nothing else, so
/// the whole dir is disposable once the wav has been read/adopted (mirrors
/// `commands.rs`'s `TempFileGuard`, but for a directory).
struct TempDirGuard(std::path::PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct TtsGenerateArgs {
    text: String,
    voice_name: Option<String>,
    rate: Option<f64>,
}

/// generates real tts speech audio via the local `say` binary and adopts
/// the resulting wav into managed blob storage — it's a byproduct this
/// command created, not a user-owned file, so it's moved in via
/// `adopt_local_file`, never `register_external_path`'d (mirrors the
/// repaired-epub synthesized-temp-file case in
/// `commands::blob_insert_from_path_impl`). returns the same `{ meta, data
/// }` shape `blob_insert`/`blob_insert_from_path` already return, plus
/// `duration_secs` (computed from the wav itself — `BlobDto` has no
/// duration field, since most blobs don't have a knowable one at insert
/// time).
pub(crate) async fn tts_generate(
    args: TtsGenerateArgs,
    state: &AppState,
) -> Result<Value, DispatchError> {
    if args.text.trim().is_empty() {
        return Err(DispatchError::InvalidPayload {
            action: "tts_generate",
            source: serde::de::Error::custom("text must not be empty"),
        });
    }

    let run_id = say::temp_run_id();
    let work_dir = std::env::temp_dir().join(format!("skein_tts_{run_id}"));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|e| DispatchError::Tts(format!("create temp dir: {e}")))?;
    let _work_dir_guard = TempDirGuard(work_dir.clone());
    let wav_path = work_dir.join("speech.wav");

    say::generate_speech_wav(&args.text, args.voice_name.as_deref(), args.rate, &wav_path)
        .await
        .map_err(|e| DispatchError::Tts(e.to_string()))?;

    let wav_bytes = tokio::fs::read(&wav_path)
        .await
        .map_err(|e| DispatchError::Tts(format!("read generated audio: {e}")))?;
    let duration_secs = say::wav_duration_secs(&wav_bytes);

    // tts clips are inherently small (seconds to low minutes of 22khz mono
    // audio) so this threshold is essentially never hit in practice, but
    // reusing it keeps the "when do we mirror bytes back" rule in one
    // place, matching `blob_insert_from_path_impl`.
    let mirror_data = if (wav_bytes.len() as u64) <= MIRROR_DATA_MAX_BYTES {
        Some(Value::String(B64.encode(&wav_bytes)))
    } else {
        None
    };

    let blob = state
        .storage
        .blobz
        .adopt_local_file(
            &wav_path,
            NewBlobMeta {
                filename: Some(format!("tts_{run_id}.wav")),
                mime: Some("audio/wav".to_string()),
                ..Default::default()
            },
        )
        .await
        .map_err(DispatchError::Blob)?;
    prewarm_fs_store(state, &blob).await;

    Ok(json!({
        "meta": BlobDto::from(blob),
        "data": mirror_data,
        "duration_secs": duration_secs,
    }))
}
