"use client";

/**
 * Sound files in `public/sounds`, played through Web Audio: `match.mp3` for a
 * match and `signal.mp3` when a headset signal is sent. If a file is missing
 * or cannot be decoded, the synthesised notes below play instead. Browsers
 * only allow audio after a user gesture, so `armChime()` is called on the
 * first tap or key press.
 */
const MATCH_SOUND_URL = "/sounds/match.mp3";
const SIGNAL_SOUND_URL = "/sounds/signal.mp3";

let ctx: AudioContext | null = null;
const sounds = new Map<string, Promise<AudioBuffer | null>>();

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Fetched and decoded once per file; `null` means "use the synthesised notes". */
function loadSound(c: AudioContext, url: string): Promise<AudioBuffer | null> {
  let sound = sounds.get(url);
  if (!sound) {
    sound = fetch(url)
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((bytes) => c.decodeAudioData(bytes))
      .catch(() => null);
    sounds.set(url, sound);
  }
  return sound;
}

function playSound(c: AudioContext, url: string, fallback: (c: AudioContext) => void): void {
  void loadSound(c, url).then((buffer) => {
    if (!buffer) return fallback(c);
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.connect(c.destination);
    source.start();
  });
}

/** Call from a user gesture so a later match can make sound. */
export function armChime(): void {
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  // Preload so a sound starts at once, not after a download.
  void loadSound(c, MATCH_SOUND_URL);
  void loadSound(c, SIGNAL_SOUND_URL);
}

/** True once the browser will actually let us play. */
export function chimeReady(): boolean {
  return ctx !== null && ctx.state === "running";
}

function note(c: AudioContext, freq: number, at: number, dur: number, peak: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/**
 * Short confirmations for a headset signal, played through the phone's current
 * audio route (so through the glasses when they are the headset).
 * "sent": `signal.mp3`, or one bright rising blip. "not sent": two low, flat beeps.
 */
function playSynthSentTone(c: AudioContext): void {
  const t = c.currentTime + 0.01;
  note(c, 880.0, t, 0.12, 0.18); // A5
  note(c, 1318.51, t + 0.09, 0.22, 0.16); // E6
}

export function playSentTone(): void {
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  playSound(c, SIGNAL_SOUND_URL, playSynthSentTone);
}

export function playNotSentTone(): void {
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  const t = c.currentTime + 0.01;
  note(c, 220.0, t, 0.14, 0.22); // A3
  note(c, 220.0, t + 0.22, 0.14, 0.22);
}

function playSynthChime(c: AudioContext): void {
  const t = c.currentTime + 0.01;
  note(c, 587.33, t, 0.7, 0.22); // D5
  note(c, 1174.66, t, 0.5, 0.05); // soft overtone
  note(c, 880.0, t + 0.16, 0.85, 0.2); // A5
  note(c, 1760.0, t + 0.16, 0.6, 0.04);
}

export function playChime(): void {
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  playSound(c, MATCH_SOUND_URL, playSynthChime);
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate([40, 60, 80]);
    } catch {
      // not supported; sound and the visual moment are enough
    }
  }
}
