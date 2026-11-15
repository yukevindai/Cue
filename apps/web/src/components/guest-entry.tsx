"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { api } from "@/lib/api";
import { safeReturnPath } from "@/lib/encounter";
import {
  decideIntro,
  GUEST_PROMPT,
  guestRequestProblem,
  phaseAfterListen,
  requestProblemText,
  statusLines,
  welcomeLine,
  type GuestPhase,
} from "@/lib/guest-entry";
import { listenOnce, primeSpeech, recognitionSupported, speak, type Listening } from "@/lib/speech";
import { Button, Card, Notice, TextField } from "@/components/ui";

/** Never hold up getting in for the spoken welcome longer than this. */
const WELCOME_MAX_WAIT_MS = 2_500;

const noopSubscribe = () => () => {};

/**
 * "New here? Just say hi": a demo guest account from nothing but a name,
 * spoken ("Say hi", browser speech recognition) or typed. Shown above the
 * sign-in and sign-up forms. Hidden once the server says the feature is off.
 */
export function GuestEntry() {
  // `null` while server rendering: neither promise nor apology until we know.
  const canListen = useSyncExternalStore(noopSubscribe, () => recognitionSupported(), () => null);
  const [phase, setPhase] = useState<GuestPhase>({ kind: "idle" });
  const [off, setOff] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const listening = useRef<Listening | null>(null);
  const headingId = useId();

  useEffect(() => () => listening.current?.abort(), []);

  const busy = phase.kind === "listening" || phase.kind === "creating" || phase.kind === "in";

  async function create(intro: string, name: string, heard: string | null) {
    setPhase({ kind: "creating", heard, name });
    try {
      const { displayName } = await api.createGuest({ intro });
      setPhase({ kind: "in", name: displayName });
      await speak(welcomeLine(displayName), { maxWaitMs: WELCOME_MAX_WAIT_MS });
      const next = safeReturnPath(new URLSearchParams(window.location.search).get("next"));
      // Full navigation on purpose: server-rendered state must reset.
      window.location.assign(next);
    } catch (err) {
      const problem = guestRequestProblem(err);
      if (problem === "off") {
        setOff(true);
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "request_problem", problem, heard });
    }
  }

  async function sayHi() {
    if (busy) return;
    // Inside the tap: lets the welcome play after the network round trip.
    primeSpeech();
    setTypedError(null);
    setPhase({ kind: "listening", heard: "" });
    const l = listenOnce({ onHeard: (heard) => setPhase({ kind: "listening", heard }) });
    listening.current = l;
    const outcome = await l.result;
    if (listening.current !== l) return;
    listening.current = null;
    const next = phaseAfterListen(outcome);
    if (next.kind === "creating") {
      await create(next.heard ?? "", next.name, next.heard);
      return;
    }
    setPhase(next);
  }

  function stopListening() {
    listening.current?.stop();
  }

  async function onTyped(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    primeSpeech();
    const d = decideIntro(typed);
    if (d.action === "empty") {
      setTypedError("Type your name, or 'Hi, my name is …'.");
      return;
    }
    if (d.action === "no_name") {
      setTypedError(requestProblemText("no_name"));
      return;
    }
    setTypedError(null);
    await create(d.intro, d.name, null);
  }

  if (off) {
    return (
      <Notice className="mb-8">
        Guest entry is switched off right now. Sign in or create an account with an email below.
      </Notice>
    );
  }

  const lines = statusLines(phase);
  const listeningNow = phase.kind === "listening";

  return (
    <Card aria-labelledby={headingId} className="mb-8 animate-rise" data-testid="guest-entry">
      <h2 id={headingId} className="font-display text-2xl leading-tight tracking-tight">
        New here? Just say hi
      </h2>
      <p className="mt-1 text-ink-soft">
        Say &lsquo;Hi, my name is &hellip;&rsquo; and you&rsquo;re in. No email or password. Guest
        accounts are for the demo and may be removed afterwards.
      </p>

      {canListen === true ? (
        <div className="mt-4">
          {listeningNow ? (
            <Button size="lg" full variant="secondary" onClick={stopListening}>
              Stop listening
            </Button>
          ) : (
            <Button
              size="lg"
              full
              onClick={() => void sayHi()}
              busy={phase.kind === "creating" && phase.heard !== null}
              disabled={busy}
            >
              Say hi
            </Button>
          )}
        </div>
      ) : canListen === false ? (
        <p className="mt-4 text-sm text-ink-soft">
          Voice entry isn&rsquo;t available in this browser, so type your name below.
        </p>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        data-testid="guest-status"
        className={lines.length ? "mt-4 space-y-1 rounded-2xl border border-line bg-sunk px-4 py-3" : "sr-only"}
      >
        {lines.map((line) => (
          <p key={line} className={line.startsWith("Heard:") ? "text-ink-soft" : "font-medium"}>
            {line}
          </p>
        ))}
      </div>

      <form onSubmit={onTyped} noValidate className="mt-5 space-y-3">
        <TextField
          label="Or type it"
          name="intro"
          autoComplete="off"
          placeholder={GUEST_PROMPT}
          maxLength={200}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            if (typedError) setTypedError(null);
          }}
          error={typedError}
        />
        <Button
          type="submit"
          variant={canListen === true ? "secondary" : "primary"}
          full
          busy={phase.kind === "creating" && phase.heard === null}
          disabled={busy}
        >
          Continue as guest
        </Button>
      </form>
    </Card>
  );
}
