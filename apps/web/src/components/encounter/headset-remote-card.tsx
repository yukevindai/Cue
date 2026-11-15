"use client";

import type { PendingSignal } from "@cue/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Card, Notice, StatusPill } from "@/components/ui";
import { api, describeError, isApiError } from "@/lib/api";
import { armChime, playNotSentTone, playSentTone } from "@/lib/chime";
import { deriveSignalView, rejectionCopy } from "@/lib/encounter";
import {
  buildQuietWavDataUrl,
  choiceForCommand,
  choiceInstruction,
  choiceLabel,
  commandLabel,
  decideCommand,
  DEFAULT_SIGNAL_CHOICE,
  isEcho,
  outcomeText,
  parseSignalChoice,
  pushRecent,
  SIGNAL_CHOICE_STORAGE_KEY,
  toneForOutcome,
  type CommandOrigin,
  type CommandOutcome,
  type MediaCommand,
  type ReceivedCommand,
  type SignalChoice,
} from "@/lib/headset-remote";

const LOST_AUDIO_TEXT = "Listening stopped: another app took over the audio.";

/* ---------- Chosen command, remembered per browser ---------- */

let memoryChoice: SignalChoice | null = null;
const choiceListeners = new Set<() => void>();

function readChoice(): SignalChoice {
  if (memoryChoice === null) {
    try {
      memoryChoice = parseSignalChoice(window.localStorage.getItem(SIGNAL_CHOICE_STORAGE_KEY));
    } catch {
      memoryChoice = DEFAULT_SIGNAL_CHOICE;
    }
  }
  return memoryChoice;
}

function writeChoice(choice: SignalChoice) {
  memoryChoice = choice;
  try {
    window.localStorage.setItem(SIGNAL_CHOICE_STORAGE_KEY, choice);
  } catch {
    // storage unavailable: the choice lasts until the page reloads
  }
  for (const fn of choiceListeners) fn();
}

function subscribeChoice(fn: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SIGNAL_CHOICE_STORAGE_KEY) return;
    memoryChoice = null;
    fn();
  };
  choiceListeners.add(fn);
  window.addEventListener("storage", onStorage);
  return () => {
    choiceListeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

const noopSubscribe = () => () => {};
const hasMediaSession = () => typeof navigator !== "undefined" && "mediaSession" in navigator;

function setHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // this browser doesn't know the action; the others still work
  }
}

