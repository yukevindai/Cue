/**
 * Writes the three cue sounds as small WAV files into lens/Assets/Audio, so
 * the Lens ships with no third-party audio. Same notes as the Mentra miniapp
 * (apps/mentra/src/tones.ts): one soft beep (sent), two rising beeps (match),
 * one low beep (not sent). Run: pnpm --filter @cue/spectacles tones
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeedbackCue } from "../lens/Assets/Scripts/Cue/Core/feedback.ts";

interface Note {
  hz: number;
  ms: number;
}

export const CUE_NOTES: Record<FeedbackCue, Note[]> = {
  signal_sent: [{ hz: 880, ms: 120 }],
  match: [
    { hz: 660, ms: 130 },
    { hz: 990, ms: 220 },
  ],
  not_sent: [{ hz: 220, ms: 260 }],
};

const FILE_NAMES: Record<FeedbackCue, string> = {
  signal_sent: "cue-signal-sent.wav",
  match: "cue-match.wav",
  not_sent: "cue-not-sent.wav",
};

const SAMPLE_RATE = 44100;
const GAP_MS = 60;

export function synthesizeWav(notes: Note[]): Uint8Array {
  const samples: number[] = [];
  notes.forEach((note, index) => {
    if (index > 0) for (let i = 0; i < (SAMPLE_RATE * GAP_MS) / 1000; i++) samples.push(0);
    const count = Math.round((SAMPLE_RATE * note.ms) / 1000);
    const fade = Math.min(400, Math.floor(count / 4));
    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / fade, (count - 1 - i) / fade);
      samples.push(Math.round(Math.sin((2 * Math.PI * note.hz * i) / SAMPLE_RATE) * 0.5 * envelope * 32767));
    }
  });
  const dataBytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true));
  return new Uint8Array(view.buffer);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "lens", "Assets", "Audio");
  mkdirSync(outDir, { recursive: true });
  for (const cue of Object.keys(CUE_NOTES) as FeedbackCue[]) {
    writeFileSync(join(outDir, FILE_NAMES[cue]), synthesizeWav(CUE_NOTES[cue]));
    process.stdout.write(`wrote ${FILE_NAMES[cue]}\n`);
  }
}
