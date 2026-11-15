"use client";

import { useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { primeSpeech, speakNow, synthesisSupported } from "@/lib/speech";

const noopSubscribe = () => () => {};
const canSpeak = () => synthesisSupported();

const TONES = {
  /** On the dark match screen. */
  dusk: {
    figure: "bg-dusk-soft",
    caption: "text-cream/70",
    quote: "text-cream",
    button: "text-cream/90 decoration-cream/50 hover:text-cream",
  },
  /** On a light page. */
  paper: {
    figure: "border border-line bg-surface shadow-card",
    caption: "text-ink-soft",
    quote: "text-ink",
    button: "text-ink decoration-ink/40 hover:text-ember-deep",
  },
} as const;

/**
 * The wingman's line with a "Hear it again" button. A tap always speaks, even
 * when "Wingman voice" is off: that switch governs speaking unprompted, and a
 * tap is a request. The button is absent where the browser cannot speak.
 */
export function WingmanLine({ text, tone }: { text: string; tone: keyof typeof TONES }) {
  const speakable = useSyncExternalStore(noopSubscribe, canSpeak, () => false);
  const t = TONES[tone];
  return (
    <figure data-testid="wingman-line" className={`rounded-2xl px-5 py-4 text-left ${t.figure}`}>
      <figcaption className={`text-xs font-medium uppercase tracking-[0.2em] ${t.caption}`}>Your wingman</figcaption>
      <blockquote className={`mt-1 font-display text-lg italic leading-snug ${t.quote}`}>&ldquo;{text}&rdquo;</blockquote>
      {speakable ? (
        <button
          type="button"
          onClick={() => void speakNow(text)}
          className={`mt-2 text-sm font-semibold underline underline-offset-4 ${t.button}`}
        >
          Hear it again
        </button>
      ) : null}
    </figure>
  );
}

type Tip = { state: "idle" } | { state: "loading" } | { state: "ready"; text: string } | { state: "failed" };

/**
 * The wingman on a match's page. Nothing is fetched until the person asks:
 * "Hear your wingman" gets the line, shows it and says it. After that it is a
 * WingmanLine with "Hear it again".
 */
export function WingmanTip({ matchId }: { matchId: string }) {
  const [tip, setTip] = useState<Tip>({ state: "idle" });

  async function ask() {
    if (tip.state === "loading") return;
    // Inside the tap, so the line may be spoken after the request returns.
    primeSpeech();
    setTip({ state: "loading" });
    try {
      const line = await api.getHype(matchId);
      setTip({ state: "ready", text: line.text });
      void speakNow(line.text);
    } catch {
      setTip({ state: "failed" });
    }
  }

  if (tip.state === "ready") return <WingmanLine text={tip.text} tone="paper" />;
  return (
    <div data-testid="wingman-tip" className="rounded-2xl border border-line bg-surface px-5 py-4 shadow-card">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-ink-soft">Your wingman</p>
      <button
        type="button"
        onClick={() => void ask()}
        disabled={tip.state === "loading"}
        className="mt-1 text-left font-semibold underline underline-offset-4 hover:text-ember-deep disabled:opacity-60"
      >
        {tip.state === "loading" ? "Getting your tip…" : "Hear your wingman"}
      </button>
      {tip.state === "failed" ? (
        <p role="status" className="mt-1 text-sm text-ink-soft">
          Couldn&apos;t get a tip right now. Try again in a moment.
        </p>
      ) : null}
    </div>
  );
}
