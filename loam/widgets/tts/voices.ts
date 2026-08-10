/**
 * voice/capability resolution for the tts widget: the `say`-backed
 * generation capability (tauri only, checked once at boot) and the
 * browser's own `speechSynthesis` voice list (used for the always-available
 * preview, and as the generation voice picker's fallback when `say` isn't
 * around).
 */

import { dispatch, isTauriMode } from "../../src/p2p/tauri-transport";

export interface TtsVoiceOption {
  name: string;
  lang: string;
}

/** sentinel shown in the voice picker for "use the system default voice" —
 *  stored as `ttsVoiceName: ""` in the doc. */
export const VOICE_DEFAULT = "system default";

let sayAvailable = false;
let sayVoices: TtsVoiceOption[] = [];

/** probes the local `say` capability once at boot (tauri mode only) —
 *  mirrors `setPandocFormatsAvailable`'s boot-time pattern in upload.ts.
 *  browser mode never calls this, so `sayAvailable` stays false there — the
 *  correct "no generation backend at all" default. */
export async function checkSayAvailable(): Promise<void> {
  if (!isTauriMode()) return;
  try {
    const result = await dispatch("say_check_available");
    sayAvailable = !!result?.available;
    sayVoices = Array.isArray(result?.voices) ? result.voices : [];
  } catch {
    sayAvailable = false;
    sayVoices = [];
  }
}

/** whether the "generate audio" action should be offered on this peer right
 *  now — checked live at render/action time, never persisted in the doc: a
 *  doc authored on a say-less machine still gets a working generate button
 *  on any later tauri+say peer who opens it. */
export function isGenerateAvailable(): boolean {
  return sayAvailable;
}

/** the real, machine-accurate voice list from `say -v ?`, when available. */
export function getSayVoices(): TtsVoiceOption[] {
  return sayVoices;
}

// ---------------------------------------------------------------------------
// browser speechSynthesis — always-available preview, works on every platform
// ---------------------------------------------------------------------------

let cachedBrowserVoices: SpeechSynthesisVoice[] = [];

function refreshBrowserVoices(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  cachedBrowserVoices = window.speechSynthesis.getVoices();
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  refreshBrowserVoices();
  window.speechSynthesis.addEventListener("voiceschanged", refreshBrowserVoices);
}

/** display names for the voice picker — prefers `say`'s real, machine-
 *  accurate list when available (tauri + say), falls back to the browser's
 *  own `speechSynthesis` voice list otherwise. always leads with
 *  `VOICE_DEFAULT`. */
export function listVoiceNames(): string[] {
  const names =
    sayAvailable && sayVoices.length > 0
      ? sayVoices.map((v) => v.name)
      : cachedBrowserVoices.map((v) => v.name);
  return [VOICE_DEFAULT, ...names];
}

/** resolves a chosen voice name back to its BCP-47 lang hint, when known —
 *  stored alongside `ttsVoiceName` as a fallback filter for a peer that
 *  doesn't have that exact voice installed. */
export function langForVoiceName(name: string): string {
  const sayMatch = sayVoices.find((v) => v.name === name);
  if (sayMatch) return sayMatch.lang;
  const browserMatch = cachedBrowserVoices.find((v) => v.name === name);
  return browserMatch?.lang ?? "";
}

// ---------------------------------------------------------------------------
// preview — speaks text via speechSynthesis, works everywhere, never gated
// ---------------------------------------------------------------------------

let activeUtterance: SpeechSynthesisUtterance | null = null;

export function isPreviewSpeaking(): boolean {
  return activeUtterance !== null;
}

export function speakPreview(text: string, voiceName: string, rate: number, onEnd: () => void): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  cancelPreview();
  if (!text.trim()) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  const voice = cachedBrowserVoices.find((v) => v.name === voiceName);
  if (voice) utterance.voice = voice;
  utterance.onend = () => {
    activeUtterance = null;
    onEnd();
  };
  utterance.onerror = () => {
    activeUtterance = null;
    onEnd();
  };
  activeUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function cancelPreview(): void {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  activeUtterance = null;
}
