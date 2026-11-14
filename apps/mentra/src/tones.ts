import type { FeedbackCue } from "./feedback";

/**
 * Short audio cues, synthesized as tiny WAV files so the miniapp needs no
 * network request or bundled asset to acknowledge a swipe. Three clearly
 * different shapes: one soft beep (sent), two rising beeps (match), one low
 * beep (not sent).
 */
interface Note {
  hz: number;
  ms: number;
}

const SAMPLE_RATE = 16000;
const GAP_MS = 60;

export const CUE_NOTES: Record<FeedbackCue, Note[]> = {
  signal_sent: [{ hz: 880, ms: 120 }],
  match: [
    { hz: 660, ms: 130 },
    { hz: 990, ms: 220 },
  ],
  not_sent: [{ hz: 220, ms: 260 }],
};

export function synthesizeWav(notes: Note[]): Uint8Array {
  const samples: number[] = [];
  notes.forEach((note, index) => {
    if (index > 0) for (let i = 0; i < (SAMPLE_RATE * GAP_MS) / 1000; i++) samples.push(0);
    const count = Math.round((SAMPLE_RATE * note.ms) / 1000);
    const fade = Math.min(160, Math.floor(count / 4));
    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / fade, (count - 1 - i) / fade);
      samples.push(Math.round(Math.sin((2 * Math.PI * note.hz * i) / SAMPLE_RATE) * 0.5 * envelope * 32767));
    }
  });
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return new Uint8Array(buffer);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const cache = new Map<FeedbackCue, string>();

export function cueDataUrl(cue: FeedbackCue): string {
  let url = cache.get(cue);
  if (url === undefined) {
    url = `data:audio/wav;base64,${toBase64(synthesizeWav(CUE_NOTES[cue]))}`;
    cache.set(cue, url);
  }
  return url;
}

/** Spoken fallback when clip playback fails. Says nothing about anyone else. */
export const CUE_SPEECH: Record<FeedbackCue, string> = {
  signal_sent: "Sent",
  match: "It's a match",
  not_sent: "Not sent",
};
