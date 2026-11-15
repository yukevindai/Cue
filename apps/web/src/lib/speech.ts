/**
 * Thin wrappers around the browser's Web Speech API: speech recognition
 * ("Say hi" guest entry) and speech synthesis (the spoken confirmation and the
 * wingman line on a match).
 *
 * Everything reads the API from a `SpeechEnv`, which defaults to `window` at
 * call time. Tests pass their own env; browser tests can replace
 * `window.webkitSpeechRecognition` / `window.speechSynthesis` before the page
 * loads and these wrappers pick the fakes up.
 *
 * The Web Speech API types are declared locally (minimal, only what Cue uses)
 * instead of adding a dependency; TypeScript's DOM lib does not ship the
 * recognition half.
 */

/* ---------- Minimal Web Speech API types ---------- */

export interface SpeechAlternativeLike {
  readonly transcript: string;
}
export interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike;
}
export interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike;
}
export interface SpeechRecognitionEventLike {
  readonly resultIndex?: number;
  readonly results: SpeechResultListLike;
}
export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface UtteranceLike {
  text: string;
  lang: string;
  volume: number;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
export type UtteranceCtor = new (text: string) => UtteranceLike;

export interface SynthesisLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  resume?(): void;
}

export interface SpeechEnv {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  speechSynthesis?: SynthesisLike;
  SpeechSynthesisUtterance?: UtteranceCtor;
}

/** The real browser, or nothing during server rendering. */
export function browserSpeechEnv(): SpeechEnv {
  if (typeof window === "undefined") return {};
  return window as unknown as SpeechEnv;
}

/* ---------- Recognition ---------- */

export function recognitionCtor(env: SpeechEnv = browserSpeechEnv()): SpeechRecognitionCtor | null {
  return env.SpeechRecognition ?? env.webkitSpeechRecognition ?? null;
}

export function recognitionSupported(env: SpeechEnv = browserSpeechEnv()): boolean {
  return recognitionCtor(env) !== null;
}

/** Why listening did not produce words. */
export type RecognitionProblem =
  | "unsupported"
  | "denied"
  | "no_microphone"
  | "no_speech"
  | "network"
  | "aborted"
  | "failed";

/** Maps a `SpeechRecognitionErrorEvent.error` code to Cue's problem kinds. */
export function recognitionProblem(code: string): RecognitionProblem {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "denied";
    case "audio-capture":
      return "no_microphone";
    case "no-speech":
      return "no_speech";
    case "network":
      return "network";
    case "aborted":
      return "aborted";
    default:
      return "failed";
  }
}

/** Joins every result so far into one transcript, and says whether the last one is final. */
export function readTranscript(results: SpeechResultListLike): { text: string; final: boolean } {
  const parts: string[] = [];
  let final = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || r.length === 0) continue;
    parts.push(r[0]?.transcript ?? "");
    final = r.isFinal;
  }
  return { text: parts.join(" ").replace(/\s+/g, " ").trim(), final };
}

export type ListenOutcome =
  | { kind: "heard"; transcript: string }
  | { kind: "problem"; problem: RecognitionProblem; heard: string };

export interface Listening {
  /** Settles once, when recognition ends. */
  result: Promise<ListenOutcome>;
  /** Stop listening and use what was heard so far. */
  stop(): void;
  /** Give up; settles as `aborted`. */
  abort(): void;
}

/**
 * Listens for one short phrase (`lang` en-US, not continuous, interim results
 * on). `onHeard` gets the words so far as they come in. Gives up after
 * `timeoutMs` and uses whatever was heard by then.
 */
export function listenOnce(
  opts: { onHeard?: (text: string) => void; timeoutMs?: number; env?: SpeechEnv } = {},
): Listening {
  const Ctor = recognitionCtor(opts.env);
  if (!Ctor) {
    return {
      result: Promise.resolve({ kind: "problem", problem: "unsupported", heard: "" }),
      stop() {},
      abort() {},
    };
  }

  let heard = "";
  let finalText: string | null = null;
  let problem: RecognitionProblem | null = null;
  let settled = false;
  let settle: (o: ListenOutcome) => void = () => {};
  const result = new Promise<ListenOutcome>((resolve) => {
    settle = (o) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
  });

  const finish = () => {
    const text = (finalText ?? heard).trim();
    if (problem && problem !== "no_speech") settle({ kind: "problem", problem, heard: text });
    else if (text) settle({ kind: "heard", transcript: text });
    else settle({ kind: "problem", problem: "no_speech", heard: "" });
  };

  let rec: SpeechRecognitionLike;
  try {
    rec = new Ctor();
  } catch {
    return {
      result: Promise.resolve({ kind: "problem", problem: "failed", heard: "" }),
      stop() {},
      abort() {},
    };
  }
  rec.lang = "en-US";
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onresult = (event) => {
    const { text, final } = readTranscript(event.results);
    heard = text;
    if (final) finalText = text;
    opts.onHeard?.(text);
  };
  rec.onerror = (event) => {
    problem = recognitionProblem(event.error);
  };
  rec.onend = finish;

  const timer = setTimeout(() => {
    try {
      rec.stop();
    } catch {
      // already stopped
    }
    // Some engines never fire `end` after stop(); do not hang on them.
    setTimeout(finish, 1500);
  }, opts.timeoutMs ?? 10_000);

  try {
    rec.start();
  } catch {
    problem = "failed";
    finish();
  }

  return {
    result,
    stop() {
      try {
        rec.stop();
      } catch {
        finish();
      }
    },
    abort() {
      problem = "aborted";
      try {
        rec.abort();
      } catch {
        // ignore
      }
      finish();
    },
  };
}

/* ---------- Synthesis ---------- */

export function synthesisSupported(env: SpeechEnv = browserSpeechEnv()): boolean {
  return Boolean(env.speechSynthesis && env.SpeechSynthesisUtterance);
}

/**
 * Browsers only let a page speak after a user gesture. Call this inside a tap
 * or key handler: it speaks a silent, empty utterance so a later `speak()`
 * (after a network round trip, say) is allowed to play.
 */
export function primeSpeech(env: SpeechEnv = browserSpeechEnv()): void {
  const synth = env.speechSynthesis;
  const Utterance = env.SpeechSynthesisUtterance;
  if (!synth || !Utterance) return;
  try {
    const u = new Utterance("");
    u.volume = 0;
    u.lang = "en-US";
    synth.speak(u);
  } catch {
    // no speech; text on screen is enough
  }
}

/**
 * Speaks `text` in English. Resolves when it has finished, failed, or after
 * `maxWaitMs`, whichever comes first, so a caller can wait for it without
 * ever being held up for long. Never rejects.
 */
export function speak(
  text: string,
  opts: { maxWaitMs?: number; env?: SpeechEnv } = {},
): Promise<void> {
  const env = opts.env ?? browserSpeechEnv();
  const synth = env.speechSynthesis;
  const Utterance = env.SpeechSynthesisUtterance;
  if (!synth || !Utterance || !text.trim()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(end, opts.maxWaitMs ?? 8_000);
    try {
      const u = new Utterance(text);
      u.lang = "en-US";
      u.volume = 1;
      u.rate = 1;
      u.onend = end;
      u.onerror = end;
      // Chrome can be left paused after a tab was in the background.
      synth.resume?.();
      synth.speak(u);
    } catch {
      end();
    }
  });
}
