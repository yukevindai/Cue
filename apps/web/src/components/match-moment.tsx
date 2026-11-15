"use client";

import { ARCHETYPES, type HypeLine, type MatchCard } from "@cue/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useLive } from "@/components/live-provider";
import { api, describeError, isApiError } from "@/lib/api";
import { formatEncounterTime, matchPlace } from "@/lib/format";
import { speak } from "@/lib/speech";
import { markAnnounced, readVoicePref, shouldSpeakHype, wasAnnounced } from "@/lib/wingman-voice";
import { Avatar, ConfirmDialog } from "@/components/ui";

/**
 * One wingman request per match per tab, shared across remounts of the
 * moment (React may mount it twice in development). `null`: no line.
 */
const hypeRequests = new Map<string, Promise<HypeLine | null>>();
const spokenHype = new Set<string>();

/**
 * Asks for the wingman's line once per match per tab and speaks it, unless
 * Wingman voice is off or linked Mentra glasses were seen in the last 30 s
 * (their own app says it). Failures show and say nothing; the moment never
 * waits for it.
 */
function useHype(matchId: string): string | null {
  const { encounter, clockOffsetMs } = useLive();
  const [text, setText] = useState<string | null>(null);
  const deviceRef = useRef({ device: encounter?.device ?? null, clockOffsetMs });
  useEffect(() => {
    deviceRef.current = { device: encounter?.device ?? null, clockOffsetMs };
  }, [encounter, clockOffsetMs]);

  useEffect(() => {
    let cancelled = false;
    let req = hypeRequests.get(matchId);
    if (!req) {
      if (wasAnnounced(matchId)) return;
      markAnnounced(matchId);
      req = api.getHype(matchId).catch(() => null);
      hypeRequests.set(matchId, req);
    }
    void req.then((line) => {
      if (cancelled || !line || line.matchId !== matchId) return;
      setText(line.text);
      if (spokenHype.has(matchId)) return;
      spokenHype.add(matchId);
      const { device, clockOffsetMs: offset } = deviceRef.current;
      if (shouldSpeakHype({ voiceOn: readVoicePref(), device, nowMs: Date.now() + offset })) {
        void speak(line.text);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  return text;
}

/**
 * The one loud moment in SocialEyes. Shown over whatever view the user is on when a
 * mutual match lands. A modal <dialog>, so focus is trapped, Escape closes it,
 * and screen readers announce it.
 */
export function MatchMoment({ match, onDismiss }: { match: MatchCard; onDismiss: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const { forgetMatch, refreshMatches } = useLive();
  const [confirmUnmatch, setConfirmUnmatch] = useState(false);
  const [unmatchBusy, setUnmatchBusy] = useState(false);
  const [unmatchError, setUnmatchError] = useState<string | null>(null);
  const hype = useHype(match.id);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  const open = () => {
    onDismiss();
    router.push(`/matches/${match.id}`);
  };

  const name = match.other.displayName;
  const place = matchPlace(match);

  /** "Not who you meant?": end the match straight from the moment. */
  async function unmatch() {
    if (unmatchBusy) return;
    setUnmatchBusy(true);
    setUnmatchError(null);
    try {
      await api.unmatch(match.id);
    } catch (err) {
      if (!isApiError(err, "not_found")) {
        setUnmatchBusy(false);
        setUnmatchError(describeError(err));
        return;
      }
      // Already gone on the server: the outcome the person wanted.
    }
    // Removing it from the queue closes this moment.
    forgetMatch(match.id);
    void refreshMatches();
  }
  const character = match.other.archetype ? ARCHETYPES[match.other.archetype] : null;

  return (
    <>
      <dialog
        ref={ref}
        data-testid="match-moment"
        aria-labelledby="match-moment-title"
        aria-describedby="match-moment-detail"
        onClose={(e) => {
          if (e.target === e.currentTarget) onDismiss();
        }}
        className="m-0 h-dvh max-h-none w-screen max-w-none animate-fade overflow-y-auto bg-dusk p-0 text-cream backdrop:bg-dusk"
      >
        <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 py-10 text-center">
          <div aria-hidden className="relative mb-8 h-28 w-48">
            <span className="absolute left-4 top-0 h-28 w-28 animate-ring-left rounded-full border-[3px] border-cream/90" />
            <span className="absolute right-4 top-0 h-28 w-28 animate-ring-right rounded-full border-[3px] border-ember bg-ember/25" />
          </div>

          <p className="text-sm font-medium uppercase tracking-[0.2em] text-cream/70">
            You both signalled
          </p>
          <h2
            id="match-moment-title"
            className="mt-3 font-display text-5xl italic leading-[1.05] tracking-tight sm:text-6xl"
          >
            It&rsquo;s mutual.
          </h2>
          <p className="mt-5 animate-rise font-display text-xl italic text-cream/80 [animation-delay:200ms] sm:text-2xl">
            In a sea of people, you noticed each other.
          </p>

          <div className="mt-8 flex animate-rise items-center gap-4 rounded-full bg-dusk-soft py-2 pl-2 pr-6 [animation-delay:350ms]">
            <Avatar name={name} src={match.other.photoUrl} size={56} />
            <div className="text-left">
              <p className="text-xl font-semibold leading-tight">{name}</p>
              {character ? (
                <p className="font-display italic leading-tight text-cream/90">{character.name}</p>
              ) : null}
              <p id="match-moment-detail" className="text-sm text-cream/75">
                {place.line} · {formatEncounterTime(match.encounterAt)}
              </p>
            </div>
          </div>

          <div aria-live="polite" className="w-full">
            {hype ? (
              <figure
                data-testid="wingman-line"
                className="mx-auto mt-6 max-w-sm animate-rise rounded-2xl bg-dusk-soft px-5 py-4 text-left"
              >
                <figcaption className="text-xs font-medium uppercase tracking-[0.2em] text-cream/70">
                  Your wingman
                </figcaption>
                <blockquote className="mt-1 font-display text-lg italic leading-snug text-cream">
                  &ldquo;{hype}&rdquo;
                </blockquote>
              </figure>
            ) : null}
          </div>

          <div className="mt-10 flex w-full animate-rise flex-col gap-3 [animation-delay:500ms]">
            <button
              type="button"
              autoFocus
              onClick={open}
              className="min-h-14 rounded-full bg-cream px-6 text-lg font-semibold text-dusk transition-colors hover:bg-white focus-visible:outline-cream"
            >
              See {name}&rsquo;s card
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-12 rounded-full px-6 font-medium text-cream/85 underline-offset-4 hover:underline focus-visible:outline-cream"
            >
              Not now
            </button>
          </div>
          <p className="mt-6 text-sm text-cream/60">
            Their card stays in Matches. There&rsquo;s no rush.
          </p>
          <p className="mt-6 max-w-sm text-sm text-cream/80">
            SocialEyes pairs you with the nearest person who signalled within the same few seconds. In a
            crowd, that can be the wrong person.
          </p>
          <button
            type="button"
            onClick={() => {
              setUnmatchError(null);
              setConfirmUnmatch(true);
            }}
            className="mt-2 min-h-12 rounded-full px-6 font-medium text-cream/85 underline underline-offset-4 hover:text-cream focus-visible:outline-cream"
          >
            Not who you meant? Unmatch
          </button>
        </div>
      </dialog>
      {confirmUnmatch ? (
        <ConfirmDialog
          title={`Unmatch ${name}?`}
          confirmLabel="Unmatch"
          danger
          busy={unmatchBusy}
          error={unmatchError}
          onConfirm={() => void unmatch()}
          onCancel={() => {
            if (!unmatchBusy) setConfirmUnmatch(false);
          }}
        >
          <p>
            You&apos;ll both lose each other&apos;s card straight away. Anything already seen
            can&apos;t be unseen. {name} isn&apos;t notified.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
