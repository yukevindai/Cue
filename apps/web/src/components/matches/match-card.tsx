import Link from "next/link";
import { ARCHETYPES, LOOKING_FOR_LABELS, type MatchCard as MatchCardData } from "@cue/contracts";
import { Avatar, Chip } from "@/components/ui";
import { formatEncounterTime, matchPlace } from "@/lib/format";
import { ageAndCity } from "@/lib/profile-facts";

const MAX_CHIPS = 4;

export function unreadText(n: number): string {
  return n === 1 ? "1 unread message" : `${n} unread messages`;
}

export function MatchCard({ match }: { match: MatchCardData }) {
  const { other } = match;
  const when = formatEncounterTime(match.encounterAt);
  const shown = other.interests.slice(0, MAX_CHIPS);
  const more = other.interests.length - shown.length;
  const character = other.archetype ? ARCHETYPES[other.archetype] : null;
  const facts = ageAndCity(other);
  const unread = match.unreadCount;
  const place = matchPlace(match);

  return (
    <li>
      <Link
        href={`/matches/${match.id}`}
        aria-label={`${other.displayName}, ${place.line.charAt(0).toLowerCase()}${place.line.slice(1)}, ${when}${unread > 0 ? `, ${unreadText(unread)}` : ""}`}
        className="block rounded-card border border-line bg-surface p-5 shadow-card transition-colors hover:border-line-strong hover:bg-white sm:p-6"
      >
        <div className="flex items-start gap-4 sm:gap-5">
          <Avatar name={other.displayName} src={other.photoUrl} size={72} />
          <div className="min-w-0 flex-1">
            <p className="font-display text-3xl leading-tight tracking-tight break-words">{other.displayName}</p>
            {unread > 0 ? (
              <span
                aria-hidden
                className="my-1 inline-flex items-center gap-1.5 rounded-full bg-ember px-2.5 py-0.5 text-sm font-semibold tabular-nums text-white"
              >
                {unreadText(unread).replace("unread", "new")}
              </span>
            ) : null}
            {character ? <p className="font-display text-lg italic leading-snug text-ink-soft">{character.name}</p> : null}
            {facts ? <p className="mt-0.5 font-medium">{facts}</p> : null}
            <p className="mt-1 text-ink">
              {place.line}
              <span className="text-ink-soft"> · {when}</span>
            </p>
            {place.note ? <p className="text-sm text-ink-soft">{place.note}</p> : null}
          </div>
        </div>

        {other.lookingFor ? (
          <p className="mt-4 text-ink-soft">
            Looking for: <span className="font-medium text-ink">{LOOKING_FOR_LABELS[other.lookingFor]}</span>
          </p>
        ) : null}
        {other.bio ? <p className="mt-3 line-clamp-2 text-ink-soft">{other.bio}</p> : null}

        {shown.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {shown.map((i) => (
              <Chip key={i}>{i}</Chip>
            ))}
            {more > 0 ? <span className="text-sm text-ink-soft">and {numberWord(more)} more</span> : null}
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