function formatClock(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

const HANDLED_ACTIONS: MediaSessionAction[] = ["play", "pause", "nexttrack", "previoustrack"];

/**
 * Meta glasses (or any Bluetooth headset): the page holds the phone's audio
 * session with a quiet loop, and one chosen media command becomes a signal.
 *
 * PRIVACY: driven only by the wearer's own commands, own mode, own place
 * (`ready`) and own pending signal. Nothing here depends on, or reveals,
 * anyone else's interest; a match is announced by the provider as usual.
 */
export function HeadsetRemoteCard() {
  const { encounter, clockOffsetMs, refreshEncounter, refreshMatches } = useLive();
  const supported = useSyncExternalStore(noopSubscribe, hasMediaSession, () => true);
  const choice = useSyncExternalStore(subscribeChoice, readChoice, () => DEFAULT_SIGNAL_CHOICE);

  const audioRef = useRef<HTMLAudioElement>(null);
  const quietUrl = useRef<string | null>(null);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [recent, setRecent] = useState<ReceivedCommand[]>([]);
  const [last, setLast] = useState<{ entry: ReceivedCommand; outcome: CommandOutcome } | null>(
    null,
  );

  // Handlers registered with the browser outlive a render: they read these refs.
  const listeningRef = useRef(false);
  const stoppingRef = useRef(false);
  const lastReceived = useRef<ReceivedCommand | null>(null);
  const lastSentAt = useRef<number | null>(null);
  const inFlight = useRef(false);
  const optimistic = useRef<PendingSignal | null>(null);
  const nextId = useRef(1);
  const live = useRef({ encounter, clockOffsetMs, choice, refreshEncounter, refreshMatches });
  useEffect(() => {
    live.current = { encounter, clockOffsetMs, choice, refreshEncounter, refreshMatches };
  });

  /** Drop the audio session. `lost`: it was taken from us rather than stopped. */
  const teardown = useCallback((lost: boolean) => {
    stoppingRef.current = true;
    listeningRef.current = false;
    lastReceived.current = null;
    setListening(false);
    audioRef.current?.pause();
    if (hasMediaSession()) {
      for (const action of HANDLED_ACTIONS) setHandler(action, null);
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      } catch {
        // nothing to clear
      }
    }
    if (lost) setNotice(LOST_AUDIO_TEXT);
  }, []);

  const report = useCallback((entry: ReceivedCommand, outcome: CommandOutcome) => {
    setLast({ entry, outcome });
    const tone = toneForOutcome(outcome);
    if (tone === "sent") playSentTone();
    else if (tone === "not_sent") playNotSentTone();
  }, []);

  const handleCommand = useCallback(
    async (command: MediaCommand, origin: CommandOrigin) => {
      const now = Date.now();
      // One single tap can arrive as both a handler call and an element pause.
      if (isEcho(lastReceived.current, command, origin, now)) return;
      const entry: ReceivedCommand = { id: nextId.current++, command, origin, atMs: now };
      lastReceived.current = entry;
      setRecent((list) => pushRecent(list, entry));

      const L = live.current;
      const enc = L.encounter;
      const view = enc ? deriveSignalView(enc, now + L.clockOffsetMs, optimistic.current) : null;
      const decision = decideCommand(
        command,
        {
          listening: listeningRef.current,
          choice: L.choice,
          encounterMode: enc?.encounterMode ?? false,
          ready: enc?.ready ?? false,
          pending: inFlight.current || view?.kind === "pending",
          lastSentAtMs: lastSentAt.current,
        },
        now,
      );
      if (decision.kind === "ignored") {
        report(entry, { kind: "ignored", reason: decision.reason });
        return;
      }

      lastSentAt.current = now;
      inFlight.current = true;
      setLast({ entry, outcome: { kind: "sending" } });
      try {
        const ack = await api.sendInterest(decision.event);
        if (ack.status === "accepted") {
          if (ack.matched) {
            // The provider shows the match moment and plays the chime.
            void L.refreshMatches();
          } else if (ack.expiresAt) {
            optimistic.current = {
              eventId: ack.eventId,
              source: "headset_remote",
              receivedAt: ack.receivedAt,
              expiresAt: ack.expiresAt,
            };
          }
          void L.refreshEncounter();
        } else if (ack.status === "duplicate") {
          if (ack.matched) void L.refreshMatches();
          void L.refreshEncounter();
        } else {
          if (rejectionCopy(ack.reason).refresh) void L.refreshEncounter();
        }
        report(entry, { kind: "sent", ack });
      } catch (err) {
        if (isApiError(err, "encounter_mode_off")) {
          report(entry, { kind: "failed", detail: rejectionCopy("encounter_mode_off").text });
          void L.refreshEncounter();
        } else if (isApiError(err, "timeout") || isApiError(err, "bad_response")) {
          report(entry, { kind: "unconfirmed" });
          void L.refreshEncounter();
        } else {
          report(entry, { kind: "failed", detail: describeError(err) });
        }
      } finally {
        inFlight.current = false;
      }
    },
    [report],
  );

  /** Keep the audio session: resume at once. Resolves false if another app has it. */
  const keepPlaying = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !listeningRef.current) return false;
    try {
      await audio.play();
    } catch {
      if (listeningRef.current) teardown(true);
      return false;
    }
    try {
      navigator.mediaSession.playbackState = "playing";
    } catch {
      // older Safari: the element's own state is enough
    }
    return true;
  }, [teardown]);

  function start() {
    const audio = audioRef.current;
    if (!audio || !supported || starting) return;
    setNotice(null);
    armChime();
    quietUrl.current ??= buildQuietWavDataUrl();
    if (audio.src !== quietUrl.current) audio.src = quietUrl.current;
    audio.loop = true;
    stoppingRef.current = false;
    setStarting(true);

    // iOS only lets audio start inside the tap, so play() is called right here.
    const playing = audio.play();
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({
        title: "SocialEyes is listening for your signal",
        artist: "SocialEyes",
      });
    } catch {
      // metadata is cosmetic
    }
    setHandler("play", () => {
      void keepPlaying();
      void handleCommand("play", "handler");
    });
    setHandler("pause", () => {
      void keepPlaying();
      void handleCommand("pause", "handler");
    });
    setHandler("nexttrack", () => void handleCommand("nexttrack", "handler"));
    setHandler("previoustrack", () => void handleCommand("previoustrack", "handler"));

    playing
      .then(() => {
        listeningRef.current = true;
        setListening(true);
        try {
          ms.playbackState = "playing";
        } catch {
          // older Safari: the element's own state is enough
        }
      })
      .catch((err: unknown) => {
        teardown(false);
        setNotice(
          `Couldn't start listening. ${err instanceof Error && err.name === "NotAllowedError" ? "The browser blocked the audio; tap the button again." : "Try again."}`,
        );
      })
      .finally(() => setStarting(false));
  }

  function stop() {
    setNotice(null);
    teardown(false);
  }

  // The element paused itself (iOS can do this for a tap before, or instead
  // of, calling the pause handler). Resume, and count it only if we got the
  // audio back; otherwise another app has taken over.
  function onElementPause() {
    if (!listeningRef.current || stoppingRef.current) return;
    void keepPlaying().then((ok) => {
      if (ok) void handleCommand("pause", "element");
    });
  }

  useEffect(() => () => teardown(false), [teardown]);

  return (
    <Card aria-labelledby="headset-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="headset-title" className="font-display text-2xl leading-tight tracking-tight">
          Meta glasses
        </h2>
        <p role="status">
          {listening ? (
            <StatusPill tone="on" pulse>
              Listening
            </StatusPill>
          ) : (
            <StatusPill tone="off">Not listening</StatusPill>
          )}
        </p>
      </div>

      {/* Kept in the page so the audio session belongs to this tab. */}
      <audio ref={audioRef} loop preload="none" onPause={onElementPause} className="hidden" />

      {!supported ? (
        <p className="mt-3">
          This browser can&apos;t receive headset commands. On an iPhone, open SocialEyes in Safari.
        </p>
      ) : (
        <>
          <p className="mt-3">
            {choiceInstruction(choice)} to signal.{" "}
            <span className="text-ink-soft">Swipes change the volume and do nothing here.</span>
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            Your signal: <span className="font-medium text-ink">{choiceLabel(choice)}</span>
          </p>

          {listening ? (
            <Button variant="secondary" className="mt-4 max-sm:w-full" onClick={stop}>
              Stop listening
            </Button>
          ) : (
            <>
              <Button className="mt-4 max-sm:w-full" busy={starting} onClick={start}>
                Listen for my glasses
              </Button>
              <p className="mt-2 text-sm text-ink-soft">
                Plays a very quiet sound so this page can hear your glasses.
              </p>
            </>
          )}

          {notice ? (
            <Notice tone="warn" className="mt-4">
              {notice}
            </Notice>
          ) : null}

          {listening || last ? (
            <p aria-live="polite" className="mt-4 rounded-2xl bg-sunk px-4 py-3 text-[0.95rem]">
              <span className="font-semibold">Last command:</span>{" "}
              {last
                ? `${commandLabel(last.entry.command)}. ${outcomeText(last.outcome, choice)}`
                : "none yet. Try a tap on the temple."}
            </p>
          ) : null}

          {recent.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-ink-soft">Received</h3>
              <ul className="mt-1 divide-y divide-line">
                {recent.map((r) => {
                  const mine = choiceForCommand(r.command) === choice;
                  return (
                    <li key={r.id} className="flex min-h-12 items-center justify-between gap-3">
                      <span>
                        <span className="font-medium">{commandLabel(r.command)}</span>{" "}
                        <span className="font-mono text-sm tabular-nums text-ink-soft">
                          {formatClock(r.atMs)}
                        </span>
                      </span>
                      {mine ? (
                        <span className="text-sm font-medium text-moss">Your signal</span>
                      ) : (
                        <Button
                          variant="quiet"
                          className="-mr-5"
                          onClick={() => writeChoice(choiceForCommand(r.command))}
                        >
                          Use as my signal
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <p className="mt-4 text-sm text-ink-soft">
            Keep this page open and playing. If music, a call or Meta AI takes over the audio, tap
            Listen again. This responds to whichever headset is connected to this phone, so it
            can&apos;t prove the tap came from Meta glasses.
          </p>
        </>
      )}
    </Card>
  );
}
