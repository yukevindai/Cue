"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MatchCard } from "@cue/contracts";
import { chatDraft } from "@/lib/chat-draft";
import { formatEncounterTime, matchPlace } from "@/lib/format";
import { Avatar, buttonClass, Card, Chip, SectionTitle } from "@/components/ui";
import { CommonGround } from "./common-ground";
import { BackLink, MatchFallback, StepAway, useMatch } from "./match-common";
import { unreadText } from "./match-card";
import { hasDetails, ProfileDetails } from "./profile-details";
import { WingmanTip } from "./wingman-line";

export function MatchDetailView({ id }: { id: string }) {
  const m = useMatch(id);
  if (m.leaving || m.gone || !m.card) return <MatchFallback m={m} />;
  return (
    <Detail
      key={m.card.id}
      match={m.card}
      onGone={m.markGone}
      onLeaving={() => m.setLeaving(true)}
      onLeaveFailed={() => m.setLeaving(false)}
    />
  );
}

export function chatHref(id: string) {
  return `/matches/${id}/chat`;
}

function Detail({
  match,
  onGone,
  onLeaving,
  onLeaveFailed,
}: {
  match: MatchCard;
  onGone: () => void;
  onLeaving: () => void;
  onLeaveFailed: () => void;
}) {
  const router = useRouter();
  const { other } = match;
  const name = other.displayName;
  const unread = match.unreadCount;

  const missing: string[] = [];
  if (!other.photoUrl) missing.push("a photo");
  if (!other.bio) missing.push("a bio");
  if (other.interests.length === 0) missing.push("interests");

  const details = hasDetails(other);
  const place = matchPlace(match);

  return (
    <div className="animate-rise space-y-8">
      <div>
        <BackLink />

        <section aria-label="Who you matched with" className="sm:flex sm:items-start sm:gap-8">
          <Avatar name={name} src={other.photoUrl} size={112} className="mb-4 sm:mb-0" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-4xl leading-[1.1] tracking-tight break-words sm:text-5xl">{name}</h1>
            <div className="mt-4 rounded-card border border-line bg-sunk px-5 py-4">
              <p className="font-display text-2xl italic leading-snug">
                You met {formatEncounterTime(match.encounterAt)}
              </p>
              <p className="font-display text-2xl leading-snug">{place.phrase}</p>
              {place.note ? <p className="mt-2 text-sm text-ink-soft">{place.note}</p> : null}
            </div>
            <Link href={chatHref(match.id)} className={buttonClass("primary", "lg", true) + " mt-4 sm:w-auto"}>
              <ChatIcon />
              Message {name}
              {unread > 0 ? (
                <span className="ml-1 rounded-full bg-white/90 px-2 py-0.5 text-sm font-semibold tabular-nums text-ember-deep">
                  {unread > 99 ? "99+" : unread}
                  <span className="sr-only"> {unreadText(unread)}</span>
                </span>
              ) : null}
            </Link>
          </div>
        </section>
      </div>

      {other.bio || details || other.interests.length > 0 ? (
        <Card className="space-y-6">
          {other.bio ? (
            <div>
              <SectionTitle>About {name}</SectionTitle>
              <p className="mt-2 whitespace-pre-line break-words text-lg">{other.bio}</p>
            </div>
          ) : null}

          {details ? <ProfileDetails profile={other} /> : null}

          {other.interests.length > 0 ? (
            <div>
              <h2 className="font-display text-xl leading-tight">Interests</h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {other.interests.map((i) => (
                  <li key={i}>
                    <Chip>{i}</Chip>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      {missing.length > 0 ? (
        <p className="text-ink-soft">
          {name} hasn&apos;t shared {joinList(missing)}.
        </p>
      ) : null}

      <WingmanTip matchId={match.id} />

      <CommonGround
        matchId={match.id}
        name={name}
        onGone={onGone}
        onUseOpener={(text) => {
          chatDraft.offerOpener(match.id, text);
          router.push(chatHref(match.id));
        }}
      />

      <StepAway match={match} onGone={onGone} onLeaving={onLeaving} onLeaveFailed={onLeaveFailed} />
    </div>
  );
}

export function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17h0A1.5 1.5 0 0 1 4 15.5z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
