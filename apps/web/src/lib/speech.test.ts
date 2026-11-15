import { describe, expect, it, vi } from "vitest";
import {
  listenOnce,
  primeSpeech,
  readTranscript,
  recognitionProblem,
  recognitionSupported,
  speak,
  type SpeechEnv,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
  type SynthesisLike,
  type UtteranceLike,
} from "./speech";

function results(parts: { text: string; final: boolean }[]): SpeechRecognitionEventLike {
  const list = parts.map((p) => Object.assign([{ transcript: p.text }], { isFinal: p.final }));
  return { results: list };
}

class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onerror?.({ error: "aborted" });
    this.onend?.();
  }
}

const recEnv = (): SpeechEnv => ({ webkitSpeechRecognition: FakeRecognition });

class FakeUtterance implements UtteranceLike {
  lang = "";
  volume = 1;
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function synthEnv(autoEnd = true) {
  const spoken: FakeUtterance[] = [];
  const synth: SynthesisLike = {
    speak(u) {
      spoken.push(u as FakeUtterance);
      if (autoEnd) setTimeout(() => u.onend?.(), 0);
    },
    cancel() {},
  };
  const env: SpeechEnv = { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance };
  return { env, spoken };
}

describe("recognitionProblem", () => {
  it("maps browser error codes", () => {
    expect(recognitionProblem("not-allowed")).toBe("denied");
    expect(recognitionProblem("service-not-allowed")).toBe("denied");
    expect(recognitionProblem("audio-capture")).toBe("no_microphone");
    expect(recognitionProblem("no-speech")).toBe("no_speech");
    expect(recognitionProblem("network")).toBe("network");
    expect(recognitionProblem("aborted")).toBe("aborted");
    expect(recognitionProblem("language-not-supported")).toBe("failed");
  });
});

describe("readTranscript", () => {
  it("joins results and reports whether the last is final", () => {
    expect(readTranscript(results([{ text: "hi my", final: false }]).results).final).toBe(false);
    expect(
      readTranscript(results([{ text: "hi my name", final: true }, { text: " is Sam ", final: true }]).results),
    ).toEqual({ text: "hi my name is Sam", final: true });
  });
});

describe("feature detection", () => {
  it("finds either constructor", () => {
    expect(recognitionSupported({})).toBe(false);
    expect(recognitionSupported({ SpeechRecognition: FakeRecognition })).toBe(true);
    expect(recognitionSupported(recEnv())).toBe(true);
  });
});

describe("listenOnce", () => {
  it("is unsupported without recognition", async () => {
    await expect(listenOnce({ env: {} }).result).resolves.toEqual({
      kind: "problem",
      problem: "unsupported",
      heard: "",
    });
  });

  it("configures recognition and resolves with the final transcript", async () => {
    const heard: string[] = [];
    const l = listenOnce({ env: recEnv(), onHeard: (t) => heard.push(t) });
    const rec = FakeRecognition.last!;
    expect(rec).toMatchObject({ lang: "en-US", continuous: false, interimResults: true, started: true });
    rec.onresult?.(results([{ text: "hi my", final: false }]));
    rec.onresult?.(results([{ text: "hi my name is Sam", final: true }]));
    rec.onend?.();
    await expect(l.result).resolves.toEqual({ kind: "heard", transcript: "hi my name is Sam" });
    expect(heard).toEqual(["hi my", "hi my name is Sam"]);
  });

  it("uses interim words when the engine ends without a final result", async () => {
    const l = listenOnce({ env: recEnv() });
    FakeRecognition.last!.onresult?.(results([{ text: "I'm Riley", final: false }]));
    FakeRecognition.last!.onend?.();
    await expect(l.result).resolves.toEqual({ kind: "heard", transcript: "I'm Riley" });
  });

  it("reports no speech, denial and network errors", async () => {
    let l = listenOnce({ env: recEnv() });
    FakeRecognition.last!.onerror?.({ error: "no-speech" });
    FakeRecognition.last!.onend?.();
    await expect(l.result).resolves.toMatchObject({ kind: "problem", problem: "no_speech" });

    l = listenOnce({ env: recEnv() });
    FakeRecognition.last!.onerror?.({ error: "not-allowed" });
    FakeRecognition.last!.onend?.();
    await expect(l.result).resolves.toMatchObject({ kind: "problem", problem: "denied" });

    l = listenOnce({ env: recEnv() });
    FakeRecognition.last!.onresult?.(results([{ text: "hi my", final: false }]));
    FakeRecognition.last!.onerror?.({ error: "network" });
    FakeRecognition.last!.onend?.();
    await expect(l.result).resolves.toEqual({ kind: "problem", problem: "network", heard: "hi my" });
  });

  it("gives up after the timeout and keeps what was heard", async () => {
    vi.useFakeTimers();
    try {
      const l = listenOnce({ env: recEnv(), timeoutMs: 1000 });
      const rec = FakeRecognition.last!;
      rec.stop = () => {}; // an engine that never fires `end`
      rec.onresult?.(results([{ text: "call me Jo", final: false }]));
      await vi.advanceTimersByTimeAsync(3000);
      await expect(l.result).resolves.toEqual({ kind: "heard", transcript: "call me Jo" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort settles as aborted", async () => {
    const l = listenOnce({ env: recEnv() });
    l.abort();
    await expect(l.result).resolves.toMatchObject({ kind: "problem", problem: "aborted" });
  });
});

describe("synthesis", () => {
  it("primes with a silent empty utterance", () => {
    const { env, spoken } = synthEnv();
    primeSpeech(env);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ text: "", volume: 0 });
  });

  it("speaks in English and resolves when done", async () => {
    const { env, spoken } = synthEnv();
    await speak("Yo Sam, you're in.", { env });
    expect(spoken[0]).toMatchObject({ text: "Yo Sam, you're in.", lang: "en-US", volume: 1 });
  });

  it("never waits longer than maxWaitMs", async () => {
    vi.useFakeTimers();
    try {
      const { env } = synthEnv(false);
      let done = false;
      void speak("hello", { env, maxWaitMs: 2500 }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(2400);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op without synthesis", async () => {
    primeSpeech({});
    await expect(speak("hello", { env: {} })).resolves.toBeUndefined();
  });
});
