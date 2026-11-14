"use client";

import type { MatchCard } from "@cue/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { formatEncounterTime } from "@/lib/format";
import { Avatar } from "@/components/ui";

/**
 * The one loud moment in Cue. Shown over whatever view the user is on when a
 * mutual match lands. A modal <dialog>, so focus is trapped, Escape closes it,
 * and screen readers announce it.
 */
export function MatchMoment({ match, onDismiss }: { match: MatchCard; onDismiss: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  const open = () => {
    onDismiss();
    router.push(`/matches/${match.id}`);
  };

  const name = match.other.displayName;

  return (
    <dialog
      ref={ref}
      data-testid="match-moment"
      aria-labelledby="match-moment-title"
      aria-describedby="match-moment-detail"
      onClose={onDismiss}
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

        <div className="mt-8 flex animate-rise items-center gap-4 rounded-full bg-dusk-soft py-2 pl-2 pr-6 [animation-delay:350ms]">
          <Avatar name={name} src={match.other.photoUrl} size={56} />
          <div className="text-left">
            <p className="text-xl font-semibold leading-tight">{name}</p>
            <p id="match-moment-detail" className="text-sm text-cream/75">
              {match.venueLabel} · {formatEncounterTime(match.encounterAt)}
            </p>
          </div>
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
      </div>
    </dialog>
  );
}
