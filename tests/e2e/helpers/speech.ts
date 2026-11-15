import type { BrowserContext, Page } from "@playwright/test";

/**
 * Fakes for the browser's Web Speech API, so the pages can be driven without a
 * microphone or a speaker. This proves what the pages do with speech; it says
 * nothing about real recognition or real audio, which headless Chromium cannot
 * do and this suite does not claim to test.
 *
 * Headless Chromium has a native `SpeechRecognition` that does not work, so
 * BOTH `SpeechRecognition` and `webkitSpeechRecognition` are replaced (the page
 * reads the unprefixed one first). `speechSynthesis` and
 * `SpeechSynthesisUtterance` are replaced by a recorder.
 *
 * What was "spoken" is kept in sessionStorage (`__e2e_spoken`), so it survives
 * the page's full navigations and reloads, and is read with `spoken(page)`.
 * The fake recogniser does nothing by itself: the test drives it with
 * `interim`, `final` and `fail`.
 */
export type RecognitionKind = "fake" | "unsupported";

const SPOKEN_KEY = "__e2e_spoken";

export interface Utterance {
  text: string;
  volume: number;
}

export async function installSpeechFakes(context: BrowserContext, opts: { recognition?: RecognitionKind } = {}): Promise<void> {
  await context.addInitScript(
    ({ recognition, spokenKey }) => {
      const w = window as unknown as Record<string, unknown>;
      const define = (name: string, value: unknown) =>
        Object.defineProperty(window, name, { value, configurable: true, writable: true });

      const readSpoken = (): Utterance[] => {
        try {
          return JSON.parse(sessionStorage.getItem(spokenKey) || "[]");
        } catch {
          return [];
        }
      };
      interface Utterance {
        text: string;
        volume: number;
      }

      class FakeUtterance {
        text: string;
        lang = "";
        volume = 1;
        rate = 1;
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      }
      const synth = {
        speak(u: FakeUtterance) {
          try {
            const all = readSpoken();
            all.push({ text: u.text, volume: u.volume });
            sessionStorage.setItem(spokenKey, JSON.stringify(all));
          } catch {
            /* no storage */
          }
          setTimeout(() => u.onend?.(), 10);
        },
        cancel() {},
        resume() {},
        speaking: false,
        pending: false,
        paused: false,
      };
      define("SpeechSynthesisUtterance", FakeUtterance);
      define("speechSynthesis", synth);

      if (recognition === "unsupported") {
        define("SpeechRecognition", undefined);
        define("webkitSpeechRecognition", undefined);
        return;
      }

      interface Rec {
        onresult: ((e: unknown) => void) | null;
        onerror: ((e: { error: string }) => void) | null;
        onend: (() => void) | null;
      }
      const control = {
        starts: 0,
        active: null as Rec | null,
        result(text: string, isFinal: boolean) {
          const alt = [{ transcript: text }] as unknown as { isFinal: boolean; length: number };
          alt.isFinal = isFinal;
          control.active?.onresult?.({ resultIndex: 0, results: [alt] });
        },
        end() {
          const rec = control.active;
          control.active = null;
          rec?.onend?.();
        },
      };
      class FakeRecognition implements Rec {
        lang = "";
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onresult: ((e: unknown) => void) | null = null;
        onerror: ((e: { error: string }) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          control.starts += 1;
          control.active = this;
        }
        stop() {
          control.end();
        }
        abort() {
          control.end();
        }
      }
      define("SpeechRecognition", FakeRecognition);
      define("webkitSpeechRecognition", FakeRecognition);
      w["__speechFake"] = control;
    },
    { recognition: opts.recognition ?? "fake", spokenKey: SPOKEN_KEY },
  );
}

/** Words as the engine hears them so far (not final). */
export async function hearInterim(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => (window as unknown as { __speechFake: { result(t: string, f: boolean): void } }).__speechFake.result(t, false), text);
}

/** The final words, after which the recogniser ends, as a real one does. */
export async function hearFinal(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const f = (window as unknown as { __speechFake: { result(t: string, f: boolean): void; end(): void } }).__speechFake;
    f.result(t, true);
    f.end();
  }, text);
}

/** The recogniser fails with a Web Speech error code (`not-allowed`, `no-speech`, ...) and ends. */
export async function failListening(page: Page, code: string): Promise<void> {
  await page.evaluate((c) => {
    const f = (window as unknown as { __speechFake: { active: { onerror: ((e: { error: string }) => void) | null } | null; end(): void } }).__speechFake;
    f.active?.onerror?.({ error: c });
    f.end();
  }, code);
}

/** Everything the page asked the (fake) speech synthesiser to say in this tab, in order. */
export async function spoken(page: Page): Promise<Utterance[]> {
  return page.evaluate((key) => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "[]") as Utterance[];
    } catch {
      return [];
    }
  }, SPOKEN_KEY);
}

/**
 * What was actually said aloud: `spoken` minus the silent, empty "prime"
 * utterances the page speaks inside a tap (Say hi, Interested) so that a later
 * line is allowed to play.
 */
export async function spokenAloud(page: Page): Promise<Utterance[]> {
  return (await spoken(page)).filter((u) => u.volume > 0 && u.text.trim() !== "");
}
