"use client";

/**
 * The match sound: two soft notes a fifth apart, about 0.9 s, synthesised with
 * Web Audio so there is no asset to load. Browsers only allow audio after a
 * user gesture, so `armChime()` is called on the first tap or key press.
 */
let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Call from a user gesture so a later match can make sound. */
export function armChime(): void {
  const c = getContext();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
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

export function playChime(): void {
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  const t = c.currentTime + 0.01;
  note(c, 587.33, t, 0.7, 0.22); // D5
  note(c, 1174.66, t, 0.5, 0.05); // soft overtone
  note(c, 880.0, t + 0.16, 0.85, 0.2); // A5
  note(c, 1760.0, t + 0.16, 0.6, 0.04);
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate([40, 60, 80]);
    } catch {
      // not supported; sound and the visual moment are enough
    }
  }
}
