import { describe, expect, it } from "vitest";
import type { FeedbackCue } from "./feedback";
import { CUE_NOTES, cueDataUrl, synthesizeWav } from "./tones";

const CUES: FeedbackCue[] = ["signal_sent", "match", "not_sent"];
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

describe("tones", () => {
  it.each(CUES)("%s is a valid 16 kHz mono 16-bit PCM WAV under 1 s", (cue) => {
    const wav = synthesizeWav(CUE_NOTES[cue]);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(16000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(wav, 36, 4)).toBe("data");
    const dataLength = view.getUint32(40, true);
    expect(dataLength).toBe(wav.byteLength - 44);
    expect(dataLength % 2).toBe(0);
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(dataLength / 2 / 16000).toBeLessThan(1);
    expect(dataLength).toBeGreaterThan(0);
  });

  it.each(CUES)("%s data URL decodes to the same bytes", (cue) => {
    const url = cueDataUrl(cue);
    const prefix = "data:audio/wav;base64,";
    expect(url.startsWith(prefix)).toBe(true);
    const decoded = Uint8Array.from(Buffer.from(url.slice(prefix.length), "base64"));
    expect(decoded).toEqual(synthesizeWav(CUE_NOTES[cue]));
    expect(cueDataUrl(cue)).toBe(url);
  });

  it("the three cues are pairwise different", () => {
    const urls = CUES.map(cueDataUrl);
    expect(new Set(urls).size).toBe(3);
    const wavs = CUES.map((c) => Buffer.from(synthesizeWav(CUE_NOTES[c])).toString("hex"));
    expect(new Set(wavs).size).toBe(3);
  });
});
