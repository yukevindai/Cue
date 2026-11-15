"use client";

import { MATCH_WINDOW_SECONDS, type EncounterStatus, type PendingSignal } from "@cue/contracts";
import { useEffect, useRef, useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Card, Notice } from "@/components/ui";
import { api, describeError, isApiError } from "@/lib/api";
import {
  buildInterestEvent,
  deriveSignalView,
  effectivePendingSignal,
  rejectionCopy,
  signalSourceText,
} from "@/lib/encounter";
import { useServerNow } from "./use-server-now";

const FADED_LINE_MS = 6000;
const MESSAGE_MS = 12_000;
const FADED_TEXT =
  "That signal has faded. Nothing was shared, and the moment stays yours. Signal again whenever you like.";

interface PanelMessage {
  text: string;
}

/**
 * The user's own signal: send it, watch it, let it fade.
 *
 * PRIVACY: every branch below is driven by the user's OWN pending signal, own
 * mode and own place. The only thing that differs when someone nearby had
 * already signalled is that a match appears (shown by the provider), never
 * anything in this panel.
 */
export function SignalPanel({ encounter }: { encounter: EncounterStatus }) {
  const { clockOffsetMs, refreshEncounter, refreshMatches, matches } = useLive();
  const now = useServerNow(clockOffsetMs, 250);

  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  /** Our own accepted ack, held only until the next encounter status arrives. */
  const [optimistic, setOptimistic] = useState<PendingSignal | null>(null);
  const [message, setMessage] = useState<PanelMessage | null>(null);
  /** Set when one of our signals reached its expiry time while still pending. */
  const [faded, setFaded] = useState<{ eventId: string; receivedAt: string } | null>(null);

  const view = deriveSignalView(encounter, now, optimistic);

  // Expiry: a timer aimed at the signal's own `expiresAt`. If the signal goes
  // away earlier (consumed by a match, reset, paused), the cleanup cancels the
  // timer and no "faded" line is ever shown.
  const signal = encounter.encounterMode ? effectivePendingSignal(encounter, optimistic) : null;
  const signalId = signal?.eventId ?? null;
  const signalExpiresAt = signal?.expiresAt ?? null;
  const signalReceivedAt = signal?.receivedAt ?? null;
  useEffect(() => {
    if (!signalId || !signalExpiresAt || !signalReceivedAt) return;
    const remaining = new Date(signalExpiresAt).getTime() - (Date.now() + clockOffsetMs);
    // Already long expired when it reached us (stale server row): nothing to say.
    if (remaining <= -1000) return;
    const id = window.setTimeout(
      () => {
        setFaded((prev) =>
          prev?.eventId === signalId ? prev : { eventId: signalId, receivedAt: signalReceivedAt },
        );
        void refreshEncounter();
      },
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(id);
  }, [signalId, signalExpiresAt, signalReceivedAt, clockOffsetMs, refreshEncounter]);

  useEffect(() => {
    if (!faded) return;
    const again = window.setTimeout(() => void refreshEncounter(), 1500);
    const clear = window.setTimeout(() => setFaded(null), FADED_LINE_MS);
    return () => {
      window.clearTimeout(again);
      window.clearTimeout(clear);
    };
  }, [faded, refreshEncounter]);

  // Panel messages are passing remarks, not state: let them go after a while.
  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => window.clearTimeout(id);
  }, [message]);

  // If the signal actually became a match right at the wire, stay silent.
  const fadedReceivedMs = faded ? new Date(faded.receivedAt).getTime() : 0;
  const becameMatch =
    faded !== null &&
    (matches ?? []).some((m) => new Date(m.createdAt).getTime() >= fadedReceivedMs - 1000);
  const showFaded =
    faded !== null &&
    !becameMatch &&
    !sending &&
    (view.kind === "idle" || view.kind === "no_place");

  async function sendInterest() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setMessage(null);
    setFaded(null);
    try {
      const ack = await api.sendInterest(buildInterestEvent());
      if (ack.status === "accepted") {
        if (ack.matched) {
          // The provider shows the match moment; nothing else to do here.
          void refreshMatches();
        } else if (ack.expiresAt) {
          setOptimistic({
            eventId: ack.eventId,
            source: "web_demo",
            receivedAt: ack.receivedAt,
            expiresAt: ack.expiresAt,
          });
        }
        void refreshEncounter();
      } else if (ack.status === "duplicate") {
        if (ack.matched) void refreshMatches();
        await refreshEncounter();
        if (!ack.matched) setMessage({ text: "Your signal is already out." });
      } else {
        const copy = rejectionCopy(ack.reason);
        setMessage({ text: `Nothing was sent. ${copy.text}` });
        if (copy.refresh) void refreshEncounter();
      }
    } catch (err) {
      if (isApiError(err, "encounter_mode_off")) {
        setMessage({ text: `Nothing was sent. ${rejectionCopy("encounter_mode_off").text}` });
        void refreshEncounter();
      } else if (isApiError(err, "network")) {
        setMessage({ text: `${describeError(err)} Your signal wasn't sent.` });
      } else if (isApiError(err, "timeout") || isApiError(err, "bad_response")) {
        // The request may have landed; ask the server rather than guess.
        setMessage({
          text: "That took too long to confirm. If your signal went out it will show here in a moment; if not, try again.",
        });
        void refreshEncounter();
      } else {
        setMessage({ text: `${describeError(err)} Your signal wasn't sent.` });
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const announcement =
    view.kind === "pending"
      ? "Your signal is out. It stays open for a few seconds."
      : showFaded
        ? FADED_TEXT
        : "";

  return (
    <Card aria-labelledby="signal-title" className="px-5 py-8 text-center sm:px-10 sm:py-10">
      <h2 id="signal-title" className="sr-only">
        Your signal
      </h2>
      {/* One announcement when a signal starts and one when it ends; never per second. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {view.kind === "pending" ? (
        <div className="animate-rise">
          <p className="font-display text-3xl italic leading-tight">Your signal is out</p>
          <CountdownRing secondsLeft={view.secondsLeft} fraction={view.fraction} />
          <p className="font-medium">{signalSourceText(view.source)}</p>
          <p className="mx-auto mt-2 max-w-sm text-ink-soft">
            If they noticed you too and signal within the window, you&apos;ll both know. If not, it
            quietly fades and nothing is shared.
          </p>
        </div>
      ) : view.kind === "paused" ? (
        <div>
          <p className="font-display text-3xl italic leading-tight">Encounter mode is off</p>
          <p className="mx-auto mt-3 max-w-sm text-ink-soft">
            You can&apos;t signal while it is off, and nothing you do here or on your glasses is
            sent. Turn it on above when you&apos;re ready.
          </p>
        </div>
      ) : (
        <div>
          <p className="font-display text-3xl italic leading-tight">
            {view.kind === "no_place" ? "Not quite yet" : "Whenever you're ready"}
          </p>
          {view.kind !== "no_place" ? (
            <p className="mx-auto mt-2 max-w-sm text-ink-soft">
              If someone here catches your eye, let them know.
            </p>
          ) : null}
          <Button
            size="lg"
            full
            className="mx-auto mt-6 min-h-16 max-w-md text-xl"
            busy={sending}
            disabled={view.kind === "no_place"}
            aria-describedby="signal-help"
            onClick={sendInterest}
          >
            Interested
          </Button>
          <p id="signal-help" className="mx-auto mt-4 max-w-sm text-ink-soft">
            {view.kind === "no_place"
              ? "SocialEyes doesn't know where you are yet. Allow location, or check in with a venue code, then signal."
              : `Sends one signal. If someone near you signals within ${MATCH_WINDOW_SECONDS} seconds, SocialEyes pairs you with the nearest of them. Otherwise nobody is told.`}
          </p>
          {showFaded ? (
            <p className="mx-auto mt-5 max-w-sm animate-fade font-display text-lg italic text-ink-soft">
              {FADED_TEXT}
            </p>
          ) : null}
        </div>
      )}

      {message ? (
        <Notice className="mx-auto mt-6 max-w-md text-left">{message.text}</Notice>
      ) : null}
    </Card>
  );
}

const RING_RADIUS = 70;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** A ring that drains as the user's own signal window runs down. */
function CountdownRing({ secondsLeft, fraction }: { secondsLeft: number; fraction: number }) {
  return (
    <div
      role="timer"
      aria-label={`${secondsLeft} seconds left on your signal`}
      className="relative mx-auto my-6 h-44 w-44"
    >
      <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="80" cy="80" r={RING_RADIUS} fill="none" strokeWidth="6" className="stroke-line" />
        <circle
          cx="80"
          cy="80"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className="stroke-ember"
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - fraction)}
          style={{ transition: "stroke-dashoffset 250ms linear" }}
        />
      </svg>
      <div aria-hidden className="absolute inset-0 grid place-items-center">
        <span className="font-mono text-5xl font-medium tabular-nums">{secondsLeft}</span>
      </div>
    </div>
  );
}
