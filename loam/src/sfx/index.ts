/**
 * short synthesized sound effects (friend online, new message, friend
 * request) — deliberately isolated from the rest of the audio stack.
 *
 * unlike src/media/audio-manager.ts (which plays real media blobs through
 * <audio>/<video> elements, with blob URL lifecycle management, platform-
 * specific playback quirks, etc.), this module has exactly one job: fire a
 * short WebAudio-synthesized tone and forget about it. no blobs, no
 * <audio> elements, no shared playback state, no dependency on any other
 * part of the app.
 *
 * this module has no concept of a "sound effects enabled" setting — that's
 * a user preference (see widgets/narthex/social/schema.ts's
 * `soundEffectsFriendsOnlineEnabled`/`soundEffectsMessagesEnabled`), and
 * gating on it is the caller's job (see src/standalone/friendz-wiring.ts's
 * onPeerBecameOnline/onFriendRequest/onCanvasKnock handlers). keeping that
 * decision out of this module is what makes it trivially reusable/testable
 * on its own.
 */

let sharedContext: AudioContext | null = null;

/** lazily create (or reuse) a single shared AudioContext. returns null in
 *  any environment without WebAudio (SSR, an old browser, jsdom in tests). */
function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  if (!sharedContext) {
    sharedContext = new Ctor();
  }
  // browsers suspend a freshly-created AudioContext until a user gesture —
  // these are optional UI flourishes, not required audio, so a failed/no-op
  // resume is fine; the tone will just silently not play that one time.
  if (sharedContext.state === "suspended") {
    void sharedContext.resume().catch(() => {});
  }
  return sharedContext;
}

/** a single note in a synthesized tone sequence. */
interface Note {
  /** frequency in Hz */
  freq: number;
  /** duration in seconds */
  duration: number;
}

/** play one short tone with a soft linear fade in/out envelope, so it
 *  doesn't click at the start/end the way a hard on/off gain would. */
function playTone(ctx: AudioContext, note: Note, startAt: number, gain: number): void {
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = note.freq;

  const attack = 0.01;
  const release = Math.min(0.05, note.duration / 2);
  gainNode.gain.setValueAtTime(0, startAt);
  gainNode.gain.linearRampToValueAtTime(gain, startAt + attack);
  gainNode.gain.setValueAtTime(gain, Math.max(startAt + attack, startAt + note.duration - release));
  gainNode.gain.linearRampToValueAtTime(0, startAt + note.duration);

  osc.connect(gainNode);
  gainNode.connect(ctx.destination);
  // disconnect once finished — without this the audio graph accumulates a
  // dead oscillator + gain node pair per tone for the lifetime of the
  // shared context, which over a long-running session can add up to
  // audible glitching/underrun as the graph grows.
  osc.onended = () => {
    osc.disconnect();
    gainNode.disconnect();
  };
  osc.start(startAt);
  osc.stop(startAt + note.duration + 0.02);
}

/** play a short sequence of notes back to back, starting now. */
function playSequence(notes: Note[], gain = 0.15): void {
  try {
    const ctx = getContext();
    if (!ctx) return;
    let t = ctx.currentTime;
    for (const note of notes) {
      playTone(ctx, note, t, gain);
      t += note.duration;
    }
  } catch {
    // a sound effect is a non-essential flourish — never let a WebAudio
    // failure propagate into a caller's real logic (friend-online
    // handling, friend-request handling, etc).
  }
}

/** a friend came online — short upward two-note ping. */
export function playFriendOnlineSound(): void {
  playSequence([
    { freq: 660, duration: 0.08 },
    { freq: 880, duration: 0.1 },
  ]);
}

/** a new message/notification arrived — a single soft blip. */
export function playNewMessageSound(): void {
  playSequence([{ freq: 520, duration: 0.09 }]);
}

/** a friend request arrived — a slightly longer three-note ascending chime. */
export function playFriendRequestSound(): void {
  playSequence([
    { freq: 440, duration: 0.08 },
    { freq: 550, duration: 0.08 },
    { freq: 660, duration: 0.12 },
  ]);
}
