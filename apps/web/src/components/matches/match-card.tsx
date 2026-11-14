import Link from "next/link";
import type { MatchCard as MatchCardData } from "@cue/contracts";
import { Avatar, Chip } from "@/components/ui";
import { formatEncounterTime } from "@/lib/format";

const MAX_CHIPS = 4;

export function MatchCard({ match }: { match: MatchCardData }) {
  const { other } = match;
  const when = formatEncounterTime(match.encounterAt);
  const shown = other.interests.slice(0, MAX_CHIPS);
  const more = other.interests.length - shown.length;

  return (
    <li>
      <Link
        href={`/matches/${match.id}`}
        aria-label={`${other.displayName}, met at ${match.venueLabel}, ${when}`}
        className="block rounded-card border border-line bg-surface p-5 shadow-card transition-colors hover:border-line-strong hover:bg-white sm:p-6"
      >
        <div className="flex items-start gap-4 sm:gap-5">
          <Avatar name={other.displayName} src={other.photoUrl} size={72} />
          <div className="min-w-0 flex-1">
            <p className="font-display text-3xl leading-tight tracking-tight break-words">
              {other.displayName}
            </p>
            <p className="mt-1 text-ink">
              Met at {match.venueLabel}
              <span className="text-ink-soft"> · {when}</span>
            </p>
            <p className="text-sm text-ink-soft">Venue entered by hand, not GPS</p>
          </div>
        </div>

        {other.bio ? <p className="mt-4 line-clamp-2 text-ink-soft">{other.bio}</p> : null}

        {shown.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {shown.map((i) => (
              <Chip key={i}>{i}</Chip>
            ))}
            {more > 0 ? (
              <span className="text-sm text-ink-soft">and {numberWord(more)} more</span>
            ) : null}
          </div>
        ) : null}
      </Link>
    </li>
  );
}

function numberWord(n: number): string {
  const words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return n < words.length ? words[n] : String(n);
}
